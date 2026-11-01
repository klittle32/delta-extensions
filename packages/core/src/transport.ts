import { Effect, Schema, Stream } from "effect";
import { watchDecodedJsonLines } from "./jsonl-process.js";
import { start, validateRequest } from "./process-session.js";
import { decodeResponse } from "./protocol.js";
import { type ProcessRequest, TransportError } from "./transport-errors.js";

export { type ProcessRequest, TransportError } from "./transport-errors.js";

/** Whole JSON document, bounded collection; success requires a proven zero exit. */
export const runJson = <S extends Schema.Constraint>(
  request: ProcessRequest,
  schema: S,
) =>
  Effect.gen(function* () {
    const limits = yield* validateRequest(request);
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const process = yield* start(request, limits);
        const chunks = yield* Stream.runCollect(
          Stream.merge(
            Stream.merge(process.stdout, process.diagnostics),
            process.input,
          ),
        );
        const code = yield* process.exitCode;
        const size = chunks.reduce((n, chunk) => n + chunk.length, 0);
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        const decode = Effect.gen(function* () {
          const text = yield* Effect.try({
            try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            catch: () =>
              new TransportError({
                kind: "encoding",
                stderr: process.stderr(),
              }),
          });
          const payload = yield* Schema.decodeEffect(
            Schema.fromJsonString(Schema.Unknown),
          )(text);
          // A valid structured CLI failure wins over its nonzero exit code.
          return yield* decodeResponse(schema)(payload);
        });
        const value = yield* decode.pipe(
          Effect.catchIf(
            (error) => code !== 0 && error._tag !== "DeltaFailure",
            () =>
              Effect.fail(
                new TransportError({
                  kind: "exit",
                  exitCode: code,
                  stderr: process.stderr(),
                }),
              ),
          ),
        );
        if (code !== 0)
          return yield* new TransportError({
            kind: "exit",
            exitCode: code,
            stderr: process.stderr(),
          });
        yield* process.checkInput;
        return value;
      }).pipe(
        Effect.timeoutOrElse({
          duration: limits.timeoutMs,
          orElse: () =>
            Effect.fail(new TransportError({ kind: "timeout", stderr: "" })),
        }),
      ),
    );
  });
/** Frames can arrive before process exit. Only natural completion proves zero exit. */
export const watchJsonLines = <S extends Schema.Constraint>(
  request: ProcessRequest,
  schema: S,
) => watchDecodedJsonLines(request, schema);
