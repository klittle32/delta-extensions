// AGPL-3.0-only; pinned child-list first-match/duplicate semantics. See NOTICE.
import type { WatchChild } from "./watch-events.js";
type Child = typeof WatchChild.Type;
/** Two private indexes preserve list duplicates/order without scanning unrelated children. */
export const makeChildInventory = () => {
  const ordered = new Map<object, Child>();
  const byId = new Map<string, Set<object>>();
  const append = (child: Child) => {
    const slot = {};
    ordered.set(slot, child);
    let slots = byId.get(child.thread_id);
    if (!slots) {
      slots = new Set();
      byId.set(child.thread_id, slots);
    }
    slots.add(slot);
  };
  const clear = () => {
    ordered.clear();
    byId.clear();
  };
  return {
    clear,
    replace: (children: readonly Child[]) => {
      clear();
      for (const child of children) append(child);
    },
    upsert: (child: Child) => {
      const first = byId.get(child.thread_id)?.values().next().value;
      if (first) ordered.set(first, child);
      else append(child);
    },
    remove: (id: string) => {
      const slots = byId.get(id);
      if (slots) for (const slot of slots) ordered.delete(slot);
      byId.delete(id);
    },
    snapshot: () => Object.freeze(Array.from(ordered.values())),
  };
};
