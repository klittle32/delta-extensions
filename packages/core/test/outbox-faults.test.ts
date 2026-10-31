import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Path,
  PlatformError,
  Schema,
  Scope,
} from "effect";
import { Digest } from "effect/crypto";
import { expect } from "vitest";
import { openOutbox } from "../src/outbox.js";
import { allocateSequence } from "../src/outbox-model.js";
import { DeltaRecord } from "../src/records.js";

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
const open = (root: string, mode: "create" | "reopen") =>
  openOutbox({ root, mode, identity });

test("injected partial write is preserved, poisons writer, and cannot recycle sequence", (root, fs) =>
  Effect.gen(function* () {
    const faulty = {
      ...fs,
      open: (...args: Parameters<typeof fs.open>) =>
        fs.open(...args).pipe(
          Effect.map((handle) =>
            args[0].endsWith("/1.json")
              ? {
                  ...handle,
                  writeAll: (bytes: Uint8Array) =>
                    handle.writeAll(bytes.subarray(0, 16)).pipe(
                      Effect.andThen(
                        Effect.fail(
                          PlatformError.badArgument({
                            module: "FileSystem",
                            method: "writeAll",
                            description: "injected failure",
                          }),
                        ),
                      ),
                    ),
                }
              : handle,
          ),
        ),
    };
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* open(root, "create").pipe(
          Effect.provideService(FileSystem.FileSystem, faulty),
        );
        expect(yield* Effect.flip(store.stage("a", body))).toHaveProperty(
          "kind",
          "storage",
        );
        expect(yield* Effect.flip(store.stage("b", body))).toHaveProperty(
          "kind",
          "corrupt",
        );
      }),
    );
    expect((yield* fs.readFile(`${root}/1.json`)).length).toBe(16);
    expect(yield* fs.exists(`${root}/.writer`)).toBe(true);
    expect(
      yield* Effect.flip(Effect.scoped(open(root, "reopen"))),
    ).toHaveProperty("kind", "locked");
    // Explicit operator action in test only; there is no automatic lock reclamation API.
    yield* fs.remove(`${root}/.writer`, { recursive: true });
    expect(
      yield* Effect.flip(Effect.scoped(open(root, "reopen"))),
    ).toHaveProperty("kind", "corrupt");
    expect((yield* fs.readFile(`${root}/1.json`)).length).toBe(16);
  }));
test("checkpoint rename failure leaves both record and checkpoint intent untouched", (root, fs) =>
  Effect.gen(function* () {
    const faulty = {
      ...fs,
      rename: () =>
        Effect.fail(
          PlatformError.badArgument({
            module: "FileSystem",
            method: "rename",
            description: "injected failure",
          }),
        ),
    };
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* open(root, "create").pipe(
          Effect.provideService(FileSystem.FileSystem, faulty),
        );
        expect(yield* Effect.flip(store.stage("a", body))).toHaveProperty(
          "kind",
          "storage",
        );
      }),
    );
    expect(yield* fs.exists(`${root}/1.json`)).toBe(true);
    expect(yield* fs.exists(`${root}/head.next`)).toBe(true);
    expect(
      JSON.parse(yield* fs.readFileString(`${root}/head.json`)).transaction,
    ).toBe(0);
  }));
test("missing root or unreadable/bad head is never initialized by reopen", (root, fs) =>
  Effect.gen(function* () {
    expect(
      yield* Effect.flip(Effect.scoped(open(root, "reopen"))),
    ).toHaveProperty("_tag", "OutboxError");
    expect(yield* fs.exists(root)).toBe(false);
    yield* Effect.scoped(open(root, "create"));
    yield* fs.writeFileString(`${root}/head.json`, "{broken");
    expect(
      yield* Effect.flip(Effect.scoped(open(root, "reopen"))),
    ).toHaveProperty("kind", "corrupt");
    expect(yield* fs.readFileString(`${root}/head.json`)).toBe("{broken");
  }));
test("extra journal and pending checkpoint files block reopen without deletion", (root, fs) =>
  Effect.gen(function* () {
    yield* Effect.scoped(open(root, "create"));
    yield* fs.writeFileString(`${root}/head.next`, "ambiguous", {
      mode: 0o600,
    });
    expect(
      yield* Effect.flip(Effect.scoped(open(root, "reopen"))),
    ).toHaveProperty("kind", "corrupt");
    expect(yield* fs.readFileString(`${root}/head.next`)).toBe("ambiguous");
  }));
test("symlink records are refused without touching their targets", (root, fs) =>
  Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.flatMap(open(root, "create"), (store) => store.stage("a", body)),
    );
    yield* fs.rename(`${root}/1.json`, `${root}/original`);
    yield* fs.symlink(`${root}/original`, `${root}/1.json`);
    expect(
      yield* Effect.flip(Effect.scoped(open(root, "reopen"))),
    ).toHaveProperty("kind", "corrupt");
    expect(yield* fs.exists(`${root}/original`)).toBe(true);
  }));
test("an operation constructed before close still refuses execution after close", (root) =>
  Effect.gen(function* () {
    const operation = yield* Effect.scoped(
      Effect.map(open(root, "create"), (store) => store.stage("a", body)),
    );
    expect(yield* Effect.flip(operation)).toHaveProperty("kind", "closed");
  }));
it.effect("maximum safe sequence does not overflow or get recycled", () =>
  Effect.gen(function* () {
    expect(yield* allocateSequence(Number.MAX_SAFE_INTEGER - 1)).toBe(
      Number.MAX_SAFE_INTEGER - 1,
    );
    for (const value of [
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 1,
      0,
      -1,
      1.5,
      NaN,
    ])
      expect(yield* Effect.flip(allocateSequence(value))).toHaveProperty(
        "kind",
        "sequence",
      );
  }),
);
for (const [name, update] of [
  [
    "user",
    {
      sessionUpdate: "user_message",
      messageId: "u",
      content: [{ type: "text", text: "hello" }],
    },
  ],
  [
    "thought",
    {
      sessionUpdate: "agent_thought",
      messageId: "thought",
      content: [{ type: "text", text: "thinking" }],
    },
  ],
  [
    "tool",
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool",
      status: "in_progress",
      rawInput: { path: "a" },
    },
  ],
  [
    "result",
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool",
      status: "completed",
      rawOutput: { ok: true },
      content: [{ type: "content", content: { type: "text", text: "done" } }],
    },
  ],
  ["title", { sessionUpdate: "session_info_update", title: "A title" }],
] as const)
  test(`actual ${name} update schema is persisted and replayed`, (root) =>
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* open(root, "create");
        const record = yield* store.stage(name, { update });
        expect(JSON.parse(record.line).update).toEqual(update);
        expect((yield* store.replay)[0]?.line).toBe(record.line);
      }),
    ));
it.effect(
  "unsupported controls, malformed tools and lossy metadata remain rejected",
  () =>
    Effect.gen(function* () {
      for (const update of [
        { sessionUpdate: "future" },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "x",
          status: "future",
        },
        {
          sessionUpdate: "agent_message",
          messageId: "m",
          content: [{ type: "image" }],
        },
      ])
        expect(
          yield* Effect.flip(
            Schema.decodeUnknownEffect(DeltaRecord)({
              schemaVersion: 1,
              sequence: 1,
              update,
            }),
          ),
        ).toHaveProperty("_tag", "SchemaError");
    }),
);
test("lossy body input never commits a record", (root) =>
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* open(root, "create");
      for (const extra of [undefined, NaN, () => 1, new Date()])
        expect(
          yield* Effect.flip(
            store.stage("lossy", {
              update: { sessionUpdate: "state_update", state: "idle", extra },
            }),
          ),
        ).toHaveProperty("kind", "input");
      expect((yield* store.snapshot).nextSequence).toBe(1);
    }),
  ));
test("scope closure waits for an active durable transaction before releasing writer lock", (root, fs) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const closing = yield* Deferred.make<void>();
    const slow = {
      ...fs,
      rename: (from: string, to: string) =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(fs.rename(from, to)),
        ),
    };
    const scope = yield* Scope.make();
    const store = yield* open(root, "create").pipe(
      Effect.provideService(FileSystem.FileSystem, slow),
      Effect.provideService(Scope.Scope, scope),
    );
    const stage = yield* store.stage("a", body).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const closer = yield* Deferred.succeed(closing, undefined).pipe(
      Effect.andThen(Scope.close(scope, Exit.void)),
      Effect.forkChild,
    );
    yield* Deferred.await(closing);
    yield* Effect.yieldNow;
    yield* Effect.sleep(30);
    const held = yield* fs.exists(`${root}/.writer`);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(stage);
    yield* Fiber.join(closer);
    expect(held).toBe(true);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const reopened = yield* open(root, "reopen");
        expect((yield* reopened.replay).length).toBe(1);
      }),
    );
  }));
test("disk corruption after opening blocks replay before any bytes can be submitted", (root, fs) =>
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* open(root, "create");
      yield* store.stage("a", body);
      const original = yield* fs.readFileString(`${root}/1.json`);
      yield* fs.writeFileString(
        `${root}/1.json`,
        original.replace("running", "idle"),
      );
      expect(yield* Effect.flip(store.replay)).toHaveProperty(
        "kind",
        "corrupt",
      );
      expect(yield* Effect.flip(store.stage("b", body))).toHaveProperty(
        "kind",
        "corrupt",
      );
    }),
  ));
test("replaced lock identity fails closed and is not removed on teardown", (root, fs) =>
  Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* open(root, "create");
        yield* fs.rename(`${root}/.writer`, `${root}/saved-writer`);
        yield* fs.makeDirectory(`${root}/.writer`, { mode: 0o700 });
        expect(yield* Effect.flip(store.stage("a", body))).toHaveProperty(
          "kind",
          "corrupt",
        );
      }),
    );
    expect(yield* fs.exists(`${root}/.writer`)).toBe(true);
    expect(yield* fs.exists(`${root}/saved-writer`)).toBe(true);
  }));
test("record size limit prevents any durable sequence allocation", (root) =>
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* open(root, "create");
      expect(
        yield* Effect.flip(
          store.stage("large", {
            update: {
              sessionUpdate: "agent_message",
              messageId: "large",
              content: [{ type: "text", text: "x".repeat(16 * 1024 * 1024) }],
            },
          }),
        ),
      ).toHaveProperty("kind", "input");
      expect((yield* store.snapshot).nextSequence).toBe(1);
    }),
  ));
test("unreadable previously bound head is preserved rather than recreated", (root, fs) =>
  Effect.gen(function* () {
    yield* Effect.scoped(open(root, "create"));
    const original = yield* fs.readFileString(`${root}/head.json`);
    const unreadable = {
      ...fs,
      open: (...args: Parameters<typeof fs.open>) =>
        args[0].endsWith("/head.json")
          ? Effect.fail(
              PlatformError.badArgument({
                module: "FileSystem",
                method: "open",
                description: "injected unreadable head",
              }),
            )
          : fs.open(...args),
    };
    expect(
      yield* Effect.flip(
        Effect.scoped(
          open(root, "reopen").pipe(
            Effect.provideService(FileSystem.FileSystem, unreadable),
          ),
        ),
      ),
    ).toHaveProperty("kind", "corrupt");
    expect(yield* fs.readFileString(`${root}/head.json`)).toBe(original);
  }));

for (const operation of ["stage", "replay", "snapshot"] as const)
  test(`interrupting ${operation} guard or queued access permits reuse and reopen`, (root, fs) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      let block = false;
      const slow = {
        ...fs,
        readDirectory: (name: string) =>
          block && name === root
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
              )
            : fs.readDirectory(name),
      };
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* open(root, "create").pipe(
            Effect.provideService(FileSystem.FileSystem, slow),
          );
          yield* store.stage("a", body);
          block = true;
          const active = yield* (
            operation === "stage" ? store.stage("b", body) : store[operation]
          ).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          const queued = yield* store
            .stage("queued", body)
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          yield* Fiber.interrupt(queued);
          yield* Fiber.interrupt(active);
          block = false;
          expect((yield* store.snapshot).nextSequence).toBe(2);
          yield* store.stage("b", body);
          expect((yield* store.replay).length).toBe(2);
        }),
      );
      expect(yield* fs.exists(`${root}/.writer`)).toBe(false);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* open(root, "reopen");
          expect((yield* store.snapshot).nextSequence).toBe(3);
        }),
      );
    }));

test("oversized identity is rejected before creating storage", (root, fs) =>
  Effect.gen(function* () {
    expect(
      yield* Effect.flip(
        Effect.scoped(
          openOutbox({
            root,
            mode: "create",
            identity: { ...identity, externalId: "x".repeat(70000) },
          }),
        ),
      ),
    ).toHaveProperty("kind", "configuration");
    expect(yield* fs.exists(root)).toBe(false);
  }));

test("receipt replay ignores object key order but preserves arrays and values", (root) =>
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* open(root, "create");
      yield* store.stage("a", body);
      const ack = {
        operation: "appended",
        thread_id: "thread-1",
        sequence: 1,
        next_sequence: 2,
        turn_sequence: 1,
        duplicate: false,
        disposition: "recorded",
        version: "actor.42",
        extra: { x: 1, y: [2, 3] },
      };
      yield* store.applyReceipts([ack]);
      expect(
        (yield* store.applyReceipts([{ ...ack, extra: { y: [2, 3], x: 1 } }]))
          .applied,
      ).toBe(0);
      for (const extra of [
        { x: 1, y: [3, 2] },
        { x: 2, y: [2, 3] },
      ])
        expect(
          yield* Effect.flip(store.applyReceipts([{ ...ack, extra }])),
        ).toHaveProperty("kind", "receipt");
    }),
  ));

test("interrupt during commit waits for durable publication without poisoning", (root, fs) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const slow = {
      ...fs,
      rename: (from: string, to: string) =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(fs.rename(from, to)),
        ),
    };
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* open(root, "create").pipe(
          Effect.provideService(FileSystem.FileSystem, slow),
        );
        const active = yield* store.stage("a", body).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const interrupt = yield* Fiber.interrupt(active).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(yield* fs.exists(`${root}/.writer`)).toBe(true);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(interrupt);
        expect((yield* store.snapshot).nextSequence).toBe(2);
        yield* store.stage("b", body);
      }),
    );
    expect(yield* fs.exists(`${root}/.writer`)).toBe(false);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* open(root, "reopen");
        expect((yield* store.replay).length).toBe(2);
      }),
    );
  }));

test("real guard read failure poisons the handle and retains writer ownership", (root, fs) =>
  Effect.gen(function* () {
    let fail = false;
    const faulty = {
      ...fs,
      readDirectory: (name: string) =>
        fail && name === root
          ? Effect.fail(
              PlatformError.badArgument({
                module: "FileSystem",
                method: "readDirectory",
                description: "injected read failure",
              }),
            )
          : fs.readDirectory(name),
    };
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* open(root, "create").pipe(
          Effect.provideService(FileSystem.FileSystem, faulty),
        );
        yield* store.stage("a", body);
        fail = true;
        expect(yield* Effect.flip(store.replay)).toHaveProperty(
          "kind",
          "corrupt",
        );
        fail = false;
        expect(yield* Effect.flip(store.snapshot)).toHaveProperty(
          "kind",
          "corrupt",
        );
      }),
    );
    expect(yield* fs.exists(`${root}/.writer`)).toBe(true);
    expect(
      yield* Effect.flip(Effect.scoped(open(root, "reopen"))),
    ).toHaveProperty("kind", "locked");
  }));
