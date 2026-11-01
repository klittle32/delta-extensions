// AGPL-3.0-only; adapted pinned frontier cases, extended for explicit producer identity. See NOTICE.
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { checkProducerFrontier } from "../src/producer-frontier.js";
const identity = {
  source: "letta-code",
  externalId: "original-producer",
  threadId: "thread",
};
const local = { identity, nextSequence: 5, pending: [3, 4] };
const observation = (next = 3) => ({
  thread_id: "thread",
  producer: {
    source: identity.source,
    external_id: identity.externalId,
    next_sequence: next,
    turn: null,
  },
});
for (const [next, error] of [
  [2, "behind"],
  [3, null],
  [4, null],
  [5, null],
  [6, "ahead"],
] as const)
  it.effect(`pending range A=3 N=5 R=${next}`, () =>
    Effect.gen(function* () {
      const remote = observation(next);
      const before = JSON.stringify({ local, remote });
      if (error)
        expect(
          yield* Effect.flip(checkProducerFrontier(local, remote)),
        ).toMatchObject({ _tag: "ProducerFrontierError", kind: error });
      else
        expect(yield* checkProducerFrontier(local, remote)).toEqual({
          identity,
          acknowledgedBefore: 3,
          nextSequence: 5,
          reportedNextSequence: next,
        });
      expect(JSON.stringify({ local, remote })).toBe(before);
    }),
  );
for (const [next, error] of [
  [4, "behind"],
  [5, null],
  [6, "ahead"],
] as const)
  it.effect(`empty queue requires exact N: R=${next}`, () =>
    Effect.gen(function* () {
      if (error)
        expect(
          yield* Effect.flip(
            checkProducerFrontier({ ...local, pending: [] }, observation(next)),
          ),
        ).toMatchObject({ kind: error });
      else
        expect(
          yield* checkProducerFrontier(
            { ...local, pending: [] },
            observation(next),
          ),
        ).toMatchObject({ acknowledgedBefore: 5, nextSequence: 5 });
    }),
  );
for (const [name, remote, kind] of [
  ["thread", { ...observation(), thread_id: "other" }, "thread-mismatch"],
  [
    "source",
    {
      ...observation(),
      producer: { ...observation().producer, source: "claude-code" },
    },
    "producer-mismatch",
  ],
  [
    "externalId",
    {
      ...observation(),
      producer: { ...observation().producer, external_id: "new-host-session" },
    },
    "producer-mismatch",
  ],
  ["null", { ...observation(), producer: null }, "producer-mismatch"],
] as const)
  it.effect(`rejects ${name} mismatch`, () =>
    Effect.gen(function* () {
      expect(
        yield* Effect.flip(checkProducerFrontier(local, remote)),
      ).toMatchObject({ kind });
    }),
  );
it.effect(
  "valid wire null producer still fails for an empty bound journal",
  () =>
    Effect.gen(function* () {
      expect(
        yield* Effect.flip(
          checkProducerFrontier(
            { ...local, nextSequence: 1, pending: [] },
            { ...observation(), producer: null },
          ),
        ),
      ).toMatchObject({ kind: "producer-mismatch" });
    }),
);
it.effect(
  "malformed observations and throwing getters fail typed without exposing caller detail",
  () =>
    Effect.gen(function* () {
      for (const remote of [
        null,
        {},
        { thread_id: "thread" },
        observation(1.5),
        { ...observation(), opaque: new SharedArrayBuffer(1) },
        { ...observation(), opaque: Number.NaN },
        {
          ...observation(),
          producer: {
            ...observation().producer,
            turn: { sequence: 0, status: "running" },
          },
        },
        {
          get thread_id() {
            throw new Error("private caller detail");
          },
        },
      ])
        expect(
          yield* Effect.flip(checkProducerFrontier(local, remote)),
        ).toMatchObject({
          _tag: "ProducerFrontierError",
          kind: "invalid-observation",
        });
    }),
);
it.effect(
  "malformed local bounds fail typed; min pending is the exclusive boundary",
  () =>
    Effect.gen(function* () {
      for (const input of [
        null,
        { ...local, nextSequence: 0 },
        { ...local, pending: [5] },
        { ...local, pending: [1.5] },
      ])
        expect(
          yield* Effect.flip(checkProducerFrontier(input, observation())),
        ).toMatchObject({ kind: "invalid-local" });
      expect(
        yield* checkProducerFrontier(
          { ...local, pending: [4, 3] },
          observation(),
        ),
      ).toHaveProperty("acknowledgedBefore", 3);
    }),
);
it.effect(
  "facts are detached/frozen, turn/actor/upload facts do not confer authority, maximum safe frontier works",
  () =>
    Effect.gen(function* () {
      const input = { ...local, identity: { ...identity } };
      const remote = {
        ...observation(),
        producer: {
          ...observation().producer,
          actor_id: "actor",
          turn: { sequence: 1, status: "superseded" },
        },
        upload: { state: "uploaded" },
      };
      const facts = yield* checkProducerFrontier(input, remote);
      input.identity.source = "changed";
      remote.producer.next_sequence = 99;
      expect(facts.identity).toEqual(identity);
      expect(facts.reportedNextSequence).toBe(3);
      expect(Object.isFrozen(facts)).toBe(true);
      expect(Object.isFrozen(facts.identity)).toBe(true);
      expect(facts).not.toHaveProperty("mayWrite");
      expect(
        yield* checkProducerFrontier(
          { ...local, nextSequence: Number.MAX_SAFE_INTEGER, pending: [] },
          observation(Number.MAX_SAFE_INTEGER),
        ),
      ).toHaveProperty("acknowledgedBefore", Number.MAX_SAFE_INTEGER);
    }),
);
