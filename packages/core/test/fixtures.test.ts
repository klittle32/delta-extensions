// AGPL fixture provenance: NOTICE; pinned upstream fixtures copied unchanged.
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import { decodeResponse, Receipt, Status } from "../src/protocol.js";
import duplicate from "./fixtures/thread-append.duplicate.json" with {
  type: "json",
};
import fenced from "./fixtures/thread-append.fenced.json" with { type: "json" };
import recorded from "./fixtures/thread-append.recorded.json" with {
  type: "json",
};
import granted from "./fixtures/thread-status.granted.json" with {
  type: "json",
};
import local from "./fixtures/thread-status.local_only.json" with {
  type: "json",
};
import unavailable from "./fixtures/thread-status.worktrees_unavailable.json" with {
  type: "json",
};

for (const [name, value] of Object.entries({ granted, local, unavailable })) {
  it.effect(`decodes pinned ${name} status fixture`, () =>
    Effect.gen(function* () {
      expect(yield* decodeResponse(Status)(value)).toEqual(value);
    }),
  );
}
for (const [name, value] of Object.entries({ recorded, fenced, duplicate })) {
  it.effect(`decodes pinned ${name} receipt fixture`, () =>
    Effect.gen(function* () {
      expect(yield* Schema.decodeUnknownEffect(Receipt)(value)).toEqual(value);
    }),
  );
}
it.effect("keeps producer identity and extension metadata intact", () =>
  Effect.gen(function* () {
    const value = {
      ...granted,
      producer: {
        ...granted.producer,
        source: "letta-code",
        external_id: "original-session",
        next_sequence: 20,
        turn: { sequence: 2, status: "superseded", future: 1 },
        future: "opaque",
      },
    };
    expect(yield* decodeResponse(Status)(value)).toEqual(value);
  }),
);
it.effect("rejects malformed known status semantics", () =>
  Effect.gen(function* () {
    for (const value of [
      { ...local, producer: { ...local.producer, next_sequence: 0 } },
      { ...local, worktrees: { status: "future" } },
      { ...local, visibility: "future" },
      { ...local, title: undefined },
    ]) {
      expect((yield* Effect.flip(decodeResponse(Status)(value)))._tag).toBe(
        "SchemaError",
      );
    }
  }),
);
