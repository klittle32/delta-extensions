// AGPL-3.0-only; adapted pinned snapshot/reset cases and original ownership tests. See NOTICE.
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { expect } from "vitest";
import fixtures from "./fixtures/watch-events.json" with { type: "json" };
import { makeWatchProjection } from "../src/watch-projection.js";
import {
  ready,
  live,
  item,
  comment,
  events,
} from "./watch-projection-fixtures.js";
it.effect(
  "refresh snapshots replace inventories and do not complete until live",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeWatchProjection("thread");
      yield* Stream.runDrain(
        owner.project(events(ready, item("old"), comment("old"), live)),
      );
      const seen = yield* Stream.runCollect(
        owner
          .project(events(ready, item("new"), live))
          .pipe(Stream.mapEffect(() => owner.snapshot)),
      );
      expect(seen[0]).toMatchObject({
        phase: "snapshot",
        snapshotComplete: false,
        items: [],
        comments: [],
        presence: null,
        children: [],
      });
      expect((yield* owner.snapshot).items.map((i) => i.id)).toEqual(["new"]);
    }),
);
it.effect(
  "input and public snapshots cannot mutate the owner's state or previous emissions",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeWatchProjection("thread");
      const frame = item("a");
      const seen = yield* Stream.runCollect(
        owner.project(
          events(
            ready,
            frame,
            { type: "item.append", id: "a", text: "!" },
            live,
          ),
        ),
      );
      frame.item.content.opaque.keep.push("changed");
      const firstItem = seen[1];
      if (!firstItem || firstItem.event.type !== "item")
        throw new Error("expected item update");
      expect(firstItem.event.item.content.text).toBe("a");
      const state = yield* owner.snapshot;
      expect(Object.isFrozen(state)).toBe(true);
      expect(Object.isFrozen(state.items[0]?.content)).toBe(true);
      expect(() =>
        Object.assign(state.items[0]?.content ?? {}, { text: "bad" }),
      ).toThrow();
      expect((yield* owner.snapshot).items[0]?.content).toEqual({
        text: "a!",
        opaque: { keep: [1, "🙂"] },
      });
    }),
);
for (const mode of ["failure", "interrupt", "take"] as const)
  it.effect(`termination preserves incomplete staged facts: ${mode}`, () =>
    Effect.gen(function* () {
      const owner = yield* makeWatchProjection("thread");
      const arrived = yield* Deferred.make<void>();
      const input = events(ready, item("a")).pipe(
        Stream.concat(mode === "failure" ? Stream.fail("reset") : Stream.never),
      );
      if (mode === "failure")
        expect(yield* Effect.flip(Stream.runDrain(owner.project(input)))).toBe(
          "reset",
        );
      else if (mode === "take")
        yield* Stream.runDrain(owner.project(input).pipe(Stream.take(2)));
      else {
        const fiber = yield* Stream.runDrain(
          owner
            .project(input)
            .pipe(
              Stream.tap((s) =>
                s.event.type === "item"
                  ? Deferred.succeed(arrived, undefined)
                  : Effect.void,
              ),
            ),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(arrived);
        yield* Fiber.interrupt(fiber);
      }
      expect(yield* owner.snapshot).toMatchObject({
        phase: "ended",
        snapshotComplete: false,
        items: [{ id: "a" }],
        end:
          mode === "failure"
            ? "failed"
            : mode === "interrupt"
              ? "interrupted"
              : "stopped",
      });
    }),
  );
it.effect(
  "one owner refuses simultaneous streams; cancellation releases admission; other owners are independent",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeWatchProjection("thread");
      const first = yield* Deferred.make<void>();
      const fiber = yield* Stream.runDrain(
        owner
          .project(events(ready).pipe(Stream.concat(Stream.never)))
          .pipe(Stream.tap(() => Deferred.succeed(first, undefined))),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(first);
      expect(
        yield* Effect.flip(Stream.runDrain(owner.project(events(ready, live)))),
      ).toMatchObject({ kind: "busy" });
      const other = yield* makeWatchProjection("thread");
      yield* Stream.runDrain(other.project(events(ready, item("other"), live)));
      expect((yield* owner.snapshot).phase).toBe("snapshot");
      yield* Fiber.interrupt(fiber);
      yield* Stream.runDrain(owner.project(events(ready, live)));
      expect((yield* owner.snapshot).items).toEqual([]);
      expect((yield* other.snapshot).items[0]?.id).toBe("other");
    }),
);
it.effect(
  "turn/worktrees retain last-known facts on refresh but mark them unreported",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeWatchProjection("thread");
      const turn = { type: "turn", state: "idle", turn_id: null, user: null };
      const trees = [{ reference: "opaque", name: "known" }];
      yield* Stream.runDrain(
        owner.project(
          events(ready, turn, { type: "worktrees", worktrees: trees }, live),
        ),
      );
      const next = yield* Stream.runCollect(
        owner
          .project(events(ready, live))
          .pipe(Stream.mapEffect(() => owner.snapshot)),
      );
      expect(next[0]).toMatchObject({
        turn,
        worktrees: trees,
        reported: { turn: false, worktrees: false },
      });
    }),
);
it.effect(
  "ready retains producer frontier facts and overrides pre-ready producer turn without claiming ownership",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeWatchProjection("thread");
      const boundReady = {
        ...ready,
        producer: {
          source: "letta-code",
          external_id: "explicit",
          next_sequence: 17,
          actor_id: null,
          turn: { sequence: 9, status: "finished" },
          future: true,
        },
      };
      const states = yield* Stream.runCollect(
        owner.project(
          events(
            { type: "producer.turn", sequence: 10, status: "running" },
            boundReady,
            live,
          ),
        ),
      );
      expect(states[0]).toMatchObject({
        phase: "awaiting-ready",
        snapshotComplete: false,
        event: { type: "producer.turn", sequence: 10 },
      });
      expect(yield* owner.snapshot).toMatchObject({
        ready: boundReady,
        producerTurn: { sequence: 9, status: "finished" },
      });
      expect(yield* owner.snapshot).not.toHaveProperty("ownTurnId");
    }),
);
it.effect(
  "post-live structured reset preserves complete inventory but ends liveness and returns original failure",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeWatchProjection("thread");
      const error = {
        code: "watch_reset",
        message: "reset",
        retryable: true,
        retry_after_ms: 200,
      };
      const failure = yield* Effect.flip(
        Stream.runDrain(
          owner.project(events(ready, item("a"), live, { error })),
        ),
      );
      expect(failure).toMatchObject({ _tag: "DeltaFailure", error });
      expect(yield* owner.snapshot).toMatchObject({
        phase: "ended",
        end: "failed",
        snapshotComplete: true,
        items: [{ id: "a" }],
      });
    }),
);
it.effect(
  "incomplete refresh cannot relabel previous complete inventory as a fresh snapshot",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeWatchProjection("thread");
      yield* Stream.runDrain(owner.project(events(ready, item("old"), live)));
      yield* Effect.exit(
        Stream.runDrain(owner.project(events(ready, item("new")))),
      );
      expect(yield* owner.snapshot).toMatchObject({
        phase: "ended",
        snapshotComplete: false,
        items: [{ id: "new" }],
      });
    }),
);
it.effect(
  "children full reports replace inventory, child upsert preserves index and removes all matching ids",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeWatchProjection("thread");
      const child = {
        thread_id: "a",
        reference: "opaque",
        name: "",
        kind: "future",
        status: "future",
      };
      const states = yield* Stream.runCollect(
        owner
          .project(
            events(
              ready,
              {
                type: "children",
                children: [child, { ...child, name: "duplicate" }],
              },
              { type: "child", child: { ...child, name: "changed" } },
              { type: "child.remove", thread_id: "a" },
              { type: "children", children: [child] },
              { type: "children", children: [] },
              live,
            ),
          )
          .pipe(Stream.mapEffect(() => owner.snapshot)),
      );
      expect(states[2]?.children.map((c) => c.name)).toEqual([
        "changed",
        "duplicate",
      ]);
      expect(states[3]?.children).toEqual([]);
      expect((yield* owner.snapshot).children).toEqual([]);
    }),
);
it.effect(
  "invalid binding and non-cloneable caller values fail visibly without changing inventory",
  () =>
    Effect.gen(function* () {
      expect(yield* Effect.flip(makeWatchProjection(""))).toMatchObject({
        kind: "configuration",
      });
      const owner = yield* makeWatchProjection("thread");
      const frame = item("a");
      Object.assign(frame.item.content, { unsupported: () => undefined });
      expect(
        yield* Effect.flip(
          Stream.runDrain(owner.project(events(ready, frame, live))),
        ),
      ).toMatchObject({ kind: "uncloneable-event" });
      expect((yield* owner.snapshot).items).toEqual([]);
    }),
);
it.effect(
  "adapted pinned frames form a snapshot/live attempt ending in the structured terminal error",
  () =>
    Effect.gen(function* () {
      const first = fixtures[0];
      if (!first || !("thread_id" in first))
        throw new Error("missing pinned ready");
      const owner = yield* makeWatchProjection(first.thread_id);
      const seen: string[] = [];
      const result = yield* Effect.result(
        Stream.runDrain(
          owner
            .project(
              events(
                ...fixtures.filter(
                  (frame, index) => index !== 0 && !("error" in frame),
                ),
                ...fixtures.filter((frame) => "error" in frame),
              ),
            )
            .pipe(
              Stream.tap((s) =>
                Effect.sync(() => {
                  seen.push(s.phase);
                }),
              ),
            ),
        ),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "DeltaFailure" },
      });
      const state = yield* owner.snapshot;
      expect(state).toMatchObject({
        phase: "ended",
        end: "failed",
        snapshotComplete: true,
      });
      expect(seen).toContain("snapshot");
      expect(seen).toContain("live");
    }),
);
it.effect(
  "schema failure after staged items preserves partial facts and original decode failure",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeWatchProjection("thread");
      expect(
        yield* Effect.flip(
          Stream.runDrain(
            owner.project(
              events(ready, item("a"), { type: "turn", state: "invalid" }),
            ),
          ),
        ),
      ).toMatchObject({ _tag: "SchemaError" });
      expect(yield* owner.snapshot).toMatchObject({
        phase: "ended",
        snapshotComplete: false,
        items: [{ id: "a" }],
      });
    }),
);
it.effect(
  "projection is cold and the same stream can be sequentially rematerialized",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeWatchProjection("thread");
      const projected = owner.project(events(ready, item("a"), live));
      expect((yield* owner.snapshot).phase).toBe("idle");
      yield* Stream.runDrain(projected);
      yield* Stream.runDrain(projected);
      expect((yield* owner.snapshot).items.map((i) => i.id)).toEqual(["a"]);
    }),
);
it.effect(
  "refresh failure before ready marks previous inventory stale without declaring it complete",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeWatchProjection("thread");
      yield* Stream.runDrain(owner.project(events(ready, item("old"), live)));
      expect(
        yield* Effect.flip(
          Stream.runDrain(owner.project(Stream.fail("spawn-failed"))),
        ),
      ).toBe("spawn-failed");
      expect(yield* owner.snapshot).toMatchObject({
        phase: "ended",
        end: "failed",
        ready: null,
        snapshotComplete: false,
        items: [{ id: "old" }],
      });
    }),
);
it.effect(
  "interruption after live keeps snapshot completion as history but not current liveness",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeWatchProjection("thread");
      const becameLive = yield* Deferred.make<void>();
      const fiber = yield* Stream.runDrain(
        owner
          .project(
            events(ready, item("a"), live).pipe(Stream.concat(Stream.never)),
          )
          .pipe(
            Stream.tap((state) =>
              state.phase === "live"
                ? Deferred.succeed(becameLive, undefined)
                : Effect.void,
            ),
          ),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(becameLive);
      yield* Fiber.interrupt(fiber);
      expect(yield* owner.snapshot).toMatchObject({
        phase: "ended",
        end: "interrupted",
        snapshotComplete: true,
        items: [{ id: "a" }],
      });
    }),
);
it.effect("non-JSON shared memory cannot bypass opaque-field ownership", () =>
  Effect.gen(function* () {
    const owner = yield* makeWatchProjection("thread");
    const frame = item("a");
    Object.assign(frame.item.content, { shared: new SharedArrayBuffer(1) });
    expect(
      yield* Effect.flip(
        Stream.runDrain(owner.project(events(ready, frame, live))),
      ),
    ).toMatchObject({ kind: "invalid-json-value" });
    expect((yield* owner.snapshot).items).toEqual([]);
  }),
);
