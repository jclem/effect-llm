import { BunContext, BunRuntime } from "@effect/platform-bun";
import * as Http from "@effect/platform/HttpClient";
import { Config, Effect, Redacted, Stream } from "effect";
import * as OpenAI from "../src/providers/openai";
import { UserMessage } from "../src/thread-event";

Config.string("OPENAI_API_KEY").pipe(
  Effect.map(Redacted.make),
  Effect.flatMap((apiKey) => OpenAI.make({ apiKey })),
  Effect.map((openai) =>
    openai.stream({
      model: OpenAI.Model.GPT4o,
      events: [new UserMessage({ content: "Write 25 words about fish" })],
    }),
  ),
  Effect.flatMap(Stream.runForEach(Effect.logInfo)),
  Effect.catchAll(Effect.logError),
  Effect.scoped,
  Effect.provide(BunContext.layer),
  Effect.provide(Http.client.layer),
  BunRuntime.runMain,
);
