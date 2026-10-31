// AGPL-3.0-only. Adapted contract subset: pinned recording/content.ts, title.ts,
// delivery.ts and outbox.ts. See NOTICE and docs/core.md.
import { Schema } from "effect";

const open = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.StructWithRest(Schema.Struct(fields), [
    Schema.Record(Schema.String, Schema.Json),
  ]);
const id = Schema.String.check(Schema.isMinLength(1));
const sequence = Schema.Finite.check(
  Schema.makeFilter(Number.isSafeInteger),
  Schema.isGreaterThan(0),
);
export const StateUpdate = open({
  sessionUpdate: Schema.Literal("state_update"),
  state: Schema.Literals(["running", "idle"]),
});
const Text = open({ type: Schema.Literal("text"), text: Schema.String });
const MessageUpdate = open({
  sessionUpdate: Schema.Literals([
    "user_message",
    "agent_message",
    "agent_thought",
  ]),
  messageId: id,
  content: Schema.Array(Text),
});
const Diff = open({
  type: Schema.Literal("diff"),
  changes: Schema.Array(
    open({ operation: Schema.Literals(["add", "modify"]), path: id }),
  ),
  patch: Schema.optionalKey(
    open({ format: Schema.Literal("git_patch"), text: Schema.String }),
  ),
});
const ToolUpdate = open({
  sessionUpdate: Schema.Literal("tool_call_update"),
  toolCallId: id,
  status: Schema.Literals(["in_progress", "completed", "failed"]),
  name: Schema.optionalKey(Schema.String),
  rawInput: Schema.optionalKey(Schema.Json),
  rawOutput: Schema.optionalKey(Schema.Json),
  content: Schema.optionalKey(
    Schema.Array(
      Schema.Union([
        open({ type: Schema.Literal("content"), content: Text }),
        Diff,
      ]),
    ),
  ),
});
const TitleUpdate = open({
  sessionUpdate: Schema.Literal("session_info_update"),
  title: Schema.String,
});
export const RecordUpdate = Schema.Union([
  StateUpdate,
  MessageUpdate,
  ToolUpdate,
  TitleUpdate,
]);
const fields = {
  schemaVersion: Schema.Literal(1),
  sequence,
  turnSequence: Schema.optionalKey(sequence),
};
const validTurn = (v: {
  sequence: number;
  turnSequence?: number;
  update: { sessionUpdate: string; [key: string]: unknown };
}) =>
  v.turnSequence === undefined ||
  v.turnSequence < v.sequence ||
  (v.turnSequence === v.sequence &&
    v.update.sessionUpdate === "state_update" &&
    v.update.state === "running");
const validKeys = (v: object) =>
  Object.keys(v).every((key) =>
    ["schemaVersion", "sequence", "turnSequence", "update"].includes(key),
  );
export const DeltaRecord = open({ ...fields, update: RecordUpdate }).check(
  Schema.makeFilter(validKeys),
  Schema.makeFilter(validTurn),
);
export const StateRecord = open({ ...fields, update: StateUpdate }).check(
  Schema.makeFilter(validKeys),
  Schema.makeFilter(validTurn),
);
export const RecordBatch = Schema.Array(DeltaRecord).check(
  Schema.isMinLength(1),
  Schema.makeFilter((rows) =>
    rows.every(
      (row, i) => i === 0 || row.sequence === (rows[i - 1]?.sequence ?? 0) + 1,
    ),
  ),
);
