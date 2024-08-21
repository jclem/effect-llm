import { HttpClient } from "@effect/platform";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { Schema as S } from "@effect/schema";
import { Config, Console, Effect, Layer, Stream } from "effect";
import { Generation, Thread } from "../src";
import * as Anthropic from "../src/providers/anthropic";
import { TextChunk } from "../src/thread";

Effect.gen(function* () {
  const llm = yield* Generation.Generation;
  const apiKey = yield* Config.redacted("ANTHROPIC_API_KEY");

  yield* Generation.streamTools(llm, {
    apiKey,
    model: Anthropic.Model.Claude35Sonnet,
    maxTokens: 256,
    events: [
      new Thread.UserMessage({
        content: [
          new TextChunk({
            content:
              "Say hello with TEXT only (not a tool), and then use a tool to say 'Greetings'",
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
  Effect.provide(Layer.effect(Generation.Generation, Anthropic.make())),
  Effect.provide(BunContext.layer),
  Effect.provide(HttpClient.layer),
  BunRuntime.runMain,
);
