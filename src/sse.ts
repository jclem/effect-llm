import { HttpClientResponse } from "@effect/platform";
import type { ResponseError } from "@effect/platform/HttpClientError";
import { Effect, Stream } from "effect";
import { createParser, type ParseEvent } from "eventsource-parser";

/**
 * Read a client response as a stream of server-sent events.
 */
export const streamSSE = (
  response: HttpClientResponse.HttpClientResponse,
): Stream.Stream<ParseEvent, ResponseError> =>
  Stream.asyncPush<ParseEvent, ResponseError>((emit) =>
    Effect.gen(function* () {
      const parser = createParser((event) => emit.single(event));

      yield* Effect.succeed(response).pipe(
        HttpClientResponse.stream,
        Stream.decodeText("utf-8"),
        Stream.runForEach((chunk) => Effect.succeed(parser.feed(chunk))),
        Effect.andThen(() => emit.end()),
      );
    }),
  );

/**
 * Filter an SSE stream to only return parsed events.
 */
export const filterParsedEvents = <E, R>(
  self: Stream.Stream<ParseEvent, E, R>,
) => Stream.filter(self, (e) => e.type === "event");
