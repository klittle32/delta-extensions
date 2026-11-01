import { Effect, Schema, Stream } from "effect";
import { start, validateRequest } from "../../../core/src/process-session.js";
import {
  TransportError,
  type ProcessRequest,
} from "../../../core/src/transport-errors.js";
const Progress = Schema.Union([
  Schema.Struct({
    schema_version: Schema.Literal(1),
    type: Schema.Literal("progress"),
    phase: Schema.Literals([
      "checking",
      "downloading",
      "preparing",
      "installing",
    ]),
    version: Schema.optional(Schema.NonEmptyString),
    percent: Schema.optional(
      Schema.Number.check(
        Schema.isInt(),
        Schema.isGreaterThanOrEqualTo(0),
        Schema.isLessThanOrEqualTo(100),
      ),
    ),
  }),
  Schema.Struct({
    schema_version: Schema.Literal(1),
    type: Schema.Literal("action_required"),
    action: Schema.NonEmptyString,
    message: Schema.NonEmptyString,
  }),
]);
export const progressMessage = (line: string) =>
  Schema.decodeEffect(Schema.fromJsonString(Progress))(line).pipe(
    Effect.match({
      onFailure: () => undefined,
      onSuccess: (value) =>
        value.type === "action_required"
          ? value.message
          : `Delta: ${value.phase}${value.percent === undefined ? "" : ` ${value.percent}%`}${value.version ? ` (${value.version})` : ""}`,
    }),
  );
/** Same bounded scoped transport as runText, with validated progress-only diagnostics. */
export const runProgress = (
  request: ProcessRequest,
  report: (message: string) => void,
  installer = false,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const limits = yield* validateRequest(request);
      const process = yield* start(request, limits);
      const chunks: Uint8Array[] = [];
      const decoder = new TextDecoder();
      let pending = "";
      const consume = (text: string) =>
        Effect.gen(function* () {
          pending += text;
          const lines = pending.split(/\r?\n/);
          pending = lines.pop() ?? "";
          for (const line of lines) {
            const message = yield* progressMessage(line);
            if (message) report(message);
          }
        });
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
          process.diagnostics.pipe(
            Stream.tap((chunk) =>
              consume(decoder.decode(chunk, { stream: true })),
            ),
          ),
        ),
      );
      yield* consume(`${decoder.decode()}\n`);
      const exitCode = yield* process.exitCode;
      yield* process.checkInput;
      const size = chunks.reduce((n, chunk) => n + chunk.length, 0);
      const bytes = new Uint8Array(size);
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
  ).pipe((effect) =>
    installer
      ? effect
      : effect.pipe(
          Effect.timeoutOrElse({
            duration: request.timeoutMs ?? 600_000,
            orElse: () =>
              Effect.fail(new TransportError({ kind: "timeout", stderr: "" })),
          }),
        ),
  );
