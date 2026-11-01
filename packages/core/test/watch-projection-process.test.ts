// Original provider-free integration of projection with the existing owned transport.
import { fileURLToPath } from "node:url";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect } from "vitest";
import { nodeProcessLayer } from "../src/node.js";
import { makeWatchProjection } from "../src/watch-projection.js";
import { watchThread } from "../src/watch.js";
const fixture = fileURLToPath(new URL("./watch-fixture.mjs", import.meta.url));
const platform = Layer.mergeAll(
  NodeFileSystem.layer,
  NodePath.layer,
  nodeProcessLayer,
);
for (const mode of ["complete", "failure", "interrupt", "take"] as const)
  it.live(`projection/transport ownership: ${mode}`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const temp = yield* fs.makeTempDirectoryScoped();
      const owner = yield* makeWatchProjection("thread-1");
      const handleReady =
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
                ? Deferred.succeed(handleReady, handle)
                : Effect.void,
            ),
          ),
      );
      const wire = watchThread({
        executable: fixture,
        cwd: temp,
        binding: {
          reference: "caller-verified",
          source: "letta-code",
          externalId: "explicit",
        },
        transport: {
          env: {
            DELTA_WATCH_LOG: `${temp}/calls`,
            DELTA_WATCH_MODE:
              mode === "complete"
                ? "normal"
                : mode === "failure"
                  ? "nonzero"
                  : "hang",
          },
          timeoutMs: 5000,
        },
      }).pipe(
        Stream.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          observing,
        ),
      );
      const projected = owner
        .project(wire)
        .pipe(Stream.tap(() => Deferred.succeed(first, undefined)));
      if (mode === "complete") yield* Stream.runDrain(projected);
      else if (mode === "failure")
        expect(yield* Effect.flip(Stream.runDrain(projected))).toMatchObject({
          _tag: "TransportError",
          kind: "exit",
        });
      else if (mode === "take")
        yield* Stream.runDrain(projected.pipe(Stream.take(1)));
      else {
        const fiber = yield* Stream.runDrain(projected).pipe(Effect.forkChild);
        yield* Deferred.await(first);
        yield* Fiber.interrupt(fiber);
      }
      expect(yield* owner.snapshot).toMatchObject({
        phase: "ended",
        snapshotComplete: mode === "complete" || mode === "failure",
        end:
          mode === "complete"
            ? "eof"
            : mode === "failure"
              ? "failed"
              : mode === "interrupt"
                ? "interrupted"
                : "stopped",
      });
      const handle = yield* Deferred.await(handleReady);
      yield* Effect.exit(handle.exitCode);
      expect(yield* handle.isRunning).toBe(false);
      expect(() => process.kill(handle.pid, 0)).toThrow();
    }).pipe(Effect.provide(platform)),
  );
