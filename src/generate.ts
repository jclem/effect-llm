import * as Http from "@effect/platform/HttpClient";
import { Data, Scope, Stream } from "effect";
import type { UnknownException } from "effect/Cause";
import type { AssistantMessage, ThreadEvent } from "./thread-event";

export interface StreamParams {
  readonly model: string;
  readonly events: ThreadEvent[];
  readonly maxTokens?: number | undefined;
}

export type StreamEvent = Data.TaggedEnum<{
  Content: { readonly content: string };
  Message: { readonly message: AssistantMessage };
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
}
