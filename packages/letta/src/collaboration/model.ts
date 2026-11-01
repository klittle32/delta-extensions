import { Schema } from "effect";
export class CollaborationError extends Schema.TaggedError<
  CollaborationError,
  { readonly brand: unique symbol }
>()("CollaborationError", { message: Schema.String }) {}
export const Binding = Schema.Struct({
  version: Schema.Literal(1),
  agent: Schema.String,
  conversation: Schema.String,
  cwd: Schema.String,
  externalId: Schema.String,
  owner: Schema.String,
  thread: Schema.optionalKey(Schema.String),
  worktree: Schema.optionalKey(Schema.String),
  snapshot: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  recovery: Schema.optionalKey(
    Schema.Struct({
      choice: Schema.Literals(["fork", "discard"]),
      phase: Schema.Literals([
        "planned",
        "fork-started",
        "forked",
        "discard-started",
        "discarded",
      ]),
      forked: Schema.optionalKey(Schema.String),
    }),
  ),
  remoteContext: Schema.optionalKey(
    Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String })),
  ),
  remoteReceipts: Schema.optionalKey(Schema.Array(Schema.String)),
  remoteOmitted: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  tools: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        turn: Schema.Finite,
        name: Schema.String,
        omitted: Schema.Boolean,
        ended: Schema.Boolean,
        input: Schema.optionalKey(Schema.Json),
        output: Schema.optionalKey(Schema.Json),
        status: Schema.optionalKey(Schema.Literals(["success", "error"])),
      }),
    ),
  ),
  pendingIdle: Schema.optionalKey(Schema.Finite),
  snapshotDone: Schema.Boolean,
  uploaded: Schema.Boolean,
  organization: Schema.optionalKey(Schema.String),
  visibility: Schema.optionalKey(Schema.Literals(["private", "organization"])),
  pending: Schema.optionalKey(
    Schema.Struct({
      token: Schema.String,
      created: Schema.Finite,
      locator: Schema.String,
      directory: Schema.optionalKey(Schema.String),
      claimed: Schema.Boolean,
    }),
  ),
});
export type Binding = typeof Binding.Type;
export const externalId = (agent: string, conversation: string) =>
  `letta:${encodeURIComponent(agent)}:${encodeURIComponent(conversation)}`;
