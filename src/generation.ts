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
export interface StreamParams<FnDefns extends Readonly<ToolDefinitionAny[]>> {
  readonly apiKey: Redacted.Redacted;
  readonly model: string;
  readonly system?: string | undefined;
  readonly events: readonly ThreadEvent[];
  readonly maxIterations?: number | undefined;
  readonly maxTokens?: number | undefined;
  readonly tools?: FnDefns | undefined;
  readonly toolCall?: ToolCallOption<FnDefns>;
  readonly additionalParameters?: Record<string, unknown> | undefined;
}

export type ToolCallOption<FnDefns extends Readonly<ToolDefinitionAny[]>> =
  | "auto"
  | "required"
  | { name: FnDefns[number]["name"] }
  | "none";

/**
 * An error reported back to the agent as an error during tool execution.
 *
 * Any other error that occurs during tool execution will be a runtime error and
 * will halt the generation process.
 */
export class ToolError<E> extends Data.TaggedError("ToolError")<{
  readonly payload: E;
}> {}

/**
 * Wrap an error in a ToolError and fail the effect with it.
 *
 * @param payload The error to wrap in a ToolError
 * @returns A new ToolError
 */
export const toolError = <P>(payload: P) =>
  Effect.fail(new ToolError({ payload }));

class HaltToolLoopError extends Data.TaggedError("HaltToolLoopError") {}

/**
 * Halt the tool loop immediately after the current tool call.
 */
export const haltToolLoop = () => Effect.fail(new HaltToolLoopError());

/**
 * A tool definition that can be used in a stream generation call.
 */
export interface ToolDefinition<
  Name extends string,
  A,
  E,
  R,
  SA,
  SI = SA,
  SR = never,
> {
  /** The name of the tool, given to the model */
  readonly name: Name;
  /** A description of the tool, given to the model */
  readonly description?: string | undefined;
  /** A schema defining the tool's inputs */
  readonly input: S.Schema<SA, SI, SR>;
  /** A function receiving the tool call ID and returning an effect that runs the tool */
  readonly effect: (
    id: string,
    input: SA,
  ) => Effect.Effect<A, E | HaltToolLoopError, R>;
}

/**
 * A utility type for an any-typed tool definition.
 */
export type ToolDefinitionAny = ToolDefinition<
  string,
  any,
  any,
  any,
  any,
  any,
  any
>;

type ToolDefinitionError<F extends ToolDefinitionAny> =
  F extends ToolDefinition<string, any, infer _E, any, any, any, any>
    ? _E
    : never;

type ToolDefinitionContext<F extends ToolDefinitionAny> =
  F extends ToolDefinition<string, any, any, infer _C, any, any, infer _SC>
    ? _C | _SC
    : never;

/**
 * Define a tool by providing its name, implementation, and other details.
 *
 * @param name The name of the tool
 * @param definition The tool definition
 * @returns A new tool definition
 */
export function defineTool<
  Name extends string,
  A,
  E,
  R,
  SA,
  SI = SA,
  SR = never,
>(
  name: Name,
  definition: Omit<ToolDefinition<Name, A, E, R, SA, SI, SR>, "name">,
): ToolDefinition<Name, A, E, R, SA, SI, SR> {
  return { ...definition, name };
}

/**
 * An event emitted during a stream generation call.
 */
export type StreamEvent = Data.TaggedEnum<{
  ContentStart: { readonly content: string };
  Content: { readonly content: string };
  Message: { readonly message: AssistantMessage };
  ToolCallStart: { readonly id: string; readonly name: string };
  ToolCall: {
    readonly id: string;
    readonly name: string;
    readonly arguments: string;
  };
  InvalidToolCall: {
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
 * The result of a tool call.
 */
export type ToolResult<RS, RE> = Data.TaggedEnum<{
  ToolResultSuccess: {
    readonly id: string;
    readonly name: string;
    readonly result: RS;
  };
  ToolResultError: {
    readonly id: string;
    readonly name: string;
    readonly result: RE;
  };
}>;

interface ToolResultDefinition extends Data.TaggedEnum.WithGenerics<2> {
  readonly taggedEnum: ToolResult<this["A"], this["B"]>;
}

/**
 * The result of a tool call.
 */
export const ToolResultEnum = Data.taggedEnum<ToolResultDefinition>();

/**
 * An error that occurs when a tool call is invalid.
 */
export class InvalidToolCallError extends Data.TaggedError(
  "InvalidToolCallError",
)<{
  readonly toolCall: TaggedEnum.Value<StreamEvent, "ToolCall">;
  readonly error: ParseError;
}> {
  message = this.error.message;
}

/**
 * An error that occurs when an LLM attempts to call an unknown tool.
 */
export class UnknownToolCallError extends Data.TaggedError(
  "UnknownToolCallError",
)<{
  readonly toolCall: TaggedEnum.Value<StreamEvent, "ToolCall">;
}> {
  message = `Unknown tool call: ${this.toolCall.name}`;
}

/**
 * An error that occurs when a tool fails to execute.
 */
export class ToolExecutionError<R> extends Data.TaggedError(
  "ToolExecutionError",
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
  <F extends Readonly<ToolDefinitionAny[]>>(
    params: StreamParams<F>,
  ): (
    provider: Provider,
  ) => Stream.Stream<
    StreamEvent,
    | ParseError
    | HttpClientError
    | HttpBodyError
    | UnknownException
    | ToolExecutionError<unknown>
    | ToolDefinitionError<F[number]>,
    Generation | Scope.Scope | ToolDefinitionContext<F[number]>
  >;
  <F extends Readonly<ToolDefinitionAny[]>>(
    provider: Provider,
    params: StreamParams<F>,
  ): Stream.Stream<
    StreamEvent,
    HttpClientError | HttpBodyError | UnknownException,
    Scope.Scope
  >;
} = dual(
  2,
  <F extends Readonly<ToolDefinitionAny[]>>(
    provider: Provider,
    params: StreamParams<F>,
  ) => provider.stream(params),
);

/**
 * An event emitted during a stream using tool calls.
 */
export type StreamToolsEvent = StreamEvent | ToolResult<unknown, unknown>;

export class MaxIterationsError extends Data.TaggedError(
  "MaxIterationsError",
) {}

/**
 * Generate a stream of events from the LLM provider, invoking the defined tools
 * as needed and returning the results to the LLM.
 *
 * This will loop until the maxIterations is reached, or until the stream
 * completes with no more tool calls.
 *
 * @param provider The provider to generate the stream from
 * @param params The parameters to configure the stream generation call
 * @returns A stream of events from the LLM provider
 */
export const streamTools: {
  <FnDefns extends Readonly<ToolDefinitionAny[]>>(
    params: StreamParams<FnDefns>,
  ): (
    provider: Provider,
  ) => Stream.Stream<
    StreamToolsEvent,
    | MaxIterationsError
    | ParseError
    | HttpClientError
    | HttpBodyError
    | UnknownException
    | ToolExecutionError<unknown>
    | ToolDefinitionError<FnDefns[number]>,
    Scope.Scope | ToolDefinitionContext<FnDefns[number]>
  >;
  <FnDefns extends Readonly<ToolDefinitionAny[]>>(
    provider: Provider,
    params: StreamParams<FnDefns>,
  ): Stream.Stream<
    StreamToolsEvent,
    | MaxIterationsError
    | ParseError
    | HttpClientError
    | HttpBodyError
    | UnknownException
    | ToolExecutionError<unknown>
    | ToolDefinitionError<FnDefns[number]>,
    Scope.Scope | ToolDefinitionContext<FnDefns[number]>
  >;
} = dual(
  2,
  <FnDefns extends Readonly<ToolDefinitionAny[]>>(
    provider: Provider,
    params: StreamParams<FnDefns>,
  ) => {
    return Stream.asyncEffect<
      StreamToolsEvent,
      | MaxIterationsError
      | ParseError
      | HttpClientError
      | HttpBodyError
      | UnknownException
      | ToolExecutionError<unknown>
      | ToolDefinitionError<FnDefns[number]>,
      Scope.Scope | ToolDefinitionContext<FnDefns[number]>
    >(
      (emit) =>
        Effect.gen(function* () {
          if (params.maxIterations === 0) {
            return yield* Effect.fail(new MaxIterationsError());
          }

          const single = (event: StreamToolsEvent) =>
            Effect.promise(() => emit.single(event));

          const end = () => Effect.promise(() => emit.end());

          const fail = (
            error:
              | MaxIterationsError
              | ParseError
              | HttpClientError
              | HttpBodyError
              | UnknownException
              | ToolExecutionError<unknown>
              | ToolDefinitionError<FnDefns[number]>,
          ) => Effect.promise(() => emit.fail(error));

          const fnCalls: {
            id: string;
            name: string;
            args: string;
            input: unknown;
            fnDefn: FnDefns[number];
          }[] = [];

          // On each event, we first check to see if it's a tool call and record
          // it. Then, we emit the event.
          const onStreamEvent = (event: StreamEvent) =>
            pipe(
              event,
              Match.type<StreamEvent>().pipe(
                Match.tag("ToolCall", (toolCall) =>
                  Effect.gen(function* () {
                    const fnFound = Array.findFirst(
                      params.tools ?? [],
                      (fn) => fn.name === toolCall.name,
                    );

                    if (Option.isNone(fnFound)) {
                      return yield* Effect.fail(
                        new UnknownToolCallError({ toolCall: toolCall }),
                      );
                    }

                    const input: unknown = yield* S.decodeUnknown(
                      S.parseJson(fnFound.value.input),
                    )(toolCall.arguments).pipe(
                      Effect.catchTag("ParseError", (error) =>
                        Effect.fail(
                          new InvalidToolCallError({
                            toolCall: toolCall,
                            error,
                          }),
                        ),
                      ),
                    );

                    fnCalls.push({
                      id: toolCall.id,
                      name: toolCall.name,
                      args: toolCall.arguments,
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

          const onInvalidToolCall = (
            error: InvalidToolCallError | UnknownToolCallError,
          ) =>
            Effect.gen(function* () {
              yield* single(
                StreamEventEnum.InvalidToolCall({
                  id: error.toolCall.id,
                  name: error.toolCall.name,
                  arguments: error.toolCall.arguments,
                }),
              );

              const input = yield* S.decodeUnknown(S.parseJson())(
                error.toolCall.arguments,
              );

              const failedToolCall = new ToolUseEvent({
                id: error.toolCall.id,
                name: error.toolCall.name,
                input,
              });

              const failedToolResult = new ToolResultErrorEvent({
                id: error.toolCall.id,
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

          const handleToolCalls = Effect.gen(function* () {
            if (fnCalls.length === 0) {
              return yield* end();
            }

            const newEvents: Extract<
              ThreadEvent,
              {
                _tag:
                  | "ToolUseEvent"
                  | "ToolResultSuccessEvent"
                  | "ToolResultErrorEvent";
              }
            >[] = [];

            for (const fnCall of fnCalls) {
              const toolCallEvent = new ToolUseEvent({
                id: fnCall.id,
                name: fnCall.name,
                input: fnCall.input,
              });

              const output: Either.Either<
                any,
                ToolError<any>
              > = yield* fnCall.fnDefn.effect(fnCall.id, fnCall.input).pipe(
                Effect.map(Either.right),
                Effect.catchTag("ToolError", (err) =>
                  Effect.succeed(Either.left(err)),
                ),
                Effect.catchAll((error: unknown) =>
                  Effect.fail(
                    error instanceof HaltToolLoopError
                      ? error
                      : new ToolExecutionError({ id: fnCall.id, error }),
                  ),
                ),
              );

              newEvents.push(toolCallEvent);

              if (Either.isRight(output)) {
                yield* single(
                  ToolResultEnum.ToolResultSuccess({
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
              } else {
                yield* single(
                  ToolResultEnum.ToolResultError({
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
              (err): err is InvalidToolCallError =>
                err instanceof InvalidToolCallError,
              (error) => onInvalidToolCall(error),
            ),
            Effect.catchIf(
              (err): err is UnknownToolCallError =>
                err instanceof UnknownToolCallError,
              (error) => onInvalidToolCall(error),
            ),
            Effect.andThen(() => handleToolCalls),
            Effect.catchTag("HaltToolLoopError", () => end()),
            Effect.catchAll((error) => fail(error)),
            Effect.catchAllDefect((defect) =>
              fail(new UnknownException(defect)),
            ),
            Effect.andThen(() => end()),
            Effect.forkScoped,
          );
        }) as Effect.Effect<
          void,
          | MaxIterationsError
          | ParseError
          | HttpClientError
          | HttpBodyError
          | UnknownException
          | ToolExecutionError<unknown>
          | ToolDefinitionError<FnDefns[number]>,
          Scope.Scope | ToolDefinitionContext<FnDefns[number]>
        >,
    );
  },
);
