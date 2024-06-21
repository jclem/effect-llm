import type { BodyError } from "@effect/platform/Http/Body";
import type { HttpClientError } from "@effect/platform/Http/ClientError";
import * as Http from "@effect/platform/HttpClient";
import { JSONSchema, Schema as S, Schema } from "@effect/schema";
import {
  Array,
  Effect,
  Match,
  Option,
  Redacted,
  Stream,
  type Scope,
} from "effect";
import type { NonEmptyArray } from "effect/Array";
import type { UnknownException } from "effect/Cause";
import {
  StreamEvent,
  type FunctionDefinition,
  type Provider,
  type StreamParams,
} from "../generate";
import { filterParsedEvents, streamSSE } from "../sse";
import {
  AssistantMessage,
  Role,
  ToolResultEvent,
  ToolUseEvent,
  type ThreadEvent,
} from "../thread-event";

export interface OpenAIConfig {
  apiKey: Redacted.Redacted<string>;
}

export enum Model {
  GPT4Turbo = "gpt-4-turbo",
  GPT4o = "gpt-4o",
}

const ChatCompletionChunk = S.parseJson(
  S.Struct({
    object: S.Literal("chat.completion.chunk"),
    choices: S.NonEmptyArray(
      S.Struct({
        delta: S.Struct({
          role: S.optional(S.NullOr(S.Literal("assistant"))),
          content: S.optional(S.NullOr(S.String)),
          tool_calls: S.optional(
            S.Array(
              S.Struct({
                id: S.optional(S.String),
                type: S.optional(S.Literal("function")),
                index: S.Int,
                function: S.Struct({
                  name: S.optional(S.String),
                  arguments: S.String,
                }),
              }),
            ),
          ),
        }),
        finish_reason: S.NullOr(S.Literal("stop", "tool_calls")),
      }),
    ),
  }),
);

type ChatCompletionChunk = typeof ChatCompletionChunk.Type;

const decodeChatCompletionChunk = S.decodeUnknownOption(ChatCompletionChunk);

export const make = (
  config: OpenAIConfig,
): Effect.Effect<Provider, never, Http.client.Client.Default> =>
  Effect.gen(function* () {
    const client = yield* Http.client.Client.pipe(
      Effect.map(Http.client.filterStatusOk),
      Effect.map(
        Http.client.mapRequest(
          Http.request.prependUrl("https://api.openai.com"),
        ),
      ),
      Effect.map(
        Http.client.mapRequest(
          Http.request.setHeaders({
            Authorization: `Bearer ${Redacted.value(config.apiKey)}`,
            "Content-Type": "application/json",
          }),
        ),
      ),
    );

    return {
      streamTools(params: StreamParams) {
        const fnCalls: Extract<
          StreamEvent,
          { _tag: "FunctionCall" }
        >["functionCall"][] = [];

        return Stream.asyncEffect<
          StreamEvent,
          HttpClientError | BodyError | UnknownException,
          Scope.Scope
        >((emit) => {
          const single = (event: StreamEvent) =>
            Effect.promise(() => emit.single(event));
          const end = () => Effect.promise(() => emit.end());
          const fail = (
            error: HttpClientError | BodyError | UnknownException,
          ) => Effect.promise(() => emit.fail(error));

          return this.stream(params).pipe(
            Stream.runForEach((event) => {
              if (event._tag === "FunctionCall") {
                fnCalls.push(event.functionCall);
              }

              return Effect.promise(() => emit.single(event));
            }),
            Effect.andThen(() =>
              Effect.gen(this, function* () {
                if (fnCalls.length === 0) {
                  return yield* end();
                }

                const newEvents: ThreadEvent[] = [];

                for (const fnCall of fnCalls) {
                  const fnDefn = Array.findFirst(
                    params.functions ?? [],
                    (f) => f.name === fnCall.name,
                  ).pipe(
                    Option.getOrThrowWith(() => new Error("No function found")),
                  );

                  const input = yield* Schema.decodeUnknown(
                    Schema.parseJson(fnDefn.input),
                  )(fnCall.arguments);

                  const toolCallEvent = new ToolUseEvent({
                    id: fnCall.id,
                    name: fnCall.name,
                    input,
                  });

                  const output = yield* fnDefn.function(input);

                  const toolResultEvent = new ToolResultEvent({
                    id: fnCall.id,
                    output,
                  });

                  newEvents.push(toolCallEvent, toolResultEvent);
                }

                if (newEvents.length === 0) {
                  return;
                }

                const newParams: StreamParams = {
                  ...params,
                  events: [...params.events, ...newEvents],
                };

                yield* this.streamTools(newParams).pipe(
                  Stream.runForEach((e) => single(e)),
                );
              }),
            ),
            Effect.catchAll((err) => fail(err)),
            Effect.andThen(() => end()),
            Effect.fork,
          );
        });
      },

      stream(params: StreamParams) {
        return Http.request.post("/v1/chat/completions").pipe(
          Http.request.jsonBody({
            model: params.model,
            messages: messagesFromEvents(params.events),
            max_tokens: params.maxTokens,
            stream: true,
            tools: params.functions ? gatherTools(params.functions) : undefined,
          }),
          Effect.flatMap(client),
          Effect.flatMap(streamSSE),
          Stream.unwrap,
          filterParsedEvents,
          Stream.filterMap((e) => decodeChatCompletionChunk(e.data)),
          (stream) => {
            let partialMessage = "";
            const partialToolCalls = new Map<
              number,
              { id: string; name: string; arguments: string }
            >();

            return Stream.mapConcat(stream, (event) => {
              const choice = event.choices[0];
              const content = choice.delta.content;
              const toolCall = choice.delta.tool_calls?.at(0);

              const events: StreamEvent[] = [];

              if (content != null) {
                partialMessage += content;
                events.push(StreamEvent.Content({ content }));
              }

              if (toolCall != null) {
                const tool = partialToolCalls.get(toolCall.index) ?? {
                  id: "",
                  name: "",
                  arguments: "",
                };
                tool.id ||= toolCall.id ?? "";
                tool.name ||= toolCall.function.name ?? "";
                tool.arguments += toolCall.function.arguments;
                partialToolCalls.set(toolCall.index, tool);
              }

              if (choice.finish_reason != null || toolCall != null) {
                if (partialMessage.length > 0) {
                  events.push(
                    StreamEvent.Message({
                      message: new AssistantMessage({
                        content: partialMessage,
                      }),
                    }),
                  );
                  partialMessage = "";
                }
              }

              if (choice.finish_reason != null) {
                for (const tool of partialToolCalls.values()) {
                  events.push(
                    StreamEvent.FunctionCall({
                      functionCall: {
                        id: tool.id,
                        name: tool.name,
                        arguments: tool.arguments,
                      },
                    }),
                  );
                }
              }

              return events;
            });
          },
        );
      },
    };
  });

const gatherTools = (
  tools: NonEmptyArray<
    FunctionDefinition<string, unknown, unknown, unknown, unknown>
  >,
) =>
  tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: JSONSchema.make(tool.input),
    },
  }));

const messagesFromEvents = Array.filterMap(
  Match.type<ThreadEvent>().pipe(
    Match.tags({
      SystemMessage: (message) =>
        Option.some({
          role: Role.System,
          content: message.content,
        }),
      UserMessage: (message) =>
        Option.some({
          role: Role.User,
          content: message.content,
        }),
      AssistantMessage: (message) =>
        Option.some({
          role: Role.Assistant,
          content: message.content,
        }),
      ToolUseEvent: (event) =>
        Option.some({
          role: Role.Assistant,
          tool_calls: [
            {
              id: event.id,
              type: "function",
              function: {
                name: event.name,
                arguments: JSON.stringify(event.input),
              },
            },
          ],
        }),
      ToolResultEvent: (event) =>
        Option.some({
          role: "tool",
          tool_call_id: event.id,
          content: JSON.stringify(event.output),
        }),
    }),
    Match.exhaustive,
  ),
);
