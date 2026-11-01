import { fileURLToPath } from "node:url";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect } from "vitest";
import { nodeProcessLayer } from "../src/node.js";
import { watchThread } from "../src/watch.js";
const fixture = fileURLToPath(new URL("./watch-fixture.mjs", import.meta.url));
const platform = Layer.mergeAll(
  NodeFileSystem.layer,
  NodePath.layer,
  nodeProcessLayer,
);
const binding = {
  reference: "opaque#s=AbCd/EfGh",
  source: "letta-code",
  externalId: "producer-🙂",
};
for (const mode of [
  "normal",
  "incompatible",
  "malformed",
  "nonzero",
  "error",
  "limit",
  "hang",
])
  it.live(`owned readonly thread-watch: ${mode}`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped();
      const log = path.join(temp, "calls.jsonl");
      const ready =
        yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const observing = ChildProcessSpawner.make((command) =>
        spawner
          .spawn(command)
          .pipe(
            Effect.tap((handle) =>
              ChildProcess.isStandardCommand(command) &&
              command.args.includes("watch")
                ? Deferred.succeed(ready, handle)
                : Effect.void,
            ),
          ),
      );
      const stream = watchThread({
        executable: fixture,
        cwd: temp,
        binding,
        transport: {
          env: { DELTA_WATCH_MODE: mode, DELTA_WATCH_LOG: log },
          timeoutMs: mode === "hang" ? 300 : 5000,
          maxOutputBytes: mode === "limit" ? 1000 : 16 * 1024 * 1024,
        },
      }).pipe(
        Stream.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          observing,
        ),
      );
      const seen: string[] = [];
      const result = yield* Effect.result(
        Stream.runCollect(
          stream.pipe(
            Stream.tap((value) =>
              Effect.sync(() => {
                seen.push(
                  value._tag === "KnownWatchEvent"
                    ? value.value.type
                    : "unknown",
                );
              }),
            ),
          ),
        ),
      );
      if (mode === "normal") {
        expect(result._tag).toBe("Success");
        expect(seen).toEqual(["ready", "unknown", "live"]);
      } else {
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure).toHaveProperty(
            "_tag",
            mode === "incompatible"
              ? "UnsupportedContract"
              : mode === "malformed"
                ? "SchemaError"
                : mode === "error"
                  ? "DeltaFailure"
                  : "TransportError",
          );
      }
      if (result._tag === "Failure") {
        if (mode === "error")
          expect(result.failure).toMatchObject({
            error: {
              code: "watch_reset",
              reason: "watch_overflow",
              retryable: true,
              retry_after_ms: 200,
              future: true,
            },
          });
        if (mode === "hang")
          expect(result.failure).toHaveProperty("kind", "timeout");
        if (mode === "nonzero") {
          expect(seen).toEqual(["ready", "unknown", "live"]);
          expect(result.failure).toHaveProperty("kind", "exit");
        }
      }
      const calls = (yield* fs.readFileString(log))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls[0].args).toEqual(["--json", "thread", "contract"]);
      expect(calls).toHaveLength(mode === "incompatible" ? 1 : 2);
      if (mode !== "incompatible") {
        expect(calls[1]).toEqual({
          cwd: temp,
          args: [
            "--json",
            "thread",
            "watch",
            binding.reference,
            "--source",
            binding.source,
            "--external-id",
            binding.externalId,
          ],
        });
        const handle = yield* Deferred.await(ready);
        yield* Effect.exit(handle.exitCode);
        expect(yield* handle.isRunning).toBe(false);
        expect(() => process.kill(handle.pid, 0)).toThrow();
      }
    }).pipe(Effect.provide(platform)),
  );
for (const mode of ["take", "interrupt"])
  it.live(`readonly watch ${mode} closes actual child`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const temp = yield* fs.makeTempDirectoryScoped();
      const ready =
        yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
      const first = yield* Deferred.make<void>();
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const observing = ChildProcessSpawner.make((command) =>
        spawner
          .spawn(command)
          .pipe(
            Effect.tap((handle) =>
              ChildProcess.isStandardCommand(command) &&
              command.args.includes("watch")
                ? Deferred.succeed(ready, handle)
                : Effect.void,
            ),
          ),
      );
      const stream = watchThread({
        executable: fixture,
        cwd: temp,
        binding,
        transport: {
          env: { DELTA_WATCH_MODE: "hang", DELTA_WATCH_LOG: `${temp}/calls` },
          timeoutMs: 5000,
        },
      }).pipe(
        Stream.tap(() => Deferred.succeed(first, undefined)),
        Stream.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          observing,
        ),
      );
      if (mode === "take")
        expect(
          yield* Stream.runCollect(stream.pipe(Stream.take(1))),
        ).toHaveLength(1);
      else {
        const fiber = yield* Stream.runDrain(stream).pipe(Effect.forkChild);
        yield* Deferred.await(first);
        yield* Fiber.interrupt(fiber);
      }
      const handle = yield* Deferred.await(ready);
      yield* Effect.exit(handle.exitCode);
      expect(yield* handle.isRunning).toBe(false);
      expect(() => process.kill(handle.pid, 0)).toThrow();
    }).pipe(Effect.provide(platform)),
  );

it.live(
  "invalid producer binding is rejected before any child is spawned",
  () =>
    Effect.gen(function* () {
      let spawns = 0;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const observing = ChildProcessSpawner.make((command) => {
        spawns++;
        return spawner.spawn(command);
      });
      const result = yield* Effect.result(
        Stream.runDrain(
          watchThread({
            executable: fixture,
            cwd: "/tmp",
            binding: { ...binding, source: "" },
          }).pipe(
            Stream.provideService(
              ChildProcessSpawner.ChildProcessSpawner,
              observing,
            ),
          ),
        ),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "TransportError", kind: "configuration" },
      });
      expect(spawns).toBe(0);
    }).pipe(Effect.provide(platform)),
);
