import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import {
  Contract,
  correlateReceipts,
  decodeResponse,
  negotiate,
  ProducerTurnEvent,
  Receipt,
  RecordBatch,
  retryDecision,
} from "../src/protocol.js";

const record = {
  schemaVersion: 1,
  sequence: 1,
  turnSequence: 1,
  update: {
    sessionUpdate: "state_update",
    state: "running",
    _meta: { future: true },
  },
};
const receipt = {
  operation: "appended",
  thread_id: "t",
  sequence: 1,
  next_sequence: 2,
  duplicate: false,
  disposition: "recorded",
  turn_sequence: 1,
  version: "actor.42",
};
it.effect("negotiates CLI contract 8 independently of record v1", () =>
  Effect.gen(function* () {
    expect(yield* negotiate({ operation: "contract", min: 8, max: 9 })).toBe(8);
    for (const range of [
      { min: 0, max: 7 },
      { min: 9, max: 10 },
    ])
      expect(
        (yield* Effect.flip(negotiate({ operation: "contract", ...range })))
          ._tag,
      ).toBe("UnsupportedContract");
    expect(yield* Schema.decodeUnknownEffect(RecordBatch)([record])).toEqual([
      record,
    ]);
  }),
);
it.effect("keeps extension fields at every decoded boundary", () =>
  Effect.gen(function* () {
    expect(
      yield* Schema.decodeUnknownEffect(Contract)({
        operation: "contract",
        min: 8,
        max: 8,
        future: 42,
      }),
    ).toHaveProperty("future", 42);
    expect(
      yield* Schema.decodeUnknownEffect(Receipt)({ ...receipt, future: true }),
    ).toHaveProperty("future", true);
  }),
);
it.effect("rejects malformed and unsupported record semantics", () =>
  Effect.gen(function* () {
    for (const value of [
      [],
      [{ ...record, schemaVersion: 8 }],
      [{ ...record, sequence: 0 }],
      [{ ...record, turnSequence: 2 }],
      [{ ...record, update: { sessionUpdate: "future" } }],
      [record, { ...record, sequence: 3 }],
    ]) {
      expect(
        (yield* Effect.flip(Schema.decodeUnknownEffect(RecordBatch)(value)))
          ._tag,
      ).toBe("SchemaError");
    }
  }),
);
it.effect("checks receipt frontier, turn and safe integers", () =>
  Effect.gen(function* () {
    for (const value of [
      { ...receipt, next_sequence: 1 },
      { ...receipt, sequence: 1.5 },
      { ...receipt, turn_sequence: 2 },
      { ...receipt, version: "" },
    ])
      expect(
        (yield* Effect.flip(Schema.decodeUnknownEffect(Receipt)(value)))._tag,
      ).toBe("SchemaError");
  }),
);
it.effect(
  "reports partial receipts and fencing without assuming remainder delivered",
  () =>
    Effect.gen(function* () {
      const records = [record, { ...record, sequence: 2 }];
      expect(yield* correlateReceipts("t", records, [receipt])).toEqual({
        acknowledged: 1,
        pending: [2],
        fenced: [],
      });
      expect(
        yield* correlateReceipts("t", records, [
          receipt,
          { ...receipt, sequence: 2, next_sequence: 3, disposition: "fenced" },
        ]),
      ).toEqual({ acknowledged: 2, pending: [], fenced: [1] });
      expect(
        (yield* Effect.flip(correlateReceipts("wrong", records, [receipt])))
          ._tag,
      ).toBe("ReceiptMismatch");
      expect(
        (yield* Effect.flip(
          correlateReceipts("t", records, [
            { ...receipt, turn_sequence: null },
          ]),
        ))._tag,
      ).toBe("ReceiptMismatch");
    }),
);
it.effect(
  "decodes structured errors without losing retry hints or reload_required",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decodeResponse(Contract)({
          error: {
            code: "reload_required",
            message: "refused",
            retryable: false,
            reason: "opaque",
            future: 1,
          },
        }),
      );
      expect(error._tag).toBe("DeltaFailure");
      if (error._tag === "DeltaFailure") {
        expect(retryDecision(error.error)).toEqual({ kind: "reload-required" });
        expect(error.error).toHaveProperty("future", 1);
      }
      expect(
        retryDecision({
          code: "app_unavailable",
          message: "wait",
          retryable: true,
          retry_after_ms: 1500,
        }),
      ).toEqual({ kind: "retry", afterMs: 1500 });
      expect(retryDecision({ code: "future", message: "unknown" })).toEqual({
        kind: "stop",
      });
      expect(
        (yield* Effect.flip(
          decodeResponse(Contract)({
            error: { code: "x", message: "x", retry_after_ms: -1 },
          }),
        ))._tag,
      ).toBe("SchemaError");
    }),
);
it.effect("validates producer turn event subset", () =>
  Effect.gen(function* () {
    expect(
      yield* Schema.decodeUnknownEffect(ProducerTurnEvent)({
        type: "producer.turn",
        sequence: 1,
        status: "superseded",
      }),
    ).toHaveProperty("status", "superseded");
    expect(
      (yield* Effect.flip(
        Schema.decodeUnknownEffect(ProducerTurnEvent)({
          type: "producer.turn",
          sequence: 0,
          status: "running",
        }),
      ))._tag,
    ).toBe("SchemaError");
  }),
);
it.effect("rejects reversed and fractional contract ranges", () =>
  Effect.gen(function* () {
    for (const range of [
      { min: 9, max: 8 },
      { min: 8.5, max: 9 },
      { min: -1, max: 8 },
    ])
      expect(
        (yield* Effect.flip(negotiate({ operation: "contract", ...range })))
          ._tag,
      ).toBe("SchemaError");
  }),
);
it.effect("rejects receipt reordering and extra receipts", () =>
  Effect.gen(function* () {
    expect(
      (yield* Effect.flip(
        correlateReceipts(
          "t",
          [record],
          [{ ...receipt, sequence: 2, next_sequence: 3 }],
        ),
      ))._tag,
    ).toBe("ReceiptMismatch");
    expect(
      (yield* Effect.flip(correlateReceipts("t", [record], [receipt, receipt])))
        ._tag,
    ).toBe("ReceiptMismatch");
    expect(yield* correlateReceipts("t", [record], [])).toEqual({
      acknowledged: 0,
      pending: [1],
      fenced: [],
    });
  }),
);
it.effect("does not silently accept unsupported control envelopes", () =>
  Effect.gen(function* () {
    for (const value of [
      { ...record, claim: 1 },
      { ...record, turn: { action: "claim" } },
      {
        ...record,
        update: { ...record.update, state: "idle" },
        turnSequence: 1,
      },
    ]) {
      expect(
        yield* Effect.flip(Schema.decodeUnknownEffect(RecordBatch)([value])),
      ).toHaveProperty("_tag", "SchemaError");
    }
  }),
);
