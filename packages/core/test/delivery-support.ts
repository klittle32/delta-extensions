import { fileURLToPath } from "node:url";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, type Scope } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { Digest } from "effect/crypto";
import { makeAppendDelivery, type DeliveryOptions } from "../src/delivery.js";
import { nodeProcessLayer } from "../src/node.js";
import { openOutbox, ProducerOutbox } from "../src/outbox.js";
export const identity = {
  source: "letta-code",
  externalId: "producer-🙂",
  threadId: "thread-1",
  scopeId: "scope-1",
};
export const body = {
  update: { sessionUpdate: "state_update", state: "running" },
  turnSequence: 1,
};
export const fixture = fileURLToPath(
  new URL("./delivery-fixture.mjs", import.meta.url),
);
export type Store = Effect.Success<ReturnType<typeof openOutbox>>;
export const platform = Layer.mergeAll(
  NodeFileSystem.layer,
  NodePath.layer,
  Digest.layerWebCrypto,
  nodeProcessLayer,
);
export const test = <E>(
  name: string,
  f: (ctx: {
    root: string;
    temp: string;
    fs: FileSystem.FileSystem;
    store: Store;
    options: DeliveryOptions;
    create: (mode?: string) => ReturnType<typeof makeAppendDelivery>;
  }) => Effect.Effect<
    void,
    E,
    | Scope.Scope
    | FileSystem.FileSystem
    | Path.Path
    | Digest.Digest
    | ChildProcessSpawner.ChildProcessSpawner
    | ProducerOutbox
  >,
) =>
  it.live(name, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped();
      const root = path.join(temp, "store");
      const store = yield* openOutbox({ root, identity, mode: "create" });
      const options: DeliveryOptions = {
        executable: fixture,
        cwd: temp,
        reference: "delta://fixture/thread",
        threadId: identity.threadId,
        producerName: "Letta Code fixture",
        acknowledgement: "server",
        transport: {
          timeoutMs: 5000,
          env: { DELTA_DELIVERY_LOG: path.join(temp, "calls.jsonl") },
        },
      };
      const create = (mode = "normal") =>
        makeAppendDelivery({
          ...options,
          transport: {
            ...options.transport,
            env: { ...options.transport?.env, DELTA_DELIVERY_MODE: mode },
          },
        });
      yield* f({ root, temp, fs, store, options, create }).pipe(
        Effect.provideService(ProducerOutbox, store),
      );
    }).pipe(Effect.provide(platform)),
  );
