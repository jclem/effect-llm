import type { BodyError } from "@effect/platform/Http/Body";
import type { HttpClientError } from "@effect/platform/Http/ClientError";
import * as Http from "@effect/platform/HttpClient";
import { JSONSchema, Schema as S } from "@effect/schema";
import { Array, Effect, Match, Option, Redacted, Scope, Stream } from "effect";
import type { NonEmptyArray } from "effect/Array";
import type { UnknownException } from "effect/Cause";
import {
  StreamEvent,
  type FunctionDefinition,
  type Provider,
  type StreamParams,
} from "../generate";
import { filterParsedEvents, streamSSE } from "../sse";
import { AssistantMessage, Role, type ThreadEvent } from "../thread-event";

export interface AnthropicConfig {
  apiKey: Redacted.Redacted<string>;
}

export enum Model {
  Claude3Opus = "claude-3-opus-20240229",
  Claude3Sonnet = "claude-3-sonnet-20240229",
  Claude35Sonnet = "claude-3-5-sonnet-20240620",
  Claude3Haiku = "claude-3-haiku-20240307",
}

const TextContentBlock = S.Struct({
  type: S.Literal("text"),
  text: S.String,
});

const ToolUseContentBlock = S.Struct({
  type: S.Literal("tool_use"),
  id: S.String,
  name: S.String,
  input: S.Object,
});

const ContentBlockStart = S.parseJson(
  S.Struct({
    type: S.Literal("content_block_start"),
    index: S.Int,
    content_block: S.Union(TextContentBlock, ToolUseContentBlock),
  }),
);

type ContentBlockStart = typeof ContentBlockStart.Type;

const TextDelta = S.Struct({
  type: S.Literal("text_delta"),
  text: S.String,
});

const ToolUseDelta = S.Struct({
  type: S.Literal("input_json_delta"),
  partial_json: S.String,
});

const ContentBlockDelta = S.parseJson(
  S.Struct({
    type: S.Literal("content_block_delta"),
    index: S.Int,
    delta: S.Union(TextDelta, ToolUseDelta),
  }),
);

type ContentBlockDelta = typeof ContentBlockDelta.Type;

const ContentBlockStop = S.parseJson(
  S.Struct({
    type: S.Literal("content_block_stop"),
    index: S.Int,
  }),
);

const ContentBlockEvent = S.Union(
  ContentBlockStart,
  ContentBlockDelta,
  ContentBlockStop,
);
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
            tools: params.functions ? gatherTools(params.functions) : undefined,
          }),
          Effect.flatMap(client),
          Effect.flatMap(streamSSE),
          Stream.unwrap,
          filterParsedEvents,
          Stream.filterMap((e) => decodeContentBlockEvent(e.data)),
          (stream) => {
            // TODO: Why does the tool use content block start have an input object?
            // TODO: Is the initial text on a text content block start also ever non-empty?
            type TextBlock = { type: "text"; index: number; text: string };
            type ToolBlock = {
              type: "toolUse";
              index: number;
              toolUse: { id: string; name: string; input: string };
            };

            type Block = TextBlock | ToolBlock;

            const blocks: Block[] = [];

            return Stream.mapConcat<
              ContentBlockEvent,
              HttpClientError | BodyError | UnknownException,
              Scope.Scope,
              StreamEvent
            >(
              stream,
              Match.type<ContentBlockEvent>().pipe(
                Match.discriminators("type")({
                  content_block_start: (event) => {
                    switch (event.content_block.type) {
                      case "text":
                        blocks.push({
                          type: "text",
                          index: event.index,
                          text: "",
                        });
                        return [];
                      default:
                        blocks.push({
                          type: "toolUse",
                          index: event.index,
                          toolUse: {
                            id: event.content_block.id,
                            name: event.content_block.name,
                            input: "",
                          },
                        });
                        return [];
                    }
                  },
                  content_block_delta: (event) => {
                    switch (event.delta.type) {
                      case "text_delta": {
                        const block = blocks.find(
                          (s): s is TextBlock =>
                            s.index === event.index && s.type === "text",
                        );

                        if (!block) {
                          throw new Error("No content block found");
                        }

                        block.text += event.delta.text;

                        return [
                          StreamEvent.Content({ content: event.delta.text }),
                        ];
                      }
                      case "input_json_delta": {
                        const block = blocks.find(
                          (s): s is ToolBlock =>
                            s.index === event.index && s.type === "toolUse",
                        );

                        if (!block) {
                          throw new Error("No content block found");
                        }

                        block.toolUse.input += event.delta.partial_json;

                        return [];
                      }
                    }
                  },
                  content_block_stop: (event) => {
                    const block = blocks.find((b) => b.index === event.index);
                    if (!block) {
                      throw new Error("No content block found");
                    }

                    switch (block.type) {
                      case "text": {
                        return [
                          StreamEvent.Message({
                            message: new AssistantMessage({
                              content: block.text,
                            }),
                          }),
                        ];
                      }
                      case "toolUse": {
                        return [
                          StreamEvent.FunctionCall({
                            functionCall: {
                              id: block.toolUse.id,
                              name: block.toolUse.name,
                              arguments: block.toolUse.input,
                            },
                          }),
                        ];
                      }
                    }
                  },
                }),
                Match.exhaustive,
              ),
            );
          },
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

const gatherTools = (
  tools: NonEmptyArray<
    FunctionDefinition<string, unknown, unknown, unknown, unknown>
  >,
) =>
  tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: JSONSchema.make(tool.input),
  }));

// Stream.mapAccum<
//   {
//     partialMessage: string;
//     toolUse: { name: string; inputs: string } | null;
//   },
//   ContentBlockEvent,
//   StreamEvent
// >({ partialMessage: "", toolUse: null }, (accum, event) => {
//   return Match.type<ContentBlockEvent>().pipe(
//     Match.discriminators("type")({
//       content_block_start: (block) => {
//         return [accum, []] as const;
//       },
//       content_block_delta: (b) => {
//         return [
//           {
//             ...accum,
//             partialMessage: accum.partialMessage + b.delta.text,
//           },
//           StreamEvent.Content({ content: b.delta.text }),
//         ] as const;
//       },
//       content_block_stop: () => {
//         return [
//           { ...accum, partialMessage: "" },
//           StreamEvent.Message({
//             message: new AssistantMessage({ content: accum }),
//           }),
//         ] as const;
//       },
//     }),
//     Match.exhaustive,
//   )(event);
// }),
