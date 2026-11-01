// AGPL-3.0-only; pinned contract-8 watch decoder: NOTICE, docs/core.md.
import { Schema } from "effect";
import {
  decodeResponse,
  ErrorDetail,
  ProducerTurnEvent,
  Status,
} from "./protocol.js";
import {
  taggedWatchValue,
  WatchChild,
  WatchComment,
  WatchItem,
  WatchUser,
  WatchWorktree,
  watchObject,
} from "./watch-shapes.js";
export {
  WatchChild,
  WatchComment,
  WatchCommentTarget,
  WatchItem,
  WatchUser,
  WatchWorktree,
} from "./watch-shapes.js";
const id = Schema.String.check(Schema.isMinLength(1));
export const WatchProducer = Status.schema.fields.producer;
const cases = {
  ready: watchObject({
    type: Schema.Literal("ready"),
    thread_id: id,
    producer: WatchProducer,
  }),
  item: watchObject({ type: Schema.Literal("item"), item: WatchItem }),
  "item.append": watchObject({
    type: Schema.Literal("item.append"),
    id,
    text: Schema.String,
  }),
  remove: watchObject({ type: Schema.Literal("remove"), id }),
  live: watchObject({ type: Schema.Literal("live") }),
  turn: watchObject({
    type: Schema.Literal("turn"),
    state: Schema.Literals(["idle", "running"]),
    turn_id: Schema.NullOr(id),
    user: Schema.NullOr(WatchUser),
  }),
  "producer.turn": ProducerTurnEvent,
  presence: watchObject({
    type: Schema.Literal("presence"),
    users: Schema.Array(WatchUser),
  }),
  children: watchObject({
    type: Schema.Literal("children"),
    children: Schema.Array(WatchChild),
  }),
  child: watchObject({ type: Schema.Literal("child"), child: WatchChild }),
  "child.remove": watchObject({
    type: Schema.Literal("child.remove"),
    thread_id: id,
  }),
  worktrees: watchObject({
    type: Schema.Literal("worktrees"),
    worktrees: Schema.Array(WatchWorktree),
  }),
  comment: watchObject({
    type: Schema.Literal("comment"),
    comment: WatchComment,
  }),
  "comment.remove": watchObject({ type: Schema.Literal("comment.remove"), id }),
  error: watchObject({ type: Schema.Literal("error"), error: ErrorDetail }),
};
export const KnownWatchEvent = Schema.Union(Object.values(cases));
const knownNames = new Set<string>(Object.keys(cases));
const FutureEvent = watchObject({
  type: Schema.String.check(Schema.makeFilter((type) => !knownNames.has(type))),
});
/** Known malformed types cannot enter the future-event branch. No values are silently dropped. */
export const WatchEvent = Schema.Union([
  taggedWatchValue(KnownWatchEvent, "KnownWatchEvent"),
  taggedWatchValue(FutureEvent, "UnknownWatchEvent"),
]);
/** Terminal envelopes fail as DeltaFailure, like pinned watchEvents, rather than becoming data. */
export const decodeWatchEvent = (input: unknown) =>
  decodeResponse(WatchEvent)(input);
