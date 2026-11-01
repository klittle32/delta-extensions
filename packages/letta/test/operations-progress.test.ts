import { Effect } from "effect";
import { expect, it } from "vitest";
import { progressMessage } from "../src/operations/progress.js";
it("shows validated update progress and action-required messages", async () => {
  expect(
    await Effect.runPromise(
      progressMessage(
        '{"schema_version":1,"type":"progress","phase":"downloading","percent":40}',
      ),
    ),
  ).toBe("Delta: downloading 40%");
  expect(
    await Effect.runPromise(
      progressMessage(
        '{"schema_version":1,"type":"action_required","action":"approve","message":"Approve the installer prompt"}',
      ),
    ),
  ).toBe("Approve the installer prompt");
});
it("ignores malformed, unsupported, or invalid progress diagnostics", async () => {
  for (const line of [
    "private diagnostics",
    '{"schema_version":2,"type":"action_required","action":"approve","message":"unsupported"}',
    '{"schema_version":1,"type":"progress","phase":"downloading","percent":101}',
  ])
    expect(await Effect.runPromise(progressMessage(line))).toBeUndefined();
});
