import * as Http from "@effect/platform/HttpClient";
import type { Schema } from "@effect/schema";
import { Context, Data, Effect, Stream, type Scope } from "effect";
import type { NonEmptyArray } from "effect/Array";
import type { UnknownException } from "effect/Cause";
import type { AssistantMessage, ThreadEvent } from "./thread-event";

export interface StreamParams {
  readonly model: string;
  readonly system?: string | undefined;
  readonly events: ThreadEvent[];
  readonly maxTokens?: number | undefined;
  readonly functions?:
    | NonEmptyArray<FunctionDefinition<any, any, any, any, any>>
    | undefined;
}

export interface FunctionDefinition<Name extends string, A, O, E, R> {
  readonly name: Name;
  readonly description?: string | undefined;
  readonly input: Schema.Schema<A, any, any>;
  readonly function: (input: A) => Effect.Effect<O, E, R>;
}

export function defineFunction<Name extends string, A, O, E, R>(
  name: Name,
  definition: Omit<FunctionDefinition<Name, A, O, E, R>, "name">,
): FunctionDefinition<Name, A, O, E, R> {
  return { ...definition, name };
}

export type StreamEvent = Data.TaggedEnum<{
  Content: { readonly content: string };
  Message: { readonly message: AssistantMessage };
  FunctionCall: {
    readonly functionCall: {
      readonly id: string;
      readonly name: string;
      readonly arguments: string;
    };
  };
}>;
export const StreamEvent = Data.taggedEnum<StreamEvent>();

export interface Provider {
  readonly stream: (
    params: StreamParams,
  ) => Stream.Stream<
    StreamEvent,
    | Http.error.HttpClientError
    | Http.error.ResponseError
    | Http.body.BodyError
    | UnknownException,
    Scope.Scope
  >;

  readonly streamTools: (
    params: StreamParams,
  ) => Stream.Stream<
    StreamEvent,
    | Http.error.HttpClientError
    | Http.error.ResponseError
    | Http.body.BodyError
    | UnknownException,
    Scope.Scope
  >;
}

export class Generation extends Context.Tag("Generation")<
  Generation,
  Provider
>() {}
