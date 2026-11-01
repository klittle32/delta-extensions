import { describe, expect, it } from "vitest";
import activate, {
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
    ).toMatchObject({ output: expect.stringContaining("not implemented") });
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
