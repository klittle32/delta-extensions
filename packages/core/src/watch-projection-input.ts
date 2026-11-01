// Own only the current decoded representation. Never read caller getters outside a typed Effect.
import { Effect, Schema } from "effect";
import { WatchEvent } from "./watch-events.js";
import { WatchProjectionError } from "./watch-projection-error.js";
const representation = Schema.toType(WatchEvent);
const freezeJson = <T>(value: T): T => {
  const stack: unknown[] = [value];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current !== null && typeof current === "object" && !seen.has(current)) {
      seen.add(current);
      for (const child of Object.values(current)) stack.push(child);
      Object.freeze(current);
    }
  }
  return value;
};
export const ownWatchEvent = (input: unknown) =>
  Effect.gen(function* () {
    const detached = yield* Effect.try({
      try: () => structuredClone(input),
      catch: () => new WatchProjectionError({ kind: "uncloneable-event" }),
    });
    // Clone alone would preserve shared backing memory on non-wire caller values.
    yield* Schema.decodeUnknownEffect(Schema.Json)(detached).pipe(
      Effect.mapError(
        () => new WatchProjectionError({ kind: "invalid-json-value" }),
      ),
    );
    // Already-tagged comment targets must be checked as decoded types, not decoded
    // again as raw wire targets. Known malformed events cannot become unknowns.
    const event = yield* Schema.decodeUnknownEffect(representation)(
      detached,
    ).pipe(
      Effect.mapError(
        () => new WatchProjectionError({ kind: "invalid-event" }),
      ),
    );
    return freezeJson(event);
  });
