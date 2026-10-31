import { Effect, Stream } from "effect";
import { TransportError } from "./transport-errors.js";

function* pieces(chunk: Uint8Array) {
  let start = 0;
  for (let i = 0; i < chunk.length; i++)
    if (chunk[i] === 10) {
      yield { bytes: chunk.subarray(start, i), end: true };
      start = i + 1;
    }
  if (start < chunk.length) yield { bytes: chunk.subarray(start), end: false };
}
/** Byte framing avoids splitting UTF8 and bounds an unfinished line before decoding. */
export const jsonLines = <E, R>(
  input: Stream.Stream<Uint8Array, E, R>,
  maxBytes: number,
  stderr: () => string,
) =>
  Stream.unwrap(
    Effect.sync(() => {
      let buffer = new Uint8Array(Math.min(4096, maxBytes));
      let length = 0;
      const decode = () => {
        try {
          const text = new TextDecoder("utf-8", { fatal: true })
            .decode(buffer.subarray(0, length))
            .replace(/\r$/, "");
          length = 0;
          return text;
        } catch {
          throw new TransportError({ kind: "encoding", stderr: stderr() });
        }
      };
      const append = (part: Uint8Array) => {
        const needed = length + part.length;
        if (needed > maxBytes)
          throw new TransportError({
            kind: "limit",
            limit: "frame",
            stderr: stderr(),
          });
        if (needed > buffer.length) {
          const next = new Uint8Array(
            Math.min(maxBytes, Math.max(needed, buffer.length * 2)),
          );
          next.set(buffer.subarray(0, length));
          buffer = next;
        }
        buffer.set(part, length);
        length = needed;
      };
      const frames = input.pipe(
        Stream.flatMap((chunk) =>
          Stream.fromIterable(pieces(chunk), { chunkSize: 1 }),
        ),
        Stream.mapEffect((part) =>
          Effect.try({
            try: () => {
              append(part.bytes);
              return part.end ? [decode()] : [];
            },
            catch: (error) =>
              error instanceof TransportError
                ? error
                : new TransportError({ kind: "encoding", stderr: stderr() }),
          }),
        ),
        Stream.flatMap(Stream.fromIterable),
      );
      return frames.pipe(
        Stream.concat(
          Stream.unwrap(
            Effect.try({
              try: () => (length ? Stream.make(decode()) : Stream.empty),
              catch: () =>
                new TransportError({ kind: "encoding", stderr: stderr() }),
            }),
          ),
        ),
      );
    }),
  );
