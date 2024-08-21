import { HttpClient } from "@effect/platform";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { Schema as S } from "@effect/schema";
import { Config, Effect } from "effect";
import { Thread } from "../src";
import { OpenAI } from "../src/providers";
import { TextChunk } from "../src/thread";

const schema = S.Struct({
  name: S.String,
  age: S.Int,
});

Effect.gen(function* () {
  const llm = yield* OpenAI.make();
  const apiKey = yield* Config.redacted("OPENAI_API_KEY");

  const info = yield* llm
    .structured({
      name: "user-info",
      apiKey,
      model: OpenAI.Model.GPT4o20240806,
      maxTokens: 256,
      events: [
        new Thread.SystemMessage({
          content:
            "Extract the user's information from the given user message.",
        }),
        new Thread.UserMessage({
          content: [
            new TextChunk({ content: "I am Jonathan, I am 10 years old." }),
          ],
        }),
      ],
      schema,
    })
    .pipe(
      Effect.tapErrorTag("ResponseError", (err) =>
        err.response.json.pipe(Effect.flatMap(Effect.logError)),
      ),
      Effect.tapErrorTag("ParseError", (err) => Effect.logError(err.message)),
      Effect.tapError(Effect.logError),
      Effect.scoped,
    );

  yield* Effect.logInfo({
    name: info.name,
    age: info.age,
  });
}).pipe(
  Effect.provide(BunContext.layer),
  Effect.provide(HttpClient.layer),
  BunRuntime.runMain,
);
