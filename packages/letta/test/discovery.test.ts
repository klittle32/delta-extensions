import { Effect } from "effect";
import { expect, it } from "vitest";
import { windowsHelpers } from "../src/discovery.js";
it("uses absolute system helper paths rather than checkout or PATH lookup", async () => {
  expect(await Effect.runPromise(windowsHelpers("C:\\Windows"))).toEqual({
    where: "C:\\Windows\\System32\\where.exe",
    reg: "C:\\Windows\\System32\\reg.exe",
  });
});
it.each([
  undefined,
  "",
  "Windows",
  "C:Windows",
  "\\Windows",
  "/Windows",
  "C:\\Windows\n",
])("rejects unsafe SystemRoot %s", async (root) => {
  await expect(Effect.runPromise(windowsHelpers(root))).rejects.toBeDefined();
});
