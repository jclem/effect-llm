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
  readonly parameter: string;
}> {
  readonly message = `Missing required parameter: ${this.parameter}`;
}

/**
 * Default parameters that can be passed to a provider
 */
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
