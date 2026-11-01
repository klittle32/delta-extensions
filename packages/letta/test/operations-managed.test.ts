import { Effect, Layer } from "effect";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
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
  signal: new AbortController().signal,
  interactive: true,
  getHistory: async () => [],
  notify: () => {},
};
const root = "/mods/packages/npm/@example/mod";
const bundle = `file://${root}/dist/index.mjs`;
const execute = (action: string, choice: string, pin?: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const calls: string[][] = [];
        let version = "1.0.0";
        const data = new Map<string, string>(
          pin
            ? [
                [
                  "/prefs",
                  JSON.stringify({ custom: 1, pluginUpdateSource: pin }),
                ],
              ]
            : [["/prefs", '{"custom":1}']],
        );
        const ops = yield* makeOperations({
          moduleUrl: bundle,
          managedModsRoot: "/mods",
          preferencesPath: "/prefs",
          interaction: { ask: () => Effect.succeed(choice) },
          files: {
            read: (p) =>
              Effect.succeed(
                p === `${root}/package.json`
                  ? JSON.stringify({
                      name: "@example/mod",
                      version,
                      letta: { manifestVersion: 1, mods: ["dist/index.mjs"] },
                    })
                  : data.get(p),
              ),
            write: (p, t) =>
              Effect.sync(() => {
                data.set(p, t);
              }),
          },
          run: (r) =>
            Effect.sync(() => {
              calls.push([r.executable, ...r.args]);
              if (r.args.includes("update")) version = "2.0.0";
              return {
                exitCode: 0,
                stderr: "",
                stdout:
                  r.executable === "npm"
                    ? '"2.0.0"'
                    : r.args.includes("update")
                      ? "Updated"
                      : `Harness mods\n  (none)\n\nInstalled packages\n  enabled  npm:@example/mod@${version}    commands`,
              };
            }),
        });
        const result = yield* ops.pluginUpdate(session, action);
        return { result, calls, preferences: JSON.parse(data.get("/prefs")!) };
      }),
    ).pipe(Effect.provide(layer)),
  );
it("checks a real managed source read-only without pretending pin history is available", async () => {
  const result = await execute("check", "cancel");
  expect(result.result).toContain("latest published version: 2.0.0");
  expect(result.result).toContain("does not retain");
  expect(result.calls).toEqual([
    ["letta", "mods", "list", "--agent", "a"],
    ["npm", "view", "@example/mod", "version", "--json"],
  ]);
});
it("adopts latest only by explicit consent, then uses native update and verifies installation", async () => {
  const result = await execute("", "latest");
  expect(result.result).toContain("Updated managed Delta mod to 2.0.0");
  expect(result.calls).toEqual([
    ["letta", "mods", "list", "--agent", "a"],
    ["letta", "mods", "update", "npm:@example/mod"],
    ["letta", "mods", "list", "--agent", "a"],
  ]);
  expect(result.preferences).toEqual({
    custom: 1,
    pluginUpdateSource: "npm:@example/mod",
  });
});
it("does not update or change preferences after declining unknown-pin adoption", async () => {
  const result = await execute("", "cancel");
  expect(result.result).toContain("cancelled");
  expect(result.calls).toHaveLength(1);
  expect(result.preferences).toEqual({ custom: 1 });
});
it("leaves owned explicit pins unchanged", async () => {
  const result = await execute("", "latest", "npm:@example/mod@1.0.0");
  expect(result.result).toContain("pinned");
  expect(result.calls).toHaveLength(1);
});
it("uses confirmed latest policy without asking to adopt another source", async () => {
  const result = await execute("", "update", "npm:@example/mod");
  expect(result.result).toContain("2.0.0");
  expect(result.calls[1]).toEqual([
    "letta",
    "mods",
    "update",
    "npm:@example/mod",
  ]);
});
