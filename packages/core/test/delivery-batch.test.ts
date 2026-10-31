import { Effect } from "effect";
import { expect } from "vitest";
import { body, test } from "./delivery-support.js";
const sized = (sequence: number, bytes: number) => {
  const update = {
    sessionUpdate: "agent_message",
    messageId: "m",
    content: [{ type: "text", text: "" }],
  };
  const overhead = new TextEncoder().encode(
    JSON.stringify({ schemaVersion: 1, sequence, update }) + "\n",
  ).length;
  return {
    update: {
      ...update,
      content: [
        {
          type: "text",
          text:
            "é".repeat(Math.floor((bytes - overhead) / 2)) +
            ((bytes - overhead) % 2 ? "x" : ""),
        },
      ],
    },
  };
};
for (const overflow of [0, 1])
  test(`Unicode records respect exact 2000000-byte boundary +${overflow}`, ({
    store,
    temp,
    fs,
    create,
  }) =>
    Effect.gen(function* () {
      const a = yield* store.stage("a", sized(1, 1_000_000));
      const b = yield* store.stage("b", sized(2, 1_000_000 + overflow));
      yield* store.stage("c", body);
      const service = yield* create();
      const result = yield* service.attempt;
      expect(result.progress.batch).toEqual(overflow ? [1] : [1, 2]);
      expect(result.progress.deferred).toEqual(overflow ? [2, 3] : [3]);
      const calls = (yield* fs.readFileString(`${temp}/calls.jsonl`))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls[1].input).toBe(overflow ? a.line : a.line + b.line);
      expect((yield* store.snapshot).pending).toEqual(overflow ? [2, 3] : [3]);
    }));
test("one complete maximum 16MiB record is sent alone without splitting", ({
  store,
  temp,
  fs,
  create,
}) =>
  Effect.gen(function* () {
    const a = yield* store.stage("a", sized(1, 16 * 1024 * 1024));
    yield* store.stage("b", body);
    const service = yield* create();
    expect((yield* service.attempt).progress.batch).toEqual([1]);
    const calls = (yield* fs.readFileString(`${temp}/calls.jsonl`))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls[1].input).toBe(a.line);
    expect((yield* store.snapshot).pending).toEqual([2]);
  }));
