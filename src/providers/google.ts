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
import type { ThreadEvent } from "../thread.js";
import { MissingParameterError, type DefaultParams } from "./index.js";

interface GoogleProviderConfig {
  serviceEndpoint: string;
}

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

const Part = S.Union(TextPart, FunctionCallPart, FunctionResponsePart);

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

export const make = (
  config: GoogleProviderConfig,
  defaultParams: DefaultParams = {},
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
        params = { ...defaultParams, ...params };

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
            Effect.flatMap(streamSSE),
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
    const schema = JSONSchema.make(tool.input);
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

const contentsFromEvents = pipe(
  Array.reduce<Content[], ThreadEvent>([], (contents, event) =>
    Match.type<ThreadEvent>().pipe(
      Match.tags({
        UserMessage: (message) =>
          contents.concat({
            role: "user",
            parts: [{ _tag: "Text", text: message.content }],
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
