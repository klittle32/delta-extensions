import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { expect, it } from "vitest";
import { nodeProcessLayer } from "../../core/src/node.js";
import { makeOperations } from "../src/operations/index.js";
import type { Session } from "../src/session.js";
const layer = Layer.mergeAll(
  NodeFileSystem.layer,
  NodePath.layer,
  nodeProcessLayer,
);
const session: Session = {
  agentId: "a",
  conversationId: "c",
  cwd: "/repo",
  interactive: false,
  signal: new AbortController().signal,
  getHistory: async () => [],
  notify: () => {
    throw new Error("must return notices only");
  },
};
const receipt = (
  status: string,
  latest: string | null = "2.0.0",
  can_install = true,
) =>
  JSON.stringify({
    schema_version: 1,
    status,
    can_install,
    current_version: "1.0.0",
    latest_version: latest,
    channel: "stable",
    message: "English message is not status",
  });
const execute = (
  status: string,
  prefs: Record<string, unknown> = {},
  moduleUrl?: string,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const calls: string[][] = [];
        const data = new Map([["/prefs", JSON.stringify(prefs)]]);
        const options = {
          preferencesPath: "/prefs",
          ...(moduleUrl ? { moduleUrl, managedModsRoot: "/mods" } : {}),
          interaction: { ask: () => Effect.die("must not interact") },
          discover: () => Effect.succeed("/delta"),
          files: {
            read: (p: string) =>
              Effect.succeed(
                p === "/mods/packages/npm/example/package.json"
                  ? JSON.stringify({
                      name: "example",
                      version: "1.0.0",
                      letta: { manifestVersion: 1, mods: ["index.mjs"] },
                    })
                  : data.get(p),
              ),
            write: (p: string, t: string) =>
              Effect.sync(() => {
                data.set(p, t);
              }),
          },
          run: (
            r: import("../../core/src/transport-errors.js").ProcessRequest,
          ) =>
            Effect.sync(() => {
              calls.push([r.executable, ...r.args]);
              return {
                exitCode: 0,
                stderr: "",
                stdout:
                  r.executable === "/delta"
                    ? receipt(status)
                    : r.executable === "npm"
                      ? '"2.0.0"'
                      : "Installed packages\n  enabled  npm:example@1.0.0    commands",
              };
            }),
        };
        const ops = yield* makeOperations(options);
        const notices = yield* ops.backgroundCheck(session);
        const again = yield* ops.backgroundCheck(session);
        const reopened = yield* makeOperations(options);
        const afterReopen = yield* reopened.backgroundCheck(session);
        return {
          notices,
          again,
          afterReopen,
          calls,
          preferences: JSON.parse(data.get("/prefs")!),
        };
      }),
    ).pipe(Effect.provide(layer)),
  );
it("returns actionable notices and durably throttles repeated checks across lifecycles", async () => {
  const result = await execute("update_available", { custom: true });
  expect(result.notices).toEqual([
    "Delta 2.0.0 is available (installed: 1.0.0). Run /delta-update to update.",
  ]);
  expect(result.again).toEqual([]);
  expect(result.afterReopen).toEqual([]);
  expect(result.calls).toEqual([["/delta", "update", "--check", "--json"]]);
  expect(result.preferences.custom).toBe(true);
});
it("notification opt-out does not discover, authenticate, or run package checks", async () => {
  const result = await execute("update_available", { notifications: false });
  expect(result.notices).toEqual([]);
  expect(result.calls).toEqual([]);
});
for (const status of ["up_to_date", "unsupported", "updated", "install_ready"])
  it(`does not notify from ${status} or interpret English message text`, async () => {
    expect((await execute(status)).notices).toEqual([]);
  });
it("loose MemFS and pinned copies never query a fake registry release", async () => {
  for (const [url, prefs] of [
    ["file:///memory/mods/delta.mjs", {}],
    [
      "file:///mods/packages/npm/example/index.mjs",
      { pluginUpdateSource: "npm:example@1.0.0" },
    ],
  ] as const) {
    const result = await execute("up_to_date", prefs, url);
    expect(result.notices).toEqual([]);
    expect(result.calls.some((args) => args[0] === "npm")).toBe(false);
  }
});
it("announces a newer verified managed npm release with an actionable command", async () => {
  const result = await execute(
    "up_to_date",
    { pluginUpdateSource: "npm:example" },
    "file:///mods/packages/npm/example/index.mjs",
  );
  expect(result.notices).toEqual([
    "Delta mod 2.0.0 is available (installed: 1.0.0). Run /delta-plugin-update to update.",
  ]);
  expect(result.calls).toContainEqual([
    "npm",
    "view",
    "example",
    "version",
    "--json",
  ]);
  expect(
    result.calls.some(
      (args) =>
        args.includes("auth") ||
        args.includes("install") ||
        (args.includes("mods") && args.includes("update")),
    ),
  ).toBe(false);
});

it("does not invoke Letta or registry clients for a loose MemFS entry", async () => {
  const result = await execute(
    "up_to_date",
    {},
    "file:///memory/mods/delta.mjs",
  );
  expect(result.calls.map((args) => args[0])).toEqual(["/delta"]);
});
it("expires old stamps and clamps implausibly future stamps instead of suppressing checks forever", async () => {
  for (const checkedAt of [
    Date.now() - 2 * 60 * 60 * 1000,
    Date.now() + 2 * 60 * 60 * 1000,
  ]) {
    const result = await execute("update_available", {
      backgroundUpdateCheck: { checkedAt, moduleUrl: null },
    });
    expect(result.notices).toHaveLength(1);
    expect(result.calls).toHaveLength(1);
  }
});
it("fresh durable stamps skip optional processes", async () => {
  const result = await execute("update_available", {
    backgroundUpdateCheck: { checkedAt: Date.now(), moduleUrl: null },
  });
  expect(result.notices).toEqual([]);
  expect(result.calls).toEqual([]);
});
