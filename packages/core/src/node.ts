/** Optional Node wiring; transport itself requires only the injected Effect spawner. */
import {
  NodeChildProcessSpawner,
  NodeFileSystem,
  NodePath,
} from "@effect/platform-node";
import { Layer } from "effect";
export const nodeProcessLayer = NodeChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
);
