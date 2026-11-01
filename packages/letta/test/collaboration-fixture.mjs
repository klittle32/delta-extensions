#!/usr/bin/env node
// Deterministic real subprocess fixture, not live Delta verification.
import {
  appendFileSync,
  readFileSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2).slice(1);
const file = join(process.cwd(), "fixture.json");
const state = existsSync(file)
  ? JSON.parse(readFileSync(file, "utf8"))
  : { next: 1 };
const log = join(process.cwd(), "calls.jsonl");
appendFileSync(log, JSON.stringify(args) + "\n");
const emit = (v) => process.stdout.write(JSON.stringify(v) + "\n");
const externalId = args.includes("--external-id")
  ? args[args.indexOf("--external-id") + 1]
  : "none";
state.producers ??= {};
const next = state.producers[externalId] ?? 1;
const producer = {
  source: "letta-code",
  external_id: args[args.indexOf("--external-id") + 1],
  next_sequence: next,
  turn: null,
};
if (args[1] === "contract") emit({ operation: "contract", min: 8, max: 8 });
else if (args[1] === "status") {
  if (state.statusFailures > 0) {
    state.statusFailures--;
    writeFileSync(file, JSON.stringify(state));
    emit({
      error: { code: "offline", message: "transient status", retryable: true },
    });
    process.exitCode = 3;
  } else
    emit({
      operation: "status",
      thread_id: "thread-1",
      title: null,
      url: "https://delta.dev/join/a",
      access: { state: state.access ?? "granted", is_owner: true },
      visibility: "private",
      upload: { state: "uploaded", organization_id: null, error: null },
      worktrees: {
        status: "available",
        items: state.empty
          ? []
          : [
              {
                reference: "tree-1",
                checkouts: [
                  { directory: process.cwd(), state: "attached", active: true },
                ],
              },
            ],
      },
      producer,
    });
} else if (args[0] === "thread" && args[1] === "create")
  emit({ operation: "created", created: true, thread_id: "thread-1" });
else if (args[0] === "worktree" && args[1] === "list")
  emit({ operation: "listed", worktrees: [] });
else if (args[0] === "worktree" && args[1] === "create")
  emit({ operation: "created", worktree_id: "tree-1", reference: "tree-1" });
else if (args[1] === "attach" || args[1] === "share" || args[1] === "invite")
  emit({
    operation: args[1] === "share" ? "shared" : "attached",
    url: "https://delta.dev/join/a",
    thread_id: "thread-1",
    reference: "tree-1",
  });
else if (args[1] === "mount") {
  writeFileSync(join(process.cwd(), "mount-cwd.txt"), process.cwd());
  emit(
    args[0] === "thread"
      ? {
          operation: "mounted",
          thread_id: "thread-1",
          owner: args[args.indexOf("--owner") + 1],
          directory: process.cwd(),
          worktrees: [
            {
              reference: "tree-1",
              name: "repo",
              directory: process.cwd(),
              state: "attached",
            },
          ],
        }
      : { operation: "mounted", reference: "tree-1", directory: args[3] },
  );
  appendFileSync(
    join(process.cwd(), "mount-pids.jsonl"),
    JSON.stringify(process.pid) + "\n",
  );
  setInterval(() => {}, 1000);
} else if (args[1] === "watch") {
  state.watchCount = (state.watchCount ?? 0) + 1;
  writeFileSync(file, JSON.stringify(state));
  emit({ type: "ready", thread_id: "thread-1", producer });
  const largeUpdates = () => {
    for (let n = 0; n < 20; n++)
      emit({
        type: "item",
        item: {
          id: `large-${n}`,
          kind: "agent_message",
          after_id: null,
          turn_id: null,
          author: { user_id: null, name: "Remote" },
          created_at: null,
          open: false,
          content: { text: `LIVE_UPDATE_${n} ${"x".repeat(24_000)}` },
        },
      });
  };
  if (state.watchLargeUpdates && state.watchCount > 1) largeUpdates();
  if (state.watchRemote) {
    const item = (id, kind, text) => ({
      type: "item",
      item: {
        id,
        kind,
        after_id: null,
        turn_id: null,
        author: { user_id: null, name: "Remote" },
        created_at: null,
        open: false,
        content: { text },
      },
    });
    emit(
      item("remote", "agent_message", `remote snapshot ${state.watchCount}`),
    );
    emit(item("thought", "agent_thought", "remote human thought"));
  }
  writeFileSync(join(process.cwd(), "watch-ready"), "ready");
  if (state.watchGate)
    while (!existsSync(join(process.cwd(), "watch-allow")))
      await new Promise((resolve) => setTimeout(resolve, 10));
  if (state.watchRefusal) {
    emit({
      error: {
        code: "reload_required",
        message: "delayed refusal",
        retryable: false,
      },
    });
    process.exitCode = 3;
  } else emit({ type: "live" });
  if (state.watchLargeUpdates && state.watchCount === 1) largeUpdates();
  if (!state.watchRestartOnce || state.watchCount > 1)
    setInterval(() => {}, 1000);
} else if (args[1] === "fork") {
  emit({ thread_id: "fork-kept" });
} else if (args[1] === "discard") {
  state.reload = false;
  writeFileSync(file, JSON.stringify(state));
  emit({ operation: "discarded", thread_id: "thread-1" });
} else if (args[1] === "append") {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  if (state.offlineAttempts > 0) {
    state.offlineAttempts--;
    writeFileSync(file, JSON.stringify(state));
    emit({
      error: {
        code: "offline",
        message: "fixture offline",
        retryable: true,
        retry_after_ms: 1,
      },
    });
    process.exitCode = 3;
  } else if (state.reload) {
    emit({
      error: {
        code: "reload_required",
        message: "fixture reload",
        retryable: false,
      },
    });
    process.exitCode = 3;
  } else {
    appendFileSync(join(process.cwd(), "records.jsonl"), text);
    for (const line of text.trim().split("\n")) {
      const row = JSON.parse(line);
      state.next = row.sequence + 1;
      state.producers[externalId] = state.next;
      emit({
        operation: "appended",
        thread_id: "thread-1",
        sequence: row.sequence,
        next_sequence: state.next,
        duplicate: false,
        disposition: state.fenced ? "fenced" : "recorded",
        turn_sequence: row.turnSequence ?? null,
        version: "a.1",
      });
    }
    writeFileSync(file, JSON.stringify(state));
  }
} else {
  process.stderr.write("unknown fixture command");
  process.exitCode = 2;
}
