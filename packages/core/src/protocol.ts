// Contract 8 subset, adapted from pinned Delta source. See NOTICE and docs/core.md.
import { Effect, Schema } from "effect";

const open = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.StructWithRest(Schema.Struct(fields), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]);
const nonempty = Schema.String.check(Schema.isMinLength(1));
const integer = Schema.Finite.check(Schema.makeFilter(Number.isSafeInteger));
const positive = integer.check(Schema.isGreaterThan(0));
const nonnegative = integer.check(Schema.isGreaterThanOrEqualTo(0));
export const Contract = open({
  operation: Schema.Literal("contract"),
  min: nonnegative,
  max: nonnegative,
}).check(Schema.makeFilter((v) => v.max >= v.min));
export class UnsupportedContract extends Schema.TaggedError<
  UnsupportedContract,
  { readonly brand: unique symbol }
>()("UnsupportedContract", { min: Schema.Finite, max: Schema.Finite }) {}
export const negotiate = (input: unknown) =>
  Effect.gen(function* () {
    const range = yield* Schema.decodeUnknownEffect(Contract)(input);
    if (range.min > 8 || range.max < 8)
      return yield* new UnsupportedContract({ min: range.min, max: range.max });
    return 8 as const;
  });
export const ErrorDetail = open({
  code: Schema.String,
  message: Schema.String,
  reason: Schema.optionalKey(Schema.String),
  retryable: Schema.optionalKey(Schema.Boolean),
  retry_after_ms: Schema.optionalKey(
    Schema.Finite.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.makeFilter(Number.isFinite),
    ),
  ),
});
export class DeltaFailure extends Schema.TaggedError<
  DeltaFailure,
  { readonly brand: unique symbol }
>()("DeltaFailure", { error: ErrorDetail }) {}
/** Error envelopes take precedence, including malformed envelopes (never fall through as success). */
export const decodeResponse =
  <S extends Schema.Constraint>(schema: S) =>
  (input: unknown) => {
    if (typeof input === "object" && input !== null && "error" in input)
      return Schema.decodeUnknownEffect(ErrorDetail)(input.error).pipe(
        Effect.flatMap((error) => Effect.fail(new DeltaFailure({ error }))),
      );
    return Schema.decodeUnknownEffect(schema)(input);
  };
export function retryDecision(error: typeof ErrorDetail.Type) {
  if (error.code === "reload_required")
    return { kind: "reload-required" } as const;
  if (error.retryable === true)
    return { kind: "retry", afterMs: error.retry_after_ms ?? 0 } as const;
  return { kind: "stop" } as const;
}
const Turn = open({
  sequence: positive,
  status: Schema.Literals(["running", "finished", "superseded"]),
});
const Producer = Schema.NullOr(
  open({
    source: nonempty,
    external_id: nonempty,
    next_sequence: positive,
    turn: Schema.NullOr(Turn),
    actor_id: Schema.optionalKey(Schema.NullOr(nonempty)),
  }),
);
const InspectionError = open({
  code: Schema.String,
  message: Schema.String,
  reason: Schema.optionalKey(Schema.String),
});
const Checkout = open({
  directory: nonempty,
  state: Schema.Literals(["attached", "inactive", "detached", "missing"]),
  active: Schema.optionalKey(Schema.Boolean),
});
export const Status = open({
  operation: Schema.Literal("status"),
  thread_id: nonempty,
  url: Schema.NullOr(nonempty),
  title: Schema.NullOr(Schema.String),
  access: open({
    state: Schema.Literals(["local_only", "granted"]),
    is_owner: Schema.NullOr(Schema.Boolean),
  }),
  visibility: Schema.NullOr(
    Schema.Literals(["private", "organization", "unlisted"]),
  ),
  upload: Schema.NullOr(
    open({
      state: Schema.Literals(["queued", "uploading", "uploaded", "failed"]),
      organization_id: Schema.NullOr(nonempty),
      error: Schema.NullOr(InspectionError),
    }),
  ),
  worktrees: Schema.Union([
    open({
      status: Schema.Literal("available"),
      items: Schema.Array(
        open({ reference: nonempty, checkouts: Schema.Array(Checkout) }),
      ),
    }),
    open({ status: Schema.Literal("unavailable"), error: InspectionError }),
  ]),
  producer: Producer,
});
export const ProducerTurnEvent = open({
  type: Schema.Literal("producer.turn"),
  ...Turn.schema.fields,
});
/** This slice supports only running/idle state updates, not arbitrary transcript updates. */
export const StateRecord = open({
  schemaVersion: Schema.Literal(1),
  sequence: positive,
  turnSequence: Schema.optionalKey(positive),
  update: open({
    sessionUpdate: Schema.Literal("state_update"),
    state: Schema.Literals(["running", "idle"]),
  }),
}).check(
  Schema.makeFilter((v) =>
    Object.keys(v).every((key) =>
      ["schemaVersion", "sequence", "turnSequence", "update"].includes(key),
    ),
  ),
  Schema.makeFilter(
    (v) =>
      v.turnSequence === undefined ||
      v.turnSequence < v.sequence ||
      (v.turnSequence === v.sequence && v.update.state === "running"),
  ),
);
export const RecordBatch = Schema.Array(StateRecord).check(
  Schema.isMinLength(1),
  Schema.makeFilter((rows) =>
    rows.every(
      (row, i) => i === 0 || row.sequence === (rows[i - 1]?.sequence ?? 0) + 1,
    ),
  ),
);
export const Receipt = open({
  operation: Schema.Literal("appended"),
  thread_id: nonempty,
  sequence: positive,
  next_sequence: positive,
  duplicate: Schema.Boolean,
  disposition: Schema.Literals(["recorded", "fenced", "duplicate"]),
  turn_sequence: Schema.NullOr(positive),
  version: nonempty,
}).check(
  Schema.makeFilter(
    (v) =>
      v.next_sequence > v.sequence &&
      (v.turn_sequence === null || v.turn_sequence <= v.sequence),
  ),
);
export class ReceiptMismatch extends Schema.TaggedError<
  ReceiptMismatch,
  { readonly brand: unique symbol }
>()("ReceiptMismatch", { index: Schema.Finite }) {}
/** Correlates each returned receipt; absent suffix remains pending. No persistence or deletion. */
export const correlateReceipts = (
  thread: string,
  records: unknown,
  receipts: readonly unknown[],
) =>
  Effect.gen(function* () {
    const batch = yield* Schema.decodeUnknownEffect(RecordBatch)(records);
    const fenced: number[] = [];
    for (const [index, input] of receipts.entries()) {
      const receipt = yield* Schema.decodeUnknownEffect(Receipt)(input);
      const record = batch[index];
      if (
        !record ||
        receipt.thread_id !== thread ||
        receipt.sequence !== record.sequence ||
        receipt.turn_sequence !== (record.turnSequence ?? null)
      )
        return yield* new ReceiptMismatch({ index });
      if (receipt.disposition === "fenced" && receipt.turn_sequence !== null)
        fenced.push(receipt.turn_sequence);
    }
    return {
      acknowledged: receipts.length,
      pending: batch.slice(receipts.length).map((row) => row.sequence),
      fenced,
    };
  });
