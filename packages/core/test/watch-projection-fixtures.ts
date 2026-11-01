// AGPL-3.0-only; adapted pinned RemoteView test values. See NOTICE.
import { Stream } from "effect";
import { decodeWatchEvent } from "../src/watch-events.js";
export const ready = { type: "ready", thread_id: "thread", producer: null };
export const live = { type: "live" };
export const item = (
  id: string,
  text: unknown = id,
  after_id: string | null = null,
) => ({
  type: "item",
  item: {
    id,
    kind: "future",
    after_id,
    turn_id: null,
    author: null,
    created_at: null,
    open: true,
    content: { text, opaque: { keep: [1, "🙂"] } },
  },
});
export const user = { user_id: "u", name: "Ada" };
export const comment = (
  id: string,
  chain = id,
  after_id: string | null = null,
) => ({
  type: "comment",
  comment: {
    id,
    chain,
    after_id,
    delivered_with: "i",
    routed_to: null,
    author: user,
    co_authors: [],
    agent: false,
    created_at: null,
    text: id,
    target: chain === id ? { kind: "future", opaque: true } : null,
  },
});
export const events = (...frames: unknown[]) =>
  Stream.fromIterable(frames).pipe(Stream.mapEffect(decodeWatchEvent));
