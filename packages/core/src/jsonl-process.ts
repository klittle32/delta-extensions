// Internal transport materialization; generic public watch behavior stays fail-fast.
import { Effect, Schema, Stream } from "effect";
import { jsonLines } from "./jsonl.js";
import { start, validateRequest } from "./process-session.js";
import { decodeResponse, DeltaFailure } from "./protocol.js";
import { type ProcessRequest, TransportError } from "./transport-errors.js";

/** Frames can arrive before process exit. Only natural completion proves zero exit. */
export const watchJsonLinesObserved = <S extends Schema.Constraint>(
  request: ProcessRequest,
  schema: S,
  onDecodedFailure?: (failure: DeltaFailure) => Effect.Effect<void>,
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
          ).pipe(
            Stream.mapEffect((line) => {
              const decode = Schema.decodeEffect(
                Schema.fromJsonString(Schema.Unknown),
              )(line).pipe(Effect.flatMap(decodeResponse(schema)));
              if (!onDecodedFailure) return decode;
              // This runs INSIDE the process Scope, before failed decoding can
              // start teardown. Mask decode + observation together so cancellation
              // cannot separate a decoded reload from its durable pause attempt.
              return Effect.uninterruptible(
                decode.pipe(
                  Effect.tapError((failure) =>
                    failure instanceof DeltaFailure
                      ? onDecodedFailure(failure)
                      : Effect.void,
                  ),
                ),
              );
            }),
          );
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
