import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  limitsFor,
  type ProcessRequest,
  TransportError,
} from "./transport-errors.js";

/** Each materialization owns a fresh process, budget and diagnostics in its scope. */
export const validateRequest = (request: ProcessRequest) =>
  Effect.gen(function* () {
    const limits = limitsFor(request);
    if (
      !request.executable ||
      !request.cwd ||
      Object.entries(limits).some(
        ([key, value]) =>
          !Number.isSafeInteger(value) ||
          value <
            (key === "maxDiagnosticBytes" || key === "forceKillAfterMs"
              ? 0
              : 1),
      )
    )
      return yield* new TransportError({ kind: "configuration", stderr: "" });
    return limits;
  });
export const start = (
  request: ProcessRequest,
  limits: ReturnType<typeof limitsFor>,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner
      .spawn(
        ChildProcess.make(request.executable, request.args, {
          cwd: request.cwd,
          env: request.env,
          extendEnv: true,
          shell: false,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          killSignal: "SIGTERM",
          forceKillAfter: limits.forceKillAfterMs,
        }),
      )
      .pipe(
        Effect.mapError(() => new TransportError({ kind: "io", stderr: "" })),
      );
    let total = 0;
    let tail = new Uint8Array(0);
    const stderr = () => new TextDecoder().decode(tail);
    const count = (chunk: Uint8Array) =>
      Effect.suspend(() => {
        total += chunk.length;
        return total > limits.maxOutputBytes
          ? Effect.fail(
              new TransportError({
                kind: "limit",
                limit: "output",
                stderr: stderr(),
              }),
            )
          : Effect.void;
      });
    const stdout = handle.stdout.pipe(
      Stream.mapError(
        () => new TransportError({ kind: "io", stderr: stderr() }),
      ),
      Stream.tap(count),
    );
    const diagnostics = handle.stderr.pipe(
      Stream.mapError(
        () => new TransportError({ kind: "io", stderr: stderr() }),
      ),
      Stream.tap((chunk) =>
        Effect.sync(() => {
          const keep = limits.maxDiagnosticBytes;
          if (keep === 0) return;
          // Copy only the retained suffix, never the full stderr history.
          const fromChunk = chunk.subarray(Math.max(0, chunk.length - keep));
          const fromTail = tail.subarray(
            Math.max(0, tail.length - (keep - fromChunk.length)),
          );
          const next = new Uint8Array(fromTail.length + fromChunk.length);
          next.set(fromTail);
          next.set(fromChunk, fromTail.length);
          tail = next;
        }),
      ),
      Stream.tap(count),
      Stream.drain,
    );
    const exitCode = handle.exitCode.pipe(
      Effect.mapError(
        () => new TransportError({ kind: "io", stderr: stderr() }),
      ),
    );
    const checkExit = Effect.flatMap(exitCode, (code) =>
      code === 0
        ? Effect.void
        : Effect.fail(
            new TransportError({
              kind: "exit",
              exitCode: code,
              stderr: stderr(),
            }),
          ),
    );
    return { stdout, diagnostics, stderr, exitCode, checkExit };
  });
