/* eslint-disable @typescript-eslint/no-explicit-any */

import type { HttpBodyError } from "@effect/platform/HttpBody";
import type { HttpClientError } from "@effect/platform/HttpClientError";
import { Schema as S } from "@effect/schema";
import type { ParseError } from "@effect/schema/ParseResult";
import type { Redacted } from "effect";
import {
  Array,
  Context,
  Data,
  Effect,
  Either,
  Match,
  Option,
  pipe,
  Stream,
  type Scope,
} from "effect";
import { UnknownException } from "effect/Cause";
import type { TaggedEnum } from "effect/Data";
import { dual } from "effect/Function";
import {
  ToolResultErrorEvent,
  ToolResultSuccessEvent,
  ToolUseEvent,
  type AssistantMessage,
  type ThreadEvent,
} from "./thread.js";

/** Parameters used to configure an LLM stream generation call. */
export interface StreamParams<
  FnDefns extends Readonly<FunctionDefinitionAny[]>,
> {
  readonly apiKey: Redacted.Redacted;
  readonly model: string;
  readonly system?: string | undefined;
  readonly events: readonly ThreadEvent[];
  readonly maxIterations?: number | undefined;
  readonly maxTokens?: number | undefined;
  readonly functions?: FnDefns | undefined;
}

/**
 * An error reported back to the agent as an error during function execution.
 *
 * Any other error that occurs during function execution will be a runtime error
 * and will halt the generation process.
 */
export class FunctionError<E> extends Data.TaggedError("FunctionError")<{
  readonly payload: E;
}> {}

/**
 * Wrap an error in a FunctionError and fail the effect with it.
 *
 * @param payload The error to wrap in a FunctionError
 * @returns A new FunctionError
 */
export const functionError = <P>(payload: P) =>
  Effect.fail(new FunctionError({ payload }));

/**
 * A function definition that can be used in a stream generation call.
 */
export interface FunctionDefinition<
  Name extends string,
  A,
  E,
  R,
  SA,
  SI = SA,
  SR = never,
> {
  readonly name: Name;
  readonly description?: string | undefined;
  readonly input: S.Schema<SA, SI, SR>;
  readonly function: (id: string, input: SA) => Effect.Effect<A, E, R>;
}

/**
 * A utility type for an any-typed function definition.
 */
export type FunctionDefinitionAny = FunctionDefinition<
  string,
  any,
  any,
  any,
  any,
  any,
  any
>;

type FunctionDefinitionError<F extends FunctionDefinitionAny> =
  F extends FunctionDefinition<string, any, infer _E, any, any, any, any>
    ? _E
    : never;

type FunctionDefinitionContext<F extends FunctionDefinitionAny> =
  F extends FunctionDefinition<string, any, any, infer _C, any, any, infer _SC>
    ? _C | _SC
    : never;

/**
 * Define a function by providing its name, implementation, and other details.
 *
 * @param name The name of the function
 * @param definition The function definition
 * @returns A new function definition
 */
export function defineFunction<
  Name extends string,
  A,
  E,
  R,
  SA,
  SI = SA,
  SR = never,
>(
  name: Name,
  definition: Omit<FunctionDefinition<Name, A, E, R, SA, SI, SR>, "name">,
): FunctionDefinition<Name, A, E, R, SA, SI, SR> {
  return { ...definition, name };
}

/**
 * An event emitted during a stream generation call.
 */
export type StreamEvent = Data.TaggedEnum<{
  ContentStart: { readonly content: string };
  Content: { readonly content: string };
  Message: { readonly message: AssistantMessage };
  FunctionCallStart: { readonly id: string; readonly name: string };
  FunctionCall: {
    readonly id: string;
    readonly name: string;
    readonly arguments: string;
  };
  InvalidFunctionCall: {
    readonly id: string;
    readonly name: string;
    readonly arguments: string;
  };
}>;
export const StreamEventEnum = Data.taggedEnum<StreamEvent>();

/**
 * An interface which provides the low-level stream from some LLM provider.
 */
export interface Provider {
  readonly stream: (
    params: StreamParams<any>,
  ) => Stream.Stream<
    StreamEvent,
    HttpClientError | HttpBodyError | UnknownException,
    Scope.Scope
  >;
}

/**
 * A tag for the generation context.
 */
export class Generation extends Context.Tag("Generation")<
  Generation,
  Provider
>() {}

/**
 * The result of a function call.
 */
export type FunctionResult<RS, RE> = Data.TaggedEnum<{
  FunctionResultSuccess: {
    readonly id: string;
    readonly name: string;
    readonly result: RS;
  };
  FunctionResultError: {
    readonly id: string;
    readonly name: string;
    readonly result: RE;
  };
}>;

interface FunctionResultDefinition extends Data.TaggedEnum.WithGenerics<2> {
  readonly taggedEnum: FunctionResult<this["A"], this["B"]>;
}

/**
 * The result of a function call.
 */
export const FunctionResultEnum = Data.taggedEnum<FunctionResultDefinition>();

/**
 * An error that occurs when a function call is invalid.
 */
export class InvalidFunctionCallError extends Data.TaggedError(
  "InvalidFunctionCallError",
)<{
  readonly functionCall: TaggedEnum.Value<StreamEvent, "FunctionCall">;
  readonly error: ParseError;
}> {
  message = this.error.message;
}

/**
 * An error that occurs when an LLM attempts to call an unknown function.
 */
export class UnknownFunctionCallError extends Data.TaggedError(
  "UnknownFunctionCallError",
)<{
  readonly functionCall: TaggedEnum.Value<StreamEvent, "FunctionCall">;
}> {
  message = `Unknown function call: ${this.functionCall.name}`;
}

/**
 * An error that occurs when a function fails to execute.
 */
export class FunctionExecutionError<R> extends Data.TaggedError(
  "FunctionExecutionError",
)<{
  readonly id: string;
  readonly error: R;
}> {}

/**
 * Generate a stream of events from the LLM provider.
 *
 * @param provider The provider to generate the stream from
 * @param params The parameters to configure the stream generation call
 * @returns A stream of events from the LLM provider
 */
export const stream: {
  <F extends Readonly<FunctionDefinitionAny[]>>(
    params: StreamParams<F>,
  ): (
    provider: Provider,
  ) => Stream.Stream<
    StreamEvent | FunctionResult<unknown, unknown>,
    | ParseError
    | HttpClientError
    | HttpBodyError
    | UnknownException
    | FunctionExecutionError<unknown>
    | FunctionDefinitionError<F[number]>,
    Generation | Scope.Scope | FunctionDefinitionContext<F[number]>
  >;
  <F extends Readonly<FunctionDefinitionAny[]>>(
    provider: Provider,
    params: StreamParams<F>,
  ): Stream.Stream<
    StreamEvent,
    HttpClientError | HttpBodyError | UnknownException,
    Scope.Scope
  >;
} = dual(
  2,
  <F extends Readonly<FunctionDefinitionAny[]>>(
    provider: Provider,
    params: StreamParams<F>,
  ) => provider.stream(params),
);

/**
 * Generate a stream of events from the LLM provider, invoking the defined
 * functions as needed and returning the results to the LLM.
 *
 * This will loop until the maxIterations is reached, or until the stream
 * completes with no more function calls.
 *
 * @param provider The provider to generate the stream from
 * @param params The parameters to configure the stream generation call
 * @returns A stream of events from the LLM provider
 */
export const streamTools: {
  <FnDefns extends Readonly<FunctionDefinitionAny[]>>(
    params: StreamParams<FnDefns>,
  ): (
    provider: Provider,
  ) => Stream.Stream<
    StreamEvent | FunctionResult<unknown, unknown>,
    | ParseError
    | HttpClientError
    | HttpBodyError
    | UnknownException
    | FunctionExecutionError<unknown>
    | FunctionDefinitionError<FnDefns[number]>,
    Generation | Scope.Scope | FunctionDefinitionContext<FnDefns[number]>
  >;
  <FnDefns extends Readonly<FunctionDefinitionAny[]>>(
    provider: Provider,
    params: StreamParams<FnDefns>,
  ): Stream.Stream<
    StreamEvent | FunctionResult<unknown, unknown>,
    | ParseError
    | HttpClientError
    | HttpBodyError
    | UnknownException
    | FunctionExecutionError<unknown>
    | FunctionDefinitionError<FnDefns[number]>,
    Generation | Scope.Scope | FunctionDefinitionContext<FnDefns[number]>
  >;
} = dual(
  2,
  <FnDefns extends Readonly<FunctionDefinitionAny[]>>(
    provider: Provider,
    params: StreamParams<FnDefns>,
  ) => {
    return Stream.asyncEffect<
      StreamEvent | FunctionResult<unknown, unknown>,
      | ParseError
      | HttpClientError
      | HttpBodyError
      | UnknownException
      | FunctionExecutionError<unknown>
      | FunctionDefinitionError<FnDefns[number]>,
      Generation | Scope.Scope | FunctionDefinitionContext<FnDefns[number]>
    >(
      (emit) =>
        Effect.gen(function* () {
          if (params.maxIterations === 0) {
            yield* Effect.log("Max iterations reached");
            return;
          }

          const single = (
            event: StreamEvent | FunctionResult<unknown, unknown>,
          ) => Effect.promise(() => emit.single(event));

          const end = () => Effect.promise(() => emit.end());

          const fail = (
            error:
              | ParseError
              | HttpClientError
              | HttpBodyError
              | UnknownException
              | FunctionExecutionError<unknown>
              | FunctionDefinitionError<FnDefns[number]>,
          ) => Effect.promise(() => emit.fail(error));

          const fnCalls: {
            id: string;
            name: string;
            args: string;
            input: unknown;
            fnDefn: FnDefns[number];
          }[] = [];

          // On each event, we first check to see if it's a function call and record
          // it. Then, we emit the event.
          const onStreamEvent = (event: StreamEvent) =>
            pipe(
              event,
              Match.type<StreamEvent>().pipe(
                Match.tag("FunctionCall", (functionCall) =>
                  Effect.gen(function* () {
                    const fnFound = Array.findFirst(
                      params.functions ?? [],
                      (fn) => fn.name === functionCall.name,
                    );

                    if (Option.isNone(fnFound)) {
                      return yield* Effect.fail(
                        new UnknownFunctionCallError({ functionCall }),
                      );
                    }

                    const input: unknown = yield* S.decodeUnknown(
                      S.parseJson(fnFound.value.input),
                    )(functionCall.arguments).pipe(
                      Effect.catchTag("ParseError", (error) =>
                        Effect.fail(
                          new InvalidFunctionCallError({ functionCall, error }),
                        ),
                      ),
                    );

                    fnCalls.push({
                      id: functionCall.id,
                      name: functionCall.name,
                      args: functionCall.arguments,
                      input,
                      fnDefn: fnFound.value,
                    });

                    return event;
                  }),
                ),
                Match.orElse((event) => Effect.succeed(event)),
              ),
              Effect.flatMap(single),
            );

          const onInvalidFunctionCall = (
            error: InvalidFunctionCallError | UnknownFunctionCallError,
          ) =>
            Effect.gen(function* () {
              yield* single(
                StreamEventEnum.InvalidFunctionCall({
                  id: error.functionCall.id,
                  name: error.functionCall.name,
                  arguments: error.functionCall.arguments,
                }),
              );

              const input = yield* S.decodeUnknown(S.parseJson())(
                error.functionCall.arguments,
              );

              const failedToolCall = new ToolUseEvent({
                id: error.functionCall.id,
                name: error.functionCall.name,
                input,
              });

              const failedToolResult = new ToolResultErrorEvent({
                id: error.functionCall.id,
                result: error.message,
              });

              yield* streamTools(provider, {
                ...params,
                events: [...params.events, failedToolCall, failedToolResult],
                maxIterations:
                  params.maxIterations == null
                    ? params.maxIterations
                    : params.maxIterations - 1,
              }).pipe(Stream.runForEach((event) => single(event)));
            });

          const handleFunctionCalls = Effect.gen(function* () {
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

              const output: Either.Either<
                any,
                FunctionError<any>
              > = yield* fnCall.fnDefn.function(fnCall.id, fnCall.input).pipe(
                Effect.map(Either.right),
                Effect.catchTag("FunctionError", (err) =>
                  Effect.succeed(Either.left(err)),
                ),
                Effect.catchAll((error: unknown) =>
                  Effect.fail(
                    new FunctionExecutionError({ id: fnCall.id, error }),
                  ),
                ),
              );

              newEvents.push(toolCallEvent);

              if (Either.isRight(output)) {
                yield* single(
                  FunctionResultEnum.FunctionResultSuccess({
                    id: fnCall.id,
                    name: fnCall.name,
                    result: output.right as unknown,
                  }),
                );

                newEvents.push(
                  new ToolResultSuccessEvent({
                    id: fnCall.id,
                    result: output.right as unknown,
                  }),
                );
              } else if (Either.isLeft(output)) {
                yield* single(
                  FunctionResultEnum.FunctionResultError({
                    id: fnCall.id,
                    name: fnCall.name,
                    result: output.left.payload as unknown,
                  }),
                );

                newEvents.push(
                  new ToolResultErrorEvent({
                    id: fnCall.id,
                    result: output.left.payload as unknown,
                  }),
                );
              }
            }

            if (newEvents.length === 0) {
              return;
            }

            const newParams = {
              ...params,
              events: [...params.events, ...newEvents],
              maxIterations:
                params.maxIterations == null
                  ? params.maxIterations
                  : params.maxIterations - 1,
            };

            yield* streamTools(provider, newParams).pipe(
              Stream.runForEach((e) => single(e)),
            );
          });

          yield* provider.stream(params).pipe(
            Stream.runForEach(onStreamEvent),
            Effect.catchIf(
              (err): err is InvalidFunctionCallError =>
                err instanceof InvalidFunctionCallError,
              (error) => onInvalidFunctionCall(error),
            ),
            Effect.catchIf(
              (err): err is UnknownFunctionCallError =>
                err instanceof UnknownFunctionCallError,
              (error) => onInvalidFunctionCall(error),
            ),
            Effect.andThen(() => handleFunctionCalls),
            Effect.catchAll((error) => fail(error)),
            Effect.catchAllDefect((defect) =>
              fail(new UnknownException(defect)),
            ),
            Effect.andThen(() => end()),
            Effect.forkScoped,
          );
        }) as Effect.Effect<
          void,
          | ParseError
          | HttpClientError
          | HttpBodyError
          | UnknownException
          | FunctionExecutionError<unknown>
          | FunctionDefinitionError<FnDefns[number]>,
          Generation | Scope.Scope | FunctionDefinitionContext<FnDefns[number]>
        >,
    );
  },
);
