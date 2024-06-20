import { BunContext, BunRuntime } from "@effect/platform-bun";
import * as Http from "@effect/platform/HttpClient";
import { Config, Effect, Layer, Stream } from "effect";
import { Generation } from "../src/generate";
import * as Anthropic from "../src/providers/anthropic";
import { UserMessage } from "../src/thread-event";

const anthropicProvider = Config.redacted("ANTHROPIC_API_KEY").pipe(
  Effect.flatMap((apiKey) => Anthropic.make({ apiKey })),
);

Generation.pipe(
  Effect.map((gen) =>
    gen.stream({
      model: Anthropic.Model.Claude3Haiku,
      maxTokens: 128,
      events: [new UserMessage({ content: "Write 25 words about fish" })],
    }),
  ),
  Effect.flatMap(Stream.runForEach(Effect.logInfo)),
  Effect.catchAll(Effect.logError),
  Effect.scoped,
  Effect.provide(Layer.effect(Generation, anthropicProvider)),
  Effect.provide(BunContext.layer),
  Effect.provide(Http.client.layer),
  BunRuntime.runMain,
);
