/* eslint-disable @typescript-eslint/no-explicit-any */

import type { HttpBodyError } from "@effect/platform/HttpBody";
import type { HttpClientError } from "@effect/platform/HttpClientError";
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
  Schema as S,
  Stream,
  type Scope,
} from "effect";
import { UnknownException } from "effect/Cause";
import type { TaggedEnum } from "effect/Data";
import { dual } from "effect/Function";
import type { ParseError } from "effect/ParseResult";
import type { MissingParameterError } from "./providers/index.js";
import {
  ToolResultErrorEvent,
  ToolResultSuccessEvent,
  ToolUseEvent,
  type AssistantMessage,
  type ThreadEvent,
} from "./thread.js";

/** An error that occurs when events can not be truncated between iterations. */
export class TruncateEventsError extends Data.TaggedError(
  "TruncateEventsError",
)<{ readonly error: Error }> {
  readonly message = `Truncation error: ${this.error.message}`;
}

/** Parameters used to configure an LLM stream generation call. */
export interface StreamParams<FnDefns extends Readonly<ToolDefinitionAny[]>> {
  /** A redacted API key */
  readonly apiKey?: Redacted.Redacted;
  /** The model to use for the completion request */
  readonly model?: string;
  /** A system message, serialized differently depending on the provider */
  readonly system?: string | undefined;
  /** The events in the thread, typically messages and tool calls/results */
  readonly events: readonly ThreadEvent[];
  /** The maximum iterations when streaming with automated tool calls */
  readonly maxIterations?: number | undefined;
  /** A function called that truncates events on the first and subsequent iterations */
  readonly truncateEvents?: (
    events: readonly ThreadEvent[],
  ) => Effect.Effect<readonly ThreadEvent[], TruncateEventsError>;
  /** The maximum number of tokens per response */
  readonly maxTokens?: number | undefined;
  /** The tools calls the model may make */
  readonly tools?: FnDefns | undefined;
  /** A parameter which dictates if and how the model may make tool calls */
  readonly toolCall?: ToolCallOption<FnDefns>;
  /** Any additional parameters passed directly to the provider's API */
  readonly additionalParameters?: Record<string, unknown> | undefined;
}

/**
 * A tool call option that dictates if and how the model may make tool calls.
 *
 * - "auto": The model may make any or no tool calls automatically
 * - "required": The model must make a tool call
 * - { name: "toolName" }: The model must make a tool call with the given name
 * - "none": The model may not make any tool calls
 */
export type ToolCallOption<FnDefns extends Readonly<ToolDefinitionAny[]>> =
  | "auto"
  | "required"
  | { name: FnDefns[number]["name"] }
  | "none";

/**
 * An error that occurs when a tool fails to execute, reported to the model.
 */
export class ToolError<E> extends Data.TaggedError("ToolError")<{
  readonly payload: E;
}> {}

/**
 * Wrap an error in a ToolError and fail the effect with it.
 *
 * ```typescript
 * defineTool("myTool", {
 *   // etc.
 *   effect: (_, input) => Effect.gen(function*() {
 *     if (input === "bad") {
 *       return yield* toolError("Input was bad");
 *     }
 *   })
 * })
 * ```
 *
 * @param payload The error to wrap in a ToolError
 * @returns A new ToolError
 */
export const toolError = <P>(payload: P) =>
  Effect.fail(new ToolError({ payload }));

class HaltToolLoopError extends Data.TaggedError("HaltToolLoopError") {}

/**
 * Halt the tool loop immediately after the current tool call.
 *
 * ```typescript
 * defineTool("myTool", {
 *   // etc.
 *   effect: (_, input) => Effect.gen(function*() {
 *     return yield* haltToolLoop();
 *   })
 * })
 * ```
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
  I extends S.Schema<any, any, any> | unknown,
> {
  /** The name of the tool, given to the model */
  readonly name: Name;
  /** A description of the tool, given to the model */
  readonly description?: string | undefined;
  /**
   * An Effect schema or JSON schema defining the tool's inputs
   *
   * If the schema is a JSON schema, the input is not validated and will be `unknown` in the effect.
   */
  readonly input: I;
  /** A function receiving the tool call ID and returning an effect that runs the tool */
  readonly effect: (
    id: string,
    input: I extends S.Schema<infer IA, any, any> ? IA : unknown,
  ) => Effect.Effect<A, E | HaltToolLoopError, R>;
}

/**
 * A utility type for an any-typed tool definition.
 */
export type ToolDefinitionAny = ToolDefinition<string, any, any, any, any>;

export type ToolDefinitionError<F extends ToolDefinitionAny> =
  F extends ToolDefinition<string, any, infer E, any, any> ? E : never;

export type ToolDefinitionContext<F extends ToolDefinitionAny> =
  F extends ToolDefinition<string, any, any, infer C, infer I>
    ? C | (I extends S.Schema<any, any, infer IR> ? IR : never)
    : never;

/**
 * Define a tool by providing its name, implementation, and other details.
 *
 * ```typescript
 * defineTool("sayHello", {
 *   description: "A tool that says hello",
 *   input: Schema.Struct({ name: Schema.String }),
 *   effect: (_, { name }) => Console.log(`Hello, ${name}!`)
 * })
 * ```
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
  I extends S.Schema<any, any, any> | unknown,
>(
  name: Name,
  definition: Omit<ToolDefinition<Name, A, E, R, I>, "name">,
): ToolDefinition<Name, A, E, R, I> {
  return { ...definition, name };
}

/**
 * An event emitted during a stream generation call.
 */
export type StreamEvent = Data.TaggedEnum<{
  /** Represents the start of content in a textual message */
  ContentStart: { readonly content: string };
  /** Represents a content chunk in a textual response */
  Content: { readonly content: string };
  /** Represents a full, completed message */
  Message: { readonly message: AssistantMessage };
  /** Represents the start of a tool call */
  ToolCallStart: { readonly id: string; readonly name: string };
  /** Represents a completed tool call from the model */
  ToolCall: {
    readonly id: string;
    readonly name: string;
    readonly arguments: string;
  };
  /** Represents an invalid tool call from the model */
  InvalidToolCall: {
    readonly id: string;
    readonly name: string;
    readonly arguments: string;
  };
  /** Represents statistics related to the call */
  Stats: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
}>;

/** An enum of all stream events */
export const StreamEventEnum = Data.taggedEnum<StreamEvent>();

/**
 * An interface which provides the low-level stream from some LLM provider.
 */
export interface Provider {
  readonly stream: (
    params: StreamParams<any>,
  ) => Stream.Stream<
    StreamEvent,
    HttpClientError | HttpBodyError | UnknownException | MissingParameterError,
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
  /** A successful tool call */
  ToolResultSuccess: {
    readonly id: string;
    readonly name: string;
    readonly result: RS;
  };
  /** A tool call which errored*/
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
 * Read the text content from a completion stream.
 *
 * ```typescript
 * Effect.gen(function*() {
 *   const stream = Generation.stream(provider, params)
 *   const content = yield* Generation.getContent(stream)
 * })
 * ```
 *
 * Since this consumes the entire stream, it is run in a scope.
 *
 * @param stream The stream to read text content from
 * @returns An effect yielding the text content from the stream
 */
export const getContent = <E, R>(
  stream: Stream.Stream<StreamEvent, E, R>,
): Effect.Effect<string, E, Exclude<R, Scope.Scope>> =>
  stream.pipe(
    Stream.filterMap(
      Match.type<StreamEvent>().pipe(
        Match.tag("Content", ({ content }) => Option.some(content)),
        Match.orElse(() => Option.none()),
      ),
    ),
    Stream.mkString,
    Effect.scoped,
  );

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

export interface StreamLoop {
  readonly _tag: "StreamLoop";
}

const StreamLoop = Data.tagged<StreamLoop>("StreamLoop");

export interface StreamLoopEnd {
  readonly _tag: "StreamLoopEnd";
}

const StreamLoopEnd = Data.tagged<StreamLoopEnd>("StreamLoopEnd");

/**
 * An event emitted during a stream using tool calls.
 */
export type StreamToolsEvent =
  | StreamEvent
  | StreamLoop
  | StreamLoopEnd
  | ToolResult<unknown, unknown>;

export class MaxIterationsError extends Data.TaggedError(
  "MaxIterationsError",
) {}

export type StreamToolsStream<FnDefns extends Readonly<ToolDefinitionAny[]>> =
  Stream.Stream<
    StreamToolsEvent,
    | MaxIterationsError
    | ParseError
    | HttpClientError
    | HttpBodyError
    | UnknownException
    | MissingParameterError
    | ToolExecutionError<unknown>
    | ToolDefinitionError<FnDefns[number]>
    | TruncateEventsError,
    Scope.Scope | ToolDefinitionContext<FnDefns[number]>
  >;

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
  ): (provider: Provider) => StreamToolsStream<FnDefns>;
  <FnDefns extends Readonly<ToolDefinitionAny[]>>(
    provider: Provider,
    params: StreamParams<FnDefns>,
  ): StreamToolsStream<FnDefns>;
} = dual(
  2,
  <FnDefns extends Readonly<ToolDefinitionAny[]>>(
    provider: Provider,
    params: StreamParams<FnDefns>,
  ) => {
    return Stream.asyncEffect<
      Stream.Stream.Success<StreamToolsStream<FnDefns>>,
      Stream.Stream.Error<StreamToolsStream<FnDefns>>,
      Stream.Stream.Context<StreamToolsStream<FnDefns>>
    >((emit) =>
      Effect.gen(function* () {
        if (params.maxIterations === 0) {
          return yield* Effect.fail(new MaxIterationsError());
        }

        const single = (event: StreamToolsEvent) =>
          Effect.promise(() => emit.single(event));

        const end = () => Effect.promise(() => emit.end());

        const fail = (error: Stream.Stream.Error<StreamToolsStream<FnDefns>>) =>
          Effect.promise(() => emit.fail(error));

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

                  let input: unknown;

                  if (S.isSchema(fnFound.value.input)) {
                    input = yield* S.decodeUnknown(
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
                  } else {
                    input = yield* S.decodeUnknown(S.parseJson())(
                      toolCall.arguments,
                    );
                  }

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
              name: error.toolCall.name,
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
                  error instanceof InvalidToolCallError
                    ? error
                    : error instanceof HaltToolLoopError
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
                  name: fnCall.name,
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
                  name: fnCall.name,
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

        yield* single(StreamLoop());

        const truncatedEvents = params.truncateEvents
          ? yield* params.truncateEvents(params.events)
          : params.events;

        yield* provider.stream({ ...params, events: truncatedEvents }).pipe(
          Stream.runForEach(onStreamEvent),
          Effect.andThen(() => single(StreamLoopEnd())),
          Effect.andThen(() => handleToolCalls),
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
          Effect.catchTag("HaltToolLoopError", () => end()),
          Effect.catchAll((error) => fail(error)),
          Effect.catchAllDefect((defect) => fail(new UnknownException(defect))),
          Effect.andThen(() => end()),
          Effect.fork,
        );
      }),
    );
  },
);
