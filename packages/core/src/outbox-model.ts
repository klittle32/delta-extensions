import { Effect, Schema } from "effect";
import { ErrorDetail, Receipt } from "./protocol.js";
import { DeltaRecord } from "./records.js";
export class OutboxError extends Schema.TaggedError<
  OutboxError,
  { readonly brand: unique symbol }
>()("OutboxError", {
  kind: Schema.Literals([
    "configuration",
    "storage",
    "locked",
    "identity",
    "corrupt",
    "conflict",
    "closed",
    "paused",
    "receipt",
    "sequence",
    "input",
  ]),
  applied: Schema.optionalKey(Schema.Finite),
  fenced: Schema.optionalKey(Schema.Array(Schema.Finite)),
}) {}
const id = Schema.String.check(Schema.isMinLength(1));
const integer = Schema.Finite.check(
  Schema.makeFilter(Number.isSafeInteger),
  Schema.isGreaterThanOrEqualTo(0),
);
export const Identity = Schema.Struct({
  source: id,
  externalId: id,
  threadId: id,
  scopeId: id,
});
export type Identity = typeof Identity.Type;
export const Head = Schema.Struct({
  format: Schema.Literal(1),
  identity: Identity,
  transaction: integer,
  digest: id,
});
export const Event = Schema.Union([
  Schema.Struct({ type: Schema.Literal("stage"), id, line: Schema.String }),
  Schema.Struct({ type: Schema.Literal("receipt"), receipt: Receipt }),
  Schema.Struct({ type: Schema.Literal("pause"), error: ErrorDetail }),
]);
export const Transaction = Schema.Struct({
  format: Schema.Literal(1),
  index: integer,
  previous: id,
  event: Event,
});
export type StoredRecord = {
  readonly id: string;
  readonly sequence: number;
  readonly line: string;
  readonly turnSequence?: number;
};
export type State = {
  nextSequence: number;
  records: StoredRecord[];
  receipts: Map<number, typeof Receipt.Type>;
  paused: typeof ErrorDetail.Type | null;
};
export const initialState = (): State => ({
  nextSequence: 1,
  records: [],
  receipts: new Map(),
  paused: null,
});
/** Refuse the last safe integer: its following frontier would not be representable. */
export const allocateSequence = (next: number) =>
  Number.isSafeInteger(next) && next > 0 && next < Number.MAX_SAFE_INTEGER
    ? Effect.succeed(next)
    : Effect.fail(new OutboxError({ kind: "sequence" }));
export const pending = (state: State) =>
  state.records.filter((row) => !state.receipts.has(row.sequence));
export const decodeLine = (line: string) =>
  Effect.gen(function* () {
    if (new TextEncoder().encode(line).length > 16 * 1024 * 1024)
      return yield* new OutboxError({ kind: "input" });
    const value = yield* Schema.decodeEffect(
      Schema.fromJsonString(Schema.Json),
    )(line);
    if (JSON.stringify(value) + "\n" !== line)
      return yield* new OutboxError({ kind: "corrupt" });
    return yield* Schema.decodeUnknownEffect(DeltaRecord)(value);
  }).pipe(Effect.mapError(() => new OutboxError({ kind: "corrupt" })));
export const applyEvent = (state: State, event: typeof Event.Type) =>
  Effect.gen(function* () {
    if (event.type === "stage") {
      const record = yield* decodeLine(event.line);
      if (
        state.paused ||
        state.records.some((row) => row.id === event.id) ||
        record.sequence !== state.nextSequence
      )
        return yield* new OutboxError({ kind: "corrupt" });
      yield* allocateSequence(record.sequence);
      state.records.push({
        id: event.id,
        sequence: record.sequence,
        line: event.line,
        ...(record.turnSequence === undefined
          ? {}
          : { turnSequence: record.turnSequence }),
      });
      state.nextSequence++;
    } else if (event.type === "receipt") {
      const row = pending(state)[0];
      const ack = event.receipt;
      if (
        !row ||
        ack.sequence !== row.sequence ||
        ack.turn_sequence !== (row.turnSequence ?? null)
      )
        return yield* new OutboxError({ kind: "corrupt" });
      state.receipts.set(row.sequence, ack);
    } else {
      if (event.error.code !== "reload_required")
        return yield* new OutboxError({ kind: "corrupt" });
      state.paused = event.error;
    }
  });
/** Reject lossy JSON serialization (undefined, NaN, class instances, cycles). */
export const jsonText = (value: unknown) =>
  Effect.try({
    try: () => {
      const ancestors = new Set<object>();
      const visit = (v: unknown, depth: number): void => {
        if (depth > 128) throw new Error();
        if (v === null || typeof v === "string" || typeof v === "boolean")
          return;
        if (typeof v === "number" && Number.isFinite(v)) return;
        if (
          typeof v !== "object" ||
          v === null ||
          ancestors.has(v) ||
          (!Array.isArray(v) &&
            Object.getPrototypeOf(v) !== Object.prototype &&
            Object.getPrototypeOf(v) !== null)
        )
          throw new Error();
        if (
          Object.getOwnPropertySymbols(v).length ||
          (Array.isArray(v) && Object.keys(v).length !== v.length)
        )
          throw new Error();
        ancestors.add(v);
        for (const child of Object.values(v)) visit(child, depth + 1);
        ancestors.delete(v);
      };
      visit(value, 0);
      return JSON.stringify(value);
    },
    catch: () => new OutboxError({ kind: "input" }),
  });
