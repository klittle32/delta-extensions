import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer, Path } from "effect";
import { Digest } from "effect/crypto";
import { expect } from "vitest";
import { openOutbox } from "../src/outbox.js";
const platform = Layer.mergeAll(
  NodeFileSystem.layer,
  NodePath.layer,
  Digest.layerWebCrypto,
);
const identity = {
  source: "letta-code",
  externalId: "original",
  threadId: "thread",
  scopeId: "scope",
};
const body = {
  update: { sessionUpdate: "state_update", state: "running" },
  turnSequence: 1,
};
const remote = (next: number) => ({
  thread_id: identity.threadId,
  producer: {
    source: identity.source,
    external_id: identity.externalId,
    next_sequence: next,
    turn: { sequence: 1, status: "superseded" },
  },
});
const ack = {
  operation: "appended",
  thread_id: identity.threadId,
  sequence: 1,
  next_sequence: 4,
  turn_sequence: 1,
  duplicate: false,
  disposition: "fenced",
  version: "opaque",
};
const test = <E>(
  name: string,
  f: (
    root: string,
    fs: FileSystem.FileSystem,
  ) => Effect.Effect<
    void,
    E,
    FileSystem.FileSystem | Path.Path | Digest.Digest
  >,
) =>
  it.live(name, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped();
      yield* f(path.join(temp, "store"), fs);
    }).pipe(Effect.provide(platform)),
  );
const use = <A, E, R>(
  root: string,
  mode: "create" | "reopen",
  f: (
    store: Effect.Success<ReturnType<typeof openOutbox>>,
  ) => Effect.Effect<A, E, R>,
) => Effect.scoped(Effect.flatMap(openOutbox({ root, identity, mode }), f));
const disk = (root: string, fs: FileSystem.FileSystem) =>
  Effect.gen(function* () {
    const names = (yield* fs.readDirectory(root))
      .filter((n) => n !== ".writer")
      .sort();
    return yield* Effect.forEach(names, (name) =>
      fs
        .readFileString(`${root}/${name}`)
        .pipe(Effect.map((bytes) => ({ name, bytes }))),
    );
  });
test("checks preserve exact journal/receipts/bytes/allocation/fences/pause across reopen", (root, fs) =>
  Effect.gen(function* () {
    let persisted: { name: string; bytes: string }[] = [];
    yield* use(root, "create", (store) =>
      Effect.gen(function* () {
        const rows = [
          yield* store.stage("a", body),
          yield* store.stage("b", { ...body, turnSequence: 1 }),
          yield* store.stage("c", { ...body, turnSequence: 1 }),
        ];
        yield* store.applyReceipts([ack]);
        const before = yield* store.snapshot;
        const pending = yield* store.replay;
        expect(before.pending).toEqual([2, 3]); // cumulative next_sequence=4 acknowledged only record 1
        expect(before.fenced).toEqual([1]);
        const files = yield* disk(root, fs);
        for (const next of [2, 3, 4]) {
          expect(yield* store.checkFrontier(remote(next))).toMatchObject({
            acknowledgedBefore: 2,
            nextSequence: 4,
            reportedNextSequence: next,
          });
          expect(yield* store.snapshot).toEqual(before);
          expect(yield* store.replay).toEqual(pending);
        }
        for (const observation of [
          remote(1),
          remote(5),
          null,
          { ...remote(2), thread_id: "wrong" },
        ])
          yield* Effect.flip(store.checkFrontier(observation));
        expect(yield* disk(root, fs)).toEqual(files);
        expect(yield* store.stage("a", body)).toEqual(rows[0]); // retained acknowledged bytes still identical, not requeued
        yield* store.pauseForReload({
          code: "reload_required",
          message: "rejected locally accepted changes",
          retryable: false,
        });
        const paused = yield* store.snapshot;
        persisted = yield* disk(root, fs);
        yield* store.checkFrontier(remote(4));
        yield* Effect.flip(store.checkFrontier(remote(1)));
        expect(yield* store.snapshot).toEqual(paused);
        expect(yield* Effect.flip(store.replay)).toHaveProperty(
          "kind",
          "paused",
        );
        expect(yield* disk(root, fs)).toEqual(persisted);
      }),
    );
    expect(yield* fs.exists(`${root}/.writer`)).toBe(false);
    yield* use(root, "reopen", (store) =>
      Effect.gen(function* () {
        expect(yield* store.snapshot).toMatchObject({
          nextSequence: 4,
          pending: [2, 3],
          fenced: [1],
          paused: { code: "reload_required" },
        });
        yield* store.checkFrontier(remote(4));
        yield* Effect.flip(store.checkFrontier(remote(1)));
        expect(yield* disk(root, fs)).toEqual(persisted);
      }),
    );
    expect(yield* fs.exists(`${root}/.writer`)).toBe(false);
  }));
test("remote errors do not poison healthy storage; later staging/check/close/reopen remain usable", (root, fs) =>
  Effect.gen(function* () {
    yield* use(root, "create", (store) =>
      Effect.gen(function* () {
        for (const observation of [
          null,
          remote(2),
          { ...remote(1), producer: null },
          {
            get thread_id() {
              throw new Error("caller");
            },
          },
        ])
          expect(
            yield* Effect.flip(store.checkFrontier(observation)),
          ).toHaveProperty("_tag", "ProducerFrontierError");
        yield* store.stage("a", body);
        expect(yield* store.checkFrontier(remote(2))).toHaveProperty(
          "nextSequence",
          2,
        );
      }),
    );
    expect(yield* fs.exists(`${root}/.writer`)).toBe(false);
    yield* use(root, "reopen", (store) =>
      Effect.gen(function* () {
        expect((yield* store.replay)[0]?.sequence).toBe(1);
        yield* store.checkFrontier(remote(1));
      }),
    );
  }));
test("genuine on-disk corruption still poisons the guarded check and retains its lock", (root, fs) =>
  Effect.gen(function* () {
    yield* use(root, "create", (store) =>
      Effect.gen(function* () {
        yield* store.stage("a", body);
        yield* fs.writeFileString(`${root}/1.json`, "corrupt");
        expect(
          yield* Effect.flip(store.checkFrontier(remote(1))),
        ).toMatchObject({ _tag: "OutboxError", kind: "corrupt" });
        expect(yield* Effect.flip(store.snapshot)).toHaveProperty(
          "kind",
          "corrupt",
        );
      }),
    );
    expect(yield* fs.exists(`${root}/.writer`)).toBe(true);
  }));
test("a deferred check uses current local bounds; a previously compatible observation can become stale", (root) =>
  use(root, "create", (store) =>
    Effect.gen(function* () {
      const check = store.checkFrontier(remote(1));
      expect(yield* check).toMatchObject({
        acknowledgedBefore: 1,
        nextSequence: 1,
      });
      yield* store.stage("a", body);
      yield* store.applyReceipts([{ ...ack, next_sequence: 2 }]);
      expect(yield* Effect.flip(check)).toHaveProperty("kind", "behind");
      expect(yield* store.snapshot).toMatchObject({
        nextSequence: 2,
        pending: [],
        fenced: [1],
      });
      yield* store.stage("b", {
        update: { sessionUpdate: "state_update", state: "idle" },
        turnSequence: 1,
      });
      expect(yield* store.checkFrontier(remote(2))).toMatchObject({
        acknowledgedBefore: 2,
        nextSequence: 3,
      });
    }),
  ));
test("a check queued behind staging derives bounds under the same permit", (root, fs) =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let block = false;
      const observedFs = {
        ...fs,
        readDirectory: (directory: string) =>
          Effect.gen(function* () {
            if (block && directory === root) {
              block = false;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
            return yield* fs.readDirectory(directory);
          }),
      };
      const store = yield* openOutbox({ root, identity, mode: "create" }).pipe(
        Effect.provideService(FileSystem.FileSystem, observedFs),
      );
      const check = store.checkFrontier(remote(2));
      block = true;
      const staging = yield* store.stage("a", body).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const checking = yield* check.pipe(Effect.forkChild);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(staging);
      expect(yield* Fiber.join(checking)).toMatchObject({
        acknowledgedBefore: 1,
        nextSequence: 2,
        reportedNextSequence: 2,
      });
    }),
  ));
