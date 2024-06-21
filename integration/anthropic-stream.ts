import { BunContext, BunRuntime } from "@effect/platform-bun";
import * as Http from "@effect/platform/HttpClient";
import { Schema } from "@effect/schema";
import { Config, Effect, Layer, Stream } from "effect";
import { Generation, defineFunction } from "../src/generate";
import * as Anthropic from "../src/providers/anthropic";
import { UserMessage } from "../src/thread-event";

const anthropicProvider = Config.redacted("ANTHROPIC_API_KEY").pipe(
  Effect.flatMap((apiKey) => Anthropic.make({ apiKey })),
);

Generation.pipe(
  Effect.map((gen) =>
    gen.streamTools({
      model: Anthropic.Model.Claude35Sonnet,
      maxTokens: 1024,
      events: [
        new UserMessage({
          content:
            'Say hello with TEXT only (not a function), and then use a function to say "Greetings"',
        }),
      ],
      functions: [
        defineFunction("sayHello", {
          description: "Say hello to the user",
          input: Schema.Struct({ greeting: Schema.String }),
          function: (input) =>
            Effect.sync(() => {
              console.log("GREETING:", input.greeting);
              return { ok: true };
            }),
        }),
      ],
    }),
  ),
  Effect.flatMap(Stream.runForEach(Effect.logInfo)),
  Effect.catchTag("ResponseError", (err) =>
    Effect.gen(function* () {
      const json = yield* err.response.json;
      yield* Effect.logError(json);
    }),
  ),
  Effect.catchAll(Effect.logError),
  Effect.scoped,
  Effect.provide(Layer.effect(Generation, anthropicProvider)),
  Effect.provide(BunContext.layer),
  Effect.provide(Http.client.layer),
  BunRuntime.runMain,
);
