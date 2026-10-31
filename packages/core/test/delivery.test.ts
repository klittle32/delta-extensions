import { Effect } from "effect";
import { expect } from "vitest";
import { makeAppendDelivery } from "../src/delivery.js";
import { body, test } from "./delivery-support.js";

test("empty outbox does not invoke contract or append", ({
  temp,
  fs,
  create,
}) =>
  Effect.gen(function* () {
    const service = yield* create();
    expect((yield* service.attempt).status).toBe("empty");
    expect(yield* fs.exists(`${temp}/calls.jsonl`)).toBe(false);
  }));
for (const acknowledgement of ["server", "local"] as const)
  test(`actual argv and immutable input with explicit ${acknowledgement} acknowledgement`, ({
    temp,
    fs,
    store,
    options,
  }) =>
    Effect.gen(function* () {
      const first = yield* store.stage("a", body);
      const second = yield* store.stage("b", {
        update: {
          sessionUpdate: "agent_message",
          messageId: "m",
          content: [{ type: "text", text: "🙂é\r\n" }],
        },
        turnSequence: 1,
      });
      const service = yield* makeAppendDelivery({
        ...options,
        acknowledgement,
      });
      const result = yield* service.attempt;
      expect(result.status).toBe("complete");
      expect(result.progress.committed).toEqual([1, 2]);
      expect(result.progress.acknowledgement).toBe(acknowledgement);
      const calls = (yield* fs.readFileString(`${temp}/calls.jsonl`))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls[0].args).toEqual(["--json", "thread", "contract"]);
      expect(calls[1]).toEqual({
        cwd: temp,
        input: first.line + second.line,
        args: [
          "--json",
          "thread",
          "append",
          options.reference,
          "--source",
          "letta-code",
          "--external-id",
          "producer-🙂",
          ...(acknowledgement === "local" ? ["--acknowledge", "local"] : []),
          "--producer-name",
          options.producerName,
        ],
      });
      expect(yield* store.replay).toEqual([]);
    }));
test("incompatible contract prevents append", ({ temp, fs, store, create }) =>
  Effect.gen(function* () {
    yield* store.stage("a", body);
    const service = yield* create("incompatible");
    expect((yield* Effect.flip(service.attempt)).failure).toHaveProperty(
      "_tag",
      "UnsupportedContract",
    );
    expect(
      (yield* fs.readFileString(`${temp}/calls.jsonl`)).trim().split("\n"),
    ).toHaveLength(1);
    expect(yield* store.replay).toHaveLength(1);
  }));
for (const mode of ["duplicate", "fenced"])
  test(`${mode} receipts are durably retained`, ({ store, create }) =>
    Effect.gen(function* () {
      yield* store.stage("a", body);
      const service = yield* create(mode);
      const result = yield* service.attempt;
      expect(result.progress.committed).toEqual([1]);
      expect(result.progress.fenced).toEqual(mode === "fenced" ? [1] : []);
      expect((yield* store.snapshot).fenced).toEqual(
        mode === "fenced" ? [1] : [],
      );
    }));
for (const mode of [
  "partial",
  "empty",
  "malformed",
  "unknown",
  "wrong",
  "reorder",
  "extra",
  "nonzero",
  "retry",
  "reload",
])
  test(`durable receipt prefix survives ${mode}`, ({ store, create }) =>
    Effect.gen(function* () {
      yield* store.stage("a", body);
      yield* store.stage("b", body);
      const service = yield* create(mode);
      const error = yield* Effect.flip(service.attempt);
      const tag = ["partial", "empty", "wrong", "reorder", "extra"].includes(
        mode,
      )
        ? "DeliveryValidationError"
        : ["retry", "reload"].includes(mode)
          ? "DeltaFailure"
          : mode === "nonzero"
            ? "TransportError"
            : "SchemaError";
      expect(error.failure).toHaveProperty("_tag", tag);
      const committed = mode === "empty" ? [] : mode === "extra" ? [1, 2] : [1];
      expect(error.progress.committed).toEqual(committed);
      expect(error.progress.remainingBatch).toEqual(
        [1, 2].slice(committed.length),
      );
      expect((yield* store.snapshot).pending).toEqual(
        [1, 2].slice(committed.length),
      );
      if (mode === "reload") {
        expect(error.progress.pausePersisted).toBe(true);
        expect((yield* store.snapshot).paused).toHaveProperty(
          "code",
          "reload_required",
        );
      }
      if (mode === "retry")
        expect(error.retry).toEqual({ kind: "retry", afterMs: 123 });
    }));
