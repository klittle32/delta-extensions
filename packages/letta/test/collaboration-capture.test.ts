import { describe, expect, it } from "vitest";
import {
  snapshotUpdates,
  launchCommand,
  protectedTool,
} from "../src/collaboration/capture.js";
describe("collaboration capture", () => {
  it("excludes protected scaffolding but preserves ordinary tools and mixed user text", () => {
    const rows = snapshotUpdates([
      { id: "s", message_type: "system_message", content: "secret" },
      {
        id: "u",
        message_type: "user_message",
        content:
          "hello <system-reminder>private memory</system-reminder> world",
      },
      {
        id: "t",
        message_type: "tool_return_message",
        tool_call_id: "call",
        name: "Bash",
        tool_return: "ordinary output",
        status: "success",
      },
      {
        id: "p",
        message_type: "user_message",
        content: "<system-reminder>skill</system-reminder>",
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain("secret");
    expect(JSON.stringify(rows)).not.toContain("private memory");
    expect(JSON.stringify(rows)).not.toContain("skill");
    expect(JSON.stringify(rows)).toContain("ordinary output");
    expect(rows).toHaveLength(2);
  });
  it("bounds history and quotes handoff without shell interpolation", () => {
    expect(
      snapshotUpdates(
        Array.from({ length: 4100 }, (_, i) => ({
          id: String(i),
          message_type: "user_message",
          content: "hi",
        })),
      ),
    ).toHaveLength(4096);
    expect(launchCommand("/tmp/a'$(evil)", "token", "agent")).toContain(
      "'\\''",
    );
  });
});
it("keeps mixed command framing, strips explicit protected injection, excludes Skill returns", () => {
  const rows = snapshotUpdates([
    {
      id: "u",
      message_type: "user_message",
      content: "keep <command-name>/foo</command-name> this",
    },
    {
      id: "call",
      message_type: "tool_call_message",
      tool_call: { tool_call_id: "skill", name: "Skill", arguments: "{}" },
    },
    {
      id: "out",
      message_type: "tool_return_message",
      tool_call_id: "skill",
      tool_return: "PRIVATE SKILL BODY",
    },
  ]);
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows)).toContain("<command-name>");
  expect(JSON.stringify(rows)).not.toContain("PRIVATE SKILL BODY");
});
it("excludes stock canonical skill user bodies with attributes and preserves mixed ordinary text", () => {
  const rows = snapshotUpdates([
    {
      id: "skill",
      message_type: "user_message",
      content:
        '<skill_content name="review" path="/skills/review">SECRET_SKILL</skill_content>',
    },
    {
      id: "mixed",
      message_type: "user_message",
      content:
        'Before <skill_content name="review">SECRET_MIXED</skill_content> after',
    },
  ]);
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toContain("SECRET");
  expect(JSON.stringify(rows)).toContain("Before  after");
});
it("excludes known public memory directory reads and shell aliases while retaining ordinary tool output", () => {
  expect(
    protectedTool(
      "Read",
      { file_path: "C:\\Users\\Alice\\AgentMemory\\core.md" },
      { memoryDirectory: "C:\\Users\\Alice\\AgentMemory", cwd: "C:\\work" },
    ),
  ).toBe(true);
  expect(
    protectedTool(
      "Bash",
      { command: 'cat "$MEMORY_DIR/core.md"' },
      { memoryDirectory: "/srv/agent/memory", cwd: "/work" },
    ),
  ).toBe(true);
  expect(
    protectedTool(
      "Read",
      { file_path: "./memory/core.md" },
      { memoryDirectory: "/srv/agent/memory", cwd: "/work" },
    ),
  ).toBe(true);
  expect(
    protectedTool(
      "Read",
      { file_path: "/work/src/main.ts" },
      { memoryDirectory: "/srv/agent/memory", cwd: "/work" },
    ),
  ).toBe(false);
});
