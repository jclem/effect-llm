import * as Http from "@effect/platform/HttpClient";
import { Schema as S } from "@effect/schema";
import { Array, Effect, Match, Option, Redacted, Stream } from "effect";
import { StreamEvent, type Provider, type StreamParams } from "../generate";
import { filterParsedEvents, streamSSE } from "../sse";
import { AssistantMessage, Role, type ThreadEvent } from "../thread-event";

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
          content: S.optional(S.String),
        }),
        finish_reason: S.NullOr(S.Literal("stop")),
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
          Http.request.setHeader(
            "Authorization",
            `Bearer ${Redacted.value(config.apiKey)}`,
          ),
        ),
      ),
    );

    return {
      stream(params: StreamParams) {
        return Http.request.post("/v1/chat/completions").pipe(
          Http.request.setHeader(
            "content-type",
            "application/json; charset=utf-8",
          ),
          Http.request.jsonBody({
            model: params.model,
            messages: messagesFromEvents(params.events),
            max_tokens: params.maxTokens,
            stream: true,
          }),
          Effect.flatMap(client),
          Effect.flatMap(streamSSE),
          Stream.unwrap,
          filterParsedEvents,
          Stream.filterMap((e) => decodeChatCompletionChunk(e.data)),
          (stream) => {
            let partialMessage = "";

            return Stream.mapConcat(stream, (event) => {
              const choice = event.choices[0];
              const content = choice.delta.content ?? "";
              const contentEvent = StreamEvent.Content({ content });

              partialMessage += content;

              if (choice.finish_reason === "stop") {
                const message = new AssistantMessage({
                  content: partialMessage,
                });

                partialMessage = "";

                return [contentEvent, StreamEvent.Message({ message })];
              } else {
                return [contentEvent];
              }
            });
          },
        );
      },
    };
  });

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
    }),
    Match.orElse(() => Option.none()),
  ),
);
