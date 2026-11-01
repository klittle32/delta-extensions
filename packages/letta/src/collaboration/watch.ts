// AGPL-3.0-only; participating watch invocation adapted from pinned delta-cli.ts.
import { Effect, Schema, Stream } from "effect";
import { Contract, negotiate } from "../../../core/src/protocol.js";
import { runJson, watchJsonLines } from "../../../core/src/transport.js";
import { decodeWatchEvent } from "../../../core/src/watch-events.js";
/** Participation reconnects with the same durable producer, never a new identity. */
export const watchCollaboration = (options: {
  executable: string;
  cwd: string;
  thread: string;
  externalId: string;
}) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const base = {
        executable: options.executable,
        cwd: options.cwd,
        env: { DELTA_CLI_INTEGRATION: "letta_code" },
      };
      yield* negotiate(
        yield* runJson(
          { ...base, args: ["--json", "thread", "contract"] },
          Contract,
        ),
      );
      return watchJsonLines(
        {
          ...base,
          args: [
            "--json",
            "thread",
            "watch",
            options.thread,
            "--source",
            "letta-code",
            "--external-id",
            options.externalId,
            "--participate",
            "Letta Code",
          ],
          timeoutMs: 86_400_000,
          maxFrameBytes: 16 * 1024 * 1024,
          maxOutputBytes: 256 * 1024 * 1024,
        },
        Schema.Json,
      ).pipe(Stream.mapEffect(decodeWatchEvent));
    }),
  );
