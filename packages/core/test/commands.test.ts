import { describe, expect, it } from "vitest";
import { commandNames, parseCommand } from "../src/commands.js";

describe("upstream slash command surface", () => {
  it("has exactly seven names", () =>
    expect(commandNames).toEqual([
      "delta",
      "delta-share",
      "delta-join",
      "delta-setup",
      "delta-update",
      "delta-plugin-update",
      "delta-org",
    ]));
  for (const [args, result] of [
    ["share", { kind: "share", emails: [] }],
    ["share a@b,c@d;a@b", { kind: "share", emails: ["a@b", "c@d"] }],
    ["join thread:x", { kind: "join", locator: "thread:x" }],
    ["setup", { kind: "setup" }],
    ["update", { kind: "update" }],
    ["plugin-update", { kind: "plugin-update", action: "update" }],
    ["plugin-update check", { kind: "plugin-update", action: "check" }],
    [
      "plugin-update notifications on",
      { kind: "plugin-update", action: "notifications", enabled: true },
    ],
    [
      "plugin-update notifications off",
      { kind: "plugin-update", action: "notifications", enabled: false },
    ],
    ["org list", { kind: "org", action: "list" }],
    ["org current", { kind: "org", action: "current" }],
    ["org manage", { kind: "org", action: "manage" }],
    ["org switch team", { kind: "org", action: "switch", id: "team" }],
    [
      "org invite a@b c@d",
      { kind: "org", action: "invite", emails: ["a@b", "c@d"] },
    ],
  ] as const) {
    it(`parses alias and dedicated ${args}`, () => {
      expect(parseCommand("delta", args)).toEqual(result);
      const [action, ...rest] = args.split(" ");
      expect(parseCommand(`delta-${action}`, rest.join(" "))).toEqual(result);
    });
  }
  for (const empty of ["", "  \t"]) {
    it(`distinguishes dedicated team menu from bare org alias (${JSON.stringify(empty)})`, () => {
      expect(parseCommand("delta-org", empty)).toEqual({ kind: "team-menu" });
      expect(parseCommand("delta", `org${empty}`).kind).toBe("usage");
    });
    it(`distinguishes dedicated join prompt from bare join alias (${JSON.stringify(empty)})`, () => {
      expect(parseCommand("delta-join", empty)).toEqual({
        kind: "join",
        locator: null,
      });
      expect(parseCommand("delta", `join${empty}`).kind).toBe("usage");
    });
  }
  it("returns menu intent without executing UI", () =>
    expect(parseCommand("delta", "")).toEqual({ kind: "menu" }));
  for (const input of [
    "bogus",
    "setup extra",
    "update now",
    "join a b",
    "org switch",
    "org list x",
    "org invite",
    "plugin-update notifications maybe",
    "share invalid",
  ]) {
    it(`returns usage for ${input}`, () =>
      expect(parseCommand("delta", input).kind).toBe("usage"));
  }
  it("rejects colon IDs and invented registrations", () => {
    expect(parseCommand("delta:share", "").kind).toBe("usage");
    expect(parseCommand("delta-org-list", "").kind).toBe("usage");
  });
});
