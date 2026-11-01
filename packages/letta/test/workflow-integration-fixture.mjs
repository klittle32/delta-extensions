#!/usr/bin/env node
// AGPL-3.0-only. Deterministic fake Delta CLI for end-to-end adapter tests.
// Not live Delta verification. Grammar follows the pinned reference
// (hooks/cli/delta-cli.ts, cli/auth.ts, cli/install-update.ts) with the Letta
// producer source `letta-code` and integration `letta_code`. Any invocation
// outside that grammar is recorded as a violation and exits 2, so tests reject
// an illegal protocol instead of matching whatever the adapter happens to send.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

const root = process.env.DELTA_FIXTURE_DIR;
if (!root || !isAbsolute(root)) {
  process.stderr.write("DELTA_FIXTURE_DIR is required\n");
  process.exit(2);
}
const argv = process.argv.slice(2);
const stateFile = join(root, "state.json");
const lockDir = join(root, "state.lock");
const SOURCE = "letta-code";
const FORMS = ["delta_subcommand", "dedicated_command"];
const integration = process.env.DELTA_CLI_INTEGRATION ?? null;
const form = process.env.DELTA_CLI_COMMAND_FORM ?? null;

const lock = () => {
  for (let i = 0; i < 2000; i++) {
    try {
      mkdirSync(lockDir);
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  throw new Error("fixture lock timeout");
};
const withState = (fn) => {
  lock();
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    const result = fn(state);
    writeFileSync(`${stateFile}.tmp`, JSON.stringify(state, null, 1));
    renameSync(`${stateFile}.tmp`, stateFile);
    return result;
  } finally {
    rmdirSync(lockDir);
  }
};
const peek = () => JSON.parse(readFileSync(stateFile, "utf8"));

appendFileSync(
  join(root, "calls.jsonl"),
  `${JSON.stringify({ argv, cwd: process.cwd(), integration, form, pid: process.pid })}\n`,
);
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const violation = (reason) => {
  appendFileSync(
    join(root, "violations.jsonl"),
    `${JSON.stringify({ argv, integration, form, reason })}\n`,
  );
  process.stderr.write(`fixture protocol violation: ${reason}\n`);
  process.exit(2);
};
// Missing integration identity is recorded as its own finding (asserted by a
// dedicated test) rather than aborting, so downstream protocol stays observable.
const requireIntegration = () => {
  if (integration !== "letta_code")
    appendFileSync(
      join(root, "integration-missing.jsonl"),
      `${JSON.stringify({ argv, integration })}\n`,
    );
};
const failWith = (code, message, extra = {}) => {
  emit({ error: { code, message, ...extra } });
  process.exit(1);
};
const exact = (expected) =>
  argv.length === expected.length &&
  expected.every((part, i) => part === null || argv[i] === part);
const nonempty = (v) => typeof v === "string" && v.length > 0;
const live = (kind) => {
  appendFileSync(
    join(root, "live.jsonl"),
    `${JSON.stringify({ kind, pid: process.pid, argv })}\n`,
  );
  const keep = setInterval(() => {}, 1 << 30);
  const stop = () => {
    clearInterval(keep);
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
};
const producerOf = (state, thread, externalId) => {
  const t = state.threads[thread];
  t.producers[externalId] ??= { next: 1, turn: null, records: [] };
  const p = t.producers[externalId];
  return {
    source: SOURCE,
    external_id: externalId,
    next_sequence: p.next,
    turn: p.turn,
    actor_id: state.actor,
  };
};
const statusOf = (state, thread, externalId) => {
  const t = state.threads[thread];
  return {
    operation: "status",
    thread_id: thread,
    url: t.url,
    title: null,
    access: { state: t.access ?? "granted", is_owner: t.owned ?? true },
    visibility: t.visibility,
    upload: {
      state: "uploaded",
      organization_id: t.organization ?? null,
      error: null,
    },
    worktrees: {
      status: "available",
      items: t.worktrees.map((reference) => ({
        reference,
        checkouts: (state.checkouts[reference] ?? []).map((directory) => ({
          directory,
          state: "attached",
          active: true,
        })),
      })),
    },
    producer: externalId ? producerOf(state, thread, externalId) : null,
  };
};
const resolveThread = (state, locator) =>
  state.threads[locator]
    ? locator
    : Object.keys(state.threads).find(
        (id) => state.threads[id].url === locator,
      );

// Human `org` commands carry no --json; every other command is JSON.
if (argv[0] === "org") {
  requireIntegration();
  if (form !== null) violation("command form on org command");
  const state = peek();
  if (exact(["org", "list"]))
    process.stdout.write(
      state.organizations
        .map((o) => `${o.current ? "*" : " "} ${o.name} (${o.id})`)
        .join("\n") + "\n",
    );
  else if (exact(["org", "current"]))
    process.stdout.write(
      `${state.organizations.find((o) => o.current).name}\n`,
    );
  else if (argv[1] === "switch" && exact(["org", "switch", "--", null]))
    process.stdout.write(`Switched to ${argv[3]}\n`);
  else if (argv[1] === "invite" && argv[2] === "--" && argv.length > 3)
    process.stdout.write(`Invited ${argv.slice(3).join(", ")}\n`);
  else violation("unknown org grammar");
  process.exit(0);
}
if (argv[0] === "update") {
  if (!(exact(["update", "--json"]) || exact(["update", "--check", "--json"])))
    violation("update grammar");
  emit({
    schema_version: 1,
    status: argv[1] === "--check" ? "up_to_date" : "updated",
    can_install: true,
    current_version: "0.9.0",
    latest_version: "0.9.0",
    channel: "stable",
    message:
      argv[1] === "--check"
        ? "Delta is up to date."
        : "Delta updated to 0.9.0.",
    restart_required: false,
  });
  process.exit(0);
}
if (argv[0] !== "--json") violation("missing leading --json");
requireIntegration();
const [, group, verb] = argv;
const formAllowed =
  (group === "thread" && (verb === "share" || verb === "invite")) ||
  (group === "thread" && verb === "mount" && argv.at(-1) === "--join");
if (form !== null && (!formAllowed || !FORMS.includes(form)))
  violation(`illegal DELTA_CLI_COMMAND_FORM ${form}`);

const producerArgs = (at) => {
  if (
    argv[at] !== "--source" ||
    argv[at + 1] !== SOURCE ||
    argv[at + 2] !== "--external-id" ||
    !nonempty(argv[at + 3])
  )
    violation("producer must be --source letta-code --external-id <id>");
  if (!/^letta:[^:]+:[^:]+$/.test(argv[at + 3]))
    violation(
      "external id is not a stable letta:<agent>:<conversation> identity",
    );
  return argv[at + 3];
};

if (group === "auth") {
  const state = peek();
  if (exact(["--json", "auth", "status"])) {
    emit(
      state.auth === "signed_in"
        ? { status: "signed_in", account: { login: "octo" } }
        : { status: state.auth },
    );
    process.exit(state.auth === "signed_in" ? 0 : 1);
  }
  if (exact(["--json", "auth", "login", "--no-wait"])) {
    emit({
      status: "pending",
      login_id: "login-1",
      url: "https://zed.dev/sign-in/x",
      expires_at: new Date(Date.now() + 600000).toISOString(),
    });
    process.exit(0);
  }
  if (exact(["--json", "auth", "wait", "login-1"])) {
    withState((s) => {
      s.auth = "signed_in";
    });
    emit({ status: "signed_in", account: { login: "octo" } });
    process.exit(0);
  }
  violation("auth grammar");
}
if (group === "thread" && verb === "contract") {
  if (!exact(["--json", "thread", "contract"])) violation("contract grammar");
  emit({ operation: "contract", min: 8, max: 8 });
  process.exit(0);
}
if (group === "org") {
  if (exact(["--json", "org", "list"])) {
    emit({ organizations: peek().organizations });
    process.exit(0);
  }
  if (argv[2] === "create" && exact(["--json", "org", "create", "--", null])) {
    emit({
      operation: "created",
      organization: { id: "org-new", name: argv[4] },
    });
    process.exit(0);
  }
  if (
    argv[2] === "invite" &&
    argv[3] === "--org" &&
    nonempty(argv[4]) &&
    argv[5] === "--" &&
    argv.length > 6
  ) {
    emit({
      operation: "invited",
      results: argv.slice(6).map((email) => ({ email, status: "invited" })),
    });
    process.exit(0);
  }
  violation("org json grammar");
}
if (group === "thread" && verb === "create") {
  const externalId = producerArgs(3);
  const rest = argv.slice(7);
  let organization = null;
  let visibility = "private";
  if (rest.length) {
    if (
      rest.length !== 4 ||
      rest[0] !== "--organization" ||
      !nonempty(rest[1]) ||
      rest[2] !== "--visibility" ||
      !["private", "organization"].includes(rest[3])
    )
      violation("thread create options");
    organization = rest[1];
    visibility = rest[3];
  }
  const result = withState((s) => {
    const existing = Object.keys(s.threads).find(
      (id) => s.threads[id].creator === externalId,
    );
    if (existing)
      return { operation: "created", created: false, thread_id: existing };
    const id = `thread-${++s.counter}`;
    s.threads[id] = {
      creator: externalId,
      url: `https://delta.dev/t/${id}`,
      organization,
      visibility,
      worktrees: [],
      producers: {},
      items: s.seedItems ?? [],
    };
    return { operation: "created", created: true, thread_id: id };
  });
  emit(result);
  process.exit(0);
}
if (group === "thread" && verb === "status") {
  if (!nonempty(argv[3])) violation("status needs a thread");
  const externalId = producerArgs(4);
  if (argv.length !== 8) violation("status grammar");
  const state = withState((s) => {
    const id = resolveThread(s, argv[3]);
    if (!id) return { missing: true };
    return { status: statusOf(s, id, externalId) };
  });
  if (state.missing) failWith("not_found", "No such thread");
  emit(state.status);
  process.exit(0);
}
if (group === "worktree" && verb === "list") {
  if (!exact(["--json", "worktree", "list"]))
    violation("worktree list grammar");
  const s = peek();
  emit({
    operation: "listed",
    worktrees: Object.entries(s.localWorktrees).map(
      ([reference, directory]) => ({ reference, directories: [{ directory }] }),
    ),
  });
  process.exit(0);
}
if (group === "worktree" && verb === "create") {
  if (!exact(["--json", "worktree", "create", null]))
    violation("worktree create grammar");
  const directory = argv[3];
  if (!isAbsolute(directory) || !existsSync(join(directory, ".git")))
    violation("worktree create needs an absolute checkout root");
  const reference = withState((s) => {
    if (Object.values(s.localWorktrees).includes(directory)) return null;
    const id = `tree-${++s.counter}`;
    s.localWorktrees[id] = directory;
    return id;
  });
  if (!reference) violation("duplicate worktree create for one checkout");
  emit({ operation: "created", worktree_id: reference, reference });
  process.exit(0);
}
if (group === "worktree" && verb === "attach") {
  if (!exact(["--json", "worktree", "attach", null, "--thread", null]))
    violation("worktree attach grammar");
  const ok = withState((s) => {
    if (!s.localWorktrees[argv[3]] || !s.threads[argv[5]]) return false;
    if (!s.threads[argv[5]].worktrees.includes(argv[3]))
      s.threads[argv[5]].worktrees.push(argv[3]);
    return true;
  });
  if (!ok) violation("attach of unknown worktree or thread");
  emit({ operation: "attached", thread_id: argv[5], reference: argv[3] });
  process.exit(0);
}
if (group === "worktree" && verb === "mount") {
  if (
    !exact(["--json", "worktree", "mount", null, null, "--existing-checkout"])
  )
    violation("worktree mount grammar");
  const ok = withState((s) => {
    if (s.localWorktrees[argv[3]] !== argv[4]) return false;
    s.checkouts[argv[3]] = [argv[4]];
    return true;
  });
  if (!ok) violation("worktree mount of unknown reference/directory");
  emit({ operation: "mounted", reference: argv[3], directory: argv[4] });
  live("worktree-mount");
} else if (group === "thread" && verb === "share") {
  if (
    !exact(["--json", "thread", "share", null, "--visibility", "organization"])
  )
    violation("thread share grammar");
  const known = withState((s) => {
    if (!s.threads[argv[3]]) return false;
    s.threads[argv[3]].visibility = "organization";
    return true;
  });
  if (!known) violation("share of unknown thread");
  emit({
    operation: "shared",
    thread_id: argv[3],
    url: `https://delta.dev/t/${argv[3]}`,
  });
  process.exit(0);
} else if (group === "thread" && verb === "invite") {
  if (!nonempty(argv[3]) || argv[4] !== "--" || argv.length < 6)
    violation("thread invite grammar");
  if (!peek().threads[argv[3]]) violation("invite to unknown thread");
  emit({
    operation: "invited",
    thread_id: argv[3],
    url: `https://delta.dev/t/${argv[3]}`,
    results: argv.slice(5).map((email) => ({ email, status: "invited" })),
  });
  process.exit(0);
} else if (group === "thread" && verb === "mount") {
  const join = argv.at(-1) === "--join";
  if (
    !(
      exact(["--json", "thread", "mount", null, "--owner", null]) ||
      exact(["--json", "thread", "mount", null, "--owner", null, "--join"])
    )
  )
    violation("thread mount grammar");
  if (!/^[0-9a-f-]{36}$/.test(argv[5]))
    violation("mount owner must be a stable random UUID");
  const result = withState((s) => {
    const id = resolveThread(s, argv[3]);
    if (!id) return undefined;
    const directory = join
      ? join_(root, "mounts", argv[5], "repo")
      : process.cwd();
    mkdirSync(join_(directory, ".git"), { recursive: true });
    const thread = s.threads[id];
    for (const reference of thread.worktrees)
      s.checkouts[reference] = [directory];
    s.mountOwners.push({ owner: argv[5], thread: id, join });
    return {
      operation: "mounted",
      thread_id: id,
      owner: argv[5],
      directory,
      worktrees: thread.worktrees.map((reference) => ({
        reference,
        name: "repo",
        directory,
        state: "attached",
      })),
    };
  });
  if (!result) failWith("not_found", "No such thread");
  emit(result);
  live(join ? "join-mount" : "thread-mount");
} else if (group === "thread" && verb === "watch") {
  if (!nonempty(argv[3])) violation("watch needs a thread");
  const externalId = producerArgs(4);
  const tail = argv.slice(8);
  if (
    !(
      tail.length === 0 ||
      (tail.length === 2 && tail[0] === "--participate" && nonempty(tail[1]))
    )
  )
    violation("watch options");
  const snapshot = withState((s) =>
    s.threads[argv[3]]
      ? {
          producer: producerOf(s, argv[3], externalId),
          items: s.threads[argv[3]].items,
          comments: s.threads[argv[3]].comments ?? [],
        }
      : undefined,
  );
  if (!snapshot) failWith("not_found", "No such thread");
  emit({ type: "ready", thread_id: argv[3], producer: snapshot.producer });
  for (const item of snapshot.items) emit({ type: "item", item });
  for (const comment of snapshot.comments) emit({ type: "comment", comment });
  emit({ type: "live" });
  live("watch");
} else if (group === "thread" && verb === "append") {
  if (!nonempty(argv[3])) violation("append needs a thread");
  const externalId = producerArgs(4);
  const tail = argv.slice(8);
  const valid =
    (tail.length === 2 && tail[0] === "--producer-name" && nonempty(tail[1])) ||
    (tail.length === 4 &&
      tail[0] === "--acknowledge" &&
      tail[1] === "local" &&
      tail[2] === "--producer-name" &&
      nonempty(tail[3]));
  if (!valid) violation("append options");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  if (!input.endsWith("\n"))
    violation("append stdin must be newline-terminated JSONL");
  const rows = input
    .slice(0, -1)
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        violation("append stdin line is not JSON");
      }
    });
  const results = withState((s) => {
    const thread = s.threads[argv[3]];
    if (!thread) return { violation: "append to unknown thread" };
    producerOf(s, argv[3], externalId);
    const p = thread.producers[externalId];
    const out = [];
    for (const row of rows) {
      const keys = Object.keys(row);
      if (
        row.schemaVersion !== 1 ||
        !Number.isSafeInteger(row.sequence) ||
        row.sequence < 1 ||
        typeof row.update !== "object" ||
        keys.some(
          (k) =>
            !["schemaVersion", "sequence", "turnSequence", "update"].includes(
              k,
            ),
        )
      )
        return { violation: "malformed record" };
      if (
        row.turnSequence !== undefined &&
        !(
          row.turnSequence < row.sequence ||
          (row.turnSequence === row.sequence &&
            row.update.sessionUpdate === "state_update" &&
            row.update.state === "running")
        )
      )
        return { violation: "turnSequence after its record" };
      if (row.sequence < p.next) {
        const prior = p.records.find((r) => r.sequence === row.sequence);
        if (!prior || JSON.stringify(prior) !== JSON.stringify(row))
          return { violation: `recycled producer sequence ${row.sequence}` };
        out.push({
          operation: "appended",
          thread_id: argv[3],
          sequence: row.sequence,
          next_sequence: p.next,
          duplicate: true,
          disposition: "duplicate",
          turn_sequence: row.turnSequence ?? null,
          version: `v${row.sequence}`,
        });
        continue;
      }
      if (row.sequence !== p.next)
        return {
          violation: `sequence gap: expected ${p.next}, got ${row.sequence}`,
        };
      p.records.push(row);
      p.next = row.sequence + 1;
      if (row.update.sessionUpdate === "state_update")
        p.turn =
          row.update.state === "running"
            ? { sequence: row.sequence, status: "running" }
            : p.turn && { ...p.turn, status: "finished" };
      const fenced =
        s.fenceTurn !== undefined && row.turnSequence === s.fenceTurn;
      out.push({
        operation: "appended",
        thread_id: argv[3],
        sequence: row.sequence,
        next_sequence: p.next,
        duplicate: false,
        disposition: fenced ? "fenced" : "recorded",
        turn_sequence: row.turnSequence ?? null,
        version: `v${row.sequence}`,
      });
    }
    return { out };
  });
  if (results.violation) violation(results.violation);
  for (const receipt of results.out) emit(receipt);
  process.exit(0);
} else if (group === "thread" && verb === "fork") {
  if (!exact(["--json", "thread", "fork", null])) violation("fork grammar");
  emit({ thread_id: `${argv[3]}-fork` });
  process.exit(0);
} else if (group === "thread" && verb === "discard") {
  if (!exact(["--json", "thread", "discard", null, "--force"]))
    violation("discard grammar");
  emit({ operation: "discarded", thread_id: argv[3] });
  process.exit(0);
} else violation("unknown command");

function join_(...parts) {
  return join(...parts);
}
