// End-to-end adapter acceptance against a strict fake Delta CLI subprocess.
// Deterministic fixture evidence only: no live Delta, account, browser or host.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commandNames } from "../../core/src/commands.js";
import { bindingPath } from "../src/collaboration/bindings.js";
import {
  createMod,
  type CommandRegistration,
  type Events,
  type ModApi,
} from "../src/index.js";
import type { HostContext, Panel } from "../src/host.js";
import type { Question } from "../src/session.js";

const fixture = fileURLToPath(
  new URL("./workflow-integration-fixture.mjs", import.meta.url),
);
const AGENT = "agent-1";
const ext = (conversation: string, agent = AGENT) =>
  `letta:${encodeURIComponent(agent)}:${encodeURIComponent(conversation)}`;

type Call = {
  argv: string[];
  cwd: string;
  integration: string | null;
  form: string | null;
  pid: number;
};
type Row = {
  schemaVersion: 1;
  sequence: number;
  turnSequence?: number;
  update: Record<string, unknown> & { sessionUpdate: string };
};

let tmp: string;
let deltaDir: string;
let dataDir: string;
const saved = {
  PATH: process.env.PATH,
  DELTA_FIXTURE_DIR: process.env.DELTA_FIXTURE_DIR,
  DELTA_LETTA_HANDOFF: process.env.DELTA_LETTA_HANDOFF,
};
const disposers: Array<() => void> = [];

const remoteItems = [
  {
    id: "remote-1",
    kind: "user_message",
    after_id: null,
    turn_id: null,
    author: { user_id: "u-ada", name: "Ada", actor_id: "actor-ada" },
    created_at: 1,
    open: false,
    content: { text: "Please check the parser" },
  },
  {
    id: "remote-2",
    kind: "agent_thought",
    after_id: "remote-1",
    turn_id: null,
    author: { user_id: "u-ada", name: "Ada", actor_id: "actor-ada" },
    created_at: 2,
    open: false,
    content: { text: "Ada agent private reasoning" },
  },
  {
    id: "self-1",
    kind: "agent_message",
    after_id: "remote-2",
    turn_id: null,
    author: { user_id: "u-me", name: "Me", actor_id: "actor-local" },
    created_at: 3,
    open: false,
    content: { text: "my own echoed row" },
  },
];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "delta-e2e-"));
  deltaDir = join(tmp, "delta");
  dataDir = join(tmp, "data");
  mkdirSync(deltaDir);
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "delta"),
    `#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`,
  );
  chmodSync(join(bin, "delta"), 0o755);
  writeFileSync(
    join(deltaDir, "state.json"),
    JSON.stringify({
      counter: 0,
      actor: "actor-local",
      auth: "signed_in",
      organizations: [{ id: "org-1", name: "Acme", current: true }],
      seedItems: remoteItems,
      threads: {
        "thread-remote": {
          creator: "letta:other:conv",
          url: "https://delta.dev/t/remote",
          organization: "org-1",
          visibility: "organization",
          owned: false,
          worktrees: ["tree-remote"],
          producers: {},
          items: [],
        },
      },
      localWorktrees: {},
      checkouts: {},
      mountOwners: [],
    }),
  );
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.DELTA_FIXTURE_DIR = deltaDir;
  delete process.env.DELTA_LETTA_HANDOFF;
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const { pid } of liveProcesses()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  rmSync(tmp, { recursive: true, force: true });
});

const lines = <T>(file: string): T[] =>
  existsSync(join(deltaDir, file))
    ? readFileSync(join(deltaDir, file), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as T)
    : [];
const calls = () => lines<Call>("calls.jsonl");
const violations = () => lines<{ reason: string }>("violations.jsonl");
const liveProcesses = () =>
  lines<{ kind: string; pid: number; argv: string[] }>("live.jsonl");
const state = () =>
  JSON.parse(readFileSync(join(deltaDir, "state.json"), "utf8"));
const records = (thread: string, producer: string): Row[] =>
  state().threads[thread]?.producers[producer]?.records ?? [];
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const argvs = () => calls().map((call) => call.argv.join(" "));

const repo = (name = "repo", git = false) => {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  if (git) {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://example.invalid/r.git"],
      { cwd: dir },
    );
  } else mkdirSync(join(dir, ".git"));
  return dir;
};

interface Harness {
  readonly api: ModApi;
  readonly commands: Map<string, CommandRegistration>;
  readonly handlers: Map<
    keyof Events,
    (event: never, ctx: HostContext) => Promise<unknown>
  >;
  readonly notices: string[];
  readonly panels: Panel[];
  readonly questions: Question[];
  readonly answers: (string | undefined)[];
  readonly controller: AbortController;
  readonly dispose: () => void;
}

const host = (
  capabilities: ModApi["capabilities"] = {
    commands: true,
    events: { lifecycle: true, turns: true, tools: true },
    ui: { panels: true },
  },
): Harness => {
  const commands = new Map<string, CommandRegistration>();
  const handlers = new Map<
    keyof Events,
    (event: never, ctx: HostContext) => Promise<unknown>
  >();
  const notices: string[] = [];
  const panels: Panel[] = [];
  const questions: Question[] = [];
  const answers: (string | undefined)[] = [];
  const controller = new AbortController();
  const api: ModApi = {
    capabilities,
    signal: controller.signal,
    commands: {
      register(command) {
        if (commands.has(command.id))
          throw new Error(`duplicate ${command.id}`);
        commands.set(command.id, command);
        return () => commands.delete(command.id);
      },
    },
    ...(capabilities.ui?.panels
      ? {
          ui: {
            notify: (message: string) => notices.push(message),
            openPanel: (panel: Panel) => {
              panels.push(panel);
              return { close: () => {}, update: () => {} };
            },
          },
        }
      : {}),
    ...(capabilities.events
      ? {
          events: {
            on: (name, callback) => {
              if (handlers.has(name))
                throw new Error(`duplicate handler ${name}`);
              handlers.set(name, callback as never);
              return () => handlers.delete(name);
            },
          },
        }
      : {}),
  };
  const dispose = createMod({
    dataDirectory: dataDir,
    interaction: {
      ask: (_session, question) =>
        Effect.sync(() => {
          questions.push(question);
          return answers.shift();
        }),
    },
  })(api);
  disposers.push(dispose);
  return {
    api,
    commands,
    handlers,
    notices,
    panels,
    questions,
    answers,
    controller,
    dispose,
  };
};

type Conversation = {
  ctx: HostContext;
  history: unknown[];
  historyReads: () => number;
  inference: () => number;
};
const conversation = (
  cwd: string,
  id: string,
  history: unknown[] = [],
  agent = AGENT,
): Conversation => {
  let reads = 0;
  let sends = 0;
  const handle = {
    id,
    getHistory: async () => {
      reads++;
      return [...history];
    },
    // Present so that any attempt to start inference is observable.
    sendMessageStream: () => {
      sends++;
      throw new Error("inference must not start");
    },
    send: () => {
      sends++;
      throw new Error("inference must not start");
    },
  };
  return {
    ctx: {
      cwd,
      agent: { id: agent },
      conversation: handle,
      subagents: { list: () => [] },
    },
    history,
    historyReads: () => reads,
    inference: () => sends,
  };
};
const transient = () => {
  const live = new Set(liveProcesses().map((p) => p.pid));
  return calls().filter((call) => !live.has(call.pid) && alive(call.pid))
    .length;
};
/**
 * Interactive stock commands return `handled` at once and report the outcome
 * through the session status. Wait until the job settles (no short-lived CLI
 * process, notices stable) and return the final notice as its output.
 */
const run = async (h: Harness, id: string, args: string, c: Conversation) => {
  const command = h.commands.get(id);
  if (!command) throw new Error(`/${id} is not registered`);
  const before = h.notices.length;
  const result = await command.run({ ...c.ctx, args });
  if (result.type !== "handled") return result;
  let seen = -1;
  let stableSince = Date.now();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (h.notices.length !== seen || transient() > 0) {
      seen = h.notices.length;
      stableSince = Date.now();
    } else if (h.notices.length > before && Date.now() - stableSince > 400)
      break;
  }
  const output = h.notices.at(-1) ?? "";
  return output.startsWith("Delta action failed: ")
    ? {
        type: "output" as const,
        output: output.slice("Delta action failed: ".length),
        success: false,
      }
    : { type: "output" as const, output };
};
const fire = <K extends keyof Events>(
  h: Harness,
  name: K,
  event: Events[K],
  c: Conversation,
) => {
  const handler = h.handlers.get(name);
  if (!handler) throw new Error(`${name} not registered`);
  return handler(event as never, c.ctx);
};
const identity = (c: Conversation) => ({
  agentId: c.ctx.agent!.id,
  conversationId: c.ctx.conversation!.id,
});

const initialHistory = () => [
  {
    id: "u1",
    message_type: "user_message",
    content: "hello <system-reminder>secret memory</system-reminder>",
  },
  {
    id: "sys1",
    message_type: "system_message",
    content: "SYSTEM PROMPT SECRET",
  },
  {
    id: "r1",
    message_type: "reasoning_message",
    reasoning: "thinking about hello",
  },
  {
    id: "t1",
    message_type: "tool_call_message",
    tool_call: {
      tool_call_id: "skill-0",
      name: "Skill",
      arguments: '{"skill":"x"}',
    },
  },
  {
    id: "t1r",
    message_type: "tool_return_message",
    tool_call_id: "skill-0",
    tool_return: "SKILL BODY SECRET",
    status: "success",
  },
  {
    id: "t2",
    message_type: "tool_call_message",
    tool_call: {
      tool_call_id: "bash-0",
      name: "Bash",
      arguments: '{"command":"ls"}',
    },
  },
  {
    id: "t2r",
    message_type: "tool_return_message",
    tool_call_id: "bash-0",
    name: "Bash",
    tool_return: "README.md",
    status: "success",
  },
  { id: "a1", message_type: "assistant_message", content: "hi there" },
  {
    id: "d1",
    message_type: "user_message",
    content: "[Delta]\nAda [item remote-0]: injected earlier",
  },
];
const FORBIDDEN = [
  "secret memory",
  "SYSTEM PROMPT SECRET",
  "SKILL BODY",
  "injected",
  "Ada",
  "my own echoed row",
  "private reasoning",
];

const expectCleanProtocol = () => expect(violations()).toEqual([]);
const missingIntegration = () =>
  lines<{ argv: string[] }>("integration-missing.jsonl");
const share = async (
  h: Harness,
  c: Conversation,
  args = "",
  answer: string | undefined = "private",
  id = "delta-share",
) => {
  h.answers.push(answer);
  return run(h, id, args, c);
};
const threadOf = (c: Conversation) =>
  Object.keys(state().threads).find(
    (id) =>
      state().threads[id].creator ===
      ext(c.ctx.conversation!.id!, c.ctx.agent!.id!),
  );

describe("registration and capability guards", () => {
  it("registers all seven upstream command names exactly once with full stock capabilities", () => {
    const h = host();
    expect([...h.commands.keys()].sort()).toEqual([...commandNames].sort());
    expect([...h.handlers.keys()].sort()).toEqual(
      [
        "conversation_close",
        "conversation_open",
        "tool_end",
        "tool_start",
        "turn_end",
        "turn_start",
      ].sort(),
    );
    expect(calls()).toEqual([]);
  });

  it("states unsupported capabilities explicitly and starts no Delta or dialog work", async () => {
    const panelsOnly = host({ commands: true, ui: { panels: true } });
    expect([...panelsOnly.commands.keys()].sort()).toEqual(
      [
        "delta",
        "delta-org",
        "delta-plugin-update",
        "delta-setup",
        "delta-update",
      ].sort(),
    );
    const c = conversation(repo(), "conv-1");
    const result = await run(panelsOnly, "delta", "share", c);
    expect(result).toMatchObject({
      success: false,
      output: expect.stringMatching(/turn and tool event capabilities/),
    });
    expect(
      (await run(panelsOnly, "delta", "join https://delta.dev/t/remote", c))
        .success,
    ).toBe(false);

    const headless = host({ commands: true });
    expect([...headless.commands.keys()].sort()).toEqual([
      "delta",
      "delta-org",
    ]);
    const setup = await run(
      headless,
      "delta",
      "setup",
      conversation(repo("headless-git", true), "conv-h"),
    );
    expect(setup.success).toBe(false);
    expect(setup.output).toMatch(/interactive/i);
    expect([...panelsOnly.questions, ...headless.questions]).toEqual([]);
    // Read-only probes are acceptable; no login, dialog-driven or mutating command runs.
    expect(
      argvs().filter(
        (line) =>
          ![
            "--json auth status",
            "--json thread contract",
            "--json org list",
          ].includes(line),
      ),
    ).toEqual([]);

    const noLifecycle = host({
      commands: true,
      events: { turns: true, tools: true },
      ui: { panels: true },
    });
    expect(noLifecycle.handlers.has("conversation_open")).toBe(false);
    expect(noLifecycle.handlers.has("turn_start")).toBe(true);
  });

  it("identifies every Delta invocation as the Letta integration, as the reference does for all commands", async () => {
    const h = host();
    const c = conversation(repo(), "conv-1", initialHistory());
    await share(h, c);
    await run(h, "delta-org", "list", c);
    expect(calls().length).toBeGreaterThan(5);
    expect(missingIntegration().map((entry) => entry.argv.join(" "))).toEqual(
      [],
    );
  });

  it("does nothing on activation or open for an unbound conversation", async () => {
    const h = host();
    const c = conversation(repo(), "conv-1", initialHistory());
    await fire(
      h,
      "conversation_open",
      { ...identity(c), reason: "startup" },
      c,
    );
    await fire(h, "turn_start", { ...identity(c), input: [] }, c);
    await fire(h, "turn_end", { ...identity(c), stopReason: "end_turn" }, c);
    expect(calls()).toEqual([]);
    expect(c.historyReads()).toBe(0);
    expect(liveProcesses()).toEqual([]);
  });
});

describe("share and recording", () => {
  it("shares with disclosure through the reference protocol and exports only permitted history", async () => {
    const h = host();
    const root = repo();
    const c = conversation(root, "conv-1", initialHistory());
    const result = await share(h, c);
    expect(result).toMatchObject({
      type: "output",
      output: expect.stringMatching(/^Delta thread: https:\/\/delta\.dev\//),
    });
    expectCleanProtocol();
    const question = h.questions[0]!;
    expect(question.message).toMatch(/uploads this conversation/);
    expect(question.message).toMatch(/untracked/);
    expect(question.choices.map((choice) => choice.value)).toEqual(
      expect.arrayContaining(["private", "cancel"]),
    );

    const thread = threadOf(c)!;
    const tree = Object.keys(state().localWorktrees)[0]!;
    const sequence = argvs();
    const index = (prefix: string) =>
      sequence.findIndex((line) => line.startsWith(prefix));
    for (const expected of [
      "--json auth status",
      "--json thread contract",
      "--json org list",
      `--json thread create --source letta-code --external-id ${ext("conv-1")} --organization org-1 --visibility private`,
      "--json worktree list",
      `--json worktree create ${root}`,
      `--json worktree attach ${tree} --thread ${thread}`,
      `--json worktree mount ${tree} ${root} --existing-checkout`,
      `--json thread status ${thread} --source letta-code --external-id ${ext("conv-1")}`,
      `--json thread watch ${thread} --source letta-code --external-id ${ext("conv-1")}`,
      `--json thread append ${thread} --source letta-code --external-id ${ext("conv-1")} --acknowledge local --producer-name Letta Code`,
    ])
      expect(index(expected), expected).toBeGreaterThanOrEqual(0);
    // Durable identity before membership, membership before mount, mount before export.
    expect(index("--json thread create")).toBeLessThan(
      index("--json worktree attach"),
    );
    expect(index("--json worktree create")).toBeLessThan(
      index("--json worktree attach"),
    );
    expect(index("--json worktree attach")).toBeLessThan(
      index("--json worktree mount"),
    );
    expect(index("--json worktree mount")).toBeLessThan(
      index("--json thread append"),
    );
    const binding = JSON.parse(
      readFileSync(
        bindingPath(dataDir, { agentId: AGENT, conversationId: "conv-1" }),
        "utf8",
      ),
    );
    expect(binding).toMatchObject({
      thread,
      worktree: tree,
      externalId: ext("conv-1"),
      uploaded: true,
    });

    const rows = records(thread, ext("conv-1"));
    expect(rows.map((row) => row.sequence)).toEqual(rows.map((_, i) => i + 1));
    expect(
      rows.map((row) => [
        row.update.sessionUpdate,
        row.update.messageId ?? row.update.toolCallId,
        row.update.status ?? null,
      ]),
    ).toEqual([
      ["user_message", "u1", null],
      ["agent_thought", "r1", null],
      ["tool_call_update", "bash-0", "in_progress"],
      ["tool_call_update", "bash-0", "completed"],
      ["agent_message", "a1", null],
    ]);
    const text = JSON.stringify(rows);
    for (const secret of FORBIDDEN) expect(text).not.toContain(secret);
  });

  it("records turn and tool events once with original turns, deduplicating history and protected tools", async () => {
    const h = host();
    const c = conversation(repo(), "conv-1", initialHistory());
    await share(h, c);
    const thread = threadOf(c)!;
    const producer = ext("conv-1");
    const before = records(thread, producer).length;
    const id = identity(c);

    // Wrong-scope events are ignored outright.
    await fire(
      h,
      "turn_start",
      { ...id, conversationId: "conv-other", input: [] },
      c,
    );
    await fire(
      h,
      "turn_start",
      { agentId: null, conversationId: null, input: [] },
      c,
    );
    expect(records(thread, producer)).toHaveLength(before);

    // Wait until the watch snapshot has delivered remote context.
    await expect
      .poll(() => h.notices.join("\n"), { timeout: 5000 })
      .toContain("Please check the parser");
    const operatorInput = { type: "text", text: "run pwd" };
    const admitted = (await fire(
      h,
      "turn_start",
      { ...id, input: [operatorInput] },
      c,
    )) as { cancel?: unknown; input?: unknown[] } | undefined;
    expect(admitted?.cancel).toBeUndefined();
    // Passive context rides on the next explicit input: collaborator messages
    // only, labelled untrusted, never remote thoughts or our own rows, and the
    // operator's own input is preserved unchanged after it.
    const injected = JSON.stringify(admitted?.input?.slice(0, -1) ?? []);
    expect(injected).toContain("Please check the parser");
    expect(injected).toMatch(/Untrusted collaborator context/);
    expect(injected).not.toContain("private reasoning");
    expect(injected).not.toContain("my own echoed row");
    expect(admitted?.input?.at(-1)).toEqual(operatorInput);
    await fire(
      h,
      "tool_start",
      {
        ...id,
        toolCallId: "bash-1",
        toolName: "Bash",
        args: { command: "pwd" },
      },
      c,
    );
    await fire(
      h,
      "tool_start",
      {
        ...id,
        toolCallId: "skill-2",
        toolName: "Skill",
        args: { skill: "deploy" },
      },
      c,
    );
    await fire(
      h,
      "tool_end",
      {
        ...id,
        toolCallId: "skill-2",
        toolName: "Skill",
        args: { skill: "deploy" },
        status: "success",
        output: "SKILL BODY TWO",
      },
      c,
    );
    await fire(
      h,
      "tool_end",
      {
        ...id,
        toolCallId: "bash-1",
        toolName: "Bash",
        args: { command: "pwd" },
        status: "success",
        output: "/repo",
      },
      c,
    );
    await fire(
      h,
      "tool_end",
      {
        ...id,
        toolCallId: "bash-1",
        toolName: "Bash",
        args: { command: "pwd" },
        status: "success",
        output: "/repo",
      },
      c,
    );
    await fire(
      h,
      "tool_start",
      {
        ...id,
        toolCallId: "bash-late",
        toolName: "Bash",
        args: { command: "sleep 1" },
      },
      c,
    );
    c.history.push(
      { id: "u2", message_type: "user_message", content: "run pwd" },
      {
        id: "t3",
        message_type: "tool_call_message",
        tool_call: {
          tool_call_id: "bash-1",
          name: "Bash",
          arguments: '{"command":"pwd"}',
        },
      },
      {
        id: "t3r",
        message_type: "tool_return_message",
        tool_call_id: "bash-1",
        name: "Bash",
        tool_return: "/repo",
        status: "success",
      },
      {
        id: "t4",
        message_type: "tool_call_message",
        tool_call: {
          tool_call_id: "skill-2",
          name: "Skill",
          arguments: '{"skill":"deploy"}',
        },
      },
      {
        id: "t4r",
        message_type: "tool_return_message",
        tool_call_id: "skill-2",
        name: "Skill",
        tool_return: "SKILL BODY TWO",
        status: "success",
      },
      {
        id: "t5",
        message_type: "tool_call_message",
        tool_call: {
          tool_call_id: "bash-late",
          name: "Bash",
          arguments: '{"command":"sleep 1"}',
        },
      },
      {
        id: "d2",
        message_type: "user_message",
        content: "[Delta]\nAda [item remote-1]: Please check the parser",
      },
      { id: "a2", message_type: "assistant_message", content: "done" },
    );
    await fire(h, "turn_end", { ...id, stopReason: "end_turn" }, c);
    await fire(h, "turn_end", { ...id, stopReason: "end_turn" }, c);
    await fire(
      h,
      "tool_end",
      {
        ...id,
        toolCallId: "bash-late",
        toolName: "Bash",
        args: { command: "sleep 1" },
        status: "success",
        output: "late output",
      },
      c,
    );
    expectCleanProtocol();

    const rows = records(thread, producer).slice(before);
    const running = rows[0]!;
    expect(running.update).toMatchObject({
      sessionUpdate: "state_update",
      state: "running",
    });
    expect(running.turnSequence).toBe(running.sequence);
    const summary = rows.map((row) => [
      row.update.sessionUpdate,
      row.update.messageId ?? row.update.toolCallId ?? row.update.state,
      row.update.status ?? null,
    ]);
    expect(summary).toEqual([
      ["state_update", "running", null],
      ["tool_call_update", "bash-1", "in_progress"],
      ["tool_call_update", "bash-1", "completed"],
      ["tool_call_update", "bash-late", "in_progress"],
      ["user_message", "u2", null],
      ["agent_message", "a2", null],
      ["state_update", "idle", null],
      ["tool_call_update", "bash-late", "completed"],
    ]);
    for (const row of rows)
      expect(row.turnSequence, JSON.stringify(row.update)).toBe(
        running.sequence,
      );
    expect(rows.at(-1)!.update.rawOutput).toBe("late output");
    const all = records(thread, producer);
    expect(all.map((row) => row.sequence)).toEqual(all.map((_, i) => i + 1));
    const text = JSON.stringify(all);
    for (const secret of FORBIDDEN) expect(text).not.toContain(secret);
    expect(c.inference()).toBe(0);
  });

  it("shows remote collaborators to the human without echoing own rows or exporting remote thoughts", async () => {
    const h = host();
    const c = conversation(repo(), "conv-1", initialHistory());
    await share(h, c);
    const visible = () =>
      [
        ...h.notices,
        ...h.panels.map((panel) =>
          panel.render({
            agent: { id: AGENT },
            sessionId: "conv-1",
            cwd: c.ctx.cwd,
          }),
        ),
      ].join("\n");
    await expect
      .poll(visible, { timeout: 5000 })
      .toContain("Please check the parser");
    expect(visible()).toMatch(
      /Ada \(thinking\)[^\n]*Ada agent private reasoning/,
    );
    expect(visible()).not.toContain("my own echoed row");
    // Remote content is never recorded back into this producer.
    const text = JSON.stringify(records(threadOf(c)!, ext("conv-1")));
    expect(text).not.toContain("Please check the parser");
    expect(text).not.toContain("private reasoning");
    expect(c.inference()).toBe(0);
  });

  it("retries a share without re-creating identity, re-exporting history or narrowing audience", async () => {
    const h = host();
    const c = conversation(repo(), "conv-1", initialHistory());
    await share(h, c);
    const thread = threadOf(c)!;
    const first = records(thread, ext("conv-1")).length;
    const result = await share(h, c, "", "unchanged");
    expect(result.output).toBe(`Delta thread: ${state().threads[thread].url}`);
    expect(h.questions[1]!.choices.map((choice) => choice.value)).toContain(
      "unchanged",
    );
    expect(h.questions[1]!.choices.map((choice) => choice.value)).not.toContain(
      "private",
    );
    expect(
      argvs().filter((line) => line.startsWith("--json thread create")),
    ).toHaveLength(1);
    expect(
      argvs().filter((line) => line.startsWith("--json worktree create")),
    ).toHaveLength(1);
    expect(records(thread, ext("conv-1"))).toHaveLength(first);
    expectCleanProtocol();
  });

  it("publishes and invites with the reference command-form environment", async () => {
    const h = host();
    const invited = conversation(repo("a"), "conv-invite", initialHistory());
    const invitedResult = await share(h, invited, "bob@example.com", "invite");
    expect(invitedResult.output).toMatch(/^Delta thread:/);
    const team = conversation(repo("b"), "conv-team", initialHistory());
    expect(
      (await share(h, team, "share", "organization", "delta")).output,
    ).toMatch(/^Delta thread:/);
    expectCleanProtocol();
    const invite = calls().find((call) => call.argv[2] === "invite")!;
    expect(invite.argv).toEqual([
      "--json",
      "thread",
      "invite",
      threadOf(invited)!,
      "--",
      "bob@example.com",
    ]);
    expect(invite.form).toBe("dedicated_command");
    const publish = calls().find((call) => call.argv[2] === "share")!;
    expect(publish.argv).toEqual([
      "--json",
      "thread",
      "share",
      threadOf(team)!,
      "--visibility",
      "organization",
    ]);
    expect(publish.form).toBe("delta_subcommand");
  });

  it("cancelling the disclosure shares nothing", async () => {
    const h = host();
    const c = conversation(repo(), "conv-1", initialHistory());
    expect((await share(h, c, "", "cancel")).output).toMatch(/cancelled/i);
    expect(
      argvs().filter((line) => /thread (create|append)|worktree/.test(line)),
    ).toEqual([]);
    expect(c.historyReads()).toBe(0);
  });
});

describe("join handoff", () => {
  it("mounts in place of the old scope, returns a quoted stock handoff, and adopts it only in a fresh conversation", async () => {
    const h = host();
    const old = conversation(repo(), "conv-1", initialHistory());
    const result = await run(
      h,
      "delta-join",
      "https://delta.dev/t/remote",
      old,
    );
    expectCleanProtocol();
    expect(result.success).not.toBe(false);
    const mount = calls().find((call) => call.argv[2] === "mount")!;
    expect(mount.argv.slice(0, 5)).toEqual([
      "--json",
      "thread",
      "mount",
      "https://delta.dev/t/remote",
      "--owner",
    ]);
    expect(mount.argv.at(-1)).toBe("--join");
    expect(mount.form).toBe("dedicated_command");
    const owner = mount.argv[5]!;
    const directory = join(deltaDir, "mounts", owner, "repo");
    const match =
      /cd -- '([^']+)' && DELTA_LETTA_HANDOFF='([0-9a-f-]{36})' letta --agent 'agent-1' --new/.exec(
        result.output,
      );
    expect(match?.[1]).toBe(directory);
    const token = match![2]!;
    // The previous scope is untouched: not read, not bound, not exported.
    expect(old.historyReads()).toBe(0);
    expect(
      existsSync(
        bindingPath(dataDir, { agentId: AGENT, conversationId: "conv-1" }),
      ),
    ).toBe(false);
    // The reference preflight queries status with the old external ID. Our fake
    // materializes an empty producer descriptor for that query; it must contain
    // no old-conversation records and never become a recording participant.
    for (const thread of Object.values(state().threads) as any[]) {
      const oldProducer = thread.producers[ext("conv-1")];
      if (oldProducer) {
        expect(oldProducer.records).toEqual([]);
        expect(oldProducer.next).toBe(1);
      }
    }
    expect(
      argvs().filter(
        (line) =>
          /thread (append|watch)/.test(line) && line.includes(ext("conv-1")),
      ),
    ).toEqual([]);
    expect(
      argvs().some((line) =>
        line.startsWith(
          `--json thread status https://delta.dev/t/remote --source letta-code --external-id ${ext("conv-1")}`,
        ),
      ),
    ).toBe(true);

    // Stock CLI handoff: a fresh process starts with the explicit env token.
    process.env.DELTA_LETTA_HANDOFF = token;
    const fresh = conversation(directory, "conv-new", []);
    const beforeAdoption = calls().length;
    await fire(
      h,
      "conversation_open",
      { ...identity(fresh), reason: "new" },
      fresh,
    );
    expectCleanProtocol();
    const adopted = argvs().slice(beforeAdoption);
    expect(adopted).toEqual(
      expect.arrayContaining([
        `--json thread mount thread-remote --owner ${owner}`,
        `--json thread watch thread-remote --source letta-code --external-id ${ext("conv-new")} --participate Letta Code`,
      ]),
    );
    expect(adopted.some((line) => line.includes(ext("conv-1")))).toBe(false);
    expect(
      existsSync(
        bindingPath(dataDir, { agentId: AGENT, conversationId: "conv-new" }),
      ),
    ).toBe(true);
    expect(fresh.inference() + old.inference()).toBe(0);
    expect(records("thread-remote", ext("conv-new"))).toEqual([]);

    // Single use: a different conversation cannot adopt the same token.
    const count = calls().length;
    const reuse = conversation(directory, "conv-third", []);
    await fire(
      h,
      "conversation_open",
      { ...identity(reuse), reason: "new" },
      reuse,
    );
    expect(
      calls()
        .slice(count)
        .filter((call) => call.argv[2] === "mount"),
    ).toEqual([]);
    expect(
      existsSync(
        bindingPath(dataDir, { agentId: AGENT, conversationId: "conv-third" }),
      ),
    ).toBe(false);

    // A resumed (non-fresh) conversation never adopts a handoff token.
    const resumed = conversation(directory, "conv-resumed", initialHistory());
    await fire(
      h,
      "conversation_open",
      { ...identity(resumed), reason: "resume" },
      resumed,
    );
    expect(
      existsSync(
        bindingPath(dataDir, {
          agentId: AGENT,
          conversationId: "conv-resumed",
        }),
      ),
    ).toBe(false);
  });
});

describe("routes", () => {
  it("routes organization, update, plugin-update, setup and menu commands to real outcomes", async () => {
    const h = host();
    const git = repo("git-repo", true);
    const c = conversation(git, "conv-1");

    expect((await run(h, "delta-org", "list", c)).output).toContain(
      "Acme (org-1)",
    );
    h.answers.push("current");
    expect((await run(h, "delta-org", "", c)).output).toContain("Acme");
    expect(
      calls()
        .filter((call) => call.argv[0] === "org")
        .map((call) => call.argv),
    ).toEqual([
      ["org", "list"],
      ["org", "current"],
    ]);

    h.answers.push("update");
    expect((await run(h, "delta-update", "", c)).output).toContain(
      "Delta updated to 0.9.0.",
    );
    expect(
      calls().some((call) => call.argv.join(" ") === "update --json"),
    ).toBe(true);

    expect(
      (await run(h, "delta-plugin-update", "notifications off", c)).output,
    ).toMatch(/off/);
    expect(
      JSON.parse(readFileSync(join(dataDir, "preferences.json"), "utf8")),
    ).toMatchObject({ notifications: false });
    expect((await run(h, "delta-plugin-update", "", c)).output).toMatch(
      /local\/source installation/,
    );
    const bogus = await run(h, "delta-plugin-update", "bogus", c);
    expect(bogus.success).toBe(false);
    expect(bogus.output).toContain(
      "plugin-update [check | notifications on|off]",
    );

    h.answers.push("org-1", "private", "later");
    expect((await run(h, "delta-setup", "", c)).output).toBe(
      "Saved private repository policy.",
    );
    expect(
      JSON.parse(readFileSync(join(git, ".delta", "settings.json"), "utf8")),
    ).toMatchObject({ threads: { mode: "private", organization: "org-1" } });
    expect(
      readFileSync(join(git, ".git", "info", "exclude"), "utf8"),
    ).toContain("/.delta/settings.json");

    h.answers.push(undefined);
    expect((await run(h, "delta", "", c)).output).toBe("Delta menu closed.");
    const usage = await run(h, "delta", "nonsense", c);
    expect(usage.success).toBe(false);
    expect(usage.output).toContain("/delta");
    expectCleanProtocol();
  });
});

describe("lifecycle ownership", () => {
  it("closes one conversation's children without touching another, and dispose kills the rest", async () => {
    const h = host();
    const a = conversation(repo("a"), "conv-a", initialHistory());
    const b = conversation(repo("b"), "conv-b", initialHistory());
    await share(h, a);
    await share(h, b);
    const owned = (c: Conversation) =>
      liveProcesses().filter((p) =>
        p.argv.some(
          (arg) => arg === ext(c.ctx.conversation!.id!) || arg === c.ctx.cwd,
        ),
      );
    await expect.poll(() => owned(a).length, { timeout: 5000 }).toBe(2);
    await expect.poll(() => owned(b).length, { timeout: 5000 }).toBe(2);
    await fire(h, "conversation_close", { ...identity(a), reason: "exit" }, a);
    await expect
      .poll(() => owned(a).filter((p) => alive(p.pid)).length, {
        timeout: 5000,
      })
      .toBe(0);
    expect(owned(b).every((p) => alive(p.pid))).toBe(true);
    // Events for the closed conversation start nothing new.
    await fire(
      h,
      "turn_start",
      { ...identity(b), conversationId: "conv-a", input: [] },
      b,
    );
    const org = h.commands.get("delta-org")!;
    h.dispose();
    await expect
      .poll(() => liveProcesses().filter((p) => alive(p.pid)).length, {
        timeout: 5000,
      })
      .toBe(0);
    expect(h.commands.size).toBe(0);
    expect(await org.run({ ...a.ctx, args: "list" })).toMatchObject({
      success: false,
      output: expect.stringMatching(/closed/),
    });
  });

  it("host reload (activation signal abort) kills shared children", async () => {
    const h = host();
    const c = conversation(repo(), "conv-1", initialHistory());
    await share(h, c);
    await expect
      .poll(() => liveProcesses().length, { timeout: 5000 })
      .toBeGreaterThanOrEqual(2);
    h.controller.abort();
    await expect
      .poll(() => liveProcesses().filter((p) => alive(p.pid)).length, {
        timeout: 5000,
      })
      .toBe(0);
    expect(h.commands.size).toBe(0);
  });

  it("reopening a bound conversation after reload restores recording without re-exporting", async () => {
    const first = host();
    const c = conversation(repo(), "conv-1", initialHistory());
    await share(first, c);
    const thread = threadOf(c)!;
    const exported = records(thread, ext("conv-1")).length;
    first.dispose();
    await expect
      .poll(() => liveProcesses().filter((p) => alive(p.pid)).length, {
        timeout: 5000,
      })
      .toBe(0);
    const second = host();
    await fire(
      second,
      "conversation_open",
      { ...identity(c), reason: "resume" },
      c,
    );
    await expect
      .poll(() => liveProcesses().filter((p) => alive(p.pid)).length, {
        timeout: 5000,
      })
      .toBe(2);
    expect(records(thread, ext("conv-1"))).toHaveLength(exported);
    const reopened = (await fire(
      second,
      "turn_start",
      { ...identity(c), input: [] },
      c,
    )) as { cancel?: unknown } | undefined;
    expect(reopened?.cancel).toBeUndefined();
    expect(records(thread, ext("conv-1"))).toHaveLength(exported + 1);
    expectCleanProtocol();
  });
});
