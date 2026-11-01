// AGPL-3.0-only. Adapted pinned watch frames and validation cases: NOTICE.
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import { decodeWatchEvent, WatchEvent } from "../src/watch-events.js";
import fixtures from "./fixtures/watch-events.json" with { type: "json" };
const frames: readonly Record<string, unknown>[] = fixtures;
it.effect(
  "every pinned watch fixture decodes losslessly or fails as a structured CLI error",
  () =>
    Effect.gen(function* () {
      for (const frame of frames) {
        if ("error" in frame) {
          expect(yield* Effect.flip(decodeWatchEvent(frame))).toMatchObject({
            _tag: "DeltaFailure",
            error: frame.error,
          });
        } else {
          const value = yield* decodeWatchEvent(frame);
          expect(value._tag).toBe("KnownWatchEvent");
          expect(yield* Schema.encodeEffect(WatchEvent)(value)).toEqual(frame);
        }
      }
    }),
);
it.effect(
  "future event types are explicit unknown values with exact opaque fields",
  () =>
    Effect.gen(function* () {
      for (const type of ["typing", "unknown", ""]) {
        const frame = {
          type,
          future: { items: [null, "🙂", 2] },
          _tag: "KnownWatchEvent",
        };
        expect(yield* decodeWatchEvent(frame)).toEqual({
          _tag: "UnknownWatchEvent",
          value: frame,
        });
      }
    }),
);
const user = { user_id: null, name: null, actor_id: "actor", future: true };
const comment = {
  id: "c",
  chain: "c",
  delivered_with: "item",
  after_id: null,
  routed_to: null,
  author: user,
  co_authors: [user],
  agent: false,
  created_at: null,
  text: "why",
  target: null,
};
for (const [tag, target] of [
  [
    "TranscriptTarget",
    { kind: "transcript", item_id: null, quote: "", future: true },
  ],
  [
    "FileTarget",
    {
      kind: "file",
      worktree: null,
      path: "src/a",
      view: "diff",
      selected: "",
      regions: [
        {
          first_line: -1,
          last_line: 0,
          status: "future",
          text: "🙂",
          future: true,
        },
      ],
    },
  ],
  [
    "UnknownCommentTarget",
    { kind: "image", coordinates: [0, 0, 4, 4], future: true },
  ],
] as const)
  it.effect(`comment target is explicitly ${tag}`, () =>
    Effect.gen(function* () {
      const frame = {
        type: "comment",
        comment: { ...comment, target },
        future: { opaque: true },
      };
      const decoded = yield* decodeWatchEvent(frame);
      if (
        decoded._tag !== "KnownWatchEvent" ||
        decoded.value.type !== "comment"
      )
        throw new Error("expected comment");
      expect(decoded.value.comment.target).toEqual({
        _tag: tag,
        value: target,
      });
      expect(yield* Schema.encodeEffect(WatchEvent)(decoded)).toEqual(frame);
    }),
  );
it.effect(
  "open item/child kinds, nullable user names, extensions and literal boundaries remain visible",
  () =>
    Effect.gen(function* () {
      for (const frame of [
        {
          type: "ready",
          thread_id: "t",
          producer: {
            source: "letta-code",
            external_id: "p",
            next_sequence: 2,
            actor_id: null,
            turn: { sequence: 1, status: "superseded", future: 2 },
            future: true,
          },
          future: true,
        },
        { type: "live", future: true },
        {
          type: "item",
          item: {
            id: "i",
            kind: "future",
            after_id: "previous",
            turn_id: null,
            author: user,
            created_at: -1.5,
            open: false,
            content: { opaque: { future: [1, 2] } },
            future: true,
          },
        },
        {
          type: "child",
          child: {
            thread_id: "c",
            reference: "opaque#s=AbCd/Xy",
            kind: "future",
            status: "future",
            name: "",
            future: true,
          },
        },
        {
          type: "worktrees",
          worktrees: [{ reference: "opaque#t=0", name: "", future: true }],
        },
      ]) {
        const decoded = yield* decodeWatchEvent(frame);
        expect(decoded._tag).toBe("KnownWatchEvent");
        expect(yield* Schema.encodeEffect(WatchEvent)(decoded)).toEqual(frame);
      }
    }),
);
it.effect(
  "known malformed events and targets cannot fall through to unknown",
  () =>
    Effect.gen(function* () {
      for (const frame of [
        null,
        [],
        "live",
        {},
        { type: 1 },
        { type: "ready", thread_id: "t" },
        { type: "ready", thread_id: "", producer: null },
        {
          type: "ready",
          thread_id: "t",
          producer: {
            source: "letta",
            external_id: "p",
            next_sequence: 0,
            turn: null,
          },
        },
        {
          type: "item",
          item: {
            id: "i",
            kind: "x",
            after_id: null,
            turn_id: null,
            author: null,
            created_at: null,
            open: false,
            content: [],
          },
        },
        { type: "item.append", id: "i" },
        { type: "remove", id: "" },
        { type: "turn", state: "paused", turn_id: null, user: null },
        {
          type: "turn",
          state: "idle",
          turn_id: null,
          user: { user_id: null, name: null, actor_id: null },
        },
        { type: "producer.turn", sequence: 1, status: "future" },
        { type: "presence", users: [{ user_id: "u" }] },
        { type: "children", children: null },
        {
          type: "child",
          child: { thread_id: "c", kind: "x", name: "", status: "x" },
        },
        { type: "child.remove", thread_id: "" },
        { type: "worktrees", worktrees: [{ reference: "r" }] },
        { type: "comment.remove", id: "" },
        ...[
          { kind: "transcript", item_id: null },
          {
            kind: "file",
            path: "a",
            view: "diff",
            worktree: null,
            selected: null,
            regions: [{ first_line: 1.5, last_line: 2, text: "", status: "x" }],
          },
          { kind: 1 },
        ].map((target) => ({
          type: "comment",
          comment: { ...comment, target },
        })),
        { type: "comment", comment: { ...comment, delivered_with: undefined } },
      ])
        expect(yield* Effect.flip(decodeWatchEvent(frame))).toHaveProperty(
          "_tag",
          "SchemaError",
        );
    }),
);
