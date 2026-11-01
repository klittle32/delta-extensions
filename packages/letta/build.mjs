import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const destination = resolve(
  process.argv[2] ?? fileURLToPath(new URL("./dist", import.meta.url)),
);
await mkdir(destination, { recursive: true });
const { stdout, stderr } = await promisify(execFile)(process.execPath, [
  "build",
  fileURLToPath(new URL("./src/index.ts", import.meta.url)),
  "--target=node",
  "--format=esm",
  `--outfile=${join(destination, "index.mjs")}`,
]);
process.stdout.write(stdout);
process.stderr.write(stderr);
await Promise.all(
  ["LICENSE", "NOTICE"].map((name) =>
    copyFile(
      new URL(`../../${name}`, import.meta.url),
      join(destination, name),
    ),
  ),
);

// Ship the installed licenses for the packages included in the standalone bundle.
const require = createRequire(import.meta.url);
const platformManifest = require.resolve("@effect/platform-node/package.json");
const manifests = [
  require.resolve("effect/package.json"),
  platformManifest,
  createRequire(platformManifest).resolve(
    "@effect/platform-node-shared/package.json",
  ),
  createRequire(platformManifest).resolve("ws/package.json"),
];
const notices = await Promise.all(
  manifests.map(async (manifestPath) => {
    const metadata = JSON.parse(await readFile(manifestPath, "utf8"));
    const license = await readFile(
      join(dirname(manifestPath), "LICENSE"),
      "utf8",
    );
    let upstreamNotices = "";
    try {
      upstreamNotices = await readFile(
        join(dirname(manifestPath), "THIRD_PARTY_NOTICES.md"),
        "utf8",
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return `${metadata.name}@${metadata.version}\n\n${license}\n${upstreamNotices}`;
  }),
);
await writeFile(
  join(destination, "THIRD_PARTY_NOTICES.txt"),
  notices.join("\n\n"),
);
