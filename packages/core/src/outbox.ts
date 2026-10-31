import {
  Cause,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Semaphore,
} from "effect";
import { makeFiles } from "./outbox-files.js";
import {
  applyEvent,
  Identity,
  initialState,
  OutboxError,
} from "./outbox-model.js";
import { makeOperations } from "./outbox-operations.js";

export {
  type Identity,
  OutboxError,
} from "./outbox-model.js";
export interface OutboxOptions {
  readonly root: string;
  readonly identity: Identity;
  readonly mode: "create" | "reopen";
}
export const openOutbox = (options: OutboxOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const decodedIdentity = yield* Schema.decodeEffect(Identity)(
      options.identity,
    ).pipe(Effect.mapError(() => new OutboxError({ kind: "configuration" })));
    const identity = { ...decodedIdentity };
    // Reserve room for the checkpoint envelope under the 64 KiB read bound.
    if (new TextEncoder().encode(JSON.stringify(identity)).length > 32768)
      return yield* new OutboxError({ kind: "configuration" });
    if (
      (options.mode !== "create" && options.mode !== "reopen") ||
      !path.isAbsolute(options.root)
    )
      return yield* new OutboxError({ kind: "configuration" });
    const parent = yield* fs.realPath(path.dirname(options.root));
    const root = path.join(parent, path.basename(options.root));
    if (options.mode === "create")
      yield* fs.makeDirectory(root, { mode: 0o700 });
    const info = yield* fs.lstat(root);
    if (info.type !== "Directory" || (info.mode & 0o077) !== 0)
      return yield* new OutboxError({ kind: "configuration" });
    const files = yield* makeFiles(root);
    const lock = path.join(root, ".writer");
    const gate = yield* Semaphore.make(1);
    let closed = false;
    let poisoned = false;
    const sameLock = (
      owner: FileSystem.File.Info,
      current: FileSystem.File.Info,
    ) =>
      current.type === "Directory" &&
      current.dev === owner.dev &&
      Option.isSome(owner.ino) &&
      Option.isSome(current.ino) &&
      owner.ino.value === current.ino.value;
    const lockInfo = yield* Effect.acquireRelease(
      fs.makeDirectory(lock, { mode: 0o700 }).pipe(
        Effect.andThen(fs.lstat(lock)),
        Effect.mapError(() => new OutboxError({ kind: "locked" })),
      ),
      (owner) =>
        poisoned
          ? Effect.void
          : fs.lstat(lock).pipe(
              Effect.flatMap((current) =>
                sameLock(owner, current)
                  ? fs.readDirectory(lock)
                  : Effect.die(new OutboxError({ kind: "corrupt" })),
              ),
              Effect.flatMap((names) =>
                names.length
                  ? Effect.die(new OutboxError({ kind: "corrupt" }))
                  : fs.remove(lock, { recursive: true }),
              ),
              Effect.andThen(files.syncDirectory()),
              Effect.orDie,
            ),
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true;
      }).pipe(Effect.andThen(gate.withPermits(1)(Effect.void))),
    );
    yield* files.syncDirectory();
    const loaded = options.mode === "reopen" ? yield* files.load() : null;
    let head = loaded?.head ?? (yield* files.initialize(identity));
    if (JSON.stringify(head.identity) !== JSON.stringify(identity))
      return yield* new OutboxError({ kind: "identity" });
    const state = initialState();
    if (loaded)
      for (const txn of loaded.transactions) {
        if (
          txn.event.type === "receipt" &&
          txn.event.receipt.thread_id !== identity.threadId
        )
          return yield* new OutboxError({ kind: "corrupt" });
        yield* applyEvent(state, txn.event);
      }
    const guard = () =>
      Effect.gen(function* () {
        if (closed) return yield* new OutboxError({ kind: "closed" });
        if (poisoned) return yield* new OutboxError({ kind: "corrupt" });
        yield* Effect.gen(function* () {
          const currentLock = yield* fs.lstat(lock);
          if (!sameLock(lockInfo, currentLock))
            return yield* new OutboxError({ kind: "corrupt" });
          const current = yield* files.load();
          if (
            current.head.transaction !== head.transaction ||
            current.head.digest !== head.digest
          )
            return yield* new OutboxError({ kind: "corrupt" });
        }).pipe(
          Effect.mapError(() => new OutboxError({ kind: "corrupt" })),
          Effect.onError((cause) =>
            Effect.sync(() => {
              if (!Cause.hasInterruptsOnly(cause)) poisoned = true;
            }),
          ),
        );
      });
    const exclusive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      gate.withPermits(1)(Effect.andThen(Effect.suspend(guard), effect));
    const commit = (event: Parameters<typeof applyEvent>[1]) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          head = yield* files.commit(head, event).pipe(
            Effect.onError(() =>
              Effect.sync(() => {
                poisoned = true;
              }),
            ),
          );
          yield* applyEvent(state, event);
        }),
      );
    return makeOperations(state, identity, exclusive, commit);
  }).pipe(
    Effect.mapError((error) =>
      error instanceof OutboxError
        ? error
        : new OutboxError({ kind: "storage" }),
    ),
  );
export class ProducerOutbox extends Context.Service<
  ProducerOutbox,
  Effect.Success<ReturnType<typeof openOutbox>>
>()("delta/ProducerOutbox") {}
export const outboxLayer = (options: OutboxOptions) =>
  Layer.effect(ProducerOutbox, openOutbox(options));
