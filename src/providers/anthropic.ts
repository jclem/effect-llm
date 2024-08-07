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
  FunctionCallOption,
  FunctionDefinitionAny,
  StreamEvent,
} from "../generation.js";
import {
  StreamEventEnum,
  type Provider,
  type StreamParams,
} from "../generation.js";
import { filterParsedEvents, streamSSE } from "../sse.js";
import { AssistantMessage, Role, type ThreadEvent } from "../thread.js";

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

const AnthropicStreamEvent = S.Union(
  ContentBlockStart,
  ContentBlockDelta,
  ContentBlockStop,
);
type ContentBlockEvent = typeof AnthropicStreamEvent.Type;
const decodeContentBlockEvent = S.decodeUnknownOption(AnthropicStreamEvent);

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
      stream<F extends Readonly<FunctionDefinitionAny[]>>(
        params: StreamParams<F>,
      ) {
        return Effect.gen(function* () {
          const toolChoice = params.functionCall
            ? yield* getToolChoice(params.functionCall)
            : undefined;

          return HttpClientRequest.post("/v1/messages").pipe(
            HttpClientRequest.setHeader(
              "X-API-Key",
              Redacted.value(params.apiKey),
            ),
            HttpClientRequest.jsonBody({
              // TODO: Handle system messages
              model: params.model,
              system: params.system,
              messages: messagesFromEvents(params.events),
              max_tokens: params.maxTokens,
              stream: true,
              tools: params.functions
                ? gatherTools(params.functions)
                : undefined,
              tool_choice: toolChoice,
              ...params.additionalParameters,
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
                HttpClientError | HttpBodyError | UnknownException,
                Scope.Scope,
                StreamEvent
              >(
                stream,
                Match.type<ContentBlockEvent>().pipe(
                  Match.discriminatorsExhaustive("type")({
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
                            StreamEventEnum.FunctionCallStart({
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
                            StreamEventEnum.FunctionCall({
                              id: block.toolUse.id,
                              name: block.toolUse.name,
                              arguments: block.toolUse.input,
                            }),
                          ];
                        }
                      }
                    },
                  }),
                ),
              );
            },
          );
        }).pipe(
          Effect.mapError((err) =>
            err instanceof InvalidFunctionCallOptionError
              ? new UnknownException(err)
              : err,
          ),
          Stream.unwrap,
          (x) => x,
        );
      },
    };
  });

type AnthropicUserMessage = {
  role: Role.User;
  content: (
    | { type: "text"; text: string }
    | {
        type: "tool_result";
        tool_use_id: string;
        is_error: boolean;
        content: string;
      }
  )[];
};

type AnthropicAssistantMessage = {
  role: Role.Assistant;
  content: (
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
  )[];
};

type Message = AnthropicUserMessage | AnthropicAssistantMessage;

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
              content: lastMessage.content.concat({
                type: "text",
                text: message.content,
              }),
            });
          } else {
            return messages.concat({
              role: Role.User,
              content: [{ type: "text", text: message.content }],
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

const gatherTools = (tools: Readonly<FunctionDefinitionAny[]>) =>
  tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: JSONSchema.make(tool.input),
  }));

class InvalidFunctionCallOptionError extends Data.TaggedError(
  "InvalidFunctionCallOptionError",
)<{
  readonly option: unknown;
  readonly reason: string;
}> {}

const getToolChoice = (
  toolCall: FunctionCallOption<Readonly<FunctionDefinitionAny[]>>,
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
          new InvalidFunctionCallOptionError({
            option: toolCall,
            reason: "Not supported.",
          }),
        );
    }
  });
