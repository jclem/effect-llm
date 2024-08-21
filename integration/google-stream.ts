import { HttpClient } from "@effect/platform";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { Schema as S } from "@effect/schema";
import { Config, Console, Effect, Layer, Stream } from "effect";
import { Generation, Thread } from "../src";
import * as Google from "../src/providers/google";
import { TextChunk } from "../src/thread";

Effect.gen(function* () {
  const llm = yield* Generation.Generation;
  const apiKey = yield* Config.redacted("GOOGLE_API_KEY");

  yield* Generation.streamTools(llm, {
    apiKey,
    model:
      "projects/effect-llm/locations/us-central1/publishers/google/models/gemini-1.5-pro",
    maxTokens: 256,
    events: [
      new Thread.UserMessage({
        content: [
          new TextChunk({
            content:
              "Say hello with TEXT only (not a function), and then use a function to say 'Greetings'",
          }),
        ],
      }),
    ],
    tools: [
      Generation.defineTool("sayHello", {
        description: "Say hello to the user",
        input: S.Struct({
          greeting: S.String,
        }),
        effect: (_, input) =>
          Effect.gen(function* () {
            yield* Console.log("GREETING:", input.greeting);
            return { ok: true };
          }),
      }),
    ],
  }).pipe(
    Stream.runForEach(Effect.logInfo),
    Effect.catchTag("ResponseError", (err) =>
      err.response.json.pipe(Effect.flatMap(Effect.logError)),
    ),
    Effect.catchAll(Effect.logError),
    Effect.scoped,
  );
}).pipe(
  Effect.provide(
    Layer.effect(
      Generation.Generation,
      Google.make({
        serviceEndpoint: "https://us-central1-aiplatform.googleapis.com",
      }),
    ),
  ),
  Effect.provide(BunContext.layer),
  Effect.provide(HttpClient.layer),
  BunRuntime.runMain,
);
