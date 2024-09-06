import { HttpClient, HttpClientRequest } from "@effect/platform";
import { JSONSchema, Schema as S } from "@effect/schema";
import {
  Array,
  Effect,
  Function,
  Match,
  Option,
  pipe,
  Redacted,
  Stream,
} from "effect";
import {
  StreamEventEnum,
  type Provider,
  type StreamParams,
  type ToolCallOption,
  type ToolDefinitionAny,
} from "../generation.js";
import { filterParsedEvents, streamSSE } from "../sse.js";
import type { ContentChunk, ThreadEvent } from "../thread.js";
import { MissingParameterError, type DefaultParams } from "./index.js";
import { mergeParams } from "./internal.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TaggedPart = <T extends string, S extends S.Struct<any>>(
  schema: S,
  tag: T,
) => schema.pipe(S.extend(S.Struct({ _tag: S.Literal(tag) })));

const TextPartInternal = S.Struct({
  text: S.String,
});

const TextPart = S.transform(
  TextPartInternal,
  TaggedPart(TextPartInternal, "Text"),
  {
    strict: true,
    decode: (value) => ({ ...value, _tag: "Text" as const }),
    encode: (value) => value,
  },
);

type TextPart = S.Schema.Type<typeof TextPart>;

const BlobPartInternal = S.Struct({
  mimeType: S.String,
  data: S.String,
});

const BlobPart = S.transform(
  BlobPartInternal,
  TaggedPart(BlobPartInternal, "Blob"),
  {
    strict: true,
    decode: (value) => ({ ...value, _tag: "Blob" as const }),
    encode: (value) => value,
  },
);

type BlobPart = S.Schema.Type<typeof BlobPart>;

const FunctionCallPartInternal = S.Struct({
  functionCall: S.Struct({
    name: S.String,
    args: S.Unknown,
  }),
});

const FunctionCallPart = S.transform(
  FunctionCallPartInternal,
  TaggedPart(FunctionCallPartInternal, "FunctionCall"),
  {
    strict: true,
    decode: (value) => ({ ...value, _tag: "FunctionCall" as const }),
    encode: (value) => value,
  },
);

type FunctionCallPart = S.Schema.Type<typeof FunctionCallPart>;

const FunctionResponsePartInternal = S.Struct({
  functionResponse: S.Struct({
    name: S.String,
    response: S.Unknown,
  }),
});

const FunctionResponsePart = S.transform(
  FunctionResponsePartInternal,
  FunctionResponsePartInternal.pipe(
    S.extend(S.Struct({ _tag: S.Literal("FunctionResponse") })),
  ),
  {
    strict: true,
    decode: (value) => ({ ...value, _tag: "FunctionResponse" as const }),
    encode: (value) => value,
  },
);

type FunctionResponsePart = S.Schema.Type<typeof FunctionResponsePart>;

const Part = S.Union(
  TextPart,
  BlobPart,
  FunctionCallPart,
  FunctionResponsePart,
);

type Part = S.Schema.Type<typeof Part>;

const Content = S.Struct({
  role: S.Literal("user", "model"),
  parts: S.Array(Part),
});

type Content = S.Schema.Type<typeof Content>;

const Candidate = S.Struct({
  content: Content,
});

const ContentResponse = S.Struct({
  candidates: S.Array(Candidate),
});

const decodeEvent = S.decodeUnknownOption(S.parseJson(ContentResponse));

interface Config {
  serviceEndpoint: string;
  defaultParams?: DefaultParams;
}

/**
 * Provides a Google AI client as a Provider for streaming generation.
 *
 * @param config - Configuration for the Google AI provider
 * @param defaultParams - Default parameters to use for requests
 * @returns An Effect that produces a Provider
 */
export const make = (
  config: Config,
): Effect.Effect<Provider, never, HttpClient.HttpClient.Default> =>
  Effect.sync(function () {
    const client = HttpClient.fetchOk.pipe(
      HttpClient.mapRequest(
        HttpClientRequest.prependUrl(config.serviceEndpoint),
      ),
      HttpClient.mapRequest(
        HttpClientRequest.setHeader("content-type", "text/event-stream"),
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

          return yield* HttpClientRequest.post(
            `/v1/${model}:streamGenerateContent?alt=sse`,
          ).pipe(
            HttpClientRequest.setHeader("Authorization", `Bearer ${apiKey}`),
            HttpClientRequest.schemaBody(RequestBody)({
              contents: contentsFromEvents(params.events),
              tools: params.tools ? gatherTools(params.tools) : undefined,
              toolConfig: params.toolCall
                ? getToolChoice(params.toolCall)
                : undefined,
              systemInstruction: params.system
                ? {
                    role: "user",
                    parts: [{ _tag: "Text", text: params.system }],
                  }
                : undefined,
            }),
            Effect.flatMap(client),
            Effect.map(streamSSE),
          );
        }).pipe(
          Stream.unwrap,
          filterParsedEvents,
          Stream.filterMap((e) => decodeEvent(e.data)),
          Stream.filterMap((resp) =>
            Option.fromNullable(resp.candidates.at(0)?.content.parts),
          ),
          Stream.mapConcat(
            Array.filterMap(
              Match.type<Part>().pipe(
                Match.tags({
                  Text: (part) =>
                    Option.some(
                      StreamEventEnum.Content({ content: part.text }),
                    ),
                  FunctionCall: (part) =>
                    Option.some(
                      StreamEventEnum.ToolCall({
                        id: crypto.randomUUID(),
                        name: part.functionCall.name,
                        arguments: JSON.stringify(part.functionCall.args),
                      }),
                    ),
                }),
                Match.orElse(Function.constant(Option.none())),
              ),
            ),
          ),
        );
      },
    };
  });

const gatherTools = (tools: Readonly<ToolDefinitionAny[]>) => {
  const removeUnknownProperties = (value: unknown) => {
    if (typeof value === "object" && value != null) {
      Reflect.deleteProperty(value, "$schema");
      Reflect.deleteProperty(value, "additionalProperties");

      for (const val of Object.values(value)) {
        removeUnknownProperties(val);
      }
    }

    if (Array.isArray(value)) {
      value.forEach(removeUnknownProperties);
    }
  };

  return tools.map((tool) => {
    const schema = S.isSchema(tool.input)
      ? JSONSchema.make(tool.input)
      : tool.input;
    removeUnknownProperties(schema);

    return {
      functionDeclarations: [
        {
          name: tool.name,
          description: tool.description,
          parameters: schema,
        },
      ],
    };
  });
};

enum FunctionCallingMode {
  Unspecified,
  Auto,
  Any,
  None,
}

const RequestBody = S.Struct({
  contents: S.Array(Content),
  tools: S.Array(
    S.Struct({
      functionDeclarations: S.Array(
        S.Struct({
          name: S.String,
          description: S.String.pipe(S.optional),
          parameters: S.Unknown,
        }),
      ),
    }),
  ).pipe(S.optional),
  toolConfig: S.Struct({
    functionCallingConfig: S.Struct({
      mode: S.Enums(FunctionCallingMode),
      allowedFunctionNames: S.Array(S.String).pipe(S.optional),
    }),
  }).pipe(S.optional),
  systemInstruction: Content.pipe(S.optional),
});

const getToolChoice = (
  toolCall: ToolCallOption<Readonly<ToolDefinitionAny[]>>,
) => {
  if (typeof toolCall === "object" && "name" in toolCall) {
    return {
      functionCallingConfig: {
        mode: FunctionCallingMode.Any,
        allowedFunctionNames: [toolCall.name],
      },
    };
  }

  switch (toolCall) {
    case "auto":
      return {
        functionCallingConfig: {
          mode: FunctionCallingMode.Auto,
        },
      };
    case "required":
      return {
        functionCallingConfig: {
          mode: FunctionCallingMode.Any,
        },
      };
    case "none":
      return {
        functionCallingConfig: {
          mode: FunctionCallingMode.None,
        },
      };
  }
};

const partsFromChunks = (chunks: ContentChunk[]) =>
  chunks.map<Part>(
    Match.typeTags<ContentChunk>()({
      TextChunk: (chunk) =>
        ({
          _tag: "Text",
          text: chunk.content,
        }) satisfies TextPart,

      ImageChunk: (chunk) =>
        ({
          _tag: "Blob",
          mimeType: chunk.mimeType,
          data: chunk.content,
        }) satisfies BlobPart,
    }),
  );

const contentsFromEvents = pipe(
  Array.reduce<Content[], ThreadEvent>([], (contents, event) =>
    Match.type<ThreadEvent>().pipe(
      Match.tags({
        UserMessage: (message) =>
          contents.concat({
            role: "user",
            parts: partsFromChunks(message.content),
          }),
        AssistantMessage: (message) =>
          contents.concat({
            role: "model",
            parts: [{ _tag: "Text", text: message.content }],
          }),
        ToolUseEvent: (event) =>
          contents.concat({
            role: "model",
            parts: [
              {
                _tag: "FunctionCall",
                functionCall: {
                  name: event.name,
                  args: event.input,
                },
              },
            ],
          }),
        ToolResultSuccessEvent: (event) =>
          contents.concat({
            role: "user",
            parts: [
              {
                _tag: "FunctionResponse",
                functionResponse: {
                  name: event.name,
                  response: event.result,
                },
              },
            ],
          }),
        ToolResultErrorEvent: (event) =>
          contents.concat({
            role: "user",
            parts: [
              {
                _tag: "FunctionResponse",
                functionResponse: {
                  name: event.name,
                  response: event.result,
                },
              },
            ],
          }),
      }),
      Match.orElse(() => contents),
    )(event),
  ),
);
