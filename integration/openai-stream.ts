import { FetchHttpClient } from "@effect/platform";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { Config, Console, Effect, Layer, Schema as S, Stream } from "effect";
import { Generation, Thread } from "../src";
import { OpenAI } from "../src/providers";
import { TextChunk } from "../src/thread";

Effect.gen(function* () {
  const llm = yield* Generation.Generation;
  const apiKey = yield* Config.redacted("OPENAI_API_KEY");

  yield* Generation.streamTools(llm, {
    apiKey,
    model: OpenAI.Model.GPT4o20240806,
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
  Effect.provide(Layer.effect(Generation.Generation, OpenAI.make())),
  Effect.provide(BunContext.layer),
  Effect.provide(FetchHttpClient.layer),
  BunRuntime.runMain,
);
