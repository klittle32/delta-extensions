import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import {
  readProjectPolicy,
  recordsAutomatically,
  serializeProjectPolicy,
} from "../src/project-policy.js";

const manual = { mode: "manual", configured: false };

for (const [label, text, policy, malformed] of [
  ["missing", undefined, manual, undefined],
  ["empty object", "{}", manual, undefined],
  ["missing mode", '{"threads":{}}', manual, undefined],
  [
    "manual",
    '{"threads":{"mode":"manual"}}',
    { mode: "manual", configured: true },
    undefined,
  ],
  [
    "manual team",
    '{"threads":{"mode":"manual","organization":"org-1"}}',
    { mode: "manual", organization: "org-1", configured: true },
    undefined,
  ],
  [
    "private team",
    '{"threads":{"mode":"private","organization":"org-1"}}',
    { mode: "private", organization: "org-1", configured: true },
    undefined,
  ],
  [
    "organization team",
    '{"threads":{"mode":"organization","organization":"org-2"}}',
    { mode: "organization", organization: "org-2", configured: true },
    undefined,
  ],
  [
    "missing private team",
    '{"threads":{"mode":"private"}}',
    { ...manual, problem: expect.any(String) },
    undefined,
  ],
  [
    "blank team",
    '{"threads":{"mode":"organization","organization":"  "}}',
    { ...manual, problem: expect.any(String) },
    undefined,
  ],
  [
    "invalid mode",
    '{"threads":{"mode":"team"}}',
    { ...manual, problem: expect.any(String) },
    undefined,
  ],
  [
    "invalid threads",
    '{"threads":[]}',
    { ...manual, problem: expect.any(String) },
    undefined,
  ],
  [
    "invalid JSON",
    "{ not json",
    { ...manual, problem: expect.any(String) },
    true,
  ],
  ["non-object", "[]", { ...manual, problem: expect.any(String) }, true],
  ["null", "null", { ...manual, problem: expect.any(String) }, true],
] as const) {
  it.effect(`reads ${label} with reference policy semantics`, () =>
    Effect.gen(function* () {
      const file = yield* readProjectPolicy(text);
      expect(file.policy).toEqual(policy);
      expect(file.malformed).toBe(malformed);
    }),
  );
}

it.effect(
  "preserves unknown keys, keeps exact organization IDs, and does not mutate prior settings",
  () =>
    Effect.gen(function* () {
      const previous = {
        unrelated: { keep: [1, 2] },
        threads: { future: "x", mode: "private", organization: "old" },
      };
      const text = yield* serializeProjectPolicy(
        previous,
        "organization",
        " org-2 ",
      );
      expect(text.endsWith("\n")).toBe(true);
      const next = yield* readProjectPolicy(text);
      expect(next.document).toEqual({
        unrelated: { keep: [1, 2] },
        threads: { future: "x", mode: "organization", organization: " org-2 " },
      });
      expect(next.policy).toEqual({
        mode: "organization",
        organization: " org-2 ",
        configured: true,
      });
      expect(previous.threads).toEqual({
        future: "x",
        mode: "private",
        organization: "old",
      });
      const retained = yield* readProjectPolicy(
        yield* serializeProjectPolicy(next.document, "manual", "org-2"),
      );
      expect(retained.policy).toEqual({
        mode: "manual",
        organization: "org-2",
        configured: true,
      });
      const removed = yield* readProjectPolicy(
        yield* serializeProjectPolicy(retained.document, "manual"),
      );
      expect(removed.document).toEqual({
        unrelated: { keep: [1, 2] },
        threads: { future: "x", mode: "manual" },
      });
    }),
);

it.effect(
  "repairs a non-object threads field without losing unrelated settings",
  () =>
    Effect.gen(function* () {
      const file = yield* readProjectPolicy('{"keep":true,"threads":false}');
      const repaired = yield* readProjectPolicy(
        yield* serializeProjectPolicy(file.document, "manual"),
      );
      expect(repaired.document).toEqual({
        keep: true,
        threads: { mode: "manual" },
      });
      expect(repaired.policy.configured).toBe(true);
    }),
);

it.effect("preserves prototype-looking JSON keys as data", () =>
  Effect.gen(function* () {
    const original =
      '{"__proto__":{"polluted":true},"threads":{"constructor":"keep","mode":"manual"}}';
    const file = yield* readProjectPolicy(original);
    const next = yield* readProjectPolicy(
      yield* serializeProjectPolicy(file.document, "private", "org"),
    );
    expect(
      Object.getOwnPropertyDescriptor(next.document ?? {}, "__proto__")?.value,
    ).toEqual({ polluted: true });
    expect(next.document?.threads).toEqual({
      constructor: "keep",
      mode: "private",
      organization: "org",
    });
    expect({}).not.toHaveProperty("polluted");
  }),
);

it.effect(
  "only valid automatic policies opt in; unusable files remain manual",
  () =>
    Effect.gen(function* () {
      for (const mode of ["private", "organization"] as const) {
        expect(
          recordsAutomatically(
            (yield* readProjectPolicy(
              yield* serializeProjectPolicy(undefined, mode, "org"),
            )).policy,
          ),
        ).toBe(true);
        expect(
          recordsAutomatically(
            (yield* readProjectPolicy(
              yield* serializeProjectPolicy(undefined, mode),
            )).policy,
          ),
        ).toBe(false);
      }
      expect(
        recordsAutomatically(
          (yield* readProjectPolicy(
            yield* serializeProjectPolicy(undefined, "manual", "org"),
          )).policy,
        ),
      ).toBe(false);
    }),
);

it.effect("serialization failures stay in the typed error channel", () =>
  Effect.gen(function* () {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const failure = yield* Effect.flip(
      serializeProjectPolicy(cyclic, "manual"),
    );
    expect(failure._tag).toBe("SchemaError");
  }),
);
