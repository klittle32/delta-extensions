import { Effect, Stream } from "effect";
import { start, validateRequest } from "../../core/src/process-session.js";
import {
  TransportError,
  type ProcessRequest,
} from "../../core/src/transport-errors.js";

/** Bounded human output; both pipes drain concurrently in the process scope. */
export const runText = (request: ProcessRequest) =>
  Effect.scoped(
    Effect.gen(function* () {
      const limits = yield* validateRequest(request);
      const process = yield* start(request, limits);
      const chunks: Uint8Array[] = [];
      yield* Stream.runDrain(
        Stream.merge(
          Stream.merge(
            process.input,
            process.stdout.pipe(
              Stream.tap((chunk) =>
                Effect.sync(() => {
                  chunks.push(chunk);
                }),
              ),
            ),
          ),
          process.diagnostics,
        ),
      );
      const exitCode = yield* process.exitCode;
      yield* process.checkInput;
      const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const stdout = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        catch: () =>
          new TransportError({ kind: "encoding", stderr: process.stderr() }),
      });
      return { stdout, stderr: process.stderr(), exitCode };
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: request.timeoutMs ?? 120_000,
      orElse: () =>
        Effect.fail(new TransportError({ kind: "timeout", stderr: "" })),
    }),
  );
