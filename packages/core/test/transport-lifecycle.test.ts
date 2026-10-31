import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { nodeProcessLayer } from "../src/node.js";
import { runJson, watchJsonLines } from "../src/transport.js";
import { Message, Pid, request } from "./transport-support.js";

// Observe real handles by replacing only the injected spawner service. No fake CLI.
const observed = (
  handleReady: Deferred.Deferred<ChildProcessSpawner.ChildProcessHandle>,
) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(command);
          yield* Deferred.succeed(handleReady, handle);
          return handle;
        }),
      );
    }),
  ).pipe(Layer.provide(nodeProcessLayer));
const assertExited = (handle: ChildProcessSpawner.ChildProcessHandle) =>
  Effect.gen(function* () {
    // exitCode resolves from the platform's exit event, not just stream cancellation.
    yield* Effect.exit(handle.exitCode);
    expect(yield* handle.isRunning).toBe(false);
    expect(() => process.kill(handle.pid, 0)).toThrow();
  });
for (const mode of ["hang", "ignore-term"] as const)
  it.live(`real child: early stream stop finalizes ${mode}`, () =>
    Effect.gen(function* () {
      const ready =
        yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
      expect(
        yield* Stream.runCollect(
          watchJsonLines({ ...request(mode), forceKillAfterMs: 20 }, Pid).pipe(
            Stream.take(1),
            Stream.provide(observed(ready)),
          ),
        ),
      ).toHaveLength(1);
      yield* assertExited(yield* Deferred.await(ready));
    }),
  );
it.live("real child: parent fiber interruption awaits child exit", () =>
  Effect.gen(function* () {
    const ready =
      yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
    const first = yield* Deferred.make<void>();
    const task = yield* Stream.runDrain(
      watchJsonLines(request("hang"), Pid).pipe(
        Stream.tap(() => Deferred.succeed(first, undefined)),
        Stream.provide(observed(ready)),
      ),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(first);
    yield* Fiber.interrupt(task);
    yield* assertExited(yield* Deferred.await(ready));
  }),
);
it.live(
  "real child: one-shot waits for exit even when output pipes close",
  () =>
    Effect.gen(function* () {
      const ready =
        yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
      const error = yield* Effect.flip(
        runJson({ ...request("close-pipes"), timeoutMs: 100 }, Pid).pipe(
          Effect.provide(observed(ready)),
        ),
      );
      expect(error).toMatchObject({ _tag: "TransportError", kind: "timeout" });
      yield* assertExited(yield* Deferred.await(ready));
    }),
);
it.effect(
  "injected TestClock drives watch deadline and finalization of a real child",
  () =>
    Effect.gen(function* () {
      const ready =
        yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
      const first = yield* Deferred.make<void>();
      const fiber = yield* Effect.flip(
        Stream.runDrain(
          watchJsonLines({ ...request("hang"), timeoutMs: 1000 }, Pid).pipe(
            Stream.tap(() => Deferred.succeed(first, undefined)),
            Stream.provide(observed(ready)),
          ),
        ),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(first);
      yield* TestClock.adjust(1000);
      expect(yield* Fiber.join(fiber)).toMatchObject({
        _tag: "TransportError",
        kind: "timeout",
      });
      yield* assertExited(yield* Deferred.await(ready));
    }),
);
for (const mode of ["run", "watch"] as const)
  it.effect(
    `injected acquisition is included in ${mode} timeout`,
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const blocked = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
            ),
          ),
        );
        const operation =
          mode === "run"
            ? runJson({ ...request("one"), timeoutMs: 1000 }, Message).pipe(
                Effect.asVoid,
              )
            : Stream.runDrain(
                watchJsonLines({ ...request("one"), timeoutMs: 1000 }, Message),
              );
        const fiber = yield* Effect.flip(
          operation.pipe(Effect.provide(blocked)),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* TestClock.adjust(1000);
        expect(yield* Fiber.join(fiber)).toMatchObject({ kind: "timeout" });
      }),
    500,
  );
for (const mode of ["malformed-hang", "frame-hang"] as const)
  it.live(`real child: ${mode} failure settles owned child`, () =>
    Effect.gen(function* () {
      const ready =
        yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
      const error = yield* Effect.flip(
        Stream.runDrain(
          watchJsonLines({ ...request(mode), maxFrameBytes: 100 }, Message),
        ).pipe(Effect.provide(observed(ready))),
      );
      expect(error).toHaveProperty(
        "_tag",
        mode === "malformed-hang" ? "SchemaError" : "TransportError",
      );
      yield* assertExited(yield* Deferred.await(ready));
    }),
  );
it.live("real child: stream EOF still waits for process exit", () =>
  Effect.gen(function* () {
    const ready =
      yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
    const error = yield* Effect.flip(
      Stream.runDrain(
        watchJsonLines({ ...request("close-pipes"), timeoutMs: 200 }, Pid),
      ).pipe(Effect.provide(observed(ready))),
    );
    expect(error).toMatchObject({ kind: "timeout" });
    yield* assertExited(yield* Deferred.await(ready));
  }),
);
