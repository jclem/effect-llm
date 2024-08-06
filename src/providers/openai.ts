import { HttpClient, HttpClientRequest } from "@effect/platform";
import { JSONSchema, Schema as S } from "@effect/schema";
import { Array, Effect, Match, Option, Redacted, Stream } from "effect";
import type { FunctionDefinitionAny } from "../generation.js";
import {
  StreamEvent,
  type Provider,
  type StreamParams,
} from "../generation.js";
import { filterParsedEvents, streamSSE } from "../sse.js";
import { AssistantMessage, Role, type ThreadEvent } from "../thread.js";

export enum Model {
  GPT4Turbo = "gpt-4-turbo",
  GPT4o = "gpt-4o",
  GPT4oMini = "gpt-4o-mini",
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

export const make = (): Effect.Effect<
  Provider,
  never,
  HttpClient.HttpClient.Default
> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient.pipe(
      Effect.map(HttpClient.filterStatusOk),
      Effect.map(
        HttpClient.mapRequest(
          HttpClientRequest.prependUrl("https://api.openai.com"),
        ),
      ),
      Effect.map(
        HttpClient.mapRequest(
          HttpClientRequest.setHeaders({
            "Content-Type": "application/json",
          }),
        ),
      ),
    );

    return {
      stream<F extends Readonly<FunctionDefinitionAny[]>>(
        params: StreamParams<F>,
      ) {
        return HttpClientRequest.post("/v1/chat/completions").pipe(
          HttpClientRequest.setHeader(
            "Authorization",
            `Bearer ${Redacted.value(params.apiKey)}`,
          ),
          HttpClientRequest.jsonBody({
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

            // TODO: Implement ContentStart, FunctionCallStart, etc.
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
                      id: tool.id,
                      name: tool.name,
                      arguments: tool.arguments,
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

const gatherTools = (tools: Readonly<FunctionDefinitionAny[]>) =>
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
    Match.tagsExhaustive({
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
      ToolResultSuccessEvent: (event) =>
        Option.some({
          role: "tool",
          tool_call_id: event.id,
          content: JSON.stringify(event.result),
        }),
      ToolResultErrorEvent: (event) =>
        Option.some({
          role: "tool",
          tool_call_id: event.id,
          content: JSON.stringify(event.result),
        }),
    }),
  ),
);
