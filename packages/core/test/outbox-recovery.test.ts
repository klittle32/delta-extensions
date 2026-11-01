import { makeFiles } from "../src/outbox-files.js";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Path,
  PlatformError,
} from "effect";
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
  externalId: "producer",
  threadId: "thread",
  scopeId: "conversation",
};
const body = (turnSequence = 1) => ({
  update: { sessionUpdate: "state_update", state: "running" },
  turnSequence,
});
const pause = {
  code: "reload_required",
  message: "user recovery required",
  retryable: false,
};
const observation = (next = 1) => ({
  thread_id: identity.threadId,
  producer: {
    source: identity.source,
    external_id: identity.externalId,
    next_sequence: next,
    turn: null,
  },
});
const receipt = (sequence: number, turn = 1) => ({
  operation: "appended",
  thread_id: identity.threadId,
  sequence,
  next_sequence: sequence + 1,
  turn_sequence: turn,
  duplicate: false,
  disposition: "recorded",
  version: "v1",
});
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
test("explicit durable resume survives reopen without changing immutable records, receipts or original turns", (root, fs) =>
  Effect.gen(function* () {
    let lines: readonly string[] = [];
    yield* use(root, "create", (store) =>
      Effect.gen(function* () {
        const first = yield* store.stage("first", body());
        const second = yield* store.stage("second", body(2));
        const late = yield* store.stage("late", body(1));
        lines = [first.line, second.line, late.line];
        yield* store.applyReceipts([receipt(1)]);
        yield* store.pauseForReload(pause);
        yield* store.checkFrontier(observation(2));
        expect((yield* store.snapshot).paused).toEqual(pause);
        yield* store.resumeAfterReload(observation(2));
        expect((yield* store.snapshot).paused).toBeNull();
      }),
    );
    yield* use(root, "reopen", (store) =>
      Effect.gen(function* () {
        expect(yield* store.snapshot).toMatchObject({
          nextSequence: 4,
          pending: [2, 3],
          paused: null,
        });
        expect((yield* store.replay).map((row) => row.line)).toEqual(
          lines.slice(1),
        );
        expect(yield* store.stage("first", body())).toHaveProperty(
          "line",
          lines[0],
        );
        expect(yield* store.applyReceipts([receipt(1)])).toMatchObject({
          applied: 0,
          pending: [2, 3],
        });
        expect(yield* store.stage("next", body(3))).toHaveProperty(
          "sequence",
          4,
        );
      }),
    );
    expect(yield* fs.readFileString(`${root}/6.json`)).toContain(
      '"type":"resume"',
    );
  }));

for (const [name, remote, kind] of [
  ["thread", { ...observation(), thread_id: "other" }, "thread-mismatch"],
  [
    "source",
    {
      ...observation(),
      producer: { ...observation().producer, source: "other" },
    },
    "producer-mismatch",
  ],
  [
    "producer",
    {
      ...observation(),
      producer: { ...observation().producer, external_id: "other" },
    },
    "producer-mismatch",
  ],
  ["behind", observation(1), "behind"],
  ["ahead", observation(4), "ahead"],
] as const)
  test(`rejects ${name} resume observations and remains paused without poisoning`, (root) =>
    use(root, "create", (store) =>
      Effect.gen(function* () {
        yield* store.stage("one", body());
        yield* store.stage("two", body(2));
        yield* store.applyReceipts([receipt(1)]);
        yield* store.pauseForReload(pause);
        expect(
          yield* Effect.flip(store.resumeAfterReload(remote)),
        ).toHaveProperty("kind", kind);
        expect((yield* store.snapshot).paused).toEqual(pause);
        expect(yield* Effect.flip(store.replay)).toHaveProperty(
          "kind",
          "paused",
        );
        yield* store.checkFrontier(observation(2));
        expect((yield* store.snapshot).paused).toEqual(pause);
        yield* store.resumeAfterReload(observation(2));
        expect((yield* store.snapshot).paused).toBeNull();
      }),
    ));

test("repeated resume is a validated no-op and never allocates a journal event or receipt", (root, fs) =>
  use(root, "create", (store) =>
    Effect.gen(function* () {
      yield* store.stage("one", body());
      yield* store.pauseForReload(pause);
      yield* store.resumeAfterReload(observation());
      const head = yield* fs.readFileString(`${root}/head.json`);
      const before = yield* store.snapshot;
      yield* store.resumeAfterReload(observation(2));
      expect(yield* fs.readFileString(`${root}/head.json`)).toBe(head);
      expect(yield* store.snapshot).toEqual(before);
      yield* store.applyReceipts([receipt(1)]);
      expect(
        yield* Effect.flip(store.resumeAfterReload(observation(1))),
      ).toHaveProperty("kind", "behind");
      expect((yield* store.snapshot).paused).toBeNull();
    }),
  ));

test("multiple pause/resume cycles preserve every original sequence and reject stale acknowledged frontier", (root) =>
  Effect.gen(function* () {
    yield* use(root, "create", (store) =>
      Effect.gen(function* () {
        yield* store.stage("one", body(1));
        yield* store.pauseForReload(pause);
        yield* store.resumeAfterReload(observation(1));
        yield* store.stage("two", body(2));
        yield* store.applyReceipts([receipt(1), receipt(2, 2)]);
        yield* store.pauseForReload(pause);
        expect(
          yield* Effect.flip(store.resumeAfterReload(observation(1))),
        ).toHaveProperty("kind", "behind");
        expect((yield* store.snapshot).paused).toEqual(pause);
        yield* store.resumeAfterReload(observation(3));
        yield* store.pauseForReload(pause);
        yield* store.resumeAfterReload(observation(3));
      }),
    );
    yield* use(root, "reopen", (store) =>
      Effect.gen(function* () {
        expect(yield* store.snapshot).toMatchObject({
          nextSequence: 3,
          pending: [],
          paused: null,
        });
        expect(yield* store.stage("one", body(1))).toHaveProperty(
          "sequence",
          1,
        );
        expect(yield* store.stage("two", body(2))).toHaveProperty(
          "sequence",
          2,
        );
        expect(
          yield* store.applyReceipts([receipt(1), receipt(2, 2)]),
        ).toMatchObject({ applied: 0 });
        expect(yield* store.stage("three", body(1))).toMatchObject({
          sequence: 3,
          turnSequence: 1,
        });
      }),
    );
  }));

test("failure before resume publication poisons the handle and reopens paused without changing records", (root, fs) =>
  Effect.gen(function* () {
    yield* use(root, "create", (store) =>
      Effect.gen(function* () {
        yield* store.stage("one", body());
        yield* store.pauseForReload(pause);
      }),
    );
    const head = yield* fs.readFileString(`${root}/head.json`);
    const record = yield* fs.readFileString(`${root}/1.json`);
    const faulty = {
      ...fs,
      open: (...args: Parameters<typeof fs.open>) =>
        args[0] === `${root}/3.json`
          ? Effect.fail(
              PlatformError.badArgument({
                module: "FileSystem",
                method: "open",
                description: "injected before write",
              }),
            )
          : fs.open(...args),
    };
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openOutbox({
          root,
          identity,
          mode: "reopen",
        }).pipe(Effect.provideService(FileSystem.FileSystem, faulty));
        expect(
          yield* Effect.flip(store.resumeAfterReload(observation())),
        ).toHaveProperty("kind", "storage");
        expect(
          yield* Effect.flip(store.resumeAfterReload(observation())),
        ).toHaveProperty("kind", "corrupt");
      }),
    );
    expect(yield* fs.readFileString(`${root}/head.json`)).toBe(head);
    expect(yield* fs.readFileString(`${root}/1.json`)).toBe(record);
    expect(yield* fs.exists(`${root}/3.json`)).toBe(false);
    expect(yield* fs.exists(`${root}/.writer`)).toBe(true);
    // Test-only operator cleanup after a known pre-write failure; never reclaimed by the API.
    yield* fs.remove(`${root}/.writer`, { recursive: true });
    yield* use(root, "reopen", (store) =>
      Effect.gen(function* () {
        expect(yield* store.snapshot).toMatchObject({
          nextSequence: 2,
          pending: [1],
          paused: pause,
        });
        yield* store.resumeAfterReload(observation());
        expect(yield* store.replay).toHaveLength(1);
      }),
    );
  }));

test("closed handles cannot resume a durable pause", (root, fs) =>
  Effect.gen(function* () {
    const store = yield* use(root, "create", (store) =>
      Effect.gen(function* () {
        yield* store.pauseForReload(pause);
        return store;
      }),
    );
    const head = yield* fs.readFileString(`${root}/head.json`);
    expect(
      yield* Effect.flip(store.resumeAfterReload(observation())),
    ).toHaveProperty("kind", "closed");
    expect(yield* fs.readFileString(`${root}/head.json`)).toBe(head);
    yield* use(root, "reopen", (store) =>
      Effect.gen(function* () {
        expect((yield* store.snapshot).paused).toEqual(pause);
      }),
    );
  }));

for (const [name, paused, changes] of [
  ["no preceding pause", false, {}],
  ["wrong producer", true, { identity: { ...identity, externalId: "wrong" } }],
  ["wrong scope", true, { identity: { ...identity, scopeId: "wrong" } }],
  ["wrong thread", true, { identity: { ...identity, threadId: "wrong" } }],
  ["stale next boundary", true, { nextSequence: 3 }],
  ["stale receipt boundary", true, { acknowledgedBefore: 2 }],
  ["behind report", true, { reportedNextSequence: 0 }],
  ["ahead report", true, { reportedNextSequence: 3 }],
] as const)
  test(`replay rejects a resume event with ${name}`, (root) =>
    Effect.gen(function* () {
      yield* use(root, "create", (store) =>
        Effect.gen(function* () {
          yield* store.stage("one", body());
          if (paused) yield* store.pauseForReload(pause);
        }),
      );
      const files = yield* makeFiles(root);
      const loaded = yield* files.load();
      yield* files.commit(loaded.head, {
        type: "resume",
        identity,
        acknowledgedBefore: 1,
        nextSequence: 2,
        reportedNextSequence: 1,
        ...changes,
      });
      expect(
        yield* Effect.flip(use(root, "reopen", (store) => store.snapshot)),
      ).toHaveProperty("kind", "corrupt");
    }));
test("resume queued behind receipt application validates the frontier inside the writer gate", (root, fs) =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let block = false;
      const slow = {
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
        Effect.provideService(FileSystem.FileSystem, slow),
      );
      yield* store.stage("one", body());
      yield* store.pauseForReload(pause);
      const resume = store.resumeAfterReload(observation(1));
      block = true;
      const acknowledging = yield* store
        .applyReceipts([receipt(1)])
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const resuming = yield* Effect.result(resume).pipe(Effect.forkChild);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(acknowledging);
      expect(yield* Fiber.join(resuming)).toMatchObject({
        _tag: "Failure",
        failure: { kind: "behind" },
      });
      expect(yield* store.snapshot).toMatchObject({
        nextSequence: 2,
        pending: [],
        paused: pause,
      });
      yield* store.resumeAfterReload(observation(2));
      expect((yield* store.snapshot).paused).toBeNull();
    }),
  ));
