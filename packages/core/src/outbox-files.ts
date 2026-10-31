import { ByteSize, Effect, FileSystem, Option, Path, Schema } from "effect";
import { Digest } from "effect/crypto";
import {
  Head,
  type Identity,
  OutboxError,
  Transaction,
} from "./outbox-model.js";

const storage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError(() => new OutboxError({ kind: "storage" })));
export const makeFiles = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const digest = yield* Digest.Digest;
    const hash = (text: string) =>
      digest.digestHex(Digest.sha256, new TextEncoder().encode(text));
    const syncDirectory = (directory = root) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* fs.open(directory, {
            flag: "r",
            noFollow: true,
          });
          yield* handle.sync;
        }),
      );
    const write = (name: string, text: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(path.join(root, name), {
            flag: "wx",
            mode: 0o600,
            noFollow: true,
          });
          yield* file.writeAll(new TextEncoder().encode(text));
          yield* file.sync;
        }),
      );
    const read = (name: string, max = 64 * 1024 * 1024) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* fs.open(path.join(root, name), {
            flag: "r",
            noFollow: true,
          });
          const info = yield* handle.stat;
          if (
            info.type !== "File" ||
            (info.mode & 0o077) !== 0 ||
            ByteSize.toBigInt(info.size) > BigInt(max)
          )
            return yield* new OutboxError({ kind: "corrupt" });
          const chunks: Uint8Array[] = [];
          let size = 0;
          while (true) {
            const next = yield* handle.readAlloc(65536);
            if (Option.isNone(next)) break;
            size += next.value.length;
            if (size > max) return yield* new OutboxError({ kind: "corrupt" });
            chunks.push(next.value);
          }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          return yield* Effect.try({
            try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            catch: () => new OutboxError({ kind: "corrupt" }),
          });
        }),
      );
    const parse = <S extends Schema.Constraint>(schema: S, text: string) =>
      Effect.gen(function* () {
        const value = yield* Schema.decodeEffect(Schema.fromJsonString(schema))(
          text,
          { onExcessProperty: "error" },
        );
        if (JSON.stringify(value) + "\n" !== text)
          return yield* new OutboxError({ kind: "corrupt" });
        return value;
      }).pipe(Effect.mapError(() => new OutboxError({ kind: "corrupt" })));
    const load = () =>
      Effect.gen(function* () {
        const head = yield* parse(Head, yield* read("head.json", 65536));
        const names = (yield* fs.readDirectory(root)).filter(
          (name) => name !== ".writer" && name !== "head.json",
        );
        if (
          names.length !== head.transaction ||
          names.some((name) => !/^([1-9][0-9]*)\.json$/.test(name))
        )
          return yield* new OutboxError({ kind: "corrupt" });
        let previous = yield* hash(JSON.stringify(head.identity));
        const transactions: (typeof Transaction.Type)[] = [];
        for (let i = 1; i <= head.transaction; i++) {
          const text = yield* read(`${i}.json`);
          const txn = yield* parse(Transaction, text);
          if (txn.index !== i || txn.previous !== previous)
            return yield* new OutboxError({ kind: "corrupt" });
          transactions.push(txn);
          previous = yield* hash(text);
        }
        if (previous !== head.digest)
          return yield* new OutboxError({ kind: "corrupt" });
        return { head, transactions };
      }).pipe(
        Effect.mapError((error) =>
          error instanceof OutboxError
            ? error
            : new OutboxError({ kind: "corrupt" }),
        ),
      );
    const initialize = (identity: Identity) =>
      Effect.gen(function* () {
        const head = {
          format: 1 as const,
          identity,
          transaction: 0,
          digest: yield* hash(JSON.stringify(identity)),
        };
        yield* write("head.json", JSON.stringify(head) + "\n");
        yield* syncDirectory();
        yield* syncDirectory(path.dirname(root));
        return head;
      });
    const commit = (
      head: typeof Head.Type,
      event: typeof Transaction.Type.event,
    ) =>
      Effect.gen(function* () {
        if (head.transaction >= Number.MAX_SAFE_INTEGER)
          return yield* new OutboxError({ kind: "sequence" });
        const index = head.transaction + 1;
        const text =
          JSON.stringify({ format: 1, index, previous: head.digest, event }) +
          "\n";
        if (new TextEncoder().encode(text).length > 64 * 1024 * 1024)
          return yield* new OutboxError({ kind: "input" });
        yield* write(`${index}.json`, text);
        yield* syncDirectory();
        const next = { ...head, transaction: index, digest: yield* hash(text) };
        yield* write("head.next", JSON.stringify(next) + "\n");
        yield* fs.rename(
          path.join(root, "head.next"),
          path.join(root, "head.json"),
        );
        yield* syncDirectory();
        return next;
      });
    return {
      fs,
      path,
      hash,
      syncDirectory,
      load,
      initialize,
      commit: (head: typeof Head.Type, event: typeof Transaction.Type.event) =>
        storage(commit(head, event)),
    };
  });
