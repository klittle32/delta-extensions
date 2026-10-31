import { Schema } from "effect";

/** Contains bounded stderr only; never includes argv, environment or stdout. */
export class TransportError extends Schema.TaggedError<
  TransportError,
  { readonly brand: unique symbol }
>()("TransportError", {
  kind: Schema.Literals([
    "configuration",
    "limit",
    "encoding",
    "io",
    "exit",
    "timeout",
  ]),
  stderr: Schema.String,
  limit: Schema.optionalKey(Schema.Literals(["frame", "output"])),
  exitCode: Schema.optionalKey(Schema.Finite),
}) {}
export interface ProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Overrides are merged with inherited environment; undefined removes a key. */
  readonly env?: Record<string, string | undefined>;
  /** Total operation lifetime (not an idle/read timeout). Default 120 seconds. */
  readonly timeoutMs?: number;
  /** Total bytes across stdout AND stderr. Default 16 MiB, including watches. */
  readonly maxOutputBytes?: number;
  /** Per JSONL line, before removing CR. Default 16 MiB. */
  readonly maxFrameBytes?: number;
  /** Retained stderr suffix in bytes. Default 4096. Zero disables retention. */
  readonly maxDiagnosticBytes?: number;
  /** SIGTERM grace before the platform escalates to SIGKILL. Default 250ms. */
  readonly forceKillAfterMs?: number;
}
export const limitsFor = (request: ProcessRequest) => ({
  timeoutMs: request.timeoutMs ?? 120_000,
  maxOutputBytes: request.maxOutputBytes ?? 16 * 1024 * 1024,
  maxFrameBytes: request.maxFrameBytes ?? 16 * 1024 * 1024,
  maxDiagnosticBytes: request.maxDiagnosticBytes ?? 4096,
  forceKillAfterMs: request.forceKillAfterMs ?? 250,
});
