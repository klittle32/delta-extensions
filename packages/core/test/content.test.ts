// AGPL-3.0-only; adapted fixtures: see NOTICE and docs/core.md.
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { Digest } from "effect/crypto";
import { expect } from "vitest";
import { openOutbox } from "../src/outbox.js";
import { DeltaRecord } from "../src/records.js";
import blocks from "./fixtures/record-content.json" with { type: "json" };

const updates = [
  ...["user_message", "agent_message", "agent_thought"].map(
    (sessionUpdate) => ({
      sessionUpdate,
      messageId: "message",
      content: blocks,
    }),
  ),
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tool",
    status: "completed",
    content: blocks.map((content) => ({ type: "content", content })),
  },
];
for (const update of updates)
  it.effect(`decodes all emitted blocks in ${update.sessionUpdate}`, () =>
    Effect.gen(function* () {
      const record = { schemaVersion: 1, sequence: 1, update };
      expect(yield* Schema.decodeUnknownEffect(DeltaRecord)(record)).toEqual(
        record,
      );
    }),
  );

it.live("all emitted content survives stage, exact replay and reopen", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const temp = yield* fs.makeTempDirectoryScoped();
    const options = {
      root: path.join(temp, "store"),
      identity: {
        source: "letta",
        externalId: "producer",
        threadId: "thread",
        scopeId: "scope",
      },
    };
    const lines = yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openOutbox({ ...options, mode: "create" });
        const lines: string[] = [];
        for (const [index, update] of updates.entries()) {
          const row = yield* store.stage(String(index), { update });
          expect(JSON.parse(row.line).update).toEqual(update);
          lines.push(row.line);
        }
        expect((yield* store.replay).map((row) => row.line)).toEqual(lines);
        expect(
          yield* Effect.flip(
            store.stage("too-large", {
              update: {
                sessionUpdate: "user_message",
                messageId: "large",
                content: [
                  {
                    type: "image",
                    data: "AAAA".repeat(4 * 1024 * 1024),
                    mimeType: "image/png",
                  },
                ],
              },
            }),
          ),
        ).toHaveProperty("kind", "input");
        expect((yield* store.snapshot).nextSequence).toBe(5);
        return lines;
      }),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openOutbox({ ...options, mode: "reopen" });
        expect((yield* store.replay).map((row) => row.line)).toEqual(lines);
      }),
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeFileSystem.layer,
        NodePath.layer,
        Digest.layerWebCrypto,
      ),
    ),
  ),
);

it.effect("rejects malformed known blocks without text fallback", () =>
  Effect.gen(function* () {
    for (const content of [
      { type: "image", data: "AB==", mimeType: "image/png" },
      { type: "audio", data: "not-base64", mimeType: "audio/wav" },
      { type: "resource", resource: { uri: "urn:a" } },
      { type: "resource", resource: { uri: "urn:a", blob: "A===" } },
      { type: "resource_link", uri: "urn:a" },
      { type: "resource_link", uri: "urn:a", name: "a", size: -1 },
      { type: "resource_link", uri: "urn:a", name: "a", icons: [{ src: 1 }] },
      { type: "text", text: "ok", annotations: { priority: 2 } },
      { type: "text", text: "ok", annotations: { audience: ["system"] } },
      { type: "image", data: "AA==", mimeType: 5 },
      { type: "text", text: "ok", _meta: "bad" },
      {
        type: "document",
        source: { type: "text", data: "not an emitted variant" },
      },
    ]) {
      expect(
        yield* Effect.flip(
          Schema.decodeUnknownEffect(DeltaRecord)({
            schemaVersion: 1,
            sequence: 1,
            update: {
              sessionUpdate: "user_message",
              messageId: "m",
              content: [content],
            },
          }),
        ),
      ).toHaveProperty("_tag", "SchemaError");
    }
  }),
);

it.effect(
  "preserves extensions, nullable optional fields and opaque empty payloads",
  () =>
    Effect.gen(function* () {
      const value = {
        schemaVersion: 1,
        sequence: 1,
        update: {
          sessionUpdate: "user_message",
          messageId: "m",
          content: [
            {
              type: "audio",
              data: "",
              mimeType: "",
              annotations: null,
              _meta: null,
              future: { array: [null, 2] },
            },
            {
              type: "resource",
              resource: {
                uri: "urn:claude-code:document:doc",
                text: "",
                mimeType: null,
                _meta: { opaque: "AA==" },
                future: true,
              },
            },
            {
              type: "resource_link",
              uri: "file:///never-read",
              name: "",
              size: null,
              icons: null,
              annotations: { lastModified: null, _meta: { future: true } },
            },
          ],
        },
      };
      expect(yield* Schema.decodeUnknownEffect(DeltaRecord)(value)).toEqual(
        value,
      );
    }),
);
