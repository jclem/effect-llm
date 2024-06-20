import { BunContext, BunRuntime } from "@effect/platform-bun";
import * as Http from "@effect/platform/HttpClient";
import { Config, Effect, Redacted, Stream } from "effect";
import * as Anthropic from "../src/providers/anthropic";
import { UserMessage } from "../src/thread-event";

Config.string("ANTHROPIC_API_KEY").pipe(
  Effect.map(Redacted.make),
  Effect.flatMap((apiKey) => Anthropic.make({ apiKey })),
  Effect.map((openai) =>
    openai.stream({
      model: Anthropic.Model.Claude3Haiku,
      maxTokens: 128,
      events: [new UserMessage({ content: "Write 25 words about fish" })],
    }),
  ),
  Effect.flatMap(Stream.runForEach(Effect.logInfo)),
  Effect.catchTag("ResponseError", (err) => {
    return err.response.json.pipe(Effect.flatMap(Effect.logError));
  }),
  Effect.catchAll(Effect.logError),
  Effect.scoped,
  Effect.provide(BunContext.layer),
  Effect.provide(Http.client.layer),
  BunRuntime.runMain,
);
