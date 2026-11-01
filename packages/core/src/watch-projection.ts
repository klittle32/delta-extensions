// AGPL-3.0-only; pinned consumer projection adapted to Effect. See NOTICE.
import { Cause, Effect, Exit, Ref, Schema, Stream } from "effect";
import { WatchProjectionError } from "./watch-projection-error.js";
import { ownWatchEvent } from "./watch-projection-input.js";
import { makeProjectionInventory } from "./watch-projection-state.js";
export { WatchProjectionError } from "./watch-projection-error.js";
export {
  commentContext,
  type WatchProjectionState,
  type WatchProjectionUpdate,
} from "./watch-projection-state.js";
/** One in-memory owner; no runtime, background fibers or reconnection policy.
 * project is cold, sequentially reusable, and emits immutable event updates.
 * Full ordered inventory is available only through the explicit snapshot Effect.
 */
export const makeWatchProjection = (expectedThread: string) =>
  Effect.gen(function* () {
    yield* Schema.decodeEffect(Schema.String.check(Schema.isMinLength(1)))(
      expectedThread,
    ).pipe(
      Effect.mapError(
        () => new WatchProjectionError({ kind: "configuration" }),
      ),
    );
    const inventory = makeProjectionInventory(expectedThread);
    const active = yield* Ref.make(false);
    const snapshot = Effect.sync(inventory.snapshot);
    // The boundary validates decoded representations, including hand-built inputs.
    const project = <E, R>(input: Stream.Stream<unknown, E, R>) =>
      Stream.unwrap(
        Effect.gen(function* () {
          let eof = false;
          yield* Effect.acquireRelease(
            Effect.gen(function* () {
              const admitted = yield* Ref.getAndSet(active, true);
              if (admitted)
                return yield* new WatchProjectionError({ kind: "busy" });
              yield* Effect.sync(inventory.begin);
            }),
            (_, exit) =>
              Effect.gen(function* () {
                yield* Effect.sync(() =>
                  inventory.finish(
                    Exit.isFailure(exit)
                      ? Cause.hasInterrupts(exit.cause)
                        ? "interrupted"
                        : "failed"
                      : eof
                        ? "eof"
                        : "stopped",
                  ),
                );
                yield* Ref.set(active, false);
              }),
          );
          return input.pipe(
            Stream.mapEffect(ownWatchEvent),
            Stream.filter((event) => event._tag === "KnownWatchEvent"),
            Stream.mapEffect((event) =>
              Effect.sync(() => inventory.apply(event.value)).pipe(
                Effect.flatMap(Effect.fromResult),
              ),
            ),
            Stream.concat(
              Stream.drain(
                Stream.fromEffect(
                  Effect.gen(function* () {
                    if (!inventory.isComplete())
                      return yield* new WatchProjectionError({
                        kind: "incomplete-snapshot",
                      });
                    eof = true;
                  }),
                ),
              ),
            ),
          );
        }),
      );
    return { snapshot, project };
  });
