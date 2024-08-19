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
    Stream.filterMap(
      Match.type<StreamEvent>().pipe(
        Match.tag("Content", (event) => Option.some(event.content)),
        Match.orElse(() => Option.none()),
      ),
    ),
    Stream.mkString,
    Effect.scoped,
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
    apiKey: yield* apiKey,
    model: Providers.Anthropic.Model.Claude35Sonnet,
    maxTokens: 512,
    events: [
      new Thread.UserMessage({
        content: "Hello, I'm Jonathan.",
      }),
    ],
  });

  const responseText = yield* stream.pipe(
    Stream.filterMap(
      Match.type<StreamEvent>().pipe(
        Match.tag("Content", (event) => Option.some(event.content)),
        Match.orElse(() => Option.none()),
      ),
    ),
    Stream.mkString,
    Effect.scoped,
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

### Defining Functions

To define a function for use with `Generation.streamTools`[^2], use the
`Generation.defineFunction` function:

```typescript
const apiKey = Config.redacted("ANTHROPIC_API_KEY");

const program = Effect.gen(function* () {
  const provider = yield* Generation.Generation;

  const sayHello = Generation.defineFunction("sayHello", {
    description: "Say hello to the user",
    input: Schema.Struct({ name: Schema.String }),
    function: (functionCallID, functionArguments) =>
      Console.log(`Hello, ${functionArguments.name}`).pipe(
        Effect.as({ ok: true }),
      ),
  });

  const stream = Generation.streamTools(provider, {
    apiKey: yield* apiKey,
    model: Providers.Anthropic.Model.Claude35Sonnet,
    maxTokens: 512,
    functions: [sayHello],
    events: [
      new Thread.UserMessage({
        content: "Hello, I'm Jonathan.",
      }),
    ],
  });

  yield* stream.pipe(Stream.runDrain, Effect.scoped);
});

program.pipe(
  Effect.provide(Layer.effect(Generation.Generation, Anthropic.make())),
  Effect.provide(HttpClient.layer),
  Effect.provide(BunContext.layer),
  BunRuntime.runMain,
);
```

#### Error Handling

Any errors that occur during function execution will _halt_ the stream and yield
a `FunctionExecutionError`. In order to handle an error and report it to the
model, you should instead fail the effect with a `FunctionError` using the
`Generation.functionError` function:

```typescript
const sayHello = Generation.defineFunction("sayHello", {
  description: "Say hello to the user",
  input: Schema.Struct({ name: Schema.String }),
  function: (functionCallID, functionArguments) =>
    Console.log(`Hello, ${functionArguments.name}`).pipe(
      Effect.catchAll((err) =>
        Generation.functionError({
          message: "An error occurred while saying hello",
          error: err,
        }),
      ),
      Effect.as({ ok: true }),
    ),
});
```

You can also fail mid-effect, since `Generation.functionError` actually fails the effect:

```typescript
const sayHello = Generation.defineFunction("sayHello", {
  description: "Say hello to the user",
  input: Schema.Struct({ name: Schema.String }),
  function: (functionCallID, functionArguments) =>
    Effect.gen(function* () {
      return yield* Generation.functionError("Whoops!");
    }),
});
```

The payload passed to `Generation.functionError` can be any value, and it is
serialized as JSON and sent to the model, which is notified that an error
occurred.

#### Halting Early

If you want to halt the iteration loop eraly, you can use the
`Generation.haltToolLoop` function:

```typescript
const sayHello = Generation.defineFunction("sayHello", {
  description: "Say hello to the user",
  input: Schema.Struct({ name: Schema.String }),
  function: (functionCallID, functionArguments) =>
    Effect.gen(function* () {
      return yield* Generation.haltToolLoop();
    }),
});
```

This will immediately halt the loop before executing any other function calls
returned by the model in that same loop, and will yield end the stream without
an error.

[^1]:
    There are some caveats to this—for example, the `stream` API doesn't require
    the `maxTokens` parameter, because OpenAI doesn't require it, but the Anthropic
    API will return a 400 if it's not provided.

[^2]:
    You can also use `Generation.defineFunction` with `Generation.stream`,
    because currently, it uses the same parameter type, but doesn't actually
    validate or execute the function calls.
