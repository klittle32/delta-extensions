import { Deferred, Effect, Fiber, FileSystem, PlatformError } from "effect";
import { expect } from "vitest";
import { makeAppendDelivery } from "../src/delivery.js";
import { openOutbox, ProducerOutbox } from "../src/outbox.js";
import { body, identity, test } from "./delivery-support.js";

for (const failureAt of ["receipt", "pause", "fenced-receipt"] as const)
  test(`ambiguous ${failureAt} persistence preserves observed vs confirmed prefix`, ({
    root,
    options,
    fs,
  }) =>
    Effect.gen(function* () {
      const otherRoot = root + "-fault";
      let commits = 0;
      const faulty = {
        ...fs,
        rename: (from: string, to: string) =>
          fs.rename(from, to).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                commits++;
                return commits === (failureAt === "pause" ? 4 : 3)
                  ? Effect.fail(
                      PlatformError.badArgument({
                        module: "FileSystem",
                        method: "rename",
                        description: "ambiguous injected post-rename failure",
                      }),
                    )
                  : Effect.void;
              }),
            ),
          ),
      };
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openOutbox({
            root: otherRoot,
            identity,
            mode: "create",
          }).pipe(Effect.provideService(FileSystem.FileSystem, faulty));
          yield* store.stage("a", body);
          yield* store.stage("b", body);
          const service = yield* makeAppendDelivery({
            ...options,
            transport: {
              ...options.transport,
              env: {
                ...options.transport?.env,
                DELTA_DELIVERY_MODE:
                  failureAt === "fenced-receipt" ? "fenced" : "reload",
              },
            },
          }).pipe(Effect.provideService(ProducerOutbox, store));
          const error = yield* Effect.flip(service.attempt);
          expect(error.progress.observed).toEqual([1]);
          expect(error.progress.committed).toEqual(
            failureAt === "pause" ? [1] : [],
          );
          expect(error.progress.pausePersisted).toBe(false);
          expect(error.progress.fenced).toEqual(
            failureAt === "fenced-receipt" ? [1] : [],
          );
          if (failureAt !== "pause")
            expect(error.failure).toHaveProperty("kind", "storage");
          else {
            expect(error.failure).toHaveProperty("_tag", "DeltaFailure");
            expect(error.pauseFailure).toHaveProperty("kind", "storage");
          }
          expect(yield* Effect.flip(store.snapshot)).toHaveProperty(
            "kind",
            "corrupt",
          );
        }),
      );
      expect(yield* fs.exists(`${otherRoot}/.writer`)).toBe(true);
      expect(yield* fs.exists(`${otherRoot}/3.json`)).toBe(true);
      expect(
        yield* Effect.flip(
          Effect.scoped(
            openOutbox({ root: otherRoot, identity, mode: "reopen" }),
          ),
        ),
      ).toHaveProperty("kind", "locked");
    }));

test("once reload is observed, interruption waits for persisted pause", ({
  store,
  create,
}) =>
  Effect.gen(function* () {
    yield* store.stage("a", body);
    yield* store.stage("b", body);
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const service = yield* create("reload").pipe(
      Effect.provideService(ProducerOutbox, {
        ...store,
        pauseForReload: (error) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(store.pauseForReload(error)),
          ),
      }),
    );
    yield* Effect.gen(function* () {
      const active = yield* service.attempt.pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const interrupt = yield* Fiber.interrupt(active).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(interrupt);
      expect((yield* store.snapshot).paused).toHaveProperty(
        "code",
        "reload_required",
      );
      expect((yield* service.progress).pausePersisted).toBe(true);
    }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
  }));
