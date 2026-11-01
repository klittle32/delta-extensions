// AGPL-3.0-only; pinned readonly thread-watch invocation: NOTICE, docs/core.md.
import { Effect, Schema, Stream } from "effect";
import { Contract, negotiate } from "./protocol.js";
import { type ProcessRequest, runJson, TransportError } from "./transport.js";
import { watchJsonLinesWith } from "./jsonl-process.js";
import { decodeWatchEvent } from "./watch-events.js";
const id = Schema.String.check(Schema.isMinLength(1));
export const WatchBinding = Schema.Struct({
  reference: id,
  source: id,
  externalId: id,
});
export interface WatchOptions {
  readonly executable: string;
  readonly cwd: string;
  /** Caller-established locator/producer binding; this leaf does not validate frontier ownership. */
  readonly binding: typeof WatchBinding.Type;
  readonly transport?: Pick<
    ProcessRequest,
    | "env"
    | "timeoutMs"
    | "maxOutputBytes"
    | "maxFrameBytes"
    | "maxDiagnosticBytes"
    | "forceKillAfterMs"
  >;
}
/** Finite readonly materialization, not a reconnecting watcher. No --participate or stdin. */
export const watchThread = (options: WatchOptions) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const binding = yield* Schema.decodeEffect(WatchBinding)(
        options.binding,
      ).pipe(
        Effect.mapError(
          () => new TransportError({ kind: "configuration", stderr: "" }),
        ),
      );
      const {
        env,
        timeoutMs,
        maxOutputBytes,
        maxFrameBytes,
        maxDiagnosticBytes,
        forceKillAfterMs,
      } = options.transport ?? {};
      // Whitelist runtime options too: an accidentally supplied wider request must
      // not inject stdin/argv or enable participation on this readonly operation.
      const base = {
        executable: options.executable,
        cwd: options.cwd,
        ...(env === undefined ? {} : { env }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
        ...(maxFrameBytes === undefined ? {} : { maxFrameBytes }),
        ...(maxDiagnosticBytes === undefined ? {} : { maxDiagnosticBytes }),
        ...(forceKillAfterMs === undefined ? {} : { forceKillAfterMs }),
      };
      yield* negotiate(
        yield* runJson(
          { ...base, args: ["--json", "thread", "contract"] },
          Contract,
        ),
      );
      return watchJsonLinesWith(
        {
          ...base,
          args: [
            "--json",
            "thread",
            "watch",
            binding.reference,
            "--source",
            binding.source,
            "--external-id",
            binding.externalId,
          ],
        },
        (line) =>
          Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(line).pipe(
            Effect.flatMap(decodeWatchEvent),
          ),
      );
    }),
  );
