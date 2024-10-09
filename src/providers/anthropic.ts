import { HttpClient, HttpClientRequest } from "@effect/platform";
import type { HttpBodyError } from "@effect/platform/HttpBody";
import type { HttpClientError } from "@effect/platform/HttpClientError";
import { JSONSchema, Schema as S } from "@effect/schema";
import {
  Array,
  Data,
  Effect,
  Match,
  Option,
  Redacted,
  Stream,
  type Scope,
} from "effect";
import { UnknownException } from "effect/Cause";
import type {
  StreamEvent,
  ToolCallOption,
  ToolDefinitionAny,
} from "../generation.js";
import {
  StreamEventEnum,
  type Provider,
  type StreamParams,
} from "../generation.js";
import { filterParsedEvents, streamSSE } from "../sse.js";
import {
  AssistantMessage,
  Role,
  type ContentChunk,
  type ThreadEvent,
} from "../thread.js";
import { MissingParameterError, type DefaultParams } from "./index.js";
import { mergeParams } from "./internal.js";

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

const MessageStart = S.parseJson(
  S.Struct({
    type: S.Literal("message_start"),
    message: S.Struct({
      usage: S.Struct({
        input_tokens: S.Int,
        output_tokens: S.Int,
      }),
    }),
  }),
);
type MessageStart = typeof MessageStart.Type;

const MessageDelta = S.parseJson(
  S.Struct({
    type: S.Literal("message_delta"),
    delta: S.Struct({
      usage: S.Struct({
        output_tokens: S.Int,
      }),
    }),
  }),
);
type MessageDelta = typeof MessageDelta.Type;

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

const AnthropicStreamEvent = S.Union(
  MessageStart,
  MessageDelta,
  ContentBlockStart,
  ContentBlockDelta,
  ContentBlockStop,
);
type AnthropicStreamEvent = typeof AnthropicStreamEvent.Type;

const decodeEvent = S.decodeUnknownOption(AnthropicStreamEvent);

interface Config {
  defaultParams?: DefaultParams;
}

export const make = (
  config: Config = {},
): Effect.Effect<Provider, never, HttpClient.HttpClient.Default> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient.pipe(
      Effect.map(HttpClient.filterStatusOk),
      Effect.map(
        HttpClient.mapRequest(
          HttpClientRequest.prependUrl("https://api.anthropic.com"),
        ),
      ),
      Effect.map(
        HttpClient.mapRequest(
          HttpClientRequest.setHeaders({
            "Anthropic-Beta": "max-tokens-3-5-sonnet-2024-07-15",
            "Anthropic-Version": "2023-06-01",
            "Content-Type": "application/json",
          }),
        ),
      ),
    );

    return {
      stream<F extends Readonly<ToolDefinitionAny[]>>(params: StreamParams<F>) {
        params = mergeParams(config.defaultParams, params);

        return Effect.gen(function* () {
          const apiKey = yield* Effect.fromNullable(params.apiKey).pipe(
            Effect.map(Redacted.value),
            Effect.mapError(
              () => new MissingParameterError({ parameter: "apiKey" }),
            ),
          );

          const model = yield* Effect.fromNullable(params.model).pipe(
            Effect.mapError(
              () => new MissingParameterError({ parameter: "model" }),
            ),
          );
          const toolChoice = params.toolCall
            ? yield* getToolChoice(params.toolCall)
            : undefined;

          return HttpClientRequest.post("/v1/messages").pipe(
            HttpClientRequest.setHeader("X-API-Key", apiKey),
            HttpClientRequest.jsonBody({
              // TODO: Handle system messages
              model,
              system: params.system,
              messages: messagesFromEvents(params.events),
              max_tokens: params.maxTokens,
              stream: true,
              tools: params.tools ? gatherTools(params.tools) : undefined,
              tool_choice: toolChoice,
              ...params.additionalParameters,
            }),
            Effect.flatMap(client),
            Effect.map(streamSSE),
            Stream.unwrap,
            filterParsedEvents,
            Stream.filterMap((e) => decodeEvent(e.data)),
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
                AnthropicStreamEvent,
                HttpClientError | HttpBodyError | UnknownException,
                Scope.Scope,
                StreamEvent
              >(
                stream,
                Match.type<AnthropicStreamEvent>().pipe(
                  Match.discriminatorsExhaustive("type")({
                    message_start: (event) => {
                      return [
                        StreamEventEnum.Stats({
                          inputTokens: event.message.usage.input_tokens,
                          outputTokens: event.message.usage.output_tokens,
                        }),
                      ];
                    },
                    content_block_start: (event) => {
                      switch (event.content_block.type) {
                        case "text":
                          blocks.push({
                            type: "text",
                            index: event.index,
                            text: "",
                          });
                          return [
                            StreamEventEnum.ContentStart({ content: "" }),
                          ];
                        case "tool_use":
                          blocks.push({
                            type: "toolUse",
                            index: event.index,
                            toolUse: {
                              id: event.content_block.id,
                              name: event.content_block.name,
                              input: "",
                            },
                          });
                          return [
                            StreamEventEnum.ToolCallStart({
                              id: event.content_block.id,
                              name: event.content_block.name,
                            }),
                          ];
                      }
                    },
                    content_block_delta: (event) => {
                      switch (event.delta.type) {
                        case "text_delta": {
                          const block = Array.findFirst(
                            blocks,
                            (s): s is TextBlock =>
                              s.index === event.index && s.type === "text",
                          ).pipe(
                            Option.getOrThrowWith(
                              () => new Error("No text block found"),
                            ),
                          );

                          block.text += event.delta.text;

                          return [
                            StreamEventEnum.Content({
                              content: event.delta.text,
                            }),
                          ];
                        }
                        case "input_json_delta": {
                          const block = Array.findFirst(
                            blocks,
                            (s): s is ToolBlock =>
                              s.index === event.index && s.type === "toolUse",
                          ).pipe(
                            Option.getOrThrowWith(
                              () => new Error("No tool use block found"),
                            ),
                          );

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
                            StreamEventEnum.Message({
                              message: new AssistantMessage({
                                content: block.text,
                              }),
                            }),
                          ];
                        }
                        case "toolUse": {
                          return [
                            StreamEventEnum.ToolCall({
                              id: block.toolUse.id,
                              name: block.toolUse.name,
                              arguments: block.toolUse.input,
                            }),
                          ];
                        }
                      }
                    },
                    message_delta: (event) => {
                      return [
                        StreamEventEnum.Stats({
                          inputTokens: 0,
                          outputTokens: event.delta.usage.output_tokens,
                        }),
                      ];
                    },
                  }),
                ),
              );
            },
          );
        }).pipe(
          Effect.mapError((err) =>
            err instanceof InvalidToolCallOptionError
              ? new UnknownException(err)
              : err,
          ),
          Stream.unwrap,
        );
      },
    };
  });

type AnthropicContentPart =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      is_error: boolean;
      content: string;
    };

type AnthropicUserMessage = {
  role: Role.User;
  content: AnthropicContentPart[];
};

type AnthropicAssistantMessage = {
  role: Role.Assistant;
  content: (
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
  )[];
};

type Message = AnthropicUserMessage | AnthropicAssistantMessage;

const contentFromChunks = (chunks: ContentChunk[]) =>
  chunks.map<AnthropicContentPart>(
    Match.typeTags<ContentChunk>()({
      TextChunk: (chunk) => ({
        type: "text" as const,
        text: chunk.content,
      }),

      ImageChunk: (chunk) => ({
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: chunk.mimeType,
          data: chunk.content,
        },
      }),
    }),
  );

const messagesFromEvents = Array.reduce<Message[], ThreadEvent>(
  [],
  (messages, event) =>
    Match.type<ThreadEvent>().pipe(
      Match.tags({
        UserMessage: (message) => {
          const lastMessage = messages.at(-1);

          if (lastMessage?.role === Role.User) {
            return messages.slice(0, -1).concat({
              ...lastMessage,
              content: lastMessage.content.concat(
                contentFromChunks(message.content),
              ),
            });
          } else {
            return messages.concat({
              role: Role.User,
              content: contentFromChunks(message.content),
            });
          }
        },
        AssistantMessage: (message) => {
          const lastMessage = messages.at(-1);

          if (lastMessage?.role === Role.Assistant) {
            return messages.slice(0, -1).concat({
              ...lastMessage,
              content: lastMessage.content.concat({
                type: "text",
                text: message.content,
              }),
            });
          } else {
            return messages.concat({
              role: Role.Assistant,
              content: [{ type: "text", text: message.content }],
            });
          }
        },
        ToolUseEvent: (event) => {
          const lastMessage = messages.at(-1);

          const chunk = {
            type: "tool_use" as const,
            id: event.id,
            name: event.name,
            input: event.input,
          };

          if (lastMessage?.role === Role.Assistant) {
            return messages.slice(0, -1).concat({
              ...lastMessage,
              content: lastMessage.content.concat(chunk),
            });
          } else {
            return messages.concat({
              role: Role.Assistant,
              content: [chunk],
            });
          }
        },
        ToolResultSuccessEvent: (event) => {
          const lastMessage = messages.at(-1);

          const chunk = {
            type: "tool_result" as const,
            tool_use_id: event.id,
            is_error: false,
            content: JSON.stringify(event.result),
          };

          if (lastMessage?.role === Role.User) {
            return messages.slice(0, -1).concat({
              ...lastMessage,
              content: lastMessage.content.concat(chunk),
            });
          } else {
            return messages.concat({
              role: Role.User,
              content: [chunk],
            });
          }
        },
        ToolResultErrorEvent: (event) => {
          const lastMessage = messages.at(-1);

          const chunk = {
            type: "tool_result" as const,
            tool_use_id: event.id,
            is_error: true,
            content: JSON.stringify(event.result),
          };

          if (lastMessage?.role === Role.User) {
            return messages.slice(0, -1).concat({
              ...lastMessage,
              content: lastMessage.content.concat(chunk),
            });
          } else {
            return messages.concat({
              role: Role.User,
              content: [chunk],
            });
          }
        },
      }),
      Match.orElse(() => messages),
    )(event),
);

const gatherTools = (tools: Readonly<ToolDefinitionAny[]>) =>
  tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: S.isSchema(tool.input)
      ? JSONSchema.make(tool.input)
      : tool.input,
  }));

class InvalidToolCallOptionError extends Data.TaggedError(
  "InvalidToolCallOptionError",
)<{
  readonly option: unknown;
  readonly reason: string;
}> {}

const getToolChoice = (
  toolCall: ToolCallOption<Readonly<ToolDefinitionAny[]>>,
) =>
  Effect.gen(function* () {
    if (typeof toolCall === "object" && "name" in toolCall) {
      return {
        type: "tool",
        name: toolCall.name,
      };
    }

    switch (toolCall) {
      case "auto":
        return { type: "auto " };
      case "required":
        return { type: "any" };
      default:
        return yield* Effect.fail(
          new InvalidToolCallOptionError({
            option: toolCall,
            reason: "Not supported.",
          }),
        );
    }
  });
