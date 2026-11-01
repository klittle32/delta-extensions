import { Effect } from "effect";
import { expect, it } from "vitest";
import { nodeProcessLayer } from "../../core/src/node.js";
import { runText } from "../src/process.js";
const run = (code: string, options = {}) =>
  Effect.runPromise(
    runText({
      executable: process.execPath,
      args: ["-e", code],
      cwd: process.cwd(),
      ...options,
    }).pipe(Effect.provide(nodeProcessLayer)),
  );
it("drains both pipes and preserves nonzero human output", async () => {
  expect(
    await run('console.log("out");console.error("err");process.exit(3)'),
  ).toEqual({ stdout: "out\n", stderr: "err\n", exitCode: 3 });
});
it("fails on invalid UTF-8 rather than replacing human output", async () => {
  await expect(
    run("process.stdout.write(Buffer.from([255]))"),
  ).rejects.toMatchObject({ kind: "encoding" });
});
it("owns timeout and output budgets", async () => {
  await expect(
    run("setInterval(()=>{},1000)", { timeoutMs: 20 }),
  ).rejects.toMatchObject({ kind: "timeout" });
  await expect(
    run('process.stderr.write("x".repeat(1000))', { maxOutputBytes: 100 }),
  ).rejects.toMatchObject({ kind: "limit" });
});
it("supports explicit stdin with the same concurrent drain ownership", async () => {
  expect(
    (await run("process.stdin.pipe(process.stdout)", { stdin: "input" }))
      .stdout,
  ).toBe("input");
}, 1000);
