import { BunContext, BunRuntime } from "@effect/platform-bun";
import * as Http from "@effect/platform/HttpClient";
import { Schema } from "@effect/schema";
import { Config, Effect, Layer, Stream } from "effect";
import { Generation, defineFunction } from "../src/generate";
import * as OpenAI from "../src/providers/openai";
import { UserMessage } from "../src/thread-event";

const openAIProvider = Config.redacted("OPENAI_API_KEY").pipe(
  Effect.flatMap((apiKey) => OpenAI.make({ apiKey })),
);

const streamTools = Generation.pipe(
  Effect.map((gen) =>
    gen.stream({
      model: OpenAI.Model.GPT4o,
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
  Stream.unwrap,
  Stream.runForEach(Effect.logInfo),
);

streamTools.pipe(
  Effect.scoped,
  Effect.provide(Layer.effect(Generation, openAIProvider)),
  Effect.provide(BunContext.layer),
  Effect.provide(Http.client.layer),
  BunRuntime.runMain,
);
