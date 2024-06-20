import { BunContext, BunRuntime } from "@effect/platform-bun";
import * as Http from "@effect/platform/HttpClient";
import { Config, Effect, Layer, Stream } from "effect";
import { Generation } from "../src/generate";
import * as OpenAI from "../src/providers/openai";
import { UserMessage } from "../src/thread-event";

const openAIProvider = Config.redacted("OPENAI_API_KEY").pipe(
  Effect.flatMap((apiKey) => OpenAI.make({ apiKey })),
);

Generation.pipe(
  Effect.map((gen) =>
    gen.stream({
      model: OpenAI.Model.GPT4o,
      events: [new UserMessage({ content: "Write 25 words about fish" })],
    }),
  ),
  Effect.flatMap(Stream.runForEach(Effect.logInfo)),
  Effect.catchAll(Effect.logError),
  Effect.scoped,
  Effect.provide(Layer.effect(Generation, openAIProvider)),
  Effect.provide(BunContext.layer),
  Effect.provide(Http.client.layer),
  BunRuntime.runMain,
);
