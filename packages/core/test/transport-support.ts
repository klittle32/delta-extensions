import { fileURLToPath } from "node:url";
import { Effect, Schema, Stream } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { nodeProcessLayer } from "../src/node.js";
import { watchJsonLines } from "../src/transport.js";
export const fixture = fileURLToPath(
  new URL("./process-fixture.mjs", import.meta.url),
);
export const cwd = fileURLToPath(new URL("../../../", import.meta.url));
export const request = (mode: string) => ({
  executable: process.execPath,
  args: [fixture, mode],
  cwd,
  timeoutMs: 5000,
});
export const Message = Schema.Struct({ text: Schema.String });
export const Pid = Schema.Struct({ pid: Schema.Finite });
export const collect = (mode: string) =>
  Stream.runCollect(watchJsonLines(request(mode), Message));
export const withNode = <A, E, R>(
  effect: Effect.Effect<A, E, R | ChildProcessSpawner.ChildProcessSpawner>,
) => effect.pipe(Effect.provide(nodeProcessLayer));
