import * as Http from "@effect/platform/HttpClient";
import { Schema as S } from "@effect/schema";
import { Array, Effect, Match, Option, Redacted, Stream } from "effect";
import { StreamEvent, type Provider, type StreamParams } from "../generate";
import { filterParsedEvents, streamSSE } from "../sse";
import { AssistantMessage, Role, type ThreadEvent } from "../thread-event";

export interface AnthropicConfig {
  apiKey: Redacted.Redacted<string>;
}

export enum Model {
  Claude3Opus = "claude-3-opus-20240229",
  Claude3Sonnet = "claude-3-sonnet-20240229",
  Claude3Haiku = "claude-3-haiku-20240307",
}

const ContentBlockDelta = S.parseJson(
  S.Struct({
    type: S.Literal("content_block_delta"),
    delta: S.Struct({
      type: S.Literal("text_delta"),
      text: S.String,
    }),
  }),
);

const ContentBlockStop = S.parseJson(
  S.Struct({
    type: S.Literal("content_block_stop"),
  }),
);

const ContentBlockEvent = S.Union(ContentBlockDelta, ContentBlockStop);
type ContentBlockEvent = typeof ContentBlockEvent.Type;
const decodeContentBlockEvent = S.decodeUnknownOption(ContentBlockEvent);

export const make = (
  config: AnthropicConfig,
): Effect.Effect<Provider, never, Http.client.Client.Default> =>
  Effect.gen(function* () {
    const client = yield* Http.client.Client.pipe(
      Effect.map(Http.client.filterStatusOk),
      Effect.map(
        Http.client.mapRequest(
          Http.request.prependUrl("https://api.anthropic.com"),
        ),
      ),
      Effect.map(
        Http.client.mapRequest(
          Http.request.setHeaders({
            "X-API-Key": Redacted.value(config.apiKey),
            "Anthropic-Version": "2023-06-01",
            "Content-Type": "application/json",
          }),
        ),
      ),
    );

    return {
      stream(params: StreamParams) {
        return Http.request.post("/v1/messages").pipe(
          Http.request.jsonBody({
            // TODO: Handle system messages
            model: params.model,
            messages: messagesFromEvents(params.events),
            max_tokens: params.maxTokens,
            stream: true,
          }),
          Effect.flatMap(client),
          Effect.flatMap(streamSSE),
          Stream.unwrap,
          filterParsedEvents,
          Stream.filterMap((e) => decodeContentBlockEvent(e.data)),
          Stream.mapAccum<string, ContentBlockEvent, StreamEvent>(
            "",
            (accum, event) => {
              return Match.type<ContentBlockEvent>().pipe(
                Match.discriminators("type")({
                  content_block_delta: (b) =>
                    [
                      accum + b.delta.text,
                      StreamEvent.Content({ content: b.delta.text }),
                    ] as const,
                  content_block_stop: (s) =>
                    [
                      "",
                      StreamEvent.Message({
                        message: new AssistantMessage({ content: accum }),
                      }),
                    ] as const,
                }),
                Match.exhaustive,
              )(event);
            },
          ),
        );
      },
    };
  });

const messagesFromEvents = Array.filterMap(
  Match.type<ThreadEvent>().pipe(
    Match.tags({
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
