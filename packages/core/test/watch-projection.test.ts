// AGPL-3.0-only; adapted RemoteView/watch consumer cases. See NOTICE.
import { it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { expect } from "vitest";
import {
  makeWatchProjection,
  commentContext,
} from "../src/watch-projection.js";
import {
  ready,
  live,
  item,
  user,
  comment,
  events,
} from "./watch-projection-fixtures.js";
it.effect(
  "snapshot stages until live; EOF disconnects without erasing completed facts",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeWatchProjection("thread");
      const seen = yield* Stream.runCollect(
        owner.project(events(ready, item("a"), live)),
      );
      expect(seen.map((s) => [s.phase, s.snapshotComplete])).toEqual([
        ["snapshot", false],
        ["snapshot", false],
        ["live", true],
      ]);
      expect(yield* owner.snapshot).toMatchObject({
        phase: "ended",
        end: "eof",
        snapshotComplete: true,
        ready,
      });
    }),
);
for (const frames of [[], [ready], [ready, item("a")]])
  it.effect(`incomplete snapshot fails at EOF (${frames.length} frames)`, () =>
    Effect.gen(function* () {
      const owner = yield* makeWatchProjection("thread");
      expect(
        yield* Effect.flip(Stream.runDrain(owner.project(events(...frames)))),
      ).toMatchObject({
        _tag: "WatchProjectionError",
        kind: "incomplete-snapshot",
      });
      expect(yield* owner.snapshot).toMatchObject({
        phase: "ended",
        snapshotComplete: false,
        end: "failed",
      });
    }),
  );
it.effect(
  "upserts keep first arrival order, ignore after_id sorting, append opaque content and remove/reinsert",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeWatchProjection("thread");
      yield* Stream.runDrain(
        owner.project(
          events(
            ready,
            item("b", "B", "a"),
            item("a"),
            item("b", "edit"),
            live,
            { type: "item.append", id: "b", text: "🙂" },
            { type: "remove", id: "absent" },
          ),
        ),
      );
      const state = yield* owner.snapshot;
      expect(state.items.map((i) => i.id)).toEqual(["b", "a"]);
      expect(state.items[0]?.content).toEqual({
        text: "edit🙂",
        opaque: { keep: [1, "🙂"] },
      });
      const next = yield* makeWatchProjection("thread");
      yield* Stream.runDrain(
        next.project(
          events(
            ready,
            item("a"),
            item("b"),
            { type: "remove", id: "a" },
            item("a", 42),
            { type: "item.append", id: "a", text: "text" },
            live,
          ),
        ),
      );
      expect(
        (yield* next.snapshot).items.map((i) => [i.id, i.content.text]),
      ).toEqual([
        ["b", "b"],
        ["a", "text"],
      ]);
    }),
);
it.effect(
  "comments retain chains, target inheritance and parent lookup without cascading removals",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeWatchProjection("thread");
      yield* Stream.runDrain(
        owner.project(
          events(
            ready,
            comment("root"),
            comment("reply", "root", "root"),
            comment("root"),
            live,
          ),
        ),
      );
      const before = yield* owner.snapshot;
      const reply = before.comments[1];
      if (!reply) throw new Error("missing reply");
      expect(commentContext(before, reply.id)).toMatchObject({
        parent: { id: "root" },
        target: { _tag: "UnknownCommentTarget", value: { kind: "future" } },
      });
      const removed = yield* makeWatchProjection("thread");
      yield* Stream.runDrain(
        removed.project(
          events(
            ready,
            comment("root"),
            comment("reply", "root", "root"),
            { type: "comment.remove", id: "root" },
            { type: "remove", id: "i" },
            live,
          ),
        ),
      );
      const after = yield* removed.snapshot;
      expect(after.comments.map((c) => c.id)).toEqual(["reply"]);
      expect(commentContext(after, "reply")).toEqual({
        parent: undefined,
        target: undefined,
      });
    }),
);
it.effect(
  "raw presence/turn/producer/children/worktrees facts update independently without authority inference",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeWatchProjection("thread");
      const child = (id: string) => ({
        thread_id: id,
        reference: `opaque/${id}`,
        name: id,
        kind: "future",
        status: "future",
      });
      yield* Stream.runDrain(
        owner.project(
          events(
            { type: "producer.turn", sequence: 2, status: "running" },
            ready,
            { type: "turn", state: "running", turn_id: "remote", user },
            { type: "producer.turn", sequence: 3, status: "superseded" },
            { type: "presence", users: [user] },
            { type: "presence", users: [] },
            { type: "children", children: [child("a"), child("b")] },
            { type: "child", child: { ...child("a"), name: "changed" } },
            { type: "child.remove", thread_id: "b" },
            { type: "child", child: child("c") },
            {
              type: "worktrees",
              worktrees: [{ reference: "opaque", name: "" }],
            },
            live,
          ),
        ),
      );
      expect(yield* owner.snapshot).toMatchObject({
        ready,
        producerTurn: { sequence: 3, status: "superseded" },
        turn: { turn_id: "remote" },
        presence: [],
        children: [{ thread_id: "a", name: "changed" }, { thread_id: "c" }],
        worktrees: [{ reference: "opaque", name: "" }],
      });
    }),
);
for (const [frames, kind] of [
  [[live], "before-ready"],
  [[item("a")], "before-ready"],
  [[ready, ready], "duplicate-ready"],
  [[{ ...ready, thread_id: "wrong" }], "wrong-thread"],
  [[ready, { type: "item.append", id: "missing", text: "x" }], "unknown-item"],
] as const)
  it.effect(`rejects ${kind}`, () =>
    Effect.gen(function* () {
      const owner = yield* makeWatchProjection("thread");
      expect(
        yield* Effect.flip(Stream.runDrain(owner.project(events(...frames)))),
      ).toMatchObject({ _tag: "WatchProjectionError", kind });
      expect((yield* owner.snapshot).snapshotComplete).toBe(false);
    }),
  );
it.effect(
  "unknown wrappers are explicitly ignored even before ready; repeated live is allowed",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeWatchProjection("thread");
      const states = yield* Stream.runCollect(
        owner.project(
          events(
            { type: "future" },
            ready,
            item("a"),
            { type: "future" },
            live,
            live,
          ),
        ),
      );
      expect(states).toHaveLength(4);
      expect((yield* owner.snapshot).items).toHaveLength(1);
    }),
);
