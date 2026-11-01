import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect } from "vitest";
import { makeAppendDelivery } from "../src/delivery.js";
import { body, test } from "./delivery-support.js";

for (const malformed of [false, true])
  for (const action of [
    "caller",
    "owner",
    "caller-grace",
    "owner-grace",
    "timeout",
    "control",
  ] as const)
    test(`decoded reload is durable through SIGTERM grace: ${action}, malformed=${malformed}`, ({
      store,
      fs,
      temp,
      options,
    }) =>
      Effect.gen(function* () {
        yield* store.stage("a", body);
        yield* store.stage("b", body);
        const owner = yield* Effect.acquireRelease(Scope.make(), (scope) =>
          Scope.close(scope, Exit.void),
        );
        const ready =
          yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const observing = ChildProcessSpawner.make((command) =>
          spawner
            .spawn(command)
            .pipe(
              Effect.tap((handle) =>
                ChildProcess.isStandardCommand(command) &&
                command.args.includes("append")
                  ? Deferred.succeed(ready, handle)
                  : Effect.void,
              ),
            ),
        );
        const service = yield* makeAppendDelivery({
          ...options,
          transport: {
            ...options.transport,
            timeoutMs:
              action === "timeout" ||
              action === "control" ||
              action.endsWith("grace")
                ? 600
                : 10000,
            forceKillAfterMs: 1500,
            env: {
              ...options.transport?.env,
              DELTA_DELIVERY_MODE: malformed
                ? "malformed-reload-grace"
                : "reload-grace",
            },
          },
        }).pipe(Effect.provideService(Scope.Scope, owner));
        const active = yield* service.attempt.pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            observing,
          ),
          Effect.forkChild,
        );
        // Decoded/persisted progress, not child-written bytes, proves observation.
        // Append now keeps scanning until exit/deadline/cancellation.
        yield* Effect.gen(function* () {
          while (!(yield* service.progress).pausePersisted)
            yield* Effect.sleep(5);
        }).pipe(Effect.timeout(3000));
        const handle = yield* Deferred.await(ready);
        expect(yield* handle.isRunning).toBe(true);
        expect((yield* service.progress).reloadObserved).toBe(true);
        expect((yield* service.progress).pausePersisted).toBe(true);
        if (action.endsWith("grace"))
          yield* Effect.gen(function* () {
            while (!(yield* fs.exists(`${temp}/calls.jsonl.term`)))
              yield* Effect.sleep(5);
          }).pipe(Effect.timeout(3000));
        yield* Effect.sleep(200);
        if (action.startsWith("caller")) yield* Fiber.interrupt(active);
        if (action.startsWith("owner")) yield* Scope.close(owner, Exit.void);
        const outcome = yield* Fiber.await(active);
        expect(Exit.isFailure(outcome)).toBe(true);
        if (
          Exit.isFailure(outcome) &&
          (action.startsWith("caller") || action.startsWith("owner"))
        )
          expect(Cause.hasInterrupts(outcome.cause)).toBe(true);
        if (action === "timeout" || action === "control") {
          const error = yield* Effect.flip(Fiber.join(active));
          expect(error.failure).toHaveProperty("kind", "timeout");
          expect(error.retry).toEqual({ kind: "unknown" });
          expect(error.progress.reloadObserved).toBe(true);
          expect(error.progress.pausePersisted).toBe(true);
        }
        expect((yield* store.snapshot).paused).toHaveProperty(
          "code",
          "reload_required",
        );
        expect((yield* store.snapshot).pending).toEqual([2]);
        const progress = yield* service.progress;
        expect(progress.committed).toEqual([1]);
        expect(progress.reloadObserved).toBe(true);
        expect(progress.pausePersisted).toBe(true);
        expect(yield* fs.exists(`${temp}/calls.jsonl.term`)).toBe(true);
        yield* Effect.exit(handle.exitCode);
        expect(yield* handle.isRunning).toBe(false);
        expect(() => process.kill(handle.pid, 0)).toThrow();
      }));

test("mid-close admission cannot spawn while a later owner finalizer is blocked", ({
  store,
  options,
  fs,
  temp,
}) =>
  Effect.gen(function* () {
    yield* store.stage("a", body);
    const owner = yield* Scope.make();
    const service = yield* makeAppendDelivery(options).pipe(
      Effect.provideService(Scope.Scope, owner),
    );
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* Scope.addFinalizer(
      owner,
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      ),
    );
    yield* Effect.gen(function* () {
      const closing = yield* Scope.close(owner, Exit.void).pipe(
        Effect.forkChild,
      );
      yield* Deferred.await(entered);
      expect(owner.state._tag).toBe("Closed");
      const error = yield* Effect.flip(service.attempt);
      expect(error.failure).toHaveProperty("kind", "closed");
      expect(yield* fs.exists(`${temp}/calls.jsonl`)).toBe(false);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(closing);
    }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
  }));

for (const mode of ["malformed-reload", "reload-zero"] as const)
  test(`append error classification: ${mode}`, ({ store, create }) =>
    Effect.gen(function* () {
      yield* store.stage("a", body);
      yield* store.stage("b", body);
      const service = yield* create(mode);
      const error = yield* Effect.flip(service.attempt);
      expect(error.failure).toHaveProperty(
        "_tag",
        mode === "malformed-reload"
          ? "DeltaFailure"
          : "DeliveryValidationError",
      );
      expect(error.progress.committed).toEqual([1]);
      expect(error.progress.reloadObserved).toBe(true);
      expect(error.progress.pausePersisted).toBe(true);
      expect((yield* store.snapshot).pending).toEqual([2]);
      expect((yield* store.snapshot).paused?.code).toBe("reload_required");
    }));
