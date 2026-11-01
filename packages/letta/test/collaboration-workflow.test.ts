import { fileURLToPath } from "node:url";
import { Effect, Fiber, FileSystem } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { platform } from "../../core/test/delivery-support.js";
import {
  makeCollaboration,
  CollaborationError,
  bindingPath,
} from "../src/collaboration/index.js";
import type { Session } from "../src/session.js";
import { openOutbox } from "../../core/src/outbox.js";
const executable = fileURLToPath(
  new URL("./collaboration-fixture.mjs", import.meta.url),
);
it.live(
  "persists watch-time context omissions until their offered turn is acknowledged",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${cwd}/.git`);
      yield* fs.writeFileString(
        `${cwd}/fixture.json`,
        JSON.stringify({ watchLargeUpdates: true }),
      );
      const session: Session = {
        agentId: "a",
        conversationId: "c",
        cwd,
        interactive: true,
        signal: yield* Effect.abortSignal,
        notify: () => {},
        getHistory: async () => [],
      };
      const service = yield* makeCollaboration({
        executable,
        stateDirectory: `${cwd}/state`,
        ready: () => Effect.void,
        organization: () => Effect.succeed("org"),
        interaction: { ask: () => Effect.succeed("private") },
      });
      yield* service.share(session);
      const file = bindingPath(`${cwd}/state`, session);
      for (let attempt = 0; attempt < 200; attempt++) {
        const binding = JSON.parse(yield* fs.readFileString(file));
        if (
          binding.remoteContext?.some((note: { text: string }) =>
            note.text.includes("LIVE_UPDATE_19"),
          )
        )
          break;
        yield* Effect.sleep(10);
      }
      const text = yield* service.takeContext(session);
      expect(text).toContain("LIVE_UPDATE_19");
      expect(text).toContain("earlier Delta context updates omitted");
      expect(text.length).toBeLessThanOrEqual(400_000);
      yield* service.close(session);
      yield* service.restore(session);
      expect(yield* service.takeContext(session)).toBe(text);
      yield* service.ackContext(session);
      expect(yield* service.takeContext(session)).toBe("");
      expect(JSON.parse(yield* fs.readFileString(file)).remoteOmitted).toBe(0);
      yield* service.close(session);
    }).pipe(Effect.provide(platform)),
);
it.live(
  "shares through actual CLI processes and reuses one snapshot and producer",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${cwd}/.git`);
      const notifications: string[] = [];
      const session: Session = {
        agentId: "a",
        conversationId: "c",
        cwd,
        interactive: true,
        signal: yield* Effect.abortSignal,
        notify: (m) => notifications.push(m),
        getHistory: async () => [
          { id: "u1", message_type: "user_message", content: "hello" },
        ],
      };
      const service = yield* makeCollaboration({
        executable,
        stateDirectory: `${cwd}/state`,
        ready: () => Effect.void,
        organization: () => Effect.succeed("org"),
        idle: () => Effect.succeed(true),
        interaction: { ask: () => Effect.succeed("private") },
      });
      let title = "Initial public title";
      const titled = {
        ...session,
        get title() {
          return title;
        },
      };
      expect(yield* service.share(titled)).toBe("https://delta.dev/join/a");
      yield* service.share(session);
      yield* service.turnStart(session);
      yield* service.toolStart(session, {
        toolCallId: "call",
        toolName: "Bash",
        args: { command: "pwd" },
      });
      title = "Updated public title";
      yield* service.turnEnd(titled);
      yield* service.toolEnd(session, {
        toolCallId: "call",
        toolName: "Bash",
        status: "success",
        output: "late result",
      });
      const rows = (yield* fs.readFileString(`${cwd}/records.jsonl`))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        rows
          .filter((row) => row.update.sessionUpdate === "session_info_update")
          .map((row) => row.update.title),
      ).toEqual(["Initial public title", "Updated public title"]);
      // Delta rejects session-scoped title records that carry a turnSequence,
      // even when the title is captured at turn end.
      expect(
        rows
          .filter((row) => row.update.sessionUpdate === "session_info_update")
          .every((row) => row.turnSequence === undefined),
      ).toBe(true);
      expect(rows.filter((row) => row.update.messageId === "u1")).toHaveLength(
        1,
      );
      const running = rows.find((row) => row.update.state === "running");
      expect(
        rows.find((row) => row.update.rawOutput === "late result").turnSequence,
      ).toBe(running.sequence);
      yield* service.close(session);
      expect(notifications.length).toBe(2);
    }).pipe(Effect.provide(platform)),
);
it.live(
  "restores legacy immutable title and reasoning intents without duplicating history",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${cwd}/.git`);
      const session: Session = {
        agentId: "a",
        conversationId: "c",
        cwd,
        interactive: true,
        title: "Old title",
        signal: yield* Effect.abortSignal,
        notify: () => {},
        getHistory: async () => [
          {
            id: "old",
            message_type: "reasoning_message",
            reasoning: "old thought",
          },
          {
            id: "old",
            message_type: "assistant_message",
            content: "new answer",
          },
        ],
      };
      const service = yield* makeCollaboration({
        executable,
        stateDirectory: `${cwd}/state`,
        ready: () => Effect.void,
        organization: () => Effect.succeed("org"),
        interaction: { ask: () => Effect.succeed("private") },
      });
      yield* service.share({
        ...session,
        title: null,
        getHistory: async () => [],
      });
      yield* service.turnStart(session);
      yield* service.turnEnd({
        ...session,
        title: null,
        getHistory: async () => [],
      });
      yield* service.close(session);
      const file = bindingPath(`${cwd}/state`, session);
      const binding = JSON.parse(yield* fs.readFileString(file));
      const title = {
        id: "legacy-title",
        update: { sessionUpdate: "session_info_update", title: "Old title" },
        turnSequence: 1,
      };
      const thought = {
        id: "old",
        update: {
          sessionUpdate: "agent_thought",
          messageId: "old",
          content: [{ type: "text", text: "old thought" }],
        },
        turnSequence: 1,
      };
      const answer = {
        id: "old",
        update: {
          sessionUpdate: "agent_message",
          messageId: "old",
          content: [{ type: "text", text: "new answer" }],
        },
        turnSequence: 1,
      };
      binding.snapshot.push(title, thought, answer);
      yield* fs.writeFileString(file, JSON.stringify(binding));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openOutbox({
            root: `${cwd}/state/${encodeURIComponent(binding.externalId)}.outbox`,
            identity: {
              source: "letta-code",
              externalId: binding.externalId,
              threadId: binding.thread,
              scopeId: binding.owner,
            },
            mode: "reopen",
          });
          yield* store.stage(`history:${title.id}`, {
            update: title.update,
            turnSequence: title.turnSequence,
          });
          yield* store.stage(`history:${thought.id}`, {
            update: thought.update,
            turnSequence: thought.turnSequence,
          });
        }),
      );
      yield* service.restore(session);
      yield* service.turnStart(session);
      yield* service.turnEnd(session);
      const saved = JSON.parse(yield* fs.readFileString(file));
      expect(
        saved.snapshot.filter(
          (row: { update: { sessionUpdate: string } }) =>
            row.update.sessionUpdate === "agent_thought",
        ),
      ).toEqual([thought]);
      expect(
        saved.snapshot.filter(
          (row: { update: { sessionUpdate: string } }) =>
            row.update.sessionUpdate === "agent_message",
        ),
      ).toHaveLength(1);
      expect(saved.snapshot).toContainEqual(title);
      yield* service.close(session);
    }).pipe(Effect.provide(platform)),
);
it.live(
  "prepares explicit single-use fresh-session handoff without exporting old history",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${cwd}/.git`);
      const session: Session = {
        agentId: "a",
        conversationId: "old",
        cwd,
        interactive: true,
        signal: yield* Effect.abortSignal,
        notify: () => {},
        getHistory: async () => {
          throw new Error("old history must not be read");
        },
      };
      const service = yield* makeCollaboration({
        executable,
        stateDirectory: `${cwd}/state`,
        ready: () => Effect.void,
        organization: () => Effect.succeed("org"),
        idle: () => Effect.succeed(true),
        interaction: { ask: () => Effect.succeed("private") },
      });
      const handoff = yield* service.join(session, "https://delta.dev/join/a");
      expect(handoff?.command).toContain("letta --agent 'a' --new");
      expect(
        yield* service
          .restore(
            {
              ...session,
              agentId: "other-agent",
              conversationId: "wrong",
              getHistory: async () => [],
            },
            handoff!.token,
            true,
          )
          .pipe(Effect.result),
      ).toHaveProperty("_tag", "Failure");
      expect(
        yield* fs.exists(
          `${cwd}/state/${encodeURIComponent(`handoff:${handoff!.token}`)}.json.claim`,
        ),
      ).toBe(false);
      yield* service.restore(
        { ...session, conversationId: "new", getHistory: async () => [] },
        handoff!.token,
        true,
      );
      expect(yield* fs.exists(`${cwd}/records.jsonl`)).toBe(false);
      expect(
        yield* service
          .restore(
            {
              ...session,
              conversationId: "another",
              getHistory: async () => [],
            },
            handoff!.token,
            true,
          )
          .pipe(Effect.result),
      ).toHaveProperty("_tag", "Failure");
      yield* service.close(session);
    }).pipe(Effect.provide(platform)),
);
it.live(
  "deduplicates tool events against polled history and never captures Skill bodies",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${cwd}/.git`);
      let history: readonly unknown[] = [];
      const session: Session = {
        agentId: "a",
        conversationId: "c",
        cwd,
        interactive: true,
        signal: yield* Effect.abortSignal,
        notify: () => {},
        getHistory: async () => history,
      };
      const service = yield* makeCollaboration({
        executable,
        stateDirectory: `${cwd}/state`,
        ready: () => Effect.void,
        organization: () => Effect.succeed("org"),
        idle: () => Effect.succeed(true),
        interaction: { ask: () => Effect.succeed("private") },
      });
      yield* service.share(session);
      yield* service.turnStart(session);
      yield* service.toolStart(session, {
        toolCallId: "bash",
        toolName: "Bash",
        args: { command: "pwd" },
      });
      yield* service.toolEnd(session, {
        toolCallId: "bash",
        toolName: "Bash",
        status: "success",
        output: "normal",
      });
      yield* service.toolStart(session, {
        toolCallId: "skill",
        toolName: "Skill",
        args: { skill: "secret" },
      });
      yield* service.toolEnd(session, {
        toolCallId: "skill",
        toolName: "Skill",
        status: "success",
        output: "PRIVATE_SKILL_BODY",
      });
      history = [
        {
          id: "t1",
          message_type: "tool_call_message",
          tool_call: { tool_call_id: "bash", name: "Bash", arguments: "{}" },
        },
        {
          id: "t2",
          message_type: "tool_return_message",
          tool_call_id: "bash",
          tool_return: "normal",
        },
        {
          id: "s1",
          message_type: "tool_call_message",
          tool_call: { tool_call_id: "skill", name: "Skill", arguments: "{}" },
        },
        {
          id: "s2",
          message_type: "tool_return_message",
          tool_call_id: "skill",
          tool_return: "PRIVATE_SKILL_BODY",
        },
      ];
      yield* service.turnEnd(session);
      const text = yield* fs.readFileString(`${cwd}/records.jsonl`);
      const rows = text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(rows.filter((r) => r.update.toolCallId === "bash")).toHaveLength(
        2,
      );
      expect(text).not.toContain("PRIVATE_SKILL_BODY");
      yield* service.close(session);
    }).pipe(Effect.provide(platform)),
);
it.live(
  "close releases its mount, preserves sibling resources, and restores late tool provenance",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${cwd}/.git`);
      const a: Session = {
        agentId: "a",
        conversationId: "one",
        cwd,
        interactive: true,
        signal: yield* Effect.abortSignal,
        notify: () => {},
        getHistory: async () => [],
      };
      const b = { ...a, conversationId: "two" };
      const service = yield* makeCollaboration({
        executable,
        stateDirectory: `${cwd}/state`,
        ready: () => Effect.void,
        organization: () => Effect.succeed("org"),
        idle: () => Effect.succeed(true),
        interaction: { ask: () => Effect.succeed("private") },
      });
      yield* service.share(a);
      yield* service.share(b);
      yield* service.turnStart(a);
      yield* service.toolStart(a, {
        toolCallId: "late",
        toolName: "Bash",
        args: {},
      });
      yield* service.turnEnd(a);
      const pids = (yield* fs.readFileString(`${cwd}/mount-pids.jsonl`))
        .trim()
        .split("\n")
        .map(Number);
      yield* service.close(a);
      expect(() => process.kill(pids[0]!, 0)).toThrow();
      expect(() => process.kill(pids[1]!, 0)).not.toThrow();
      yield* service.restore(a);
      yield* service.toolEnd(a, {
        toolCallId: "late",
        toolName: "Bash",
        status: "success",
        output: "after reload",
      });
      const rows = (yield* fs.readFileString(`${cwd}/records.jsonl`))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        rows.find((r) => r.update.rawOutput === "after reload").turnSequence,
      ).toBe(rows.find((r) => r.update.toolCallId === "late").turnSequence);
      yield* service.close(a);
      yield* service.close(b);
    }).pipe(Effect.provide(platform)),
);
it.live(
  "join refuses access, empty threads and active children before mounting",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${cwd}/.git`);
      const session: Session = {
        agentId: "a",
        conversationId: "one",
        cwd,
        interactive: true,
        signal: yield* Effect.abortSignal,
        notify: () => {},
        getHistory: async () => [],
      };
      let idle = false;
      const service = yield* makeCollaboration({
        executable,
        stateDirectory: `${cwd}/state`,
        ready: () => Effect.void,
        idle: () => Effect.succeed(idle),
        interaction: { ask: () => Effect.succeed("private") },
      });
      expect(
        yield* service.join(session, "thread").pipe(Effect.result),
      ).toHaveProperty("_tag", "Failure");
      idle = true;
      yield* fs.writeFileString(
        `${cwd}/fixture.json`,
        JSON.stringify({ access: "local_only" }),
      );
      expect(
        yield* service.join(session, "thread").pipe(Effect.result),
      ).toHaveProperty("_tag", "Failure");
      yield* fs.writeFileString(
        `${cwd}/fixture.json`,
        JSON.stringify({ empty: true }),
      );
      expect(
        yield* service.join(session, "thread").pipe(Effect.result),
      ).toHaveProperty("_tag", "Failure");
      expect(yield* fs.exists(`${cwd}/mount-pids.jsonl`)).toBe(false);
    }).pipe(Effect.provide(platform)),
);
it.live(
  "retries only explicitly retryable immutable append and fences future admissions",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${cwd}/.git`);
      yield* fs.writeFileString(
        `${cwd}/fixture.json`,
        JSON.stringify({ offlineAttempts: 1 }),
      );
      const session: Session = {
        agentId: "a",
        conversationId: "c",
        cwd,
        interactive: true,
        signal: yield* Effect.abortSignal,
        notify: () => {},
        getHistory: async () => [
          { id: "u", message_type: "user_message", content: "hi" },
        ],
      };
      const service = yield* makeCollaboration({
        executable,
        stateDirectory: `${cwd}/state`,
        ready: () => Effect.void,
        organization: () => Effect.succeed("org"),
        idle: () => Effect.succeed(true),
        interaction: { ask: () => Effect.succeed("private") },
      });
      yield* service.share(session);
      const rows = (yield* fs.readFileString(`${cwd}/records.jsonl`))
        .trim()
        .split("\n");
      expect(rows).toHaveLength(1);
      const state = JSON.parse(yield* fs.readFileString(`${cwd}/fixture.json`));
      yield* fs.writeFileString(
        `${cwd}/fixture.json`,
        JSON.stringify({ ...state, fenced: true }),
      );
      expect(yield* service.turnStart(session)).toHaveProperty("cancel");
      expect(
        yield* service.toolStart(session, {
          toolCallId: "blocked",
          toolName: "Bash",
          args: {},
        }),
      ).toHaveProperty("result.status", "error");
      yield* service.close(session);
    }).pipe(Effect.provide(platform)),
);
it.live(
  "reload-required preserves immutable queue and prevents unsupported recovery mutations",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${cwd}/.git`);
      yield* fs.writeFileString(
        `${cwd}/fixture.json`,
        JSON.stringify({ reload: true }),
      );
      const session: Session = {
        agentId: "a",
        conversationId: "c",
        cwd,
        interactive: true,
        signal: yield* Effect.abortSignal,
        notify: () => {},
        getHistory: async () => [
          { id: "u", message_type: "user_message", content: "retain me" },
        ],
      };
      const service = yield* makeCollaboration({
        executable,
        stateDirectory: `${cwd}/state`,
        ready: () => Effect.void,
        organization: () => Effect.succeed("org"),
        idle: () => Effect.succeed(true),
        interaction: { ask: () => Effect.succeed("private") },
      });
      expect(yield* service.share(session).pipe(Effect.result)).toHaveProperty(
        "_tag",
        "Failure",
      );
      expect(yield* service.turnStart(session)).toHaveProperty("cancel");
      expect(
        yield* service.recover(session, "fork").pipe(Effect.result),
      ).toHaveProperty("_tag", "Failure");
      const calls = (yield* fs.readFileString(`${cwd}/calls.jsonl`)).split(
        "\n",
      );
      expect(calls.filter((line) => line.includes('"append"'))).toHaveLength(1);
      expect(calls.some((line) => line.includes('"fork"'))).toBe(false);
      yield* service.close(session);
    }).pipe(Effect.provide(platform)),
);
it.live(
  "setup audience avoids duplicate consent and repository organization wins",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${cwd}/.git`);
      yield* fs.makeDirectory(`${cwd}/.delta`);
      yield* fs.writeFileString(
        `${cwd}/.delta/settings.json`,
        JSON.stringify({
          threads: { mode: "private", organization: "repo-team" },
        }),
      );
      const session: Session = {
        agentId: "a",
        conversationId: "c",
        cwd,
        interactive: true,
        signal: yield* Effect.abortSignal,
        notify: () => {},
        getHistory: async () => [],
      };
      const service = yield* makeCollaboration({
        executable,
        stateDirectory: `${cwd}/state`,
        ready: () => Effect.void,
        organization: () => Effect.succeed("global-team"),
        interaction: {
          ask: () => Effect.die("confirmed setup must not reask"),
        },
      });
      yield* service.share(session, [], "dedicated_command", {
        organization: "setup-team",
        visibility: "private",
      });
      const calls = yield* fs.readFileString(`${cwd}/calls.jsonl`);
      expect(calls).toContain("repo-team");
      expect(calls).not.toContain("global-team");
      yield* service.close(session);
    }).pipe(Effect.provide(platform)),
);
it.live(
  "recovery checkpoints fork before discard and never repeats completed mutations when resume fails",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${cwd}/.git`);
      yield* fs.writeFileString(
        `${cwd}/fixture.json`,
        JSON.stringify({ reload: true }),
      );
      const session: Session = {
        agentId: "a",
        conversationId: "c",
        cwd,
        interactive: true,
        signal: yield* Effect.abortSignal,
        notify: () => {},
        getHistory: async () => [
          { id: "u", message_type: "user_message", content: "keep" },
        ],
      };
      const service = yield* makeCollaboration({
        executable,
        stateDirectory: `${cwd}/state`,
        ready: () => Effect.void,
        organization: () => Effect.succeed("org"),
        resumeOutbox: () =>
          Effect.fail(
            new CollaborationError({
              message: "Injected durable resume failure",
            }),
          ),
        interaction: { ask: () => Effect.succeed("private") },
      });
      yield* service.share(session).pipe(Effect.result);
      expect(
        yield* service.recover(session, "fork").pipe(Effect.result),
      ).toHaveProperty("_tag", "Failure");
      expect(
        yield* service.recover(session, "fork").pipe(Effect.result),
      ).toHaveProperty("_tag", "Failure");
      const calls = (yield* fs.readFileString(`${cwd}/calls.jsonl`))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const mutations = calls.filter(
        (args) => args[1] === "fork" || args[1] === "discard",
      );
      expect(mutations.map((args) => args[1])).toEqual(["fork", "discard"]);
      yield* service.close(session);
    }).pipe(Effect.provide(platform)),
);
it.live(
  "watch reconnect rebuilds fresh inventory, renders thoughts only to humans, and drains model context once",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${cwd}/.git`);
      yield* fs.writeFileString(
        `${cwd}/fixture.json`,
        JSON.stringify({ watchRemote: true, watchRestartOnce: true }),
      );
      const notices: string[] = [];
      const session: Session = {
        agentId: "a",
        conversationId: "c",
        cwd,
        interactive: true,
        signal: yield* Effect.abortSignal,
        notify: (m) => notices.push(m),
        getHistory: async () => [],
      };
      const service = yield* makeCollaboration({
        executable,
        stateDirectory: `${cwd}/state`,
        ready: () => Effect.void,
        organization: () => Effect.succeed("org"),
        interaction: { ask: () => Effect.succeed("private") },
      });
      yield* service.share(session);
      for (let attempt = 0; attempt < 150; attempt++) {
        const snapshot = yield* service.remoteSnapshot(session);
        if (
          snapshot?.items.some(
            (item) => item.content.text === "remote snapshot 2",
          )
        )
          break;
        yield* Effect.sleep(20);
      }
      const snapshot = yield* service.remoteSnapshot(session);
      expect(
        snapshot?.items.find((item) => item.id === "remote")?.content.text,
      ).toBe("remote snapshot 2");
      const context = yield* service.takeContext(session);
      expect(context).toContain("remote snapshot 2");
      expect(context).not.toContain("remote human thought");
      expect(context.startsWith("[Delta]")).toBe(true);
      expect(yield* service.takeContext(session)).toBe(context);
      yield* service.ackContext(session);
      expect(yield* service.takeContext(session)).toBe("");
      expect(notices.join("\n")).toContain("remote human thought");
      yield* service.close(session);
    }).pipe(Effect.provide(platform)),
);
it.live(
  "normal restore reconciles persisted tool output and idle intents before a new turn",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${cwd}/.git`);
      const session: Session = {
        agentId: "a",
        conversationId: "c",
        cwd,
        interactive: true,
        signal: yield* Effect.abortSignal,
        notify: () => {},
        getHistory: async () => [],
      };
      const service = yield* makeCollaboration({
        executable,
        stateDirectory: `${cwd}/state`,
        ready: () => Effect.void,
        organization: () => Effect.succeed("org"),
        interaction: { ask: () => Effect.succeed("private") },
      });
      yield* service.share(session);
      yield* service.turnStart(session);
      yield* service.toolStart(session, {
        toolCallId: "saved",
        toolName: "Bash",
        args: { command: "pwd" },
      });
      yield* service.close(session);
      const file = bindingPath(`${cwd}/state`, session);
      const binding = JSON.parse(yield* fs.readFileString(file));
      binding.tools.saved.output = "persisted-before-stage";
      binding.tools.saved.status = "success";
      binding.pendingIdle = 1;
      yield* fs.writeFileString(file, JSON.stringify(binding));
      yield* service.restore(session);
      yield* service.turnStart(session);
      const rows = (yield* fs.readFileString(`${cwd}/records.jsonl`))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const output = rows.find(
        (row) => row.update.rawOutput === "persisted-before-stage",
      );
      const idle = rows.find((row) => row.update.state === "idle");
      expect(output.turnSequence).toBe(1);
      expect(output.sequence).toBeLessThan(idle.sequence);
      expect(rows.at(-1).update.state).toBe("running");
      expect(rows.at(-1).sequence).toBeGreaterThan(idle.sequence);
      yield* service.close(session);
    }).pipe(Effect.provide(platform)),
);
it.live(
  "share and restore mount the checkout root while retaining nested host cwd",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${root}/.git`);
      yield* fs.makeDirectory(`${root}/subdir`);
      const cwd = `${root}/subdir`;
      const session: Session = {
        agentId: "a",
        conversationId: "c",
        cwd,
        interactive: true,
        signal: yield* Effect.abortSignal,
        notify: () => {},
        getHistory: async () => [],
      };
      const service = yield* makeCollaboration({
        executable,
        stateDirectory: `${root}/state`,
        ready: () => Effect.void,
        organization: () => Effect.succeed("org"),
        interaction: { ask: () => Effect.succeed("private") },
      });
      yield* service.share(session);
      yield* service.close(session);
      yield* service.restore(session);
      const calls = (yield* fs.readFileString(`${cwd}/calls.jsonl`))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        calls
          .filter((args) => args[0] === "worktree" && args[1] === "mount")
          .map((args) => args[3]),
      ).toEqual([root, root]);
      expect(yield* fs.readFileString(`${cwd}/mount-cwd.txt`)).toBe(cwd);
      yield* service.close(session);
    }).pipe(Effect.provide(platform)),
);
it.live(
  "explicit fork and restore resumes the real paused outbox without recycling producer sequences",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${cwd}/.git`);
      yield* fs.writeFileString(
        `${cwd}/fixture.json`,
        JSON.stringify({ reload: true }),
      );
      const session: Session = {
        agentId: "a",
        conversationId: "c",
        cwd,
        interactive: true,
        signal: yield* Effect.abortSignal,
        notify: () => {},
        getHistory: async () => [
          { id: "u", message_type: "user_message", content: "keep" },
        ],
      };
      const service = yield* makeCollaboration({
        executable,
        stateDirectory: `${cwd}/state`,
        ready: () => Effect.void,
        organization: () => Effect.succeed("org"),
        resumeOutbox: (store, status) =>
          store
            .resumeAfterReload(status)
            .pipe(
              Effect.mapError(
                () =>
                  new CollaborationError({ message: "Cannot resume outbox" }),
              ),
            ),
        interaction: { ask: () => Effect.succeed("private") },
      });
      expect(yield* service.share(session).pipe(Effect.result)).toHaveProperty(
        "_tag",
        "Failure",
      );
      yield* service.recover(session, "fork");
      yield* service.turnStart(session);
      const rows = (yield* fs.readFileString(`${cwd}/records.jsonl`))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(rows.map((row) => row.sequence)).toEqual([1, 2]);
      expect(rows[0].update.content[0].text).toBe("keep");
      yield* service.close(session);
    }).pipe(Effect.provide(platform)),
);
it.live(
  "peeked remote context survives canceled admission and reload until explicit completed-turn acknowledgement",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${cwd}/.git`);
      const session: Session = {
        agentId: "a",
        conversationId: "c",
        cwd,
        interactive: true,
        signal: yield* Effect.abortSignal,
        notify: () => {},
        getHistory: async () => [],
      };
      const service = yield* makeCollaboration({
        executable,
        stateDirectory: `${cwd}/state`,
        ready: () => Effect.void,
        organization: () => Effect.succeed("org"),
        interaction: { ask: () => Effect.succeed("private") },
      });
      yield* service.share(session);
      yield* service.close(session);
      const file = bindingPath(`${cwd}/state`, session);
      const binding = JSON.parse(yield* fs.readFileString(file));
      binding.remoteContext = [
        { id: "offered", text: "[Delta]\nUnread collaborator input" },
      ];
      yield* fs.writeFileString(file, JSON.stringify(binding));
      yield* service.restore(session);
      const offered = yield* service.takeContext(session);
      expect(offered).toContain("Unread collaborator input");
      yield* service.close(session);
      yield* service.restore(session);
      expect(yield* service.takeContext(session)).toBe(offered);
      yield* service.ackContext(session);
      expect(yield* service.takeContext(session)).toBe("");
      yield* service.close(session);
      const queued = JSON.parse(yield* fs.readFileString(file));
      queued.remoteContext = [
        {
          id: "old",
          text: `OLD_UPDATE_START${"a".repeat(200_000)}OLD_UPDATE_END`,
        },
        {
          id: "middle",
          text: `MIDDLE_UPDATE_START${"b".repeat(200_000)}MIDDLE_UPDATE_END`,
        },
        {
          id: "new",
          text: `NEW_UPDATE_START${"c".repeat(200_000)}NEW_UPDATE_END`,
        },
      ];
      yield* fs.writeFileString(file, JSON.stringify(queued));
      yield* service.restore(session);
      const bounded = yield* service.takeContext(session);
      expect(bounded.length).toBeLessThanOrEqual(400_000);
      expect(bounded).toContain("2 earlier Delta context updates omitted");
      expect(bounded).not.toContain("MIDDLE_UPDATE_END");
      expect(bounded).toContain("NEW_UPDATE_START");
      expect(bounded).toContain("NEW_UPDATE_END");
      yield* service.ackContext(session);
      expect(yield* service.takeContext(session)).toBe("");
      yield* service.close(session);
    }).pipe(Effect.provide(platform)),
);
it.live(
  "never stages canonical Skill user bodies or known public memory tool data",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${cwd}/.git`);
      const session: Session = {
        agentId: "a",
        conversationId: "c",
        cwd,
        memoryDirectory: "C:\\Users\\A\\AgentMemory",
        interactive: true,
        signal: yield* Effect.abortSignal,
        notify: () => {},
        getHistory: async () => [
          {
            id: "skill",
            message_type: "user_message",
            content:
              '<skill_content name="review">SECRET_SKILL_BODY</skill_content>',
          },
          {
            id: "memory-call",
            message_type: "tool_call_message",
            tool_call: {
              tool_call_id: "memory",
              name: "Read",
              arguments: JSON.stringify({
                file_path: "C:\\Users\\A\\AgentMemory\\core.md",
              }),
            },
          },
          {
            id: "memory-output",
            message_type: "tool_return_message",
            tool_call_id: "memory",
            tool_return: "SECRET_MEMORY_BODY",
          },
          {
            id: "ordinary",
            message_type: "user_message",
            content: "Ordinary authored message",
          },
        ],
      };
      const service = yield* makeCollaboration({
        executable,
        stateDirectory: `${cwd}/state`,
        ready: () => Effect.void,
        organization: () => Effect.succeed("org"),
        interaction: { ask: () => Effect.succeed("private") },
      });
      yield* service.share(session);
      yield* service.turnStart(session);
      yield* service.toolStart(session, {
        toolCallId: "shell",
        toolName: "Bash",
        args: { command: "cat $MEMORY_DIR/core.md" },
      });
      yield* service.toolEnd(session, {
        toolCallId: "shell",
        toolName: "Bash",
        status: "success",
        output: "SECRET_SHELL_MEMORY",
      });
      yield* service.turnEnd(session);
      const records = yield* fs.readFileString(`${cwd}/records.jsonl`);
      const binding = yield* fs.readFileString(
        bindingPath(`${cwd}/state`, session),
      );
      expect(records).not.toContain("SECRET_");
      expect(binding).not.toContain("SECRET_");
      expect(records).toContain("Ordinary authored message");
      yield* service.close(session);
    }).pipe(Effect.provide(platform)),
);
it.live(
  "history arriving in turn B completes a turn-A tool once under its original turn before delayed tool_end",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${cwd}/.git`);
      let history: readonly unknown[] = [];
      const session: Session = {
        agentId: "a",
        conversationId: "c",
        cwd,
        interactive: true,
        signal: yield* Effect.abortSignal,
        notify: () => {},
        getHistory: async () => history,
      };
      const service = yield* makeCollaboration({
        executable,
        stateDirectory: `${cwd}/state`,
        ready: () => Effect.void,
        organization: () => Effect.succeed("org"),
        interaction: { ask: () => Effect.succeed("private") },
      });
      yield* service.share(session);
      yield* service.turnStart(session);
      yield* service.toolStart(session, {
        toolCallId: "late-a",
        toolName: "Bash",
        args: { command: "pwd" },
      });
      yield* service.turnEnd(session);
      yield* service.turnStart(session);
      history = [
        {
          id: "call-a",
          message_type: "tool_call_message",
          tool_call: { tool_call_id: "late-a", name: "Bash", arguments: "{}" },
        },
        {
          id: "return-a",
          message_type: "tool_return_message",
          tool_call_id: "late-a",
          tool_return: "turn A result",
          status: "success",
        },
      ];
      yield* service.turnEnd(session);
      yield* service.toolEnd(session, {
        toolCallId: "late-a",
        toolName: "Bash",
        status: "success",
        output: "turn A result",
      });
      yield* service.close(session);
      yield* service.restore(session);
      const rows = (yield* fs.readFileString(`${cwd}/records.jsonl`))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const completions = rows.filter(
        (row) =>
          row.update.toolCallId === "late-a" &&
          row.update.status === "completed",
      );
      expect(completions).toHaveLength(1);
      expect(completions[0].turnSequence).toBe(1);
      yield* service.close(session);
    }).pipe(Effect.provide(platform)),
);
it.live(
  "initial snapshot blocks admissions until live context is ready without blocking the native hook",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${cwd}/.git`);
      yield* fs.writeFileString(
        `${cwd}/fixture.json`,
        JSON.stringify({ watchGate: true, watchRemote: true }),
      );
      const session: Session = {
        agentId: "a",
        conversationId: "c",
        cwd,
        interactive: true,
        signal: yield* Effect.abortSignal,
        notify: () => {},
        getHistory: async () => [],
      };
      const service = yield* makeCollaboration({
        executable,
        stateDirectory: `${cwd}/state`,
        ready: () => Effect.void,
        organization: () => Effect.succeed("org"),
        interaction: { ask: () => Effect.succeed("private") },
      });
      const sharing = yield* service.share(session).pipe(Effect.forkChild);
      while (!(yield* fs.exists(`${cwd}/watch-ready`))) yield* Effect.sleep(10);
      expect(
        yield* service.turnStart(session).pipe(Effect.timeout("1 second")),
      ).toHaveProperty("cancel");
      expect(
        yield* service.toolStart(session, {
          toolCallId: "blocked",
          toolName: "Bash",
          args: {},
        }),
      ).toHaveProperty("result.status", "error");
      yield* fs.writeFileString(`${cwd}/watch-allow`, "go");
      yield* Fiber.join(sharing);
      expect(yield* service.takeContext(session)).toContain("remote snapshot");
      expect(yield* service.turnStart(session)).toBeUndefined();
      yield* service.close(session);
    }).pipe(Effect.provide(platform)),
);
it.live(
  "failed activation releases its writer scope so transient status and reconcile failures can retry",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${cwd}/.git`);
      const session: Session = {
        agentId: "a",
        conversationId: "c",
        cwd,
        interactive: true,
        signal: yield* Effect.abortSignal,
        notify: () => {},
        getHistory: async () => [],
      };
      const service = yield* makeCollaboration({
        executable,
        stateDirectory: `${cwd}/state`,
        ready: () => Effect.void,
        organization: () => Effect.succeed("org"),
        interaction: { ask: () => Effect.succeed("private") },
      });
      yield* service.share(session);
      yield* service.close(session);
      const fixture = JSON.parse(
        yield* fs.readFileString(`${cwd}/fixture.json`),
      );
      yield* fs.writeFileString(
        `${cwd}/fixture.json`,
        JSON.stringify({ ...fixture, statusFailures: 1 }),
      );
      expect(
        yield* service.restore(session).pipe(Effect.result),
      ).toHaveProperty("_tag", "Failure");
      const outbox = `${cwd}/state/${encodeURIComponent("letta:a:c")}.outbox`;
      expect(yield* fs.exists(`${outbox}/.writer`)).toBe(false);
      expect(yield* service.turnStart(session)).toHaveProperty("cancel");
      yield* service.restore(session);
      yield* service.close(session);
      const file = bindingPath(`${cwd}/state`, session);
      const saved = yield* fs.readFileString(file);
      const corrupt = JSON.parse(saved);
      corrupt.snapshot = [{ id: "bad", update: { sessionUpdate: "invalid" } }];
      yield* fs.writeFileString(file, JSON.stringify(corrupt));
      expect(
        yield* service.restore(session).pipe(Effect.result),
      ).toHaveProperty("_tag", "Failure");
      expect(yield* fs.exists(`${outbox}/.writer`)).toBe(false);
      expect(yield* service.turnStart(session)).toHaveProperty("cancel");
      yield* fs.writeFileString(file, saved);
      yield* service.restore(session);
      yield* service.close(session);
    }).pipe(Effect.provide(platform)),
);
it.live(
  "delayed reload refusal never admits a running turn or tool before a complete snapshot",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${cwd}/.git`);
      yield* fs.writeFileString(
        `${cwd}/fixture.json`,
        JSON.stringify({ watchGate: true, watchRefusal: true }),
      );
      const session: Session = {
        agentId: "a",
        conversationId: "c",
        cwd,
        interactive: true,
        signal: yield* Effect.abortSignal,
        notify: () => {},
        getHistory: async () => [],
      };
      const service = yield* makeCollaboration({
        executable,
        stateDirectory: `${cwd}/state`,
        ready: () => Effect.void,
        organization: () => Effect.succeed("org"),
        interaction: { ask: () => Effect.succeed("private") },
      });
      const sharing = yield* service
        .share(session)
        .pipe(Effect.result, Effect.forkChild);
      while (!(yield* fs.exists(`${cwd}/watch-ready`))) yield* Effect.sleep(10);
      expect(
        yield* service.turnStart(session).pipe(Effect.timeout("1 second")),
      ).toHaveProperty("cancel");
      yield* fs.writeFileString(`${cwd}/watch-allow`, "go");
      expect(yield* Fiber.join(sharing)).toHaveProperty("_tag", "Failure");
      expect(yield* service.turnStart(session)).toHaveProperty("cancel");
      expect(
        yield* service.toolStart(session, {
          toolCallId: "blocked",
          toolName: "Bash",
          args: {},
        }),
      ).toHaveProperty("result.status", "error");
      expect(yield* fs.exists(`${cwd}/records.jsonl`)).toBe(false);
      yield* service.close(session);
    }).pipe(Effect.provide(platform)),
);
it.live(
  "hot reload can acquire an overlapping writer after its owner closes, without reclaiming a foreign lock",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${cwd}/.git`);
      const session: Session = {
        agentId: "a",
        conversationId: "c",
        cwd,
        interactive: true,
        signal: yield* Effect.abortSignal,
        notify: () => {},
        getHistory: async () => [],
      };
      const options = {
        executable,
        stateDirectory: `${cwd}/state`,
        ready: () => Effect.void,
        organization: () => Effect.succeed("org"),
        interaction: { ask: () => Effect.succeed("private") },
      };
      const first = yield* makeCollaboration(options);
      yield* first.share(session);
      const second = yield* makeCollaboration(options);
      const restoring = yield* second.restore(session).pipe(Effect.forkChild);
      while (
        (yield* fs.readFileString(`${cwd}/mount-pids.jsonl`)).trim().split("\n")
          .length < 2
      )
        yield* Effect.sleep(5);
      yield* Effect.sleep(60);
      yield* first.close(session);
      yield* Fiber.join(restoring);
      yield* second.close(session);
      const lock = `${cwd}/state/${encodeURIComponent("letta:a:c")}.outbox/.writer`;
      yield* fs.makeDirectory(lock, { mode: 0o700 });
      expect(yield* second.restore(session).pipe(Effect.result)).toHaveProperty(
        "_tag",
        "Failure",
      );
      expect(yield* fs.exists(lock)).toBe(true);
      // Test-only removal of our synthetic foreign lock; production never reclaims it.
      yield* fs.remove(lock, { recursive: true });
      yield* second.close(session);
    }).pipe(Effect.provide(platform)),
);
