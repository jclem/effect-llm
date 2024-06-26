import { Data } from "effect";

/**
 * The entity that a message is attributed to
 */
export enum Role {
  User = "user",
  Assistant = "assistant",
  System = "system",
}

/**
 * A message that was sent by a user
 */
export class UserMessage extends Data.TaggedClass("UserMessage")<{
  readonly content: string;
}> {
  readonly role = Role.User;
}

/**
 * A message that was sent by an assistant
 */
export class AssistantMessage extends Data.TaggedClass("AssistantMessage")<{
  readonly content: string;
}> {
  readonly role = Role.Assistant;
}

/**
 * A message attributed to the system that is managing the thread
 *
 * NOTE: Not all providers support interleaved system messages, so some
 * providers may have concatenate system message content and provide them to the
 * model via other means.
 */
export class SystemMessage extends Data.TaggedClass("SystemMessage")<{
  readonly content: string;
}> {
  readonly role = Role.System;
}

/**
 * A request to invoke a tool by an assistant
 */
export class ToolUseEvent<Name extends string, Input> extends Data.TaggedClass(
  "ToolUseEvent",
)<{
  readonly id: string;
  readonly name: Name;
  readonly input: Input;
}> {}

/**
 * The result of a successful tool invocation
 */
export class ToolResultSuccessEvent<Output> extends Data.TaggedClass(
  "ToolResultSuccessEvent",
)<{
  readonly id: string;
  readonly result: Output;
}> {}

/**
 * The result of an unsuccessful tool invocation
 */
export class ToolResultErrorEvent<Output> extends Data.TaggedClass(
  "ToolResultErrorEvent",
)<{
  readonly id: string;
  readonly result: Output;
}> {}

/**
 * An event that occurred in a thread
 */
export type ThreadEvent =
  | UserMessage
  | AssistantMessage
  | SystemMessage
  | ToolUseEvent<string, unknown>
  | ToolResultSuccessEvent<unknown>
  | ToolResultErrorEvent<unknown>;
