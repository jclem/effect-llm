import { Data } from "effect";
import type { StreamParams, ToolDefinitionAny } from "../generation.js";

export * as Anthropic from "./anthropic.js";
export * as Google from "./google.js";
export * as OpenAI from "./openai.js";

/**
 * An error indicating that a required parameter is missing.
 *
 * This is needed because params may be missing from both default parameters
 * passed to a provider and from the actual stream call.
 */
export class MissingParameterError extends Data.TaggedError(
  "MissingParameterError",
)<{
  parameter: string;
}> {}

export type DefaultParams = Partial<
  Pick<
    StreamParams<readonly ToolDefinitionAny[]>,
    | "apiKey"
    | "model"
    | "maxTokens"
    | "maxIterations"
    | "system"
    | "additionalParameters"
  >
>;

export const mergeParams = <
  A extends { additionalParameters?: Record<string, unknown> | undefined },
  B extends { additionalParameters?: Record<string, unknown> | undefined },
>(
  a: A | undefined,
  b: B | undefined,
): A & B => {
  return {
    ...a,
    ...b,
    additionalParameters: {
      ...a?.additionalParameters,
      ...b?.additionalParameters,
    },
  } as A & B;
};
