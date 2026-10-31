// Real Bun child runs the actual outbox; the parent kills it using Effect's spawner.

import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Effect, FileSystem, Layer } from "effect";
import { Digest } from "effect/crypto";
import { openOutbox } from "../src/outbox.js";

const root = process.argv[2];
const mode = process.argv[3];
if (!root) throw new Error("root required");
const program = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const injected = {
      ...fs,
      rename: (from: string, to: string) =>
        mode === "prepared"
          ? Effect.sync(() => {
              process.stdout.write('{"prepared":true}\n');
            }).pipe(Effect.andThen(Effect.never))
          : fs.rename(from, to),
    };
    const options = {
      root,
      identity: {
        source: "letta-code",
        externalId: "crash-producer",
        threadId: "thread-1",
        scopeId: "scope-1",
      },
      mode: "create" as const,
    };
    if (mode === "attempt") {
      const result = yield* Effect.exit(
        openOutbox({ ...options, mode: "reopen" }),
      );
      process.stdout.write(JSON.stringify({ _tag: result._tag }) + "\n");
      return;
    }
    const store = yield* openOutbox(options).pipe(
      Effect.provideService(FileSystem.FileSystem, injected),
    );
    const record = yield* store.stage("child-event", {
      update: { sessionUpdate: "state_update", state: "running" },
      turnSequence: 1,
    });
    process.stdout.write(JSON.stringify({ line: record.line }) + "\n");
    return yield* Effect.never;
  }),
).pipe(
  Effect.provide(
    Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, Digest.layerWebCrypto),
  ),
);
Effect.runPromise(program).catch(() => {
  process.exitCode = 1;
});
