// AGPL-3.0-only; adapted from pinned hooks/watch/conversation.ts (renderComment,
// removed*Row, endSnapshot, nextRow): bounds, visibility and correction policy.
import { createHash } from "node:crypto";
import {
  commentContext,
  type WatchProjectionState,
} from "../../../core/src/watch-projection-state.js";

export interface RemoteDelivery {
  readonly model: string;
  readonly human: readonly string[];
  readonly receipts: readonly string[];
}
type Item = WatchProjectionState["items"][number];
type Comment = WatchProjectionState["comments"][number];
type Target = NonNullable<Comment["target"]>;

const BUDGET = 399_000;
const ROW_LIMIT = 24_000;
const SECTION_LIMIT = 4_000;
const HUMAN_LIMIT = 5;
const THOUGHT = "agent_thought";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (text: string, limit: number) =>
  text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n[… ${text.length - limit} more characters not shown.]`;
const itemAuthor = (item: Item) => item.author?.name ?? "Delta collaborator";
const commentAuthor = (comment: Comment) =>
  [comment.author.name, ...comment.co_authors.map((p) => p.name)]
    .filter((name): name is string => Boolean(name?.trim()))
    .filter((name, i, all) => all.indexOf(name) === i)
    .join(", ") || "Delta collaborator";
const itemText = (item: Item) =>
  typeof item.content.text === "string"
    ? item.content.text
    : item.kind === "tool_call"
      ? JSON.stringify(item.content)
      : "";

/** `<prefix><id>:<revision>` receipts; ids may contain colons, revisions do not. */
const parse = (receipt: string, prefix: string) => {
  if (!receipt.startsWith(prefix)) return undefined;
  const body = receipt.slice(prefix.length);
  const split = body.lastIndexOf(":");
  return split < 0
    ? undefined
    : { id: body.slice(0, split), revision: body.slice(split + 1) };
};

/**
 * The persisted ledger: rows the model was shown (by id and revision), removals
 * already corrected or explicitly omitted, and every id ever classified as a
 * thought, so a thought stays human-only after it leaves the snapshot.
 */
const ledger = (seen: ReadonlySet<string>, kind: "item" | "comment") => {
  const known = new Map<string, string[]>();
  const removed = new Set<string>();
  for (const receipt of seen) {
    const shown = parse(receipt, `${kind}:`);
    if (shown)
      known.set(shown.id, [...(known.get(shown.id) ?? []), shown.revision]);
    const gone =
      parse(receipt, `removed:${kind}:`) ??
      parse(receipt, `omitted-removal:${kind}:`);
    if (gone) removed.add(`${gone.id}:${gone.revision}`);
  }
  return { known, removed };
};

const renderTarget = (
  target: Target | null | undefined,
  quotable: (id: string | null) => boolean,
) => {
  if (!target) return [];
  if (target._tag === "FileTarget") {
    const file = target.value;
    const lines = [`  <file>${escape(file.path)}</file>`];
    const context = file.regions
      .flatMap((region) => {
        const mark =
          region.status === "added"
            ? "+"
            : region.status === "deleted"
              ? "-"
              : " ";
        return region.text
          .split("\n")
          .map((line, i) => `${region.first_line + i} ${mark} ${line}`);
      })
      .join("\n");
    if (context)
      lines.push(
        "  <context>",
        escape(clip(context, SECTION_LIMIT)),
        "  </context>",
      );
    if (file.selected)
      lines.push(
        `  <selected>${escape(clip(file.selected, SECTION_LIMIT))}</selected>`,
      );
    return lines;
  }
  if (target._tag === "TranscriptTarget") {
    const quote = target.value.quote.trim();
    if (!quote) return [];
    // Fail closed: quote only rows known to be model-visible, never a thought
    // (current or historic) or a passage whose source cannot be classified.
    if (!quotable(target.value.item_id))
      return ["  <context>(about a passage that is not shown here)</context>"];
    return [
      `  <context><quote>${escape(clip(quote, SECTION_LIMIT))}</quote></context>`,
    ];
  }
  return [];
};

const renderComment = (
  snapshot: WatchProjectionState,
  comment: Comment,
  edited: boolean,
  quotable: (id: string | null) => boolean,
) => {
  const text = comment.text.trim();
  if (!text) return undefined;
  const { parent, target } = commentContext(snapshot, comment.id);
  const author = commentAuthor(comment);
  const label = comment.chain !== comment.id ? "reply to a comment" : "comment";
  const lines = [
    edited
      ? `[Delta] ${author} changed an earlier ${label} (comment ${comment.id}); it now reads:`
      : `[Delta] ${author}, ${label} (comment ${comment.id}):`,
  ];
  if (comment.routed_to)
    lines.push(
      `It was sent to the Delta subthread ${comment.routed_to}, not to you.`,
    );
  lines.push("<comments>", ...renderTarget(target, quotable));
  const answered =
    comment.chain !== comment.id && parent ? parent.text.trim() : "";
  if (answered)
    lines.push(
      `  <comment from="${escape(commentAuthor(parent!))}">${escape(clip(answered, SECTION_LIMIT))}</comment>`,
    );
  lines.push(
    `  <comment from="${escape(author)}">${escape(text)}</comment>`,
    "</comments>",
  );
  return clip(lines.join("\n"), ROW_LIMIT);
};

/** One candidate row; `omitted` receipts settle it without claiming delivery. */
interface Row {
  readonly model?: string;
  readonly human?: string;
  readonly delivered: readonly string[];
  readonly omitted: readonly string[];
}

/**
 * New, changed and withdrawn remote rows since `seen`. Comments and closed
 * items are model context; thoughts are human-only; open items wait. Every row,
 * corrections included, shares one newest-first budget (the newest always
 * fits) and one five-notice human limit. Rows past either are explicitly
 * omitted, settled by `omitted…` receipts so they are never replayed.
 */
export const remoteDelivery = (
  snapshot: WatchProjectionState,
  seen: ReadonlySet<string>,
  local: ReadonlySet<string>,
): RemoteDelivery => {
  if (!snapshot.snapshotComplete) return { model: "", human: [], receipts: [] };
  const own = snapshot.ready?.producer?.actor_id;
  const items = ledger(seen, "item");
  const comments = ledger(seen, "comment");
  const thoughts = new Set(
    snapshot.items.filter((i) => i.kind === THOUGHT).map((i) => i.id),
  );
  for (const receipt of seen) {
    const thought = parse(receipt, "thought:");
    if (thought) thoughts.add(thought.id);
  }
  const visible = new Set(
    snapshot.items.filter((i) => i.kind !== THOUGHT).map((i) => i.id),
  );
  const quotable = (id: string | null) =>
    id !== null &&
    !thoughts.has(id) &&
    (visible.has(id) || items.known.has(id));
  const rows: Row[] = [];

  for (const item of snapshot.items) {
    if (item.open) continue;
    if ((own && item.author?.actor_id === own) || local.has(item.id)) continue;
    const messageId = item.content.messageId ?? item.content.message_id;
    if (typeof messageId === "string" && local.has(messageId)) continue;
    const text = itemText(item);
    if (!text) continue;
    const revision = hash(item.content);
    if (item.kind === THOUGHT) {
      // The classification receipt is recorded even when not drawn.
      const receipt = `thought:${item.id}:${revision}`;
      if (!seen.has(receipt))
        rows.push({
          human: clip(
            `${itemAuthor(item)} (thinking) [item ${item.id}]: ${text}`,
            2000,
          ),
          delivered: [receipt],
          omitted: [receipt],
        });
      continue;
    }
    const receipt = `item:${item.id}:${revision}`;
    const skipped = `omitted:item:${item.id}:${revision}`;
    if (seen.has(receipt) || seen.has(skipped)) continue;
    const rendered = items.known.has(item.id)
      ? `[Delta] ${itemAuthor(item)} changed an earlier item (item ${item.id}); it now reads:\n${text}`
      : `${itemAuthor(item)} [item ${item.id}]: ${text}`;
    rows.push({
      model: clip(rendered, ROW_LIMIT),
      human: clip(rendered, 2000),
      delivered: [receipt],
      omitted: [skipped],
    });
  }
  for (const comment of snapshot.comments) {
    const { target } = commentContext(snapshot, comment.id);
    const shownTarget =
      target?._tag === "TranscriptTarget"
        ? { ...target, value: { ...target.value, item_id: null } }
        : (target ?? null);
    const revision = hash({
      text: comment.text,
      target: shownTarget,
      chain: comment.chain,
      routed_to: comment.routed_to,
    });
    const receipt = `comment:${comment.id}:${revision}`;
    const skipped = `omitted:comment:${comment.id}:${revision}`;
    if (seen.has(receipt) || seen.has(skipped)) continue;
    const rendered = renderComment(
      snapshot,
      comment,
      comments.known.has(comment.id),
      quotable,
    );
    if (!rendered) continue;
    rows.push({
      model: rendered,
      human: clip(
        `Delta comment from ${commentAuthor(comment)}${comment.routed_to ? ` (sent to subthread ${comment.routed_to})` : ""}: ${comment.text}`,
        2000,
      ),
      delivered: [receipt],
      omitted: [skipped],
    });
  }
  // Withdrawn rows the model was shown get one explicit correction, budgeted
  // like any other row; its settlement covers every shown revision.
  const present = {
    item: new Set(snapshot.items.map((i) => i.id)),
    comment: new Set(snapshot.comments.map((c) => c.id)),
  };
  for (const [kind, entries] of [
    ["item", items],
    ["comment", comments],
  ] as const)
    for (const [id, revisions] of entries.known) {
      if (present[kind].has(id)) continue;
      const open = revisions.filter(
        (revision) => !entries.removed.has(`${id}:${revision}`),
      );
      if (!open.length) continue;
      const text =
        kind === "item"
          ? `[Delta] An earlier item (item ${id}) was removed from the shared thread; disregard it.`
          : `[Delta] An earlier comment (comment ${id}) was withdrawn from the shared thread; disregard it.`;
      rows.push({
        model: text,
        human: text,
        delivered: open.map((revision) => `removed:${kind}:${id}:${revision}`),
        omitted: open.map(
          (revision) => `omitted-removal:${kind}:${id}:${revision}`,
        ),
      });
    }

  const model: string[] = [];
  const human: string[] = [];
  const receipts: string[] = [];
  let used = 0;
  let omittedModel = 0;
  let omittedHuman = 0;
  // Newest first: rows were collected in thread order with corrections last.
  for (const row of [...rows].reverse()) {
    if (row.model === undefined) {
      receipts.push(...row.delivered);
      if (row.human && human.length < HUMAN_LIMIT) human.push(row.human);
      else if (row.human) omittedHuman++;
      continue;
    }
    if (model.length && used + row.model.length > BUDGET) {
      omittedModel++;
      receipts.push(...row.omitted);
      continue;
    }
    used += row.model.length;
    model.push(row.model);
    receipts.push(...row.delivered);
    if (row.human && human.length < HUMAN_LIMIT) human.push(row.human);
    else if (row.human) omittedHuman++;
  }
  omittedHuman += omittedModel;
  if (omittedHuman) {
    // The summary takes the last of the five slots rather than adding a sixth.
    if (human.length === HUMAN_LIMIT) {
      human.pop();
      omittedHuman++;
    }
    human.push(
      `${omittedHuman} more Delta updates are not shown here; open the shared thread to read them.`,
    );
  }
  const thread = snapshot.expectedThread.replaceAll("'", "'\\''");
  const route = `Older/full history: delta thread show '${thread}' --format messages --messages 1-20`;
  const omission = omittedModel
    ? `\n[${omittedModel} older Delta rows or corrections were omitted to stay within the context budget.]`
    : "";
  return {
    model: model.length
      ? `[Delta]\n${model.reverse().join("\n\n")}${omission}\n${route}`
      : "",
    human,
    receipts,
  };
};
