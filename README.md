# Effect LLM

Effect LLM built with [Effect](https://effect.website) for interacting with
large language model APIs.

The goal is of the library is to make it as easy as possible to switch between
various API providers (while also providing a means of using provider-specific
functionality where needed).

# Usage

## Basic Usage

To use this library, you'll initialize a provider (a client for a specific API
such as Anthropic or OpenAI) and use that provider to make LLM API calls via the
Generation service.

```typescript
const program = Effect.gen(function* () {
  const apiKey = yield* Config.redacted("ANTHROPIC_API_KEY");
  const provider = yield* Providers.Anthropic.make();

  const stream = Generation.stream(provider, {
    apiKey,
    model: Providers.Anthropic.Model.Claude35Sonnet,
    maxTokens: 512,
    events: [
      new Thread.UserMessage({
        content: "Hello, I'm Jonathan.",
      }),
    ],
  });

  const responseText = yield* stream.pipe(
    Stream.filter((event) => event._tag === "Content"),
    Stream.runFold("", (acc, event) => acc + event.content),
  );

  yield* Console.log("The model says:", responseText);
});

program.pipe(
  Effect.provide(HttpClient.layer),
  Effect.provide(BunContext.layer),
  BunRuntime.runMain,
);
```

Generally, it is recommended that you set up the provider as a layer so that it
can be swapped out with relative ease[^1].

```typescript
const apiKey = Config.redacted("ANTHROPIC_API_KEY");

const program = Effect.gen(function* () {
  const provider = yield* Generation.Generation;

  const stream = Generation.stream(provider, {
    apiKey,
    model: Providers.Anthropic.Model.Claude35Sonnet,
    maxTokens: 512,
    events: [
      new Thread.UserMessage({
        content: "Hello, I'm Jonathan.",
      }),
    ],
  });

  const responseText = yield* stream.pipe(
    Stream.filter((event) => event._tag === "Content"),
    Stream.runFold("", (acc, event) => acc + event.content),
  );

  yield* Console.log("The model says:", responseText);
});

program.pipe(
  Effect.provide(Layer.effect(Generation.Generation, Anthropic.make())),
  Effect.provide(HttpClient.layer),
  Effect.provide(BunContext.layer),
  BunRuntime.runMain,
);
```

## Function-Calling

There are two ways of utilizing LLM functions in this library.

### Using `Generation.stream`

The `Generation.stream` function accepts `functions` and `functionCall` as
parameters. When using these parameters, you can expect to see the following
events emitted from the stream:

| Name                | Payload Type                                                                  | Description                                                                           |
| ------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `FunctionCallStart` | `{ readonly id: string; readonly name: string; }`                             | Emitted when a function call begins, but before its arguments have been streamed      |
| `FunctionCall`      | `{ readonly id: string; readonly name: string; readonly arguments: string; }` | Emitted when a function call and its arguments have been fully streamed and collected |

Note that when using `Generation.stream`, the function calls are not validated
or executed, nor are there arguments even parsed.

### Using `Generation.streamTools`

If instead you would like to have effect-llm parse and _execute_ function calls
for you, use `Generation.streamTools`. This function accepts the same parameters
as `Generation.stream`, with the addition of a `maxIterations` parameter used to
limit the number of loops that will be executed. When using
`Generation.streamTools`, the following sequence of events will occur:

1. Send the completion request to the provider
2. Parse the response
3. If there are function calls in the response:
   1. Parse the arguments
   2. Append the function call to the events list
   3. Call the function
   4. Append the function result to the events list
   5. Go to (1) with the new events list
4. OR, If there are no function calls in the resopnse:
   1. End the stream

If the `maxIterations` limit is exceeded, the stream will emit a
`MaxIterationsError`.

The stream returned by `Generation.streamTools` emits the same events as
`Generation.stream` with some additions:

| Name                    | Payload Type                                                                  | Description                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `FunctionCallStart`     | `{ readonly id: string; readonly name: string; }`                             | Emitted when a function call begins, but before its arguments have been streamed                          |
| `FunctionCall`          | `{ readonly id: string; readonly name: string; readonly arguments: string; }` | Emitted when a function call and its arguments have been fully streamed and collected                     |
| `InvalidFunctionCall`   | `{ readonly id: string; readonly name: string; readonly arguments: string; }` | Emitted when a function call's arguments are invalid or the function call is not in the defined functions |
| `FunctionResultSuccess` | `{ readonly id: string; readonly name: string; readonly result: unknown }`    | Emitted when a function call's arguments are invalid or the function call is not in the defined functions |
| `FunctionResultError`   | `{ readonly id: string; readonly name: string; readonly result: unknown }`    | Emitted when a function call's arguments are invalid or the function call is not in the defined functions |

[^1]:
    There are some caveats to this—for example, the `stream` API doesn't require
    the `maxTokens` parameter, because OpenAI doesn't require it, but the Anthropic
    API will return a 400 if it's not provided.
