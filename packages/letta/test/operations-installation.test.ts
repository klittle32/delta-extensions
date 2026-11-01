import { Effect } from "effect";
import { NodePath } from "@effect/platform-node";
import { expect, it } from "vitest";
import { classifyModInstallation } from "../src/operations/installation.js";
const manifest = JSON.stringify({
  name: "@example/mod",
  version: "1.2.3",
  letta: { manifestVersion: 1, mods: ["dist/index.mjs"] },
});
const listing =
  "Harness mods\n  (none)\n\nInstalled packages\n  enabled  npm:@example/mod@1.2.3    commands";
const read = (file: string) =>
  Effect.succeed(
    file === "/mods/packages/npm/@example/mod/package.json"
      ? manifest
      : undefined,
  );
const classify = (url: string, policy?: string, text = listing) =>
  Effect.runPromise(
    classifyModInstallation(url, text, { read }, policy, "/mods").pipe(
      Effect.provide(NodePath.layer),
    ),
  );
it("matches running bundle to a public listing plus its package manifest", async () => {
  expect(
    await classify("file:///mods/packages/npm/@example/mod/dist/index.mjs"),
  ).toMatchObject({
    kind: "managed",
    source: "npm:@example/mod",
    pin: "unknown",
    version: "1.2.3",
  });
});
it("preserves explicit owned update pins and latest policy without inventing historical metadata", async () => {
  expect(
    await classify(
      "file:///mods/packages/npm/@example/mod/dist/index.mjs",
      "npm:@example/mod@1.2.3",
    ),
  ).toMatchObject({ kind: "pinned", version: "1.2.3" });
  expect(
    await classify(
      "file:///mods/packages/npm/@example/mod/dist/index.mjs",
      "npm:@example/mod",
    ),
  ).toMatchObject({ kind: "managed", pin: "latest" });
});
it("never treats loose MemFS or an unlisted/ambiguous package as managed", async () => {
  expect(await classify("file:///memory/mods/delta.mjs")).toMatchObject({
    kind: "local",
  });
  expect(
    await classify(
      "file:///mods/packages/npm/@example/mod/dist/index.mjs",
      undefined,
      "Installed packages\n  (none)",
    ),
  ).toMatchObject({ kind: "local" });
  expect(
    await classify(
      "file:///mods/packages/npm/@example/mod/dist/index.mjs",
      undefined,
      listing + "\n  enabled  npm:@example/mod@1.2.3",
    ),
  ).toMatchObject({ kind: "local" });
});
it("does not confuse a source checkout that copies managed layout with the native installation root", async () => {
  const result = await Effect.runPromise(
    classifyModInstallation(
      "file:///source/packages/npm/@example/mod/dist/index.mjs",
      listing,
      {
        read: (p) =>
          Effect.succeed(
            p === "/source/packages/npm/@example/mod/package.json"
              ? manifest
              : undefined,
          ),
      },
      undefined,
      "/mods",
    ).pipe(Effect.provide(NodePath.layer)),
  );
  expect(result).toMatchObject({ kind: "local" });
});
it("classifies the verified native GitHub package layout without importing private metadata", async () => {
  const gitRoot = "/mods/packages/git/github.com/owner/repo";
  const result = await Effect.runPromise(
    classifyModInstallation(
      `file://${gitRoot}/dist/index.mjs`,
      "Installed packages\n  enabled  git:https://github.com/owner/repo@1.2.3    commands",
      {
        read: (p) =>
          Effect.succeed(
            p === `${gitRoot}/package.json` ? manifest : undefined,
          ),
      },
      undefined,
      "/mods",
    ).pipe(Effect.provide(NodePath.layer)),
  );
  expect(result).toMatchObject({
    kind: "managed",
    source: "git:https://github.com/owner/repo",
    pin: "unknown",
  });
});
