import type { HttpBodyError } from "@effect/platform/HttpBody";
import type {
  HttpClientError,
  ResponseError,
} from "@effect/platform/HttpClientError";
import { Schema } from "@effect/schema";
import {
  Array,
  Context,
  Data,
  Effect,
  Option,
  Stream,
  type Scope,
} from "effect";
import type { NonEmptyArray } from "effect/Array";
import type { UnknownException } from "effect/Cause";
import {
  ToolResultSuccessEvent,
  ToolUseEvent,
  type AssistantMessage,
  type ThreadEvent,
} from "./thread";

export interface StreamParams {
  readonly model: string;
  readonly system?: string | undefined;
  readonly events: readonly ThreadEvent[];
  readonly maxTokens?: number | undefined;
  readonly functions?:
    | Readonly<NonEmptyArray<FunctionDefinition<any, any, any, any, any, any>>>
    | undefined;
}

export type FunctionResult<RS, RE> = Data.TaggedEnum<{
  FunctionResultSuccess: { readonly id: string; readonly result: RS };
  FunctionResultError: { readonly id: string; readonly result: RE };
}>;

interface FunctionResultDefinition extends Data.TaggedEnum.WithGenerics<2> {
  readonly taggedEnum: FunctionResult<this["A"], this["B"]>;
}

export const FunctionResult = Data.taggedEnum<FunctionResultDefinition>();

export interface FunctionDefinition<
  Name extends string,
  SA,
  E = never,
  R = never,
  SI = SA,
  SR = SI,
> {
  readonly name: Name;
  readonly description?: string | undefined;
  readonly input: Schema.Schema<SA, SI, SR>;
  readonly function: (
    input: SA,
  ) => Effect.Effect<FunctionResult<unknown, unknown>, E, R>;
}

export function defineFunction<
  Name extends string,
  SA,
  E = never,
  R = never,
  SI = SA,
  SR = SI,
>(
  name: Name,
  definition: Omit<FunctionDefinition<Name, SA, E, R, SI, SR>, "name">,
): FunctionDefinition<Name, SA, E, R, SI, SR> {
  return { ...definition, name };
}

export type StreamEvent = Data.TaggedEnum<{
  Content: { readonly content: string };
  Message: { readonly message: AssistantMessage };
  FunctionCall: {
    readonly id: string;
    readonly name: string;
    readonly arguments: string;
  };
}>;
export const StreamEvent = Data.taggedEnum<StreamEvent>();

export interface Provider {
  readonly stream: (
    params: StreamParams,
  ) => Stream.Stream<
    StreamEvent,
    HttpClientError | ResponseError | HttpBodyError | UnknownException,
    Scope.Scope
  >;
}

export class Generation extends Context.Tag("Generation")<
  Generation,
  Provider
>() {}

export function streamTools(
  params: StreamParams,
): Stream.Stream<
  StreamEvent | FunctionResult<unknown, unknown>,
  HttpClientError | HttpBodyError | UnknownException,
  Scope.Scope
> {
  const fnCalls: Extract<StreamEvent, { _tag: "FunctionCall" }>[] = [];

  return Stream.asyncEffect<
    StreamEvent | FunctionResult<unknown, unknown>,
    HttpClientError | HttpBodyError | UnknownException,
    Scope.Scope
  >((emit) => {
    const single = (event: StreamEvent | FunctionResult<unknown, unknown>) =>
      Effect.promise(() => emit.single(event));
    const end = () => Effect.promise(() => emit.end());
    const fail = (error: HttpClientError | HttpBodyError | UnknownException) =>
      Effect.promise(() => emit.fail(error));

    return Generation.pipe(
      Effect.flatMap((gen) =>
        gen.stream(params).pipe(
          Stream.runForEach((event) => {
            if (event._tag === "FunctionCall") {
              fnCalls.push(event);
            }

            return single(event);
          }),
          Effect.andThen(() =>
            Effect.gen(function* () {
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

                yield* single(output);

                const toolResultEvent = new ToolResultSuccessEvent({
                  id: fnCall.id,
                  result: output.result,
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

              yield* streamTools(newParams).pipe(
                Stream.runForEach((e) => single(e)),
              );
            }),
          ),
          Effect.catchAll((err) => fail(err)),
          Effect.andThen(() => end()),
          Effect.fork,
        ),
      ),
    );
  });
}
