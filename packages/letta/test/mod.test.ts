import { describe, expect, it } from "vitest";
import { Deferred, Effect } from "effect";
import activate, {
  createMod,
  type CommandRegistration,
  type ModApi,
} from "../src/index.js";

function host(enabled = true) {
  const commands = new Map<string, CommandRegistration>();
  const controller = new AbortController();
  const api: ModApi = {
    capabilities: { commands: enabled },
    signal: controller.signal,
    commands: {
      register(command) {
        commands.set(command.id, command);
        return () => {
          commands.delete(command.id);
        };
      },
    },
  };
  return { api, commands, controller };
}
describe("stock mod facade", () => {
  it("registers only working commands and closes retained handles", async () => {
    const h = host();
    const dispose = activate(h.api);
    expect([...h.commands.keys()]).toEqual(["delta", "delta-org"]);
    const run = h.commands.get("delta-org")!.run;
    expect(await run({ args: "", cwd: "/tmp" })).toMatchObject({
      type: "output",
      output: expect.stringContaining("/delta-org"),
    });
    expect(
      await h.commands.get("delta")!.run({ args: "share", cwd: "/tmp" }),
    ).toMatchObject({
      output: expect.stringContaining("requires stock turn and tool"),
    });
    expect(dispose()).toBeUndefined();
    expect(h.commands.size).toBe(0);
    expect(await run({ args: "list", cwd: "/tmp" })).toMatchObject({
      success: false,
      output: expect.stringContaining("closed"),
    });
  });
  it("guards commands and already aborted activations", () => {
    const h = host(false);
    activate(h.api)();
    expect(h.commands.size).toBe(0);
    const a = host();
    a.controller.abort();
    activate(a.api)();
    expect(a.commands.size).toBe(0);
  });
});

it("propagates a throwing invocation context as a live runtime defect", async () => {
  const h = host();
  const dispose = activate(h.api);
  try {
    await expect(
      h.commands.get("delta-org")!.run({
        get args(): string {
          throw new Error("broken invocation context");
        },
        cwd: "/tmp",
      }),
    ).rejects.toThrow("broken invocation context");
    expect(
      await h.commands.get("delta-org")!.run({ args: "", cwd: "/tmp" }),
    ).toMatchObject({ type: "output" });
  } finally {
    dispose();
  }
});
it.each(["share", "join locator", "setup", "update", "plugin-update check"])(
  "marks unavailable %s unsuccessful",
  async (args) => {
    const h = host();
    const dispose = activate(h.api);
    try {
      expect(
        await h.commands.get("delta")!.run({ args, cwd: "/tmp" }),
      ).toMatchObject({ success: false });
    } finally {
      dispose();
    }
  },
);
it("offers org as the root argument prefix only", () => {
  const h = host();
  const dispose = activate(h.api);
  try {
    expect(h.commands.get("delta")!.args).toBe(
      "org list|current|switch <ID>|invite <email>…|manage",
    );
    expect(h.commands.get("delta-org")!.args).toBe(
      "list|current|switch <ID>|invite <email>…|manage",
    );
  } finally {
    dispose();
  }
});

it("returns handled before a browser question is answered (stock commands time out at 30 seconds)", async () => {
  const h = host();
  const notices: string[] = [];
  const answer = Effect.runSync(Deferred.make<string | undefined>());
  const api: ModApi = {
    ...h.api,
    capabilities: {
      commands: true,
      events: { tools: true, turns: true, lifecycle: true },
      ui: { panels: true },
    },
    events: { on: () => () => {} },
    ui: {
      notify: (value) => {
        notices.push(value);
      },
      openPanel: () => ({ update: () => {}, close: () => {} }),
    },
  };
  const dispose = createMod({
    interaction: { ask: () => Deferred.await(answer) },
  })(api);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      h.commands.get("delta")!.run({
        args: "",
        cwd: "/tmp",
        agent: { id: "agent-test" },
        conversation: { id: "conv-test", getHistory: async () => [] },
      }),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ type: "timed-out" }), 1000);
      }),
    ]);
    expect(result).toEqual({ type: "handled" });
    Effect.runSync(Deferred.succeed(answer, undefined));
    await expect.poll(() => notices).toContain("Delta menu closed.");
  } finally {
    clearTimeout(timer);
    dispose();
  }
});
