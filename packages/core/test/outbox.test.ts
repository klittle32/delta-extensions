import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { Digest } from "effect/crypto";
import { expect } from "vitest";
import { openOutbox, outboxLayer, ProducerOutbox } from "../src/outbox.js";

const platform = Layer.mergeAll(
  NodeFileSystem.layer,
  NodePath.layer,
  Digest.layerWebCrypto,
);
const identity = {
  source: "letta-code",
  externalId: "producer-1",
  threadId: "thread-1",
  scopeId: "conversation-1",
};
const body = {
  update: { sessionUpdate: "state_update", state: "running" },
  turnSequence: 1,
};
const receipt = (sequence: number, turn: number | null = 1) => ({
  operation: "appended",
  thread_id: "thread-1",
  sequence,
  next_sequence: sequence + 1,
  turn_sequence: turn,
  duplicate: false,
  disposition: "recorded",
  version: "actor.42",
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

test("durably stages before return and reopens exact bytes after lost receipt", (root, fs) =>
  Effect.gen(function* () {
    const staged = yield* use(root, "create", (store) =>
      store.stage("event-1", body),
    );
    const line =
      JSON.stringify({ schemaVersion: 1, sequence: 1, ...body }) + "\n";
    expect(staged.line).toBe(line);
    expect(yield* fs.readDirectory(root)).toContain("1.json");
    yield* use(root, "reopen", (store) =>
      Effect.gen(function* () {
        expect(yield* store.replay).toEqual([staged]);
        expect(yield* store.stage("event-1", body)).toEqual(staged);
        expect((yield* store.snapshot).nextSequence).toBe(2);
      }),
    );
  }));
test("serializes parallel staging with monotonic consecutive sequences", (root) =>
  use(root, "create", (store) =>
    Effect.gen(function* () {
      const values = yield* Effect.all(
        Array.from({ length: 12 }, (_, i) =>
          store.stage(`event-${i}`, {
            update: { sessionUpdate: "state_update", state: "idle" },
          }),
        ),
        { concurrency: "unbounded" },
      );
      expect(values.map((v) => v.sequence).sort((a, b) => a - b)).toEqual(
        Array.from({ length: 12 }, (_, i) => i + 1),
      );
    }),
  ));
test("same ID conflicting bytes fails without allocating another sequence", (root) =>
  use(root, "create", (store) =>
    Effect.gen(function* () {
      yield* store.stage("same", body);
      expect(
        yield* Effect.flip(
          store.stage("same", {
            update: { sessionUpdate: "state_update", state: "idle" },
          }),
        ),
      ).toHaveProperty("kind", "conflict");
      expect((yield* store.snapshot).nextSequence).toBe(2);
    }),
  ));
test("partial per-record receipts survive reopen and retain unacknowledged suffix", (root) =>
  Effect.gen(function* () {
    yield* use(root, "create", (store) =>
      Effect.gen(function* () {
        yield* store.stage("start", body);
        yield* store.stage("end", {
          update: { sessionUpdate: "state_update", state: "idle" },
          turnSequence: 1,
        });
        expect(yield* store.applyReceipts([receipt(1)])).toMatchObject({
          applied: 1,
          pending: [2],
        });
      }),
    );
    yield* use(root, "reopen", (store) =>
      Effect.gen(function* () {
        expect((yield* store.replay).map((v) => v.sequence)).toEqual([2]);
        expect(yield* store.applyReceipts([receipt(1)])).toMatchObject({
          applied: 0,
          pending: [2],
        });
      }),
    );
  }));
test("valid receipt prefix is persisted even if later batch receipt is malformed", (root) =>
  Effect.gen(function* () {
    yield* use(root, "create", (store) =>
      Effect.gen(function* () {
        yield* store.stage("a", body);
        yield* store.stage("b", {
          update: { sessionUpdate: "state_update", state: "idle" },
          turnSequence: 1,
        });
        expect(
          yield* Effect.flip(
            store.applyReceipts([
              receipt(1),
              { ...receipt(2), thread_id: "wrong" },
            ]),
          ),
        ).toMatchObject({ kind: "receipt", applied: 1 });
      }),
    );
    yield* use(root, "reopen", (store) =>
      Effect.gen(function* () {
        expect((yield* store.replay).map((v) => v.sequence)).toEqual([2]);
      }),
    );
  }));
test("preserves original late old-turn association and reports fencing", (root) =>
  use(root, "create", (store) =>
    Effect.gen(function* () {
      yield* store.stage("first", body);
      yield* store.stage("new-turn", {
        update: { sessionUpdate: "state_update", state: "running" },
        turnSequence: 2,
      });
      const late = yield* store.stage("late", {
        update: {
          sessionUpdate: "agent_message",
          messageId: "msg",
          content: [{ type: "text", text: "late🙂" }],
        },
        turnSequence: 1,
      });
      expect(JSON.parse(late.line).turnSequence).toBe(1);
      expect(
        yield* store.applyReceipts([
          receipt(1),
          receipt(2, 2),
          { ...receipt(3), disposition: "fenced" },
        ]),
      ).toMatchObject({ fenced: [1], pending: [] });
    }),
  ));
test("reload_required persists a pause without removing records or automatic resume", (root) =>
  Effect.gen(function* () {
    yield* use(root, "create", (store) =>
      Effect.gen(function* () {
        yield* store.stage("a", body);
        yield* store.pauseForReload({
          code: "reload_required",
          message: "refused",
          retryable: false,
          reason: "opaque",
        });
        expect(yield* Effect.flip(store.replay)).toHaveProperty(
          "kind",
          "paused",
        );
      }),
    );
    yield* use(root, "reopen", (store) =>
      Effect.gen(function* () {
        expect((yield* store.snapshot).pending).toEqual([1]);
        expect((yield* store.snapshot).paused).toHaveProperty(
          "code",
          "reload_required",
        );
        expect(yield* Effect.flip(store.stage("b", body))).toHaveProperty(
          "kind",
          "paused",
        );
      }),
    );
  }));
test("same local store has one exclusive scoped writer", (root) =>
  use(root, "create", () =>
    Effect.gen(function* () {
      expect(
        yield* Effect.flip(
          Effect.scoped(openOutbox({ root, identity, mode: "reopen" })),
        ),
      ).toHaveProperty("kind", "locked");
    }),
  ));
test("closed handles cannot write after scope teardown", (root) =>
  Effect.gen(function* () {
    const store = yield* Effect.scoped(
      openOutbox({ root, identity, mode: "create" }),
    );
    expect(yield* Effect.flip(store.stage("closed", body))).toHaveProperty(
      "kind",
      "closed",
    );
  }));
for (const field of ["source", "externalId", "threadId", "scopeId"] as const)
  test(`reopen refuses ${field} mismatch`, (root) =>
    Effect.gen(function* () {
      yield* use(root, "create", () => Effect.void);
      expect(
        yield* Effect.flip(
          Effect.scoped(
            openOutbox({
              root,
              mode: "reopen",
              identity: { ...identity, [field]: "different" },
            }),
          ),
        ),
      ).toHaveProperty("kind", "identity");
    }));
for (const file of ["head.json", "1.json"] as const)
  test(`missing previously bound ${file} never resets state`, (root, fs) =>
    Effect.gen(function* () {
      yield* use(root, "create", (store) =>
        store.stage("a", body).pipe(Effect.asVoid),
      );
      yield* fs.remove(`${root}/${file}`);
      expect(
        yield* Effect.flip(use(root, "reopen", () => Effect.void)),
      ).toHaveProperty("_tag", "OutboxError");
    }));
test("corrupt canonical bytes and extra files are preserved", (root, fs) =>
  Effect.gen(function* () {
    yield* use(root, "create", (store) =>
      store.stage("a", body).pipe(Effect.asVoid),
    );
    const text = yield* fs.readFileString(`${root}/1.json`);
    yield* fs.writeFileString(
      `${root}/1.json`,
      text.replace("running", "idle"),
    );
    expect(
      yield* Effect.flip(use(root, "reopen", () => Effect.void)),
    ).toHaveProperty("kind", "corrupt");
    expect(yield* fs.readFileString(`${root}/1.json`)).toBe(
      text.replace("running", "idle"),
    );
  }));
test("explicit root is required and POSIX storage stays private", (root, fs) =>
  Effect.gen(function* () {
    expect(
      yield* Effect.flip(use("relative", "create", () => Effect.void)),
    ).toHaveProperty("kind", "configuration");
    yield* use(root, "create", (store) =>
      store.stage("a", body).pipe(Effect.asVoid),
    );
    expect((yield* fs.stat(root)).mode & 0o777).toBe(0o700);
    expect((yield* fs.stat(`${root}/head.json`)).mode & 0o777).toBe(0o600);
    expect((yield* fs.stat(`${root}/1.json`)).mode & 0o777).toBe(0o600);
  }));
test("actual service layer owns the writer lifecycle", (root) =>
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const store = yield* ProducerOutbox;
      yield* store.stage("a", body);
    }).pipe(Effect.provide(outboxLayer({ root, identity, mode: "create" })));
    yield* use(root, "reopen", (store) =>
      Effect.gen(function* () {
        expect((yield* store.replay).length).toBe(1);
      }),
    );
  }));
test("fencing survives a later invalid receipt and idempotent application", (root) =>
  use(root, "create", (store) =>
    Effect.gen(function* () {
      yield* store.stage("a", body);
      yield* store.stage("b", {
        update: { sessionUpdate: "state_update", state: "idle" },
        turnSequence: 1,
      });
      const fenced = { ...receipt(1), disposition: "fenced" };
      expect(
        yield* Effect.flip(
          store.applyReceipts([fenced, { ...receipt(2), thread_id: "wrong" }]),
        ),
      ).toMatchObject({ applied: 1, fenced: [1] });
      expect(yield* store.applyReceipts([fenced])).toMatchObject({
        applied: 0,
        fenced: [1],
      });
      expect(yield* store.snapshot).toMatchObject({
        fenced: [1],
        pending: [2],
      });
    }),
  ));
