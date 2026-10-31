import { Effect, Schema } from "effect";
import {
  allocateSequence,
  type Event,
  type Identity,
  jsonText,
  OutboxError,
  pending,
  type State,
  type StoredRecord,
} from "./outbox-model.js";
import { ErrorDetail, Receipt } from "./protocol.js";
import { DeltaRecord } from "./records.js";

/** JSON object order is irrelevant; array order and scalar values are not. */
const sameJson = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (Array.isArray(left))
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJson(value, right[index]))
    );
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null ||
    Array.isArray(right)
  )
    return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every(
      (key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]),
    )
  );
};

type Exclusive = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | OutboxError, R>;
export const makeOperations = (
  state: State,
  identity: Identity,
  exclusive: Exclusive,
  commit: (event: typeof Event.Type) => Effect.Effect<void, OutboxError>,
) => {
  const snapshot = exclusive(
    Effect.sync(() => ({
      identity: { ...identity },
      nextSequence: state.nextSequence,
      pending: pending(state).map((row) => row.sequence),
      fenced: [...state.receipts.values()].flatMap((ack) =>
        ack.disposition === "fenced" && ack.turn_sequence !== null
          ? [ack.turn_sequence]
          : [],
      ),
      paused:
        state.paused === null
          ? null
          : (JSON.parse(
              JSON.stringify(state.paused),
            ) as typeof ErrorDetail.Type),
    })),
  );
  const replay = exclusive(
    Effect.gen(function* () {
      if (state.paused) return yield* new OutboxError({ kind: "paused" });
      return pending(state).map((row) => ({ ...row }));
    }),
  );
  const stage = (id: string, body: unknown) =>
    exclusive(
      Effect.gen(function* () {
        if (state.paused) return yield* new OutboxError({ kind: "paused" });
        if (typeof id !== "string" || !id)
          return yield* new OutboxError({ kind: "input" });
        const bodyText = yield* jsonText(body);
        const input: unknown = JSON.parse(bodyText);
        if (
          typeof input !== "object" ||
          input === null ||
          Array.isArray(input) ||
          Object.keys(input).some(
            (key) => !["update", "turnSequence"].includes(key),
          )
        )
          return yield* new OutboxError({ kind: "input" });
        const old = state.records.find((row) => row.id === id);
        const sequence =
          old?.sequence ?? (yield* allocateSequence(state.nextSequence));
        const value = { schemaVersion: 1, sequence, ...input };
        const record = yield* Schema.decodeUnknownEffect(DeltaRecord)(
          value,
        ).pipe(Effect.mapError(() => new OutboxError({ kind: "input" })));
        const line = JSON.stringify(value) + "\n";
        if (new TextEncoder().encode(line).length > 16 * 1024 * 1024)
          return yield* new OutboxError({ kind: "input" });
        if (old) {
          if (old.line !== line)
            return yield* new OutboxError({ kind: "conflict" });
          return { ...old };
        }
        yield* commit({ type: "stage", id, line });
        return {
          id,
          sequence,
          line,
          ...(record.turnSequence === undefined
            ? {}
            : { turnSequence: record.turnSequence }),
        } satisfies StoredRecord;
      }),
    );
  const applyReceipts = (inputs: readonly unknown[]) =>
    exclusive(
      Effect.gen(function* () {
        let applied = 0;
        const fenced: number[] = [];
        for (const input of inputs) {
          const clean = yield* jsonText(input).pipe(
            Effect.mapError(
              () =>
                new OutboxError({
                  kind: "receipt",
                  applied,
                  fenced: [...fenced],
                }),
            ),
          );
          const ack = yield* Schema.decodeUnknownEffect(Receipt)(
            JSON.parse(clean),
          ).pipe(
            Effect.mapError(
              () =>
                new OutboxError({
                  kind: "receipt",
                  applied,
                  fenced: [...fenced],
                }),
            ),
          );
          const existing = state.receipts.get(ack.sequence);
          if (existing) {
            if (!sameJson(existing, ack))
              return yield* new OutboxError({
                kind: "receipt",
                applied,
                fenced: [...fenced],
              });
            if (ack.disposition === "fenced" && ack.turn_sequence !== null)
              fenced.push(ack.turn_sequence);
            continue;
          }
          const row = pending(state)[0];
          if (
            !row ||
            ack.thread_id !== identity.threadId ||
            ack.sequence !== row.sequence ||
            ack.turn_sequence !== (row.turnSequence ?? null)
          )
            return yield* new OutboxError({
              kind: "receipt",
              applied,
              fenced: [...fenced],
            });
          yield* commit({ type: "receipt", receipt: ack }).pipe(
            Effect.mapError(
              (error) =>
                new OutboxError({
                  kind: error.kind,
                  applied,
                  fenced: [...fenced],
                }),
            ),
          );
          applied++;
          if (ack.disposition === "fenced" && ack.turn_sequence !== null)
            fenced.push(ack.turn_sequence);
        }
        return {
          applied,
          pending: pending(state).map((row) => row.sequence),
          fenced,
        };
      }),
    );
  const pauseForReload = (input: unknown) =>
    exclusive(
      Effect.gen(function* () {
        const clean = yield* jsonText(input);
        const error = yield* Schema.decodeUnknownEffect(ErrorDetail)(
          JSON.parse(clean),
        ).pipe(Effect.mapError(() => new OutboxError({ kind: "input" })));
        if (error.code !== "reload_required")
          return yield* new OutboxError({ kind: "input" });
        yield* commit({ type: "pause", error });
      }),
    );
  return { stage, replay, snapshot, applyReceipts, pauseForReload };
};
