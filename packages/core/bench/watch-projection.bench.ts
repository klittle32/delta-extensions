// Repeatable bounded measurements; correctness assertions, no performance thresholds.
import { availableParallelism, cpus } from "node:os";
import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { expect } from "vitest";
import { nodeProcessLayer } from "../src/node.js";
import { makeWatchProjection } from "../src/watch-projection.js";
import { watchThread } from "../src/watch.js";
import { ready, live } from "../test/watch-projection-fixtures.js";
const fixture = fileURLToPath(
  new URL("./watch-projection-benchmark-fixture.mjs", import.meta.url),
);
const known = (value: unknown) => ({ _tag: "KnownWatchEvent", value });
const record = (index: number, size: number) => ({
  type: "item",
  item: {
    id: `i${index}`,
    kind: "message",
    after_id: null,
    turn_id: null,
    author: null,
    created_at: null,
    open: false,
    content: { text: "x".repeat(size) },
  },
});
for (const [count, size, source] of [
  [1000, 1024, "memory"],
  [4000, 1024, "memory"],
  [1000, 4096, "memory"],
  [2000, 4096, "memory"],
  [10000, 200, "child"],
] as const)
  it.live(
    `projection measurement: ${source} ${count} x ${size} UTF-8 bytes`,
    () =>
      Effect.gen(function* () {
        const raw = [
          ready,
          ...Array.from({ length: count }, (_, i) => record(i, size)),
          live,
        ];
        const wireBytes = raw.reduce(
          (n, frame) => n + Buffer.byteLength(JSON.stringify(frame)) + 1,
          0,
        );
        const frames = raw.map(known);
        const runs: {
          ms: number;
          maxEventGapMs: number;
          snapshotMs: number;
        }[] = [];
        for (let repetition = 0; repetition < 3; repetition++) {
          const owner = yield* makeWatchProjection("thread");
          let observed = 0;
          let maxEventGapMs = 0;
          const start = performance.now();
          let last = start;
          const input =
            source === "memory"
              ? Stream.fromIterable(frames)
              : watchThread({
                  executable: fixture,
                  cwd: fileURLToPath(new URL(".", import.meta.url)),
                  binding: {
                    reference: "verified-fixture",
                    source: "letta-code",
                    externalId: "fixture",
                  },
                  // Default 120s/16MiB transport budgets, with no retries or real Delta.
                });
          yield* Stream.runForEach(owner.project(input), () =>
            Effect.sync(() => {
              const now = performance.now();
              maxEventGapMs = Math.max(maxEventGapMs, now - last);
              last = now;
              observed++;
            }),
          );
          const ms = performance.now() - start;
          const snapshotStart = performance.now();
          const state = yield* owner.snapshot;
          const snapshotMs = performance.now() - snapshotStart;
          expect(observed).toBe(count + 2);
          expect(state.items).toHaveLength(count);
          expect(state).toMatchObject({
            phase: "ended",
            end: "eof",
            snapshotComplete: true,
          });
          runs.push({ ms, maxEventGapMs, snapshotMs });
        }
        yield* Effect.sync(() =>
          process.stdout.write(
            "PROJECTION_BENCH " +
              JSON.stringify({
                source,
                count,
                size,
                wireBytes,
                runs,
                environment: {
                  node: process.versions.node,
                  bun: process.versions.bun ?? null,
                  platform: process.platform,
                  arch: process.arch,
                  cpu: cpus()[0]?.model,
                  parallelism: availableParallelism(),
                },
              }) +
              "\n",
          ),
        );
      }).pipe(Effect.provide(nodeProcessLayer)),
    60_000,
  );
