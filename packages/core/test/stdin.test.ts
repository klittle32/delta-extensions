import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { nodeProcessLayer } from "../src/node.js";
import {
  type ProcessRequest,
  runJson,
  watchJsonLines,
} from "../src/transport.js";
import { cwd, Message, Pid, withNode } from "./transport-support.js";
const fixture = fileURLToPath(new URL("./stdin-fixture.mjs", import.meta.url));
const request = (mode: string): ProcessRequest => ({
  executable: process.execPath,
  args: [fixture, mode],
  cwd,
  timeoutMs: 5000,
});
const large = "x".repeat(2 * 1024 * 1024);
const observed = (
  ready: Deferred.Deferred<ChildProcessSpawner.ChildProcessHandle>,
) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(command);
          yield* Deferred.succeed(ready, handle);
          return handle;
        }),
      );
    }),
  ).pipe(Layer.provide(nodeProcessLayer));
const exited = (handle: ChildProcessSpawner.ChildProcessHandle) =>
  Effect.gen(function* () {
    yield* Effect.exit(handle.exitCode);
    expect(yield* handle.isRunning).toBe(false);
    expect(() => process.kill(handle.pid, 0)).toThrow();
  });
for (const stdin of [undefined, "", '{"text":"🙂é"}\r\n{"text":"tail"}'])
  it.live(
    `UTF8 stdin exact bytes: ${stdin === undefined ? "absent" : stdin === "" ? "empty" : "JSONL"}`,
    () =>
      withNode(
        Effect.gen(function* () {
          const input = {
            ...request("echo"),
            ...(stdin === undefined ? {} : { stdin }),
          };
          const expected = { text: Buffer.from(stdin ?? "").toString("hex") };
          expect(yield* runJson(input, Message)).toEqual(expected);
          expect(
            yield* Stream.runCollect(watchJsonLines(input, Message)),
          ).toEqual([expected]);
        }),
      ),
  );
it.effect(
  "invalid/oversized input is rejected before spawn in both operations",
  () =>
    Effect.gen(function* () {
      let spawned = 0;
      const layer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => {
          spawned++;
          return Effect.die("must not spawn");
        }),
      );
      for (const options of [
        { stdin: "é", maxInputBytes: 1 },
        { stdin: "x".repeat(16 * 1024 * 1024 + 1) },
        { stdin: "x", maxInputBytes: -1 },
        { stdin: "", maxInputBytes: 1.5 },
        { stdin: "", maxInputBytes: Infinity },
        { stdin: "\ud800" },
        { stdin: "\udc00" },
        { stdin: "a\ud800b" },
        { stdin: "a\udc00b" },
      ])
        for (const mode of ["run", "watch"]) {
          const input = { ...request("echo"), ...options };
          const operation =
            mode === "run"
              ? runJson(input, Message).pipe(Effect.asVoid)
              : Stream.runDrain(watchJsonLines(input, Message));
          expect(
            yield* Effect.flip(operation.pipe(Effect.provide(layer))),
          ).toHaveProperty("_tag", "TransportError");
        }
      expect(spawned).toBe(0);
    }),
);
it.live(
  "duplex pressure drains stdout/stderr while writing backpressured stdin",
  () =>
    withNode(
      Effect.gen(function* () {
        const input = {
          ...request("duplex"),
          stdin: large,
          maxOutputBytes: 10 * 1024 * 1024,
        };
        const expected = { text: Buffer.from(large).toString("hex") };
        expect(yield* runJson(input, Message)).toEqual(expected);
        expect(
          yield* Stream.runCollect(watchJsonLines(input, Message)),
        ).toEqual([expected]);
      }),
    ),
);
for (const mode of ["early", "early-nonzero", "early-structured"])
  it.live(`early stdin close remains visible: ${mode}`, () =>
    withNode(
      Effect.gen(function* () {
        const input = { ...request(mode), stdin: large };
        const error = yield* Effect.flip(runJson(input, Message));
        expect(error).toHaveProperty(
          mode === "early-structured" ? "_tag" : "kind",
          mode === "early-structured"
            ? "DeltaFailure"
            : mode === "early"
              ? "input"
              : "exit",
        );
        const seen: string[] = [];
        const streamError = yield* Effect.flip(
          Stream.runDrain(
            watchJsonLines(input, Message).pipe(
              Stream.tap((row) =>
                Effect.sync(() => {
                  seen.push(row.text);
                }),
              ),
            ),
          ),
        );
        expect(seen).toEqual(mode === "early-structured" ? [] : ["prefix"]);
        expect(streamError).toHaveProperty(
          mode === "early-structured" ? "_tag" : "kind",
          mode === "early-structured"
            ? "DeltaFailure"
            : mode === "early"
              ? "input"
              : "exit",
        );
      }),
    ),
  );
it.effect(
  "blocked input shares total TestClock deadline and proves child exit",
  () =>
    Effect.gen(function* () {
      const ready =
        yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
      const first = yield* Deferred.make<void>();
      const task = yield* Effect.flip(
        Stream.runDrain(
          watchJsonLines(
            { ...request("blocked"), stdin: large, timeoutMs: 1000 },
            Pid,
          ).pipe(
            Stream.tap(() => Deferred.succeed(first, undefined)),
            Stream.provide(observed(ready)),
          ),
        ),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(first);
      yield* TestClock.adjust(1000);
      expect(yield* Fiber.join(task)).toHaveProperty("kind", "timeout");
      yield* exited(yield* Deferred.await(ready));
    }),
);
for (const action of ["interrupt", "take"])
  it.live(`blocked writer cleanup on stream ${action}`, () =>
    Effect.gen(function* () {
      const ready =
        yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
      const first = yield* Deferred.make<void>();
      const stream = watchJsonLines(
        { ...request("blocked"), stdin: large },
        Pid,
      ).pipe(
        Stream.tap(() => Deferred.succeed(first, undefined)),
        Stream.provide(observed(ready)),
      );
      if (action === "take")
        expect(
          yield* Stream.runCollect(stream.pipe(Stream.take(1))),
        ).toHaveLength(1);
      else {
        const task = yield* Stream.runDrain(stream).pipe(Effect.forkChild);
        yield* Deferred.await(first);
        yield* Fiber.interrupt(task);
      }
      yield* exited(yield* Deferred.await(ready));
    }),
  );

it.live(
  "JSONL preserves prefix before structured error during failed input",
  () =>
    withNode(
      Effect.gen(function* () {
        const seen: string[] = [];
        const error = yield* Effect.flip(
          Stream.runDrain(
            watchJsonLines(
              { ...request("early-structured-prefix"), stdin: large },
              Message,
            ).pipe(
              Stream.tap((row) =>
                Effect.sync(() => {
                  seen.push(row.text);
                }),
              ),
            ),
          ),
        );
        expect(seen).toEqual(["prefix"]);
        expect(error).toMatchObject({
          _tag: "DeltaFailure",
          error: { code: "reload_required" },
        });
      }),
    ),
);
it.live("one-shot blocked input deadline finalizes direct child", () =>
  Effect.gen(function* () {
    const ready =
      yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
    const error = yield* Effect.flip(
      runJson(
        { ...request("blocked"), stdin: large, timeoutMs: 300 },
        Pid,
      ).pipe(Effect.provide(observed(ready))),
    );
    expect(error).toHaveProperty("kind", "timeout");
    yield* exited(yield* Deferred.await(ready));
  }),
);
it.live("zero input budget permits explicit EOF", () =>
  withNode(
    Effect.gen(function* () {
      expect(
        yield* runJson(
          { ...request("echo"), stdin: "", maxInputBytes: 0 },
          Message,
        ),
      ).toEqual({ text: "" });
    }),
  ),
);
