import { Schema } from "effect";
export class WatchProjectionError extends Schema.TaggedError<
  WatchProjectionError,
  { readonly brand: unique symbol }
>()("WatchProjectionError", {
  kind: Schema.Literals([
    "configuration",
    "busy",
    "duplicate-ready",
    "wrong-thread",
    "before-ready",
    "unknown-item",
    "incomplete-snapshot",
    "uncloneable-event",
    "invalid-json-value",
    "invalid-event",
  ]),
}) {}
