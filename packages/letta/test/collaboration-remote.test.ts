// Grounded in pinned hooks/watch/conversation.ts: renderComment (comments are
// model context, replies carry parent and chain target, routed comments are
// context only), endSnapshot/nextRow (open items wait, newest-first budget,
// five drawn rows) and commentRow/removed*Row (edits and removals corrected).
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { decodeWatchEvent } from "../../core/src/watch-events.js";
import { makeWatchProjection } from "../../core/src/watch-projection.js";
import type { WatchProjectionState } from "../../core/src/watch-projection-state.js";
import { remoteDelivery } from "../src/collaboration/remote.js";

const ready = {
  type: "ready",
  thread_id: "thread",
  producer: {
    source: "letta-code",
    external_id: "here",
    next_sequence: 1,
    actor_id: "own",
    turn: null,
  },
};
const item = (
  id: string,
  kind: string,
  text: string,
  options: { actor?: string; open?: boolean } = {},
) => ({
  type: "item",
  item: {
    id,
    kind,
    after_id: null,
    turn_id: null,
    author: {
      user_id: null,
      name: "Remote",
      actor_id: options.actor ?? "other",
    },
    created_at: null,
    open: options.open ?? false,
    content: { text },
  },
});
const comment = (
  id: string,
  text: string,
  options: {
    chain?: string;
    after?: string | null;
    routed?: string | null;
    target?: unknown;
    name?: string;
  } = {},
) => ({
  type: "comment",
  comment: {
    id,
    chain: options.chain ?? id,
    after_id: options.after ?? null,
    delivered_with: "remote",
    routed_to: options.routed ?? null,
    author: { user_id: null, name: options.name ?? "Person" },
    co_authors: [],
    agent: false,
    created_at: null,
    text,
    target: options.target ?? null,
  },
});
const snapshot = (events: readonly unknown[]): Promise<WatchProjectionState> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const projection = yield* makeWatchProjection("thread");
      yield* Stream.runDrain(
        projection.project(
          Stream.fromIterable([ready, ...events, { type: "live" }]).pipe(
            Stream.mapEffect(decodeWatchEvent),
          ),
        ),
      );
      return yield* projection.snapshot;
    }),
  );
/** Feed receipts forward the way the adapter persists them. */
const deliver = (
  state: WatchProjectionState,
  seen: Set<string>,
  local = new Set<string>(),
) => {
  const result = remoteDelivery(state, seen, local);
  for (const receipt of result.receipts) seen.add(receipt);
  return result;
};

describe("remote delivery", () => {
  it("delivers comments as model context, keeps only thoughts human-only, excludes own echo and deduplicates", async () => {
    const state = await snapshot([
      item("thought", "agent_thought", "PRIVATE_THOUGHT"),
      item("remote", "agent_message", "REMOTE_MESSAGE"),
      item("own", "agent_message", "OWN_ECHO", { actor: "own" }),
      comment("c1", "HUMAN_COMMENT <b>&"),
    ]);
    const seen = new Set<string>();
    const delivery = deliver(state, seen);
    expect(delivery.model).toContain("REMOTE_MESSAGE");
    expect(delivery.model).toContain("[Delta] Person, comment (comment c1):");
    expect(delivery.model).toContain(
      '<comment from="Person">HUMAN_COMMENT &lt;b&gt;&amp;</comment>',
    );
    expect(delivery.model).not.toContain("PRIVATE_THOUGHT");
    expect(delivery.model).not.toContain("OWN_ECHO");
    const human = delivery.human.join("\n");
    expect(human).toContain("PRIVATE_THOUGHT");
    expect(human).toContain("HUMAN_COMMENT");
    expect(human).not.toContain("OWN_ECHO");
    const again = deliver(state, seen);
    expect(again).toEqual({ model: "", human: [], receipts: [] });
  });

  it("gives replies their parent and chain target, and marks routed comments as context, not requests", async () => {
    const file = {
      kind: "file",
      worktree: null,
      path: "src/parse.ts",
      view: "diff",
      selected: "parse(<input>)",
      regions: [
        {
          first_line: 10,
          last_line: 11,
          status: "added",
          text: "const a = 1;\nconst b = 2;",
        },
      ],
    };
    const state = await snapshot([
      comment("root", "Why this?", { target: file, name: "Ada" }),
      comment("reply", "Because of X", {
        chain: "root",
        after: "root",
        name: "Bo",
      }),
      comment("routed", "Subagent: fix it", { routed: "child-thread" }),
    ]);
    const { model } = deliver(state, new Set());
    const reply = model.slice(model.indexOf("(comment reply)"));
    expect(model).toContain("[Delta] Bo, reply to a comment (comment reply):");
    expect(reply).toContain("<file>src/parse.ts</file>");
    expect(reply).toContain("10 + const a = 1;");
    expect(reply).toContain("<selected>parse(&lt;input&gt;)</selected>");
    expect(reply).toMatch(
      /<comment from="Ada">Why this\?<\/comment>\s*<comment from="Bo">Because of X<\/comment>/,
    );
    expect(model).toContain(
      "It was sent to the Delta subthread child-thread, not to you.",
    );
  });

  it("quotes transcript targets but never the text of a remote thought", async () => {
    const state = await snapshot([
      item("thought", "agent_thought", "SECRET_REASONING"),
      item("msg", "agent_message", "visible message"),
      comment("on-thought", "Interesting idea", {
        target: {
          kind: "transcript",
          item_id: "thought",
          quote: "SECRET_REASONING",
        },
      }),
      comment("on-msg", "Agree", {
        target: {
          kind: "transcript",
          item_id: "msg",
          quote: "visible message",
        },
      }),
    ]);
    const { model } = deliver(state, new Set());
    expect(model).not.toContain("SECRET_REASONING");
    expect(model).toContain("<quote>visible message</quote>");
    expect(model).toContain("Interesting idea");
  });

  it("waits for open items to close before delivering, and then delivers them once", async () => {
    const seen = new Set<string>();
    const open = deliver(
      await snapshot([item("m", "agent_message", "partial", { open: true })]),
      seen,
    );
    expect(open.model).not.toContain("partial");
    expect(open.human.join("\n")).not.toContain("partial");
    expect(open.receipts).toEqual([]);
    const closed = deliver(
      await snapshot([item("m", "agent_message", "complete answer")]),
      seen,
    );
    expect(closed.model).toContain("complete answer");
    expect(
      deliver(
        await snapshot([item("m", "agent_message", "complete answer")]),
        seen,
      ).model,
    ).toBe("");
  });

  it("corrects edits and removals of delivered rows exactly once, and ignores ones never shown", async () => {
    const seen = new Set<string>();
    deliver(
      await snapshot([
        item("m", "agent_message", "first text"),
        item("gone", "agent_message", "will vanish"),
        item("t", "agent_thought", "a thought"),
        comment("c", "original comment"),
        comment("withdrawn", "please ignore later"),
      ]),
      seen,
    );
    const next = await snapshot([
      item("m", "agent_message", "edited text"),
      comment("c", "edited comment"),
      item("new-open", "agent_message", "never shown", { open: true }),
    ]);
    const correction = deliver(next, seen);
    expect(correction.model).toContain(
      "changed an earlier item (item m); it now reads:",
    );
    expect(correction.model).toContain("edited text");
    expect(correction.model).toContain(
      "[Delta] Person changed an earlier comment (comment c); it now reads:",
    );
    expect(correction.model).toContain(
      "An earlier item (item gone) was removed from the shared thread; disregard it.",
    );
    expect(correction.model).toContain(
      "An earlier comment (comment withdrawn) was withdrawn from the shared thread; disregard it.",
    );
    // A thought never reached the model, so its removal needs no model correction.
    expect(correction.model).not.toContain("item t");
    const human = correction.human.join("\n");
    expect(human).toContain("item gone");
    expect(human).toContain("comment withdrawn");
    expect(deliver(next, seen)).toEqual({ model: "", human: [], receipts: [] });
  });

  it("keeps the newest rows within the 400k budget and draws at most five for the person", async () => {
    const events = Array.from({ length: 40 }, (_, i) =>
      item(`i${i}`, "agent_message", `${i}:`.padEnd(20_000, "x")),
    );
    const { model, human } = deliver(await snapshot(events), new Set());
    expect(model.length).toBeLessThanOrEqual(400_000);
    expect(model).toContain("[item i39]");
    expect(model).not.toContain("[item i0]");
    expect(model).toMatch(/Older\/full history: delta thread show 'thread'/);
    expect(human).toHaveLength(5);
    expect(human[0]).toContain("[item i39]");
  });

  it("does not re-deliver items the local producer authored by message id", async () => {
    const state = await snapshot([
      {
        ...item("x", "user_message", "my message"),
        item: {
          ...item("x", "user_message", "my message").item,
          content: { text: "my message", messageId: "u1" },
        },
      },
    ]);
    expect(deliver(state, new Set(), new Set(["u1"])).model).toBe("");
  });

  it("keeps a removed thought human-only when a later comment quotes it, and fails closed on unknown targets", async () => {
    const seen = new Set<string>();
    deliver(
      await snapshot([item("t1", "agent_thought", "SECRET_REASONING")]),
      seen,
    );
    // The thought is gone from the current snapshot; its receipt still classifies it.
    const later = await snapshot([
      comment("c-thought", "About that idea", {
        target: {
          kind: "transcript",
          item_id: "t1",
          quote: "SECRET_REASONING",
        },
      }),
      comment("c-unknown", "About something", {
        target: {
          kind: "transcript",
          item_id: "never-seen",
          quote: "UNKNOWN_QUOTE",
        },
      }),
      comment("c-null", "About a passage", {
        target: { kind: "transcript", item_id: null, quote: "NULL_QUOTE" },
      }),
    ]);
    const { model } = deliver(later, seen);
    expect(model).not.toContain("SECRET_REASONING");
    expect(model).not.toContain("UNKNOWN_QUOTE");
    expect(model).not.toContain("NULL_QUOTE");
    // The comments themselves are still delivered.
    for (const text of [
      "About that idea",
      "About something",
      "About a passage",
    ])
      expect(model).toContain(text);
    // An edited comment on the removed thought stays closed too.
    const edited = await snapshot([
      comment("c-thought", "About that idea, revised", {
        target: {
          kind: "transcript",
          item_id: "t1",
          quote: "SECRET_REASONING",
        },
      }),
    ]);
    const correction = deliver(edited, seen).model;
    expect(correction).toContain("revised");
    expect(correction).not.toContain("SECRET_REASONING");
  });

  it("budgets corrections with new rows, caps human notices at five, and never replays an omitted change", async () => {
    const seen = new Set<string>();
    const big = (i: number, tag: string) =>
      item(`e${i}`, "agent_message", `${tag}${i}:`.padEnd(23_000, "y"));
    deliver(
      await snapshot(Array.from({ length: 20 }, (_, i) => big(i, "v1-"))),
      seen,
    );
    for (let i = 0; i < 20; i++) seen.add(`item:e${i}:legacy`); // ensure all ids count as shown
    const edited = await snapshot(
      Array.from({ length: 20 }, (_, i) => big(i, "v2-")),
    );
    const first = deliver(edited, seen);
    expect(first.model.length).toBeLessThanOrEqual(400_000);
    expect(first.model).toContain("changed an earlier item (item e19)");
    expect(first.model).toMatch(/omitted/);
    expect(first.human.length).toBeLessThanOrEqual(5);
    // Omitted corrections are classified as omitted, never as delivered.
    const delivered = first.receipts.filter((r) => r.startsWith("item:"));
    const omitted = first.receipts.filter((r) => r.startsWith("omitted:"));
    expect(delivered.length + omitted.length).toBe(20);
    expect(omitted.length).toBeGreaterThan(0);
    for (const receipt of delivered)
      expect(first.model).toContain(`(item ${receipt.split(":")[1]})`);
    // Exactly one correction per revision: nothing is replayed.
    expect(deliver(edited, seen)).toEqual({
      model: "",
      human: [],
      receipts: [],
    });

    // Mass removal is budgeted and capped the same way, then settles.
    const removedSnapshot = await snapshot([]);
    const removal = deliver(removedSnapshot, seen);
    expect(removal.model.length).toBeLessThanOrEqual(400_000);
    expect(removal.human.length).toBeLessThanOrEqual(5);
    expect(removal.model).toContain("was removed from the shared thread");
    expect(deliver(removedSnapshot, seen)).toEqual({
      model: "",
      human: [],
      receipts: [],
    });
  });
});
