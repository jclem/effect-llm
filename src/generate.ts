import type { HttpBodyError } from "@effect/platform/HttpBody";
import type {
  HttpClientError,
  ResponseError,
} from "@effect/platform/HttpClientError";
import { Schema } from "@effect/schema";
import type { ParseError } from "@effect/schema/ParseResult";
import {
  Array,
  Context,
  Data,
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
  ToolResultErrorEvent,
  ToolResultSuccessEvent,
  ToolUseEvent,
  type AssistantMessage,
  type ThreadEvent,
} from "./thread";

export interface StreamParams {
  readonly apiKey: Redacted.Redacted<string>;
  readonly model: string;
  readonly system?: string | undefined;
  readonly events: readonly ThreadEvent[];
  readonly maxTokens?: number | undefined;
  readonly functions?:
    | Readonly<NonEmptyArray<FunctionDefinition<any, any, any, any, any, any>>>
    | undefined;
}

export type FunctionReturn<RS, RE> = Data.TaggedEnum<{
  Success: { readonly result: RS };
  Error: { readonly result: RE };
}>;

interface FunctionReturnDefinition extends Data.TaggedEnum.WithGenerics<2> {
  readonly taggedEnum: FunctionReturn<this["A"], this["B"]>;
}

export const FunctionReturn = Data.taggedEnum<FunctionReturnDefinition>();

export interface FunctionDefinition<
  Name extends string,
  SA,
  A extends FunctionReturn<any, any>,
  E,
  R,
  SI = SA,
  SR = SI,
> {
  readonly name: Name;
  readonly description?: string | undefined;
  readonly input: Schema.Schema<SA, SI, SR>;
  readonly function: (id: string, input: SA) => Effect.Effect<A, E, R>;
}

export function defineFunction<
  Name extends string,
  SA,
  A extends FunctionReturn<any, any>,
  E,
  R,
  SI = SA,
  SR = SI,
>(
  name: Name,
  definition: Omit<FunctionDefinition<Name, SA, A, E, R, SI, SR>, "name">,
): FunctionDefinition<Name, SA, A, E, R, SI, SR> {
  return { ...definition, name };
}

export type StreamEvent = Data.TaggedEnum<{
  ContentStart: { readonly content: string };
  Content: { readonly content: string };
  Message: { readonly message: AssistantMessage };
  InvalidFunctionCall: {
    readonly id: string;
    readonly name: string;
    readonly arguments: string;
  };
  FunctionCallStart: { readonly id: string; readonly name: string };
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

export type FunctionResult<RS, RE> = Data.TaggedEnum<{
  FunctionResultSuccess: { readonly id: string; readonly result: RS };
  FunctionResultError: { readonly id: string; readonly result: RE };
}>;

interface FunctionResultDefinition extends Data.TaggedEnum.WithGenerics<2> {
  readonly taggedEnum: FunctionResult<this["A"], this["B"]>;
}

export const FunctionResult = Data.taggedEnum<FunctionResultDefinition>();

class InvalidFunctionCallError extends Data.TaggedError(
  "InvalidFunctionCallError",
)<{
  readonly functionCall: Extract<StreamEvent, { _tag: "FunctionCall" }>;
  readonly error: ParseError;
}> {}

export function streamTools(
  params: StreamParams,
): Stream.Stream<
  StreamEvent | FunctionResult<unknown, unknown>,
  HttpClientError | HttpBodyError | UnknownException,
  Scope.Scope
> {
  return Stream.asyncEffect<
    StreamEvent | FunctionResult<unknown, unknown>,
    HttpClientError | HttpBodyError | UnknownException,
    Scope.Scope
  >((emit) =>
    Effect.gen(function* () {
      const gen = yield* Generation;

      const single = (event: StreamEvent | FunctionResult<unknown, unknown>) =>
        Effect.promise(() => emit.single(event));
      const end = () => Effect.promise(() => emit.end());
      const fail = (
        error: HttpClientError | HttpBodyError | UnknownException,
      ) => Effect.promise(() => emit.fail(error));

      const fnCalls: {
        id: string;
        name: string;
        args: string;
        input: unknown;
        fnDefn: FunctionDefinition<any, any, any, any, any, any, any>;
      }[] = [];

      return yield* gen.stream(params).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (event._tag === "FunctionCall") {
              const fnDefn = Array.findFirst(
                params.functions ?? [],
                (f) => f.name === event.name,
              ).pipe(
                Option.getOrThrowWith(() => new Error("No function found")),
              );

              const input = yield* Schema.decodeUnknown(
                Schema.parseJson(fnDefn.input),
              )(event.arguments).pipe(
                Effect.catchTag("ParseError", (err) =>
                  Effect.fail(
                    new InvalidFunctionCallError({
                      functionCall: event,
                      error: err,
                    }),
                  ),
                ),
              );

              fnCalls.push({
                id: event.id,
                name: event.name,
                args: event.arguments,
                input,
                fnDefn,
              });
            }

            yield* single(event);
          }),
        ),
        Effect.catchTag("InvalidFunctionCallError", (error) =>
          Effect.gen(function* () {
            yield* single(
              StreamEvent.InvalidFunctionCall({
                id: error.functionCall.id,
                name: error.functionCall.name,
                arguments: error.functionCall.arguments,
              }),
            );

            // NOTE: This could result in a parse error, but only if the model returns invalid JSON.
            const input = Schema.decodeUnknown(Schema.parseJson())(
              error.functionCall.arguments,
            );

            const failedToolCall = new ToolUseEvent({
              id: error.functionCall.id,
              name: error.functionCall.name,
              input,
            });

            const failedToolResult = new ToolResultErrorEvent({
              id: error.functionCall.id,
              result: error.error.message,
            });

            yield* streamTools({
              ...params,
              events: [...params.events, failedToolCall, failedToolResult],
            }).pipe(Stream.runForEach((e) => single(e)));
          }),
        ),
        Effect.andThen(() =>
          Effect.gen(function* () {
            if (fnCalls.length === 0) {
              return yield* end();
            }

            const newEvents: ThreadEvent[] = [];

            for (const fnCall of fnCalls) {
              const toolCallEvent = new ToolUseEvent({
                id: fnCall.id,
                name: fnCall.name,
                input: fnCall.input,
              });

              const output = yield* fnCall.fnDefn.function(
                fnCall.id,
                fnCall.input,
              );

              newEvents.push(toolCallEvent);

              yield* Match.type<FunctionReturn<unknown, unknown>>().pipe(
                Match.tags({
                  Success: () =>
                    Effect.gen(function* () {
                      yield* single(
                        FunctionResult.FunctionResultSuccess({
                          id: fnCall.id,
                          result: output.result,
                        }),
                      );

                      newEvents.push(
                        new ToolResultSuccessEvent({
                          id: fnCall.id,
                          result: output.result,
                        }),
                      );
                    }),
                  Error: () =>
                    Effect.gen(function* () {
                      yield* single(
                        FunctionResult.FunctionResultError({
                          id: fnCall.id,
                          result: output.result,
                        }),
                      );

                      newEvents.push(
                        new ToolResultErrorEvent({
                          id: fnCall.id,
                          result: output.result,
                        }),
                      );
                    }),
                }),
                Match.exhaustive,
              )(output);
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
      );
    }),
  );
}
