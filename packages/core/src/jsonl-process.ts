// Internal transport materialization; generic public watch behavior stays fail-fast.
import { Effect, Schema, Stream } from "effect";
import { jsonLines } from "./jsonl.js";
import { start, validateRequest } from "./process-session.js";
import { decodeResponse } from "./protocol.js";
import { type ProcessRequest, TransportError } from "./transport-errors.js";

/** Frames can arrive before process exit. Only natural completion proves zero exit. */
export const watchJsonLinesWith = <A, E, R>(
  request: ProcessRequest,
  decodeLine: (line: string) => Effect.Effect<A, E, R>,
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const limits = yield* validateRequest(request);
      return Stream.unwrap(
        Effect.gen(function* () {
          const process = yield* start(request, limits);
          const frames = jsonLines(
            process.stdout,
            limits.maxFrameBytes,
            process.stderr,
          ).pipe(Stream.mapEffect(decodeLine));
          return Stream.merge(
            Stream.merge(frames, process.diagnostics),
            process.input,
          ).pipe(
            Stream.concat(Stream.fromEffectDrain(process.checkExit)),
            Stream.concat(Stream.fromEffectDrain(process.checkInput)),
          );
        }),
      ).pipe(
        Stream.interruptWhen(
          Effect.sleep(limits.timeoutMs).pipe(
            Effect.andThen(
              Effect.fail(new TransportError({ kind: "timeout", stderr: "" })),
            ),
          ),
        ),
      );
    }),
  );

/** Generic decoding remains fail-fast. Specialized append scanning uses only the
 * internal line seam above, with identical framing, budgets and child ownership. */
export const watchDecodedJsonLines = <S extends Schema.Constraint>(
  request: ProcessRequest,
  schema: S,
) =>
  watchJsonLinesWith(request, (line) =>
    Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(line).pipe(
      Effect.flatMap(decodeResponse(schema)),
    ),
  );
