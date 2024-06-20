import * as Http from "@effect/platform/HttpClient";
import { Data, Effect, Exit, Match, Queue, Stream } from "effect";
import { UnknownException } from "effect/Cause";
import {
  createParser,
  type ParseEvent,
  type ParsedEvent,
} from "eventsource-parser";

type SSEQueueEvent = Data.TaggedEnum<{
  Event: { readonly event: ParseEvent };
  Error: { readonly error: Http.error.ResponseError | UnknownException };
}>;

const SSEQueueEvent = Data.taggedEnum<SSEQueueEvent>();

/**
 * Read a client response as a stream of server-sent events.
 */
export const streamSSE = (response: Http.response.ClientResponse) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<SSEQueueEvent>();
    const parser = createParser((event) =>
      queue.unsafeOffer(SSEQueueEvent.Event({ event })),
    );

    const fiberId = yield* Effect.forkScoped(
      Effect.succeed(response).pipe(
        Http.response.stream,
        Stream.decodeText("utf-8"),
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            parser.feed(chunk);
          }),
        ),
        Effect.ensuring(queue.shutdown),
      ),
    );

    fiberId.addObserver((exit) => {
      if (Exit.isSuccess(exit)) {
        return;
      }

      Match.type<typeof exit.cause>().pipe(
        Match.tag("Fail", (cause) => {
          queue.unsafeOffer(SSEQueueEvent.Error(cause));
        }),
        Match.tag("Die", (die) => {
          queue.unsafeOffer(
            SSEQueueEvent.Error({ error: new UnknownException(die.defect) }),
          );
        }),
        Match.orElse(() => Effect.void),
      )(exit.cause);
    });

    const mapQueueEvent = Match.type<SSEQueueEvent>().pipe(
      Match.tag("Event", (event) => Effect.succeed(event.event)),
      Match.tag("Error", (error) => Effect.fail(error.error)),
      Match.exhaustive,
    );

    return Stream.fromQueue(queue, { shutdown: true }).pipe(
      Stream.mapEffect(mapQueueEvent),
    );
  });

/**
 * Filter an SSE stream to only return parsed events.
 */
export const filterParsedEvents = <E, R>(
  self: Stream.Stream<ParseEvent, E, R>,
) =>
  self.pipe(
    Stream.filter((event): event is ParsedEvent => event.type === "event"),
  );
