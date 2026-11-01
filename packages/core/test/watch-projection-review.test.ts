// Original review regressions: bounded per-event work and untrusted decoded representations.
import { it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { expect, vi } from "vitest";
import { makeWatchProjection } from "../src/watch-projection.js";
import {
  events,
  ready,
  live,
  item,
  comment,
} from "./watch-projection-fixtures.js";
const known = (value: unknown) => ({ _tag: "KnownWatchEvent", value });
for (const count of [64, 256])
  it.effect(
    `updates never scan prior inventory or re-freeze historical payloads (${count})`,
    () =>
      Effect.gen(function* () {
        const owner = yield* makeWatchProjection("thread");
        let frozenMarkers = 0;
        let inventoryScanWork = 0;
        const freeze = Object.freeze;
        const frozen = vi
          .spyOn(Object, "freeze")
          .mockImplementation((value) => {
            if (
              value !== null &&
              typeof value === "object" &&
              "projectionWorkMarker" in value
            )
              frozenMarkers++;
            return freeze(value);
          });
        const isInventory = (array: readonly unknown[]) => {
          const first = array[0];
          return (
            first !== null &&
            typeof first === "object" &&
            "id" in first &&
            "content" in first
          );
        };
        // These operations on inventory arrays make insertion/update proportional to
        // historical inventory size. Wire payload arrays in this fixture contain no items.
        const findIndex = Array.prototype.findIndex;
        const map = Array.prototype.map;
        const find = Array.prototype.find;
        const filter = Array.prototype.filter;
        const iterator = Array.prototype[Symbol.iterator];
        const findSpy = vi
          .spyOn(Array.prototype, "findIndex")
          .mockImplementation(function (this: unknown[], ...args) {
            if (isInventory(this)) inventoryScanWork += this.length;
            return findIndex.apply(this, args);
          });
        const mapSpy = vi
          .spyOn(Array.prototype, "map")
          .mockImplementation(function (this: unknown[], ...args) {
            if (isInventory(this)) inventoryScanWork += this.length;
            return map.apply(this, args);
          });
        const lookupSpy = vi
          .spyOn(Array.prototype, "find")
          .mockImplementation(function (this: unknown[], ...args) {
            if (isInventory(this)) inventoryScanWork += this.length;
            return find.apply(this, args);
          });
        const filterSpy = vi
          .spyOn(Array.prototype, "filter")
          .mockImplementation(function (this: unknown[], ...args) {
            if (isInventory(this)) inventoryScanWork += this.length;
            return filter.apply(this, args);
          });
        // A spy on Symbol.iterator recurses inside the mocking framework's own
        // argument handling, so instrument this one method directly and restore it.
        Array.prototype[Symbol.iterator] = function (this: unknown[]) {
          if (isInventory(this)) inventoryScanWork += this.length;
          return iterator.call(this);
        };
        try {
          const frames = Array.from({ length: count }, (_, index) => {
            const frame = item(String(index));
            Object.assign(frame.item.content, {
              marker: { projectionWorkMarker: true },
            });
            return frame;
          });
          const updates = yield* Stream.runCollect(
            owner.project(
              events(
                ready,
                ...frames,
                live,
                { type: "item.append", id: String(count - 1), text: "!" },
                { type: "remove", id: String(count - 2) },
              ),
            ),
          );
          const before = yield* owner.snapshot;
          const again = yield* owner.snapshot;
          expect(
            updates.every(
              (update) => !("items" in update) && "event" in update,
            ),
          ).toBe(true);
          expect(frozenMarkers).toBe(count);
          expect(inventoryScanWork).toBe(0);
          const update = updates[1];
          if (!update || update.event.type !== "item")
            throw new Error("expected item update");
          expect(before.items[0]).toBe(update.event.item);
          expect(again.items[0]).toBe(before.items[0]);
          expect(again.items).not.toBe(before.items);
          expect(Object.isFrozen(update)).toBe(true);
          expect(Object.isFrozen(update.event.item.content)).toBe(true);
        } finally {
          frozen.mockRestore();
          findSpy.mockRestore();
          mapSpy.mockRestore();
          lookupSpy.mockRestore();
          filterSpy.mockRestore();
          Array.prototype[Symbol.iterator] = iterator;
        }
      }),
  );
for (const [name, invalid] of [
  ["unknown known-tag type", known({ type: "bogus" })],
  ["missing producer", known({ type: "ready", thread_id: "thread" })],
  [
    "missing item fields",
    known({ type: "item", item: { kind: "future", content: {} } }),
  ],
  ["bad presence", known({ type: "presence", users: 5 })],
  [
    "unknown wrapper conceals known type",
    { _tag: "UnknownWatchEvent", value: { type: "item" } },
  ],
  [
    "bad target wrapper",
    known({
      type: "comment",
      comment: {
        ...comment("c").comment,
        target: { _tag: "FileTarget", value: { kind: "file" } },
      },
    }),
  ],
] as const)
  it.effect(`invalid decoded representation cannot poison owner: ${name}`, () =>
    Effect.gen(function* () {
      const owner = yield* makeWatchProjection("thread");
      expect(
        yield* Effect.flip(
          Stream.runDrain(owner.project(Stream.make(known(ready), invalid))),
        ),
      ).toMatchObject({ _tag: "WatchProjectionError", kind: "invalid-event" });
      expect(yield* owner.snapshot).toMatchObject({
        expectedThread: "thread",
        phase: "ended",
        items: [],
      });
      yield* Stream.runDrain(owner.project(events(ready, item("valid"), live)));
      expect((yield* owner.snapshot).items.map((i) => i.id)).toEqual(["valid"]);
    }),
  );
it.effect(
  "throwing representation getters fail typed and leave the owner reusable",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeWatchProjection("thread");
      const invalid = {
        get _tag() {
          throw new Error("private caller detail");
        },
      };
      expect(
        yield* Effect.flip(
          Stream.runDrain(owner.project(Stream.make(invalid))),
        ),
      ).toMatchObject({ kind: "uncloneable-event" });
      yield* Stream.runDrain(owner.project(events(ready, live)));
      expect((yield* owner.snapshot).expectedThread).toBe("thread");
    }),
);
it.effect(
  "already tagged comment targets validate without raw-wire reinterpretation",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeWatchProjection("thread");
      const updates = yield* Stream.runCollect(
        owner.project(events(ready, comment("c"), live)),
      );
      const update = updates[1];
      if (!update || update.event.type !== "comment")
        throw new Error("expected comment update");
      expect(update.event.comment.target).toMatchObject({
        _tag: "UnknownCommentTarget",
        value: { kind: "future" },
      });
      expect((yield* owner.snapshot).comments[0]).toBe(update.event.comment);
    }),
);
it.effect(
  "caller getters run only at owned ingress; frozen payloads are shared across snapshots safely",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeWatchProjection("thread");
      const raw = item("a");
      let reads = 0;
      Object.defineProperty(raw.item.content, "extension", {
        enumerable: true,
        get: () => {
          reads++;
          return { deep: ["original"] };
        },
      });
      const updates = yield* Stream.runCollect(
        owner.project(Stream.make(known(ready), known(raw), known(live))),
      );
      const first = yield* owner.snapshot;
      const second = yield* owner.snapshot;
      const update = updates[1];
      if (!update || update.event.type !== "item")
        throw new Error("expected item update");
      expect(reads).toBe(1);
      expect(first.items[0]).toBe(update.event.item);
      expect(second.items[0]).toBe(first.items[0]);
      expect(() =>
        Object.assign(first.items[0]?.content ?? {}, { extension: "changed" }),
      ).toThrow();
      expect((yield* owner.snapshot).items[0]?.content.extension).toEqual({
        deep: ["original"],
      });
    }),
);
