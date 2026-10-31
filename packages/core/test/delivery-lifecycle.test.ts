import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect } from "vitest";
import {
  AppendDelivery,
  appendDeliveryLayer,
  makeAppendDelivery,
} from "../src/delivery.js";
import { openOutbox, ProducerOutbox } from "../src/outbox.js";
import { body, identity, test } from "./delivery-support.js";

test("bound thread mismatch and wrong first receipt acknowledge nothing", ({
  store,
  options,
  temp,
  fs,
  create,
}) =>
  Effect.gen(function* () {
    yield* store.stage("a", body);
    const mismatch = yield* makeAppendDelivery({
      ...options,
      threadId: "other",
    });
    expect((yield* Effect.flip(mismatch.attempt)).failure).toHaveProperty(
      "kind",
      "identity",
    );
    expect(yield* fs.exists(`${temp}/calls.jsonl`)).toBe(false);
    const wrong = yield* create("wrong-first");
    expect((yield* Effect.flip(wrong.attempt)).progress.observed).toEqual([]);
    expect((yield* store.snapshot).pending).toEqual([1]);
  }));
test("receipt for concurrently staged but unsent record is refused", ({
  store,
  create,
}) =>
  Effect.gen(function* () {
    yield* store.stage("a", body);
    const service = yield* create("extra").pipe(
      Effect.provideService(ProducerOutbox, {
        ...store,
        applyReceipts: (inputs) =>
          store
            .applyReceipts(inputs)
            .pipe(Effect.tap(() => store.stage("late", body))),
      }),
    );
    const error = yield* Effect.flip(service.attempt);
    expect(error.failure).toHaveProperty("kind", "receipt");
    expect(error.progress.batch).toEqual([1]);
    expect(error.progress.committed).toEqual([1]);
    expect((yield* store.snapshot).pending).toEqual([2]);
  }));
test("single-flight queues a concurrent attempt then observes an empty outbox", ({
  store,
  create,
  temp,
  fs,
}) =>
  Effect.gen(function* () {
    yield* store.stage("a", body);
    yield* store.stage("b", body);
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const service = yield* create().pipe(
      Effect.provideService(ProducerOutbox, {
        ...store,
        applyReceipts: (inputs) =>
          store.applyReceipts(inputs).pipe(
            Effect.tap(() => Deferred.succeed(entered, undefined)),
            Effect.tap(() => Deferred.await(release)),
          ),
      }),
    );
    yield* Effect.gen(function* () {
      const first = yield* service.attempt.pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const second = yield* service.attempt.pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(first)).status).toBe("complete");
      expect((yield* Fiber.join(second)).status).toBe("empty");
      expect(
        (yield* fs.readFileString(`${temp}/calls.jsonl`)).trim().split("\n"),
      ).toHaveLength(2);
    }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
  }));
test("interruption preserves durable prefix, cancels queued attempt and proves actual child exit", ({
  store,
  create,
}) =>
  Effect.gen(function* () {
    yield* store.stage("a", body);
    yield* store.stage("b", body);
    const committed = yield* Deferred.make<void>();
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
    const service = yield* create("hang").pipe(
      Effect.provideService(ProducerOutbox, {
        ...store,
        applyReceipts: (inputs) =>
          store
            .applyReceipts(inputs)
            .pipe(Effect.tap(() => Deferred.succeed(committed, undefined))),
      }),
    );
    const active = yield* service.attempt.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observing),
      Effect.forkChild,
    );
    yield* Deferred.await(committed);
    const queued = yield* service.attempt.pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(queued);
    yield* Fiber.interrupt(active);
    const interrupted = yield* Fiber.await(active);
    expect(Exit.isFailure(interrupted)).toBe(true);
    if (Exit.isFailure(interrupted))
      expect(Cause.hasInterrupts(interrupted.cause)).toBe(true);
    expect((yield* service.progress).committed).toEqual([1]);
    expect((yield* store.snapshot).pending).toEqual([2]);
    const handle = yield* Deferred.await(ready);
    yield* Effect.exit(handle.exitCode);
    expect(yield* handle.isRunning).toBe(false);
    expect(() => process.kill(handle.pid, 0)).toThrow();
  }));
for (const mode of ["partial", "reload", "crash"])
  test(`${mode} prefix and pause survive real filesystem reopen`, ({
    root,
    fs,
    temp,
    options,
  }) =>
    Effect.gen(function* () {
      const otherRoot = root + "-reopen";
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openOutbox({
            root: otherRoot,
            identity,
            mode: "create",
          });
          yield* store.stage("a", body);
          yield* store.stage("b", body);
          const gate = `${temp}/receipt.ready`;
          const service = yield* makeAppendDelivery({
            ...options,
            transport: {
              ...options.transport,
              env: {
                ...options.transport?.env,
                DELTA_DELIVERY_MODE: mode,
                DELTA_DELIVERY_ACK_GATE: gate,
              },
            },
          }).pipe(
            Effect.provideService(ProducerOutbox, {
              ...store,
              applyReceipts: (inputs) =>
                store
                  .applyReceipts(inputs)
                  .pipe(Effect.tap(() => fs.writeFileString(gate, "durable"))),
            }),
          );
          expect(
            (yield* Effect.flip(service.attempt)).progress.committed,
          ).toEqual([1]);
        }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reopened = yield* openOutbox({
            root: otherRoot,
            identity,
            mode: "reopen",
          });
          expect((yield* reopened.snapshot).pending).toEqual([2]);
          expect((yield* reopened.snapshot).paused?.code).toBe(
            mode === "reload" ? "reload_required" : undefined,
          );
        }),
      );
    }));
test("output limit after durable receipt cannot undo that prefix", ({
  store,
  options,
  fs,
  temp,
}) =>
  Effect.gen(function* () {
    yield* store.stage("a", body);
    yield* store.stage("b", body);
    const gate = `${temp}/receipt.ready`;
    const service = yield* makeAppendDelivery({
      ...options,
      transport: {
        ...options.transport,
        maxOutputBytes: 1024,
        env: {
          ...options.transport?.env,
          DELTA_DELIVERY_MODE: "limit",
          DELTA_DELIVERY_ACK_GATE: gate,
        },
      },
    }).pipe(
      Effect.provideService(ProducerOutbox, {
        ...store,
        applyReceipts: (inputs) =>
          store
            .applyReceipts(inputs)
            .pipe(Effect.tap(() => fs.writeFileString(gate, "durable"))),
      }),
    );
    const error = yield* Effect.flip(service.attempt);
    expect(error.failure).toHaveProperty("kind", "limit");
    expect(error.progress.committed).toEqual([1]);
    expect((yield* store.snapshot).pending).toEqual([2]);
  }));

test("closed service refuses work and its layer injects a functional owner", ({
  store,
  options,
}) =>
  Effect.gen(function* () {
    const service = yield* Effect.scoped(makeAppendDelivery(options));
    expect((yield* Effect.flip(service.attempt)).failure).toHaveProperty(
      "kind",
      "closed",
    );
    yield* store.stage("a", body);
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* AppendDelivery;
        return yield* owner.attempt;
      }).pipe(Effect.provide(appendDeliveryLayer(options))),
    );
    expect(result.status).toBe("complete");
  }));

test("owner Scope close cancels an attempt called from an outer fiber", ({
  store,
  options,
}) =>
  Effect.gen(function* () {
    yield* store.stage("a", body);
    yield* store.stage("b", body);
    const owner = yield* Scope.make();
    const committed = yield* Deferred.make<void>();
    const service = yield* makeAppendDelivery({
      ...options,
      transport: {
        ...options.transport,
        timeoutMs: 2000,
        env: { ...options.transport?.env, DELTA_DELIVERY_MODE: "hang" },
      },
    }).pipe(
      Effect.provideService(Scope.Scope, owner),
      Effect.provideService(ProducerOutbox, {
        ...store,
        applyReceipts: (inputs) =>
          store
            .applyReceipts(inputs)
            .pipe(Effect.tap(() => Deferred.succeed(committed, undefined))),
      }),
    );
    const active = yield* service.attempt.pipe(Effect.forkChild);
    yield* Deferred.await(committed);
    yield* Scope.close(owner, Exit.void).pipe(Effect.timeout(1000));
    const outcome = yield* Fiber.await(active);
    expect(Exit.isFailure(outcome)).toBe(true);
    if (Exit.isFailure(outcome))
      expect(Cause.hasInterrupts(outcome.cause)).toBe(true);
    expect((yield* service.progress).committed).toEqual([1]);
    expect((yield* store.snapshot).pending).toEqual([2]);
  }));
