// AGPL-3.0-only; pinned envelope/append cases adapted as described in NOTICE.
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import { decodeWatchEvent, WatchEvent } from "../src/watch-events.js";
import { retryDecision } from "../src/protocol.js";
import { makeAppendDelivery } from "../src/delivery.js";
import { body, test } from "./delivery-support.js";

it.effect(
  "watch recognizes envelopes by code/message, independently normalizes hints",
  () =>
    Effect.gen(function* () {
      for (const error of [null, {}, { code: 1, message: "x" }, "bad"]) {
        const frame = { type: "live", error };
        const decoded = yield* decodeWatchEvent(frame);
        expect(decoded._tag).toBe("KnownWatchEvent");
        expect(yield* Schema.encodeEffect(WatchEvent)(decoded)).toEqual(frame);
      }
      expect((yield* decodeWatchEvent({ type: "error" }))._tag).toBe(
        "UnknownWatchEvent",
      );
      for (const hints of [
        { reason: 1, retryable: "true", retry_after_ms: -1 },
        { reason: "", retryable: null, retry_after_ms: Infinity },
        { reason: null, retryable: [], retry_after_ms: "2" },
      ]) {
        const failure = yield* Effect.flip(
          decodeWatchEvent({
            error: { code: "reload_required", message: "x", ...hints },
          }),
        );
        expect(failure).toMatchObject({
          _tag: "DeltaFailure",
          error: { code: "reload_required", message: "x" },
        });
        expect(failure).not.toHaveProperty("error.retryable");
        expect(failure).not.toHaveProperty("error.retry_after_ms");
        expect(failure).not.toHaveProperty("error.reason");
      }
      const failure = yield* Effect.flip(
        decodeWatchEvent({
          error: {
            code: "",
            message: "",
            reason: "diagnostic",
            retryable: false,
            retry_after_ms: 0.5,
          },
        }),
      );
      expect(failure).toHaveProperty("error", {
        code: "",
        message: "",
        reason: "diagnostic",
        retryable: false,
        retry_after_ms: 0.5,
      });
      const diagnostic = yield* Effect.flip(
        decodeWatchEvent({
          error: {
            code: "offline",
            message: "x",
            reason: "reload_required",
            retryable: true,
            retry_after_ms: "bad",
          },
        }),
      );
      if (diagnostic._tag === "DeltaFailure")
        expect(retryDecision(diagnostic.error)).toEqual({
          kind: "retry",
          afterMs: 0,
        });
      else throw new Error("expected recognized failure");
      expect(
        yield* Effect.flip(
          decodeWatchEvent({ type: "item", item: {}, error: null }),
        ),
      ).toHaveProperty("_tag", "SchemaError");
    }),
);

for (const mode of [
  "scan-malformed",
  "scan-wrong",
  "scan-multiple",
  "scan-zero",
  "scan-complete-zero",
])
  test(`append compatibility: ${mode}`, ({ store, create }) =>
    Effect.gen(function* () {
      yield* store.stage("a", body);
      yield* store.stage("b", body);
      const service = yield* create(mode);
      const failure = yield* Effect.flip(service.attempt);
      const complete = mode === "scan-complete-zero";
      expect(failure.progress.committed).toEqual(complete ? [1, 2] : [1]);
      expect((yield* store.snapshot).pending).toEqual(complete ? [] : [2]);
      expect(failure.progress.reloadObserved).toBe(true);
      expect(failure.progress.pausePersisted).toBe(true);
      expect((yield* store.snapshot).paused?.message).toBe("first reload");
      expect(failure.progress).toHaveProperty("lastError.code", "offline");
      if (mode.includes("zero")) {
        expect(failure.failure).toMatchObject({
          _tag: "DeliveryValidationError",
          kind: "receipt",
        });
        expect(failure.retry).toEqual({ kind: "unknown" });
      } else {
        expect(failure.failure).toMatchObject({
          _tag: "DeltaFailure",
          error: { code: "offline" },
        });
        expect(failure.retry).toEqual({ kind: "retry", afterMs: 123 });
      }
      if (failure.failure._tag === "DeltaFailure")
        (failure.failure.error as Record<string, unknown>).message =
          "consumer failure mutation";
      if (failure.progress.lastError)
        (failure.progress.lastError as Record<string, unknown>).message =
          "consumer progress mutation";
      const progress = yield* service.progress;
      if (progress.lastError)
        (progress.lastError as Record<string, unknown>).message =
          "consumer mutation";
      expect(yield* service.progress).toHaveProperty(
        "lastError.message",
        "last error",
      );
    }));

for (const mode of ["scan-encoding", "scan-limit"])
  test(`transport failure after decoded reload remains visible: ${mode}`, ({
    store,
    options,
  }) =>
    Effect.gen(function* () {
      yield* store.stage("a", body);
      yield* store.stage("b", body);
      const service = yield* makeAppendDelivery({
        ...options,
        transport: {
          ...options.transport,
          maxFrameBytes: 4096,
          env: { ...options.transport?.env, DELTA_DELIVERY_MODE: mode },
        },
      });
      const failure = yield* Effect.flip(service.attempt);
      expect(failure.failure).toMatchObject({
        _tag: "TransportError",
        kind: mode === "scan-limit" ? "limit" : "encoding",
      });
      expect(failure.progress.committed).toEqual([1]);
      expect(failure.progress.reloadObserved).toBe(true);
      expect(failure.progress.pausePersisted).toBe(true);
      expect(failure.progress).toHaveProperty("lastError.code", "offline");
      expect((yield* store.snapshot).paused?.message).toBe("first reload");
    }));
