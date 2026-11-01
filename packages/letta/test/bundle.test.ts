import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
const exec = promisify(execFile);
it("bundles and activates from outside the source tree without host or workspace dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "delta-bundle-"));
  try {
    await exec("bun", ["packages/letta/build.mjs", directory]);
    for (const name of ["LICENSE", "NOTICE"]) {
      expect(await readFile(join(directory, name), "utf8")).toBe(
        await readFile(new URL(`../../../${name}`, import.meta.url), "utf8"),
      );
    }
    const require = createRequire(import.meta.url);
    const platformManifest = require.resolve(
      "@effect/platform-node/package.json",
    );
    const packageManifests = [
      require.resolve("effect/package.json"),
      platformManifest,
      createRequire(platformManifest).resolve(
        "@effect/platform-node-shared/package.json",
      ),
    ];
    const notices = await readFile(
      join(directory, "THIRD_PARTY_NOTICES.txt"),
      "utf8",
    );
    for (const manifestPath of packageManifests) {
      const metadata = JSON.parse(await readFile(manifestPath, "utf8"));
      expect(notices).toContain(`${metadata.name}@4.1.1`);
      expect(notices).toContain(
        await readFile(join(dirname(manifestPath), "LICENSE"), "utf8"),
      );
    }
    expect(notices).toContain(
      await readFile(
        join(dirname(packageManifests[0]!), "THIRD_PARTY_NOTICES.md"),
        "utf8",
      ),
    );
    await copyFile(join(directory, "index.mjs"), join(directory, "mod.mjs"));
    await writeFile(
      join(directory, "accept.mjs"),
      `
import activate from './mod.mjs';
const commands = new Map();
const controller = new AbortController();
const dispose = activate({capabilities:{commands:true},signal:controller.signal,commands:{register(command){commands.set(command.id,command);return ()=>commands.delete(command.id)}}});
if (commands.size !== 2) throw Error('registration');
const result = await commands.get('delta-org').run({args:'',cwd:process.cwd()});
if (!result.output.includes('/delta-org')) throw Error('invocation');
dispose();
if(commands.size)throw Error('disposal');
console.log('activated');
`,
    );
    const result = await exec(
      process.execPath,
      [join(directory, "accept.mjs")],
      { cwd: directory },
    );
    expect(result.stdout.trim()).toBe("activated");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
it("declares a native stock Letta package manifest for the bundled mod", async () => {
  const { readFile } = await import("node:fs/promises");
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  expect(manifest.letta).toEqual({
    manifestVersion: 1,
    mods: ["dist/index.mjs"],
    engines: { lettaCodeCli: "0.34.36" },
    capabilities: ["commands"],
  });
});
