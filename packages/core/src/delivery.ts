// AGPL-3.0-only; invocation and incremental durable receipt adaptation: NOTICE.
import { Context, Effect, Fiber, Layer, Semaphore, Stream } from "effect";
import {
  type AttemptProgress,
  type AttemptResult,
  copyProgress,
  DeliveryAttemptError,
  type DeliveryOptions,
  DeliveryValidationError,
  selectBatch,
} from "./delivery-model.js";
import { type OutboxError, ProducerOutbox } from "./outbox.js";
import {
  Contract,
  DeltaFailure,
  negotiate,
  Receipt,
  retryDecision,
} from "./protocol.js";
import { runJson } from "./transport.js";
import { watchJsonLinesObserved } from "./jsonl-process.js";
export {
  type AttemptProgress,
  type AttemptResult,
  DeliveryAttemptError,
  type DeliveryOptions,
  DeliveryValidationError,
} from "./delivery-model.js";

export const makeAppendDelivery = (options: DeliveryOptions) =>
  Effect.gen(function* () {
    if (
      ![
        options.executable,
        options.cwd,
        options.reference,
        options.threadId,
        options.producerName,
      ].every((value) => typeof value === "string" && value.length > 0) ||
      !["local", "server"].includes(options.acknowledgement)
    )
      return yield* new DeliveryValidationError({ kind: "configuration" });
    const config = {
      ...options,
      transport: {
        ...options.transport,
        ...(options.transport?.env === undefined
          ? {}
          : { env: { ...options.transport.env } }),
      },
    };
    const store = yield* ProducerOutbox;
    const scope = yield* Effect.scope;
    const gate = yield* Semaphore.make(1);
    let closed = false;
    const fresh = (): AttemptProgress => ({
      acknowledgement: config.acknowledgement,
      phase: "preflight",
      batch: [],
      observed: [],
      committed: [],
      remainingBatch: [],
      deferred: [],
      fenced: [],
      reloadObserved: false,
      pausePersisted: false,
    });
    let last = fresh();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true;
      }).pipe(Effect.andThen(gate.withPermits(1)(Effect.void))),
    );
    const isClosed = () => closed || scope.state._tag === "Closed";
    const runAttempt = gate.withPermits(1)(
      Effect.suspend(() => {
        last = fresh();
        let pauseFailure: OutboxError | undefined;
        const observeReload = (failure: DeltaFailure) =>
          Effect.uninterruptible(
            Effect.gen(function* () {
              if (
                failure.error.code !== "reload_required" ||
                last.reloadObserved
              )
                return;
              last = { ...last, reloadObserved: true };
              pauseFailure = yield* store.pauseForReload(failure.error).pipe(
                Effect.as(undefined),
                Effect.catch((error) => Effect.succeed(error)),
              );
              if (!pauseFailure) last = { ...last, pausePersisted: true };
            }),
          );
        return Effect.gen(function* () {
          if (isClosed())
            return yield* new DeliveryValidationError({ kind: "closed" });
          const snapshot = yield* store.snapshot;
          if (snapshot.identity.threadId !== config.threadId)
            return yield* new DeliveryValidationError({ kind: "identity" });
          const pending = yield* store.replay;
          const batch = selectBatch(pending);
          last = {
            ...last,
            batch: batch.map((row) => row.sequence),
            remainingBatch: batch.map((row) => row.sequence),
            deferred: pending.slice(batch.length).map((row) => row.sequence),
          };
          if (!batch.length) {
            last = { ...last, phase: "done" };
            return {
              status: "empty",
              progress: copyProgress(last),
            } satisfies AttemptResult;
          }
          const base = {
            ...config.transport,
            executable: config.executable,
            cwd: config.cwd,
          };
          last = { ...last, phase: "contract" };
          yield* negotiate(
            yield* runJson(
              { ...base, args: ["--json", "thread", "contract"] },
              Contract,
            ),
          );
          last = { ...last, phase: "append" };
          yield* Stream.runForEach(
            watchJsonLinesObserved(
              {
                ...base,
                args: [
                  "--json",
                  "thread",
                  "append",
                  config.reference,
                  "--source",
                  snapshot.identity.source,
                  "--external-id",
                  snapshot.identity.externalId,
                  ...(config.acknowledgement === "local"
                    ? ["--acknowledge", "local"]
                    : []),
                  "--producer-name",
                  config.producerName,
                ],
                stdin: batch.map((row) => row.line).join(""),
                maxInputBytes: 16 * 1024 * 1024,
              },
              Receipt,
              observeReload,
            ),
            (receipt) =>
              Effect.uninterruptible(
                Effect.gen(function* () {
                  const expected = batch[last.observed.length];
                  if (
                    !expected ||
                    receipt.thread_id !== snapshot.identity.threadId ||
                    receipt.sequence !== expected.sequence ||
                    receipt.turn_sequence !== (expected.turnSequence ?? null)
                  )
                    return yield* new DeliveryValidationError({
                      kind: "receipt",
                    });
                  last = {
                    ...last,
                    observed: [...last.observed, receipt.sequence],
                    fenced:
                      receipt.disposition === "fenced" &&
                      receipt.turn_sequence !== null
                        ? [...last.fenced, receipt.turn_sequence]
                        : last.fenced,
                  };
                  yield* store.applyReceipts([receipt]);
                  last = {
                    ...last,
                    committed: [...last.committed, receipt.sequence],
                    remainingBatch: batch
                      .slice(last.observed.length)
                      .map((row) => row.sequence),
                  };
                }),
              ),
          );
          if (last.committed.length !== batch.length)
            return yield* new DeliveryValidationError({ kind: "incomplete" });
          last = { ...last, phase: "done" };
          return {
            status: "complete",
            progress: copyProgress(last),
          } satisfies AttemptResult;
        }).pipe(
          Effect.catch((failure) =>
            Effect.uninterruptible(
              Effect.gen(function* () {
                if (failure instanceof DeltaFailure)
                  yield* observeReload(failure);
                return yield* new DeliveryAttemptError({
                  failure,
                  progress: copyProgress(last),
                  retry:
                    failure instanceof DeltaFailure
                      ? retryDecision(failure.error)
                      : { kind: "unknown" },
                  ...(pauseFailure ? { pauseFailure } : {}),
                });
              }),
            ),
          ),
        );
      }),
    );
    // Each invocation belongs to this owner Scope AND honors its caller's abort.
    // Fork/join registration is atomic; no worker exists between calls.
    const attempt = Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (isClosed())
          return yield* new DeliveryAttemptError({
            failure: new DeliveryValidationError({ kind: "closed" }),
            progress: fresh(),
            retry: { kind: "unknown" },
          });
        const fiber = yield* Effect.forkIn(runAttempt, scope, {
          uninterruptible: false,
        });
        return yield* restore(Fiber.join(fiber)).pipe(
          Effect.onInterrupt(() => Fiber.interrupt(fiber)),
        );
      }),
    );
    return { attempt, progress: Effect.sync(() => copyProgress(last)) };
  });
export class AppendDelivery extends Context.Service<
  AppendDelivery,
  Effect.Success<ReturnType<typeof makeAppendDelivery>>
>()("delta/AppendDelivery") {}
export const appendDeliveryLayer = (options: DeliveryOptions) =>
  Layer.effect(AppendDelivery, makeAppendDelivery(options));
