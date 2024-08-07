import { HttpClient } from "@effect/platform";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { Schema as S } from "@effect/schema";
import { Config, Console, Effect, Layer, Stream } from "effect";
import { Generation, Thread } from "../src";
import { OpenAI } from "../src/providers";

Effect.gen(function* () {
  const llm = yield* Generation.Generation;
  const apiKey = yield* Config.redacted("OPENAI_API_KEY");

  yield* Generation.streamTools(llm, {
    apiKey,
    model: OpenAI.Model.GPT4o20240806,
    maxTokens: 256,
    events: [
      new Thread.UserMessage({
        content:
          "Say hello with TEXT only (not a function), and then use a function to say 'Greetings'",
      }),
    ],
    functions: [
      Generation.defineFunction("sayHello", {
        description: "Say hello to the user",
        input: S.Struct({
          greeting: S.String,
        }),
        function: (_, input) =>
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
  Effect.provide(Layer.effect(Generation.Generation, OpenAI.make())),
  Effect.provide(BunContext.layer),
  Effect.provide(HttpClient.layer),
  BunRuntime.runMain,
);
