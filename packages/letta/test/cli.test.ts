import { mkdtemp, writeFile, chmod, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import activate, { type CommandRegistration } from "../src/index.js";
let directory: string;
let commands: Map<string, CommandRegistration>;
let dispose: () => void;
let controller: AbortController;
let originalPath: string | undefined;
let originalHome: string | undefined;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "delta-mod-"));
  originalPath = process.env.PATH;
  originalHome = process.env.HOME;
  process.env.PATH = directory;
  process.env.HOME = directory;
  commands = new Map();
  controller = new AbortController();
  dispose = activate({
    capabilities: { commands: true },
    signal: controller.signal,
    commands: {
      register(command) {
        commands.set(command.id, command);
        return () => {
          commands.delete(command.id);
        };
      },
    },
  });
});
afterEach(async () => {
  dispose();
  process.env.PATH = originalPath;
  process.env.HOME = originalHome;
  await rm(directory, { recursive: true, force: true });
});
async function cli(body: string) {
  const file = join(directory, "delta");
  await writeFile(file, `#!${process.execPath}\n${body}\n`);
  await chmod(file, 0o755);
}
const run = async (args: string, id = "delta-org", cwd = directory) => {
  const result = await commands.get(id)!.run({ args, cwd });
  if (result.type !== "output")
    throw new Error("Organization commands must return their bounded output.");
  return result;
};
it("has no eager discovery and reports missing CLI without side effects", async () => {
  expect((await run("list")).output).toContain("CLI is missing");
});
it.each([
  ["list", ["org", "list"]],
  ["current", ["org", "current"]],
  ["switch --hostile", ["org", "switch", "--", "--hostile"]],
  ["invite a@b c@d a@b", ["org", "invite", "--", "a@b", "c@d"]],
])(
  "uses literal argv, cwd and integration env for %s",
  async (args, expected) => {
    await cli(
      "console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),integration:process.env.DELTA_CLI_INTEGRATION}))",
    );
    const result = await run(args);
    expect(JSON.parse(result.output)).toEqual({
      args: expected,
      cwd: directory,
      integration: "letta_code",
    });
    expect(await run(`org ${args}`, "delta")).toEqual(result);
  },
);
it("preserves individual invitation outcomes and never retries failed mutations", async () => {
  await cli('console.log("a@b invited\\nc@d failed: no permission");');
  expect((await run("invite a@b c@d")).output).toBe(
    "a@b invited\nc@d failed: no permission",
  );
  await cli(
    'require("node:fs").appendFileSync("attempts", "x"); console.error("a@b invited; c@d rejected"); process.exit(1)',
  );
  expect((await run("invite a@b c@d")).output).toContain(
    "a@b invited; c@d rejected",
  );
  expect(await readFile(join(directory, "attempts"), "utf8")).toBe("x");
});
it("manage requests JSON and gives a link without claiming browser opening", async () => {
  await cli(
    'if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(["--json","org","list"]))process.exit(1);console.log(JSON.stringify({organizations:[{id:"org-1",name:"Team",current:true}]}))',
  );
  expect((await run("manage")).output).toBe(
    "Manage Team's members here: https://dashboard.zed.dev/org-1/members",
  );
});
it.each([
  "{}",
  '{"organizations":[{"id":"x","name":"T"}]}',
  '{"organizations":',
  '{"error":{"message":"Denied"}}',
])("rejects malformed or partial manage output %s", async (output) => {
  await cli(`console.log(${JSON.stringify(output)})`);
  expect((await run("manage")).output).toContain("failed");
});
it("returns dashboard when no organization is selected", async () => {
  await cli("console.log(JSON.stringify({organizations:[]}))");
  expect((await run("manage")).output).toContain("no team selected");
});
it("uses per invocation cwd rather than activation cwd", async () => {
  await cli("console.log(process.cwd())");
  expect((await run("current", "delta-org", tmpdir())).output).toBe(tmpdir());
});
it("cancels real children on host abort and settles retained command handles", async () => {
  await cli(
    'require("node:fs").writeFileSync("started",String(process.pid));setInterval(()=>{},1000)',
  );
  const retained = commands.get("delta-org")!;
  const pending = run("current");
  let pid = 0;
  for (let i = 0; i < 200; i++) {
    try {
      pid = Number(await readFile(join(directory, "started"), "utf8"));
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  expect(pid).toBeGreaterThan(0);
  controller.abort();
  expect(await pending).toMatchObject({ success: false });
  expect(() => process.kill(pid, 0)).toThrow();
  expect(await retained.run({ args: "current", cwd: directory })).toMatchObject(
    { success: false },
  );
  expect(commands.size).toBe(0);
}, 5000);
it("fails closed on bounded output", async () => {
  await cli('process.stdout.write("x".repeat(5*1024*1024))');
  expect((await run("list")).output).toContain("failed");
});
it("preserves structured manage error messages", async () => {
  await cli(
    'console.log(JSON.stringify({error:{code:"permission_denied",message:"Membership denied"}}))',
  );
  expect((await run("manage")).output).toContain("Membership denied");
});
it("discovers the pinned Linux standard location without PATH", async () => {
  if (process.platform !== "linux") return;
  const { mkdir, rename } = await import("node:fs/promises");
  await cli('console.log("standard location")');
  await mkdir(join(directory, ".local/delta.app/bin"), { recursive: true });
  await rename(
    join(directory, "delta"),
    join(directory, ".local/delta.app/bin/delta"),
  );
  expect((await run("current")).output).toBe("standard location");
});
it("settles cancellation during synchronous disposal and permits a fresh activation", async () => {
  await cli(
    'require("node:fs").writeFileSync("started",String(process.pid));process.on("SIGTERM",()=>setTimeout(()=>process.exit(0),30));setInterval(()=>{},1000)',
  );
  const pending = run("list");
  let pid = 0;
  for (let i = 0; i < 200; i++) {
    try {
      pid = Number(await readFile(join(directory, "started"), "utf8"));
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  expect(pid).toBeGreaterThan(0);
  expect(dispose()).toBeUndefined();
  expect(commands.size).toBe(0);
  expect(await pending).toMatchObject({ success: false });
  expect(() => process.kill(pid, 0)).toThrow();
  const next = activate({
    capabilities: { commands: true },
    signal: new AbortController().signal,
    commands: {
      register(command) {
        commands.set(command.id, command);
        return () => {
          commands.delete(command.id);
        };
      },
    },
  });
  try {
    expect((await run("")).output).toContain("/delta-org");
  } finally {
    next();
  }
});
it("prefers a recognized manage error over nonzero exit and raw JSON", async () => {
  await cli(
    'console.log(JSON.stringify({error:{code:"denied",message:"Team access denied"}}));process.exit(1)',
  );
  const result = await run("manage");
  expect(result.success).toBe(false);
  expect(result.output).toContain("Team access denied");
  expect(result.output).not.toContain('{"error"');
});
it("skips a delta directory in an earlier PATH entry", async () => {
  const { mkdir, rename } = await import("node:fs/promises");
  const { delimiter } = await import("node:path");
  await cli('console.log("later executable")');
  const first = join(directory, "first");
  const second = join(directory, "second");
  await mkdir(join(first, "delta"), { recursive: true });
  await mkdir(second);
  await rename(join(directory, "delta"), join(second, "delta"));
  process.env.PATH = [first, second].join(delimiter);
  expect((await run("current")).output).toBe("later executable");
});
