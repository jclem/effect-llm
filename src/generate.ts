import * as Http from "@effect/platform/HttpClient";
import { Data, Effect, Scope, Stream } from "effect";
import type { UnknownException } from "effect/Cause";
import type { ThreadEvent } from "./thread-event";

export interface StreamParams {
  readonly model: string;
  readonly events: ThreadEvent[];
}

export type StreamEvent = Data.TaggedEnum<{
  Content: { readonly content: string };
}>;
export const StreamEvent = Data.taggedEnum<StreamEvent>();

export interface Provider {
  readonly stream: (
    params: StreamParams,
  ) => Effect.Effect<
    Stream.Stream<StreamEvent, Http.error.ResponseError | UnknownException>,
    Http.error.HttpClientError | Http.body.BodyError,
    Scope.Scope
  >;
}
