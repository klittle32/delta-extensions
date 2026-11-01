// AGPL-3.0-only; pinned watch/RemoteView inventory semantics. See NOTICE.
import { Result } from "effect";
import { makeChildInventory } from "./watch-projection-children.js";
import { DeltaFailure } from "./protocol.js";
import type {
  KnownWatchEvent,
  WatchChild,
  WatchComment,
  WatchItem,
  WatchUser,
  WatchWorktree,
} from "./watch-events.js";
import { WatchProjectionError } from "./watch-projection-error.js";
type Event = typeof KnownWatchEvent.Type;
type Ready = Extract<Event, { type: "ready" }>;
type Turn = Extract<Event, { type: "turn" }>;
export interface WatchProjectionState {
  readonly expectedThread: string;
  readonly phase: "idle" | "awaiting-ready" | "snapshot" | "live" | "ended";
  /** A live marker was observed in this attempt; not connection health or authority. */
  readonly snapshotComplete: boolean;
  readonly end: null | "eof" | "failed" | "interrupted" | "stopped";
  readonly ready: Ready | null;
  readonly items: readonly (typeof WatchItem.Type)[];
  readonly comments: readonly (typeof WatchComment.Type)[];
  readonly presence: readonly (typeof WatchUser.Type)[] | null;
  readonly children: readonly (typeof WatchChild.Type)[];
  /** Raw facts only. No inference of our turn, execution rights or reconciled frontier. */
  readonly producerTurn: {
    readonly sequence: number;
    readonly status: "running" | "finished" | "superseded";
    readonly [key: string]: unknown;
  } | null;
  readonly turn: Turn | null;
  readonly worktrees: readonly (typeof WatchWorktree.Type)[] | null;
  /** Upstream retains these last-known facts across ready; flags distinguish fresh reports. */
  readonly reported: { readonly turn: boolean; readonly worktrees: boolean };
}
/** One immutable per-event observation; full inventory is an explicit snapshot read. */
export interface WatchProjectionUpdate {
  readonly event: Event;
  readonly phase: WatchProjectionState["phase"];
  readonly snapshotComplete: boolean;
}
type Facts = Omit<WatchProjectionState, "items" | "comments" | "children">;
// A compile-time exhaustive guard that also fails closed for invalid runtime input.
const unexpected = (_event: never) =>
  Result.fail(new WatchProjectionError({ kind: "invalid-event" }));
/** Private mutable indexes. No Map, iterator or mutable metadata escapes the owner. */
export const makeProjectionInventory = (expectedThread: string) => {
  let facts: Facts = {
    expectedThread,
    phase: "idle",
    snapshotComplete: false,
    end: null,
    ready: null,
    presence: null,
    producerTurn: null,
    turn: null,
    worktrees: null,
    reported: Object.freeze({ turn: false, worktrees: false }),
  };
  const items = new Map<string, typeof WatchItem.Type>();
  const comments = new Map<string, typeof WatchComment.Type>();
  const children = makeChildInventory();
  const apply = (
    event: Event,
  ): Result.Result<
    WatchProjectionUpdate,
    WatchProjectionError | DeltaFailure
  > => {
    // Pinned watch handles producer.turn before its readiness gate.
    if (event.type === "error")
      return Result.fail(new DeltaFailure({ error: event.error }));
    if (
      event.type !== "ready" &&
      event.type !== "producer.turn" &&
      !facts.ready
    )
      return Result.fail(new WatchProjectionError({ kind: "before-ready" }));
    switch (event.type) {
      case "ready":
        if (facts.ready)
          return Result.fail(
            new WatchProjectionError({ kind: "duplicate-ready" }),
          );
        if (event.thread_id !== expectedThread)
          return Result.fail(
            new WatchProjectionError({ kind: "wrong-thread" }),
          );
        items.clear();
        comments.clear();
        children.clear();
        facts = {
          ...facts,
          phase: "snapshot",
          ready: event,
          snapshotComplete: false,
          presence: null,
          producerTurn: event.producer?.turn ?? null,
          reported: Object.freeze({ turn: false, worktrees: false }),
        };
        break;
      case "producer.turn":
        facts = { ...facts, producerTurn: event };
        break;
      case "live":
        facts = { ...facts, phase: "live", snapshotComplete: true };
        break;
      case "item":
        items.set(event.item.id, event.item);
        break;
      case "item.append": {
        const item = items.get(event.id);
        if (!item)
          return Result.fail(
            new WatchProjectionError({ kind: "unknown-item" }),
          );
        // Existing payloads are already owned/frozen. Freeze only the two new
        // containers; no walk or clone of unchanged nested opaque content.
        const content = Object.freeze({
          ...item.content,
          text:
            (typeof item.content.text === "string" ? item.content.text : "") +
            event.text,
        });
        items.set(event.id, Object.freeze({ ...item, content }));
        break;
      }
      case "remove":
        items.delete(event.id);
        break;
      case "comment":
        comments.set(event.comment.id, event.comment);
        break;
      case "comment.remove":
        comments.delete(event.id);
        break;
      case "presence":
        facts = { ...facts, presence: event.users };
        break;
      case "turn":
        facts = {
          ...facts,
          turn: event,
          reported: Object.freeze({ ...facts.reported, turn: true }),
        };
        break;
      case "children":
        children.replace(event.children);
        break;
      case "child":
        children.upsert(event.child);
        break;
      case "child.remove":
        children.remove(event.thread_id);
        break;
      case "worktrees":
        facts = {
          ...facts,
          worktrees: event.worktrees,
          reported: Object.freeze({ ...facts.reported, worktrees: true }),
        };
        break;
      default:
        return unexpected(event);
    }
    return Result.succeed(
      Object.freeze({
        event,
        phase: facts.phase,
        snapshotComplete: facts.snapshotComplete,
      }),
    );
  };
  return {
    apply,
    begin: () => {
      facts = {
        ...facts,
        phase: "awaiting-ready",
        ready: null,
        snapshotComplete: false,
        end: null,
        reported: Object.freeze({ turn: false, worktrees: false }),
      };
    },
    finish: (end: WatchProjectionState["end"]) => {
      facts = { ...facts, phase: "ended", end };
    },
    isComplete: () => facts.snapshotComplete,
    // O(inventory size), only on explicit request. Payloads are immutable and
    // shared safely; fresh frozen ordered arrays cannot mutate the private maps.
    snapshot: (): WatchProjectionState =>
      Object.freeze({
        ...facts,
        items: Object.freeze(Array.from(items.values())),
        comments: Object.freeze(Array.from(comments.values())),
        children: children.snapshot(),
      }),
  };
};
/** Root target and immediate parent follow RemoteView; removing a root does not cascade. */
export const commentContext = (state: WatchProjectionState, id: string) => {
  const comment = state.comments.find((c) => c.id === id);
  return {
    parent:
      comment?.after_id == null
        ? undefined
        : state.comments.find((c) => c.id === comment.after_id),
    target: !comment
      ? undefined
      : comment.chain === comment.id
        ? comment.target
        : state.comments.find((c) => c.id === comment.chain)?.target,
  };
};
