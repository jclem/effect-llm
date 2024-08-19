import { BunContext } from "@effect/platform-bun";
import {
  afterEach as bunAfterEach,
  describe as bunDescribe,
  expect as bunExpect,
  it as bunIt,
} from "bun:test";
import { Effect, Either, Function, Match, Types } from "effect";

export const describe = bunDescribe;

export const expect = bunExpect;

export const it = (
  label: string,
  effect: Effect.Effect<void, unknown, BunContext.BunContext>,
) =>
  bunIt(label, async () => {
    await Effect.runPromise(effect.pipe(Effect.provide(BunContext.layer)));
  });

export const afterEach = (
  effect: Effect.Effect<void, unknown, BunContext.BunContext>,
) =>
  bunAfterEach(async () => {
    await Effect.runPromise(effect.pipe(Effect.provide(BunContext.layer)));
  });

export const getError = <A, E, S>(effect: Effect.Effect<A, E, S>) =>
  effect.pipe(
    Effect.either,
    Effect.map(Either.flip),
    Effect.map(Either.getOrThrow),
  );

export const expectErrorTag =
  <E, P extends Match.Types.Tags<"_tag", E> & string>(
    ...pattern: [first: P, ...values: Array<P>]
  ) =>
  <A, S>(effect: Effect.Effect<A, E, S>) =>
    effect.pipe(
      getError,
      Effect.map(
        Match.type<E>().pipe(
          Match.tag(...pattern, Function.constant(Effect.void)),
          Match.orElseAbsurd,
        ),
      ),
    );

export const matchErrorTag =
  <E, P extends Match.Types.Tags<"_tag", E> & string, Ret, B extends Ret>(
    ...pattern: [
      first: P,
      ...values: Array<P>,
      f: (_: Extract<Types.NoInfer<E>, Record<"_tag", P>>) => B,
    ]
  ) =>
  <A, S>(effect: Effect.Effect<A, E, S>) =>
    effect.pipe(
      getError,
      Effect.map(
        Match.type<E>().pipe(Match.tag(...pattern), Match.orElseAbsurd),
      ),
    );
