import { fileURLToPath } from "node:url";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Schema, Stream } from "effect";
import { Digest } from "effect/crypto";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect } from "vitest";
import { nodeProcessLayer } from "../src/node.js";
import { openOutbox } from "../src/outbox.js";

const fixture = fileURLToPath(
  new URL("./outbox-crash-fixture.ts", import.meta.url),
);
const platform = Layer.mergeAll(
  NodeFileSystem.layer,
  NodePath.layer,
  Digest.layerWebCrypto,
  nodeProcessLayer,
);
const identity = {
  source: "letta-code",
  externalId: "crash-producer",
  threadId: "thread-1",
  scopeId: "scope-1",
};
for (const mode of ["committed", "prepared"] as const)
  it.live(
    `actual child SIGKILL after ${mode} persistence preserves ambiguous ownership`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temp = yield* fs.makeTempDirectoryScoped();
        const root = path.join(temp, "store");
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const child = yield* spawner.spawn(
          ChildProcess.make("bun", ["run", fixture, root, mode], {
            cwd: temp,
            shell: false,
            extendEnv: true,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            killSignal: "SIGKILL",
            forceKillAfter: 20,
          }),
        );
        const ready = yield* Stream.runCollect(
          child.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.take(1),
          ),
        ).pipe(Effect.timeout(5000));
        const payload = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.JsonObject),
        )(ready[0]);
        yield* child.kill({ killSignal: "SIGKILL", forceKillAfter: 20 });
        yield* Effect.exit(child.exitCode);
        expect(yield* child.isRunning).toBe(false);
        const before = yield* fs.readFileString(`${root}/1.json`);
        expect(
          yield* Effect.flip(
            Effect.scoped(openOutbox({ root, identity, mode: "reopen" })),
          ),
        ).toHaveProperty("kind", "locked");
        // Test-only explicit operator lock removal, never an automatic production recovery.
        yield* fs.remove(`${root}/.writer`, { recursive: true });
        if (mode === "committed") {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const reopened = yield* openOutbox({
                root,
                identity,
                mode: "reopen",
              });
              expect((yield* reopened.replay)[0]?.line).toBe(payload.line);
              expect((yield* reopened.snapshot).nextSequence).toBe(2);
            }),
          );
        } else {
          expect(payload.prepared).toBe(true);
          expect(yield* fs.exists(`${root}/head.next`)).toBe(true);
          expect(
            yield* Effect.flip(
              Effect.scoped(openOutbox({ root, identity, mode: "reopen" })),
            ),
          ).toHaveProperty("kind", "corrupt");
        }
        expect(yield* fs.readFileString(`${root}/1.json`)).toBe(before);
      }).pipe(Effect.provide(platform)),
    10000,
  );
