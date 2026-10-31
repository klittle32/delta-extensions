import { it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { expect } from "vitest";
import { nodeProcessLayer } from "../src/node.js";
import { runJson, watchJsonLines } from "../src/transport.js";
import {
  collect,
  cwd,
  fixture,
  Message,
  request,
  withNode,
} from "./transport-support.js";

it.live(
  "real child: fragmented UTF8, CRLF, multiple frames and final unterminated line",
  () =>
    withNode(
      Effect.gen(function* () {
        expect(yield* collect("fragments")).toEqual([
          { text: "🙂é" },
          { text: "second" },
          { text: "tail" },
        ]);
      }),
    ),
);
it.live(
  "real child: concurrently drains 4 MiB stderr without deadlocking stdout",
  () =>
    withNode(
      Effect.gen(function* () {
        expect(yield* collect("stderr")).toEqual([{ text: "drained" }]);
        expect(yield* runJson(request("stderr"), Message)).toEqual({
          text: "drained",
        });
      }),
    ),
);
it.live(
  "real child: bounds retained diagnostics and rejects nonzero after valid output",
  () =>
    withNode(
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          runJson({ ...request("nonzero"), maxDiagnosticBytes: 4 }, Message),
        );
        expect(error).toMatchObject({
          _tag: "TransportError",
          kind: "exit",
          exitCode: 7,
          stderr: "tail",
        });
        const streamError = yield* Effect.flip(collect("nonzero"));
        expect(streamError).toMatchObject({
          _tag: "TransportError",
          kind: "exit",
          exitCode: 7,
        });
      }),
    ),
);
for (const mode of ["malformed", "unknown"] as const)
  it.live(`real child: ${mode} output stays a schema failure`, () =>
    withNode(
      Effect.gen(function* () {
        expect(yield* Effect.flip(collect(mode))).toHaveProperty(
          "_tag",
          "SchemaError",
        );
        expect(
          yield* Effect.flip(runJson(request(mode), Message)),
        ).toHaveProperty("_tag", "SchemaError");
      }),
    ),
  );
it.live("real child: invalid UTF8 stays visible", () =>
  withNode(
    Effect.gen(function* () {
      expect(yield* Effect.flip(collect("utf8"))).toMatchObject({
        _tag: "TransportError",
        kind: "encoding",
      });
    }),
  ),
);
it.live("real child: bounds JSONL frames and aggregate output", () =>
  withNode(
    Effect.gen(function* () {
      expect(
        yield* Effect.flip(
          Stream.runDrain(
            watchJsonLines(
              { ...request("frame"), maxFrameBytes: 100 },
              Message,
            ),
          ),
        ),
      ).toMatchObject({ kind: "limit", limit: "frame" });
      expect(
        yield* Effect.flip(
          Stream.runDrain(
            watchJsonLines(
              { ...request("output"), maxOutputBytes: 100 },
              Message,
            ),
          ),
        ),
      ).toMatchObject({ kind: "limit", limit: "output" });
      expect(
        yield* Effect.flip(
          runJson({ ...request("frame"), maxOutputBytes: 100 }, Message),
        ),
      ).toMatchObject({ kind: "limit", limit: "output" });
      expect(
        yield* Effect.flip(
          runJson({ ...request("stderr"), maxOutputBytes: 1000 }, Message),
        ),
      ).toMatchObject({ kind: "limit", limit: "output" });
    }),
  ),
);
it.live(
  "real child: bounded one-shot accepts pretty JSON but rejects multiple documents",
  () =>
    withNode(
      Effect.gen(function* () {
        expect(yield* runJson(request("pretty"), Message)).toEqual({
          text: "🙂",
        });
        expect(
          yield* Effect.flip(runJson(request("fragments"), Message)),
        ).toHaveProperty("_tag", "SchemaError");
      }),
    ),
);
it.live(
  "real child: structured error survives nonzero exit without retries",
  () =>
    withNode(
      Effect.gen(function* () {
        for (const operation of [
          runJson(request("structured"), Message).pipe(Effect.asVoid),
          collect("structured").pipe(Effect.asVoid),
        ]) {
          expect(yield* Effect.flip(operation)).toMatchObject({
            _tag: "DeltaFailure",
            error: {
              code: "reload_required",
              retryable: false,
              retry_after_ms: 123,
              extra: "preserved",
            },
          });
        }
      }),
    ),
);
it.live(
  "real child: argv is literal, cwd explicit, inherited env survives overrides",
  () =>
    withNode(
      Effect.gen(function* () {
        const arg = "$(echo should-not-run); spaced";
        const result = yield* runJson(
          {
            ...request("environment"),
            args: [fixture, "environment", arg],
            env: { DELTA_FIXTURE_EXTRA: "present" },
          },
          Schema.Struct({
            cwd: Schema.String,
            arg: Schema.String,
            path: Schema.Boolean,
            extra: Schema.String,
          }),
        );
        expect(result).toEqual({
          cwd: cwd.replace(/\/$/, ""),
          arg,
          path: true,
          extra: "present",
        });
      }),
    ),
);

it.live("invalid limits and spawn failures are typed", () =>
  withNode(
    Effect.gen(function* () {
      expect(
        yield* Effect.flip(
          runJson({ ...request("one"), maxOutputBytes: 0 }, Message),
        ),
      ).toMatchObject({ kind: "configuration" });
      expect(
        yield* Effect.flip(
          runJson(
            {
              ...request("one"),
              executable: "/nonexistent/delta-core-fixture",
            },
            Message,
          ),
        ),
      ).toMatchObject({ _tag: "TransportError", kind: "io" });
    }),
  ),
);
it.live(
  "real child: preserves valid prefix before malformed UTF8 or oversized next frame",
  () =>
    withNode(
      Effect.gen(function* () {
        for (const mode of ["prefix-utf8", "prefix-frame"]) {
          const seen: unknown[] = [];
          const error = yield* Effect.flip(
            Stream.runDrain(
              watchJsonLines(
                { ...request(mode), maxFrameBytes: 100 },
                Message,
              ).pipe(
                Stream.tap((value) => Effect.sync(() => seen.push(value))),
              ),
            ),
          );
          expect(error).toHaveProperty("_tag", "TransportError");
          expect(seen).toEqual([{ text: "first" }]);
        }
      }),
    ),
);
it.live(
  "real child: watch exposes valid frames before terminal nonzero exit",
  () =>
    withNode(
      Effect.gen(function* () {
        const seen: unknown[] = [];
        const error = yield* Effect.flip(
          Stream.runDrain(
            watchJsonLines(request("nonzero"), Message).pipe(
              Stream.tap((value) => Effect.sync(() => seen.push(value))),
            ),
          ),
        );
        expect(seen).toEqual([{ text: "valid" }]);
        expect(error).toMatchObject({ kind: "exit", exitCode: 7 });
      }),
    ),
);
it.live("real child: stderr retention can be disabled", () =>
  withNode(
    Effect.gen(function* () {
      expect(
        yield* Effect.flip(
          runJson({ ...request("nonzero"), maxDiagnosticBytes: 0 }, Message),
        ),
      ).toMatchObject({ kind: "exit", stderr: "" });
    }),
  ),
);
it.live(
  "injected spawner deterministically fragments real pipe bytes including multibyte UTF8",
  () =>
    Effect.gen(function* () {
      const fragmented = Layer.effect(
        ChildProcessSpawner.ChildProcessSpawner,
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          return ChildProcessSpawner.make((command) =>
            spawner.spawn(command).pipe(
              Effect.map((handle) => ({
                ...handle,
                stdout: handle.stdout.pipe(
                  Stream.flatMap((chunk) =>
                    Stream.fromIterable(chunk, { chunkSize: 1 }),
                  ),
                  Stream.map((byte) => Uint8Array.of(byte)),
                ),
              })),
            ),
          );
        }),
      ).pipe(Layer.provide(nodeProcessLayer));
      expect(
        yield* collect("fragments").pipe(Effect.provide(fragmented)),
      ).toEqual([{ text: "🙂é" }, { text: "second" }, { text: "tail" }]);
    }),
);
it.live(
  "real child: nonzero exit with no JSON preserves exit diagnostics",
  () =>
    withNode(
      Effect.gen(function* () {
        expect(
          yield* Effect.flip(runJson(request("nonzero-empty"), Message)),
        ).toMatchObject({
          _tag: "TransportError",
          kind: "exit",
          exitCode: 9,
          stderr: "no-json",
        });
      }),
    ),
);
