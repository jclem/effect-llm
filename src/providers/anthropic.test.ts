import { HttpClient, HttpClientResponse } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { Chunk, Effect, Layer, Match, Option, Redacted, Stream } from "effect";
import type { StreamEvent } from "../generation.js";
import { describe, expect, it } from "../testing.js";
import { UserMessage } from "../thread.js";
import { Anthropic } from "./index.js";

const setup = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(Effect.scoped, Effect.provide(BunContext.layer));

const responseLayer = (body: string, init?: ResponseInit) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.makeDefault((req) =>
      Effect.succeed(HttpClientResponse.fromWeb(req, new Response(body, init))),
    ),
  );

describe("Anthropic", () => {
  describe(".stream", () => {
    it(
      "streams content chunks",
      Effect.gen(function* () {
        const llm = yield* Anthropic.make();

        const result = yield* llm
          .stream({
            apiKey: Redacted.make("api-key"),
            model: Anthropic.Model.Claude35Sonnet,
            events: [new UserMessage({ content: "Hello." })],
          })
          .pipe(
            Stream.filterMap(
              Match.type<StreamEvent>().pipe(
                Match.tag("Content", ({ content }) => Option.some(content)),
                Match.orElse(() => Option.none()),
              ),
            ),
            Stream.mkString,
          );

        expect(result).toEqual("Hello, there! How may I help you?");
      }).pipe(
        Effect.provide(
          responseLayer(`
event: content_block_start
data: { "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } }

event: content_block_delta
data: { "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "Hello, there!" } }

event: content_block_delta
data: { "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": " How may I help you?" } }

event: content_block_stop
data: { "type": "content_block_stop", "index": 0 }\n\n`),
        ),
        setup,
      ),
    );

    it(
      "streams tool use events",
      Effect.gen(function* () {
        const llm = yield* Anthropic.make();

        const events = yield* llm
          .stream({
            apiKey: Redacted.make("api-key"),
            model: Anthropic.Model.Claude35Sonnet,
            events: [new UserMessage({ content: "Hello." })],
          })
          .pipe(
            Stream.filter((e) => e._tag === "ToolCall"),
            Stream.runCollect,
            Effect.map(Chunk.toArray),
          );

        expect(events).toEqual([
          {
            _tag: "ToolCall",
            id: "123",
            arguments: `{ "name": "Jonathan" }`,
            name: "sayHello",
          },
        ]);
      }).pipe(
        Effect.provide(
          responseLayer(`
event: content_block_start
data: { "type": "content_block_start", "index": 0, "content_block": { "type": "tool_use", "id": "123", "name": "sayHello", "input": {} } }

event: content_block_delta
data: { "type": "content_block_delta", "index": 0, "delta": { "type": "input_json_delta", "partial_json": "{ \\"name\\":" } }

event: content_block_delta
data: { "type": "content_block_delta", "index": 0, "delta": { "type": "input_json_delta", "partial_json": " \\"Jonathan\\" }" } }

event: content_block_stop
data: { "type": "content_block_stop", "index": 0 }\n\n`),
        ),
        setup,
      ),
    );

    it(
      "currently ignores errors",
      Effect.gen(function* () {
        const llm = yield* Anthropic.make();

        yield* llm
          .stream({
            apiKey: Redacted.make("api-key"),
            model: Anthropic.Model.Claude35Sonnet,
            events: [new UserMessage({ content: "Hello." })],
          })
          .pipe(Stream.runDrain);
      }).pipe(
        Effect.provide(
          responseLayer(`
event: error
data: { "type": "error", "error": { "type": "something" } }\n\n`),
        ),
        setup,
      ),
    );
  });
});
