// AGPL-3.0-only; bounded snapshot/framing policy adapted from pinned Delta recorder.
import { posix, win32 } from "node:path";
import { Schema } from "effect";
import { ContentBlock } from "../../../core/src/content.js";
import { RecordUpdate } from "../../../core/src/records.js";
export type Update = typeof RecordUpdate.Type;
const object = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
const framing =
  /<(system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>[\s\S]*?<\/\1>/g;
const protectedBlocks =
  /<(system-reminder|letta-memory|skill-body|skill_content|policy|system-prompt)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
export const cleanText = (text: string) => {
  if (/^\s*\[Delta\](?:\s|$)/.test(text)) return "";
  // Command framing in a mixed ordinary message is not guessed away. Protected
  // injected blocks are different: their body must never leave the host.
  if (text.replace(framing, "").trim() === "" && framing.test(text)) {
    framing.lastIndex = 0;
    return "";
  }
  framing.lastIndex = 0;
  return text
    .replace(protectedBlocks, "")
    .replace(/<skill_content\b[^>]*>[\s\S]*$/gi, "");
};
export interface CaptureScope {
  readonly memoryDirectory?: string | null;
  readonly cwd?: string;
}
export const protectedTool = (
  name: string,
  args: unknown,
  scope: CaptureScope = {},
): boolean => {
  if (
    /^(?:skill|memory(?:_|$)|core_memory|archival_memory|reflection|read_memory|search_memory)/i.test(
      name,
    )
  )
    return true;
  const strings: string[] = [];
  const visit = (v: unknown, depth = 0): void => {
    if (depth > 64) throw new Error("deep tool input");
    if (typeof v === "string") {
      strings.push(v);
      if (v.trimStart().startsWith("{") || v.trimStart().startsWith("[")) {
        try {
          const decoded: unknown = JSON.parse(v);
          if (decoded !== v) visit(decoded, depth + 1);
        } catch {
          /* Ordinary non-JSON arguments remain text. */
        }
      }
    } else if (typeof v === "object" && v !== null)
      for (const child of Object.values(v)) visit(child, depth + 1);
  };
  try {
    visit(args);
  } catch {
    return true;
  }
  const normalize = (value: string) =>
    value
      .replaceAll("\\", "/")
      .replace(/\/+/g, "/")
      .replace(/\/$/, "")
      .toLowerCase();
  const memory = scope.memoryDirectory
    ? normalize(scope.memoryDirectory)
    : undefined;
  return strings.some((value) => {
    const text = normalize(value);
    if (
      /(?:\.letta\/(?:agents\/[^\s"']+\/memory|memory)|\.codex\/skills|(?:^|\/)skill\.md(?:[\s"']|$))/.test(
        text,
      )
    )
      return true;
    if (
      /\$(?:\{memory_dir\b|memory_dir\b|env:memory_dir\b)|%memory_dir%/i.test(
        value,
      )
    )
      return true;
    if (!memory) return false;
    if (text.includes(memory)) return true;
    if (/(?:^|[\s"'=(])(?:\.\/)?\/?memory(?:\/|$)/.test(text)) return true;
    const paths = /^[a-z]:/i.test(scope.memoryDirectory ?? "") ? win32 : posix;
    return value.split(/[\s"']+/).some((part) => {
      const resolved = normalize(paths.resolve(scope.cwd ?? ".", part));
      return resolved === memory || resolved.startsWith(`${memory}/`);
    });
  });
};
const blocks = (raw: unknown): (typeof ContentBlock.Type)[] => {
  const inputs =
    typeof raw === "string"
      ? [{ type: "text", text: raw }]
      : Array.isArray(raw)
        ? raw
        : [];
  return inputs.flatMap((input): (typeof ContentBlock.Type)[] => {
    const block = object(input);
    if (block.type === "text" && typeof block.text === "string") {
      const text = cleanText(block.text);
      return text.trim() ? [{ type: "text", text }] : [];
    }
    if (block.type === "image") {
      const source = object(block.source);
      if (
        typeof source.data === "string" &&
        typeof source.media_type === "string"
      ) {
        const image = {
          type: "image",
          data: source.data,
          mimeType: source.media_type,
        };
        return Schema.is(ContentBlock)(image) ? [image] : [];
      }
      if (typeof source.url === "string" && /^https?:\/\//.test(source.url))
        return [{ type: "resource_link", uri: source.url, name: "Image" }];
      if (typeof source.file_id === "string")
        return [
          {
            type: "text",
            text: "[Image bytes are unavailable through the public conversation history.]",
          },
        ];
    }
    return [];
  });
};
export const snapshotUpdates = (
  messages: readonly unknown[],
  scope: CaptureScope = {},
): readonly { id: string; update: Update }[] => {
  const bounded = messages.slice(-4096).flatMap((input) => {
    const m = object(input);
    return m.message_type === "tool_call_message" && Array.isArray(m.tool_calls)
      ? m.tool_calls.map((call, i) => ({
          ...m,
          id: `${String(m.id)}:call:${i}`,
          tool_call: call,
        }))
      : [input];
  });
  const omitted = new Set<string>();
  for (const input of bounded) {
    const m = object(input);
    const call = object(m.tool_call);
    if (
      m.message_type === "tool_call_message" &&
      typeof call.tool_call_id === "string" &&
      protectedTool(String(call.name), call.arguments, scope)
    )
      omitted.add(call.tool_call_id);
  }
  return bounded.flatMap((input) => {
    const m = object(input);
    if (typeof m.id !== "string") return [];
    const kind = m.message_type;
    let update: unknown;
    if (kind === "tool_return_message" && typeof m.tool_call_id === "string") {
      if (
        omitted.has(m.tool_call_id) ||
        (typeof m.name === "string" && protectedTool(m.name, {}, scope))
      )
        return [];
      // An unmatched tool result may be the tail of a protected Skill call outside
      // the bounded snapshot. Require its public name or observed call provenance.
      const known = bounded.some(
        (row) => object(object(row).tool_call).tool_call_id === m.tool_call_id,
      );
      if (!known && typeof m.name !== "string") return [];
      update = {
        sessionUpdate: "tool_call_update",
        toolCallId: m.tool_call_id,
        status: m.status === "error" ? "failed" : "completed",
        rawOutput:
          typeof m.tool_return === "string"
            ? cleanText(m.tool_return)
            : blocks(m.tool_return),
      };
    } else if (kind === "tool_call_message") {
      const call = object(m.tool_call);
      if (
        typeof call.tool_call_id !== "string" ||
        omitted.has(call.tool_call_id)
      )
        return [];
      update = {
        sessionUpdate: "tool_call_update",
        toolCallId: call.tool_call_id,
        ...(typeof call.name === "string" ? { name: call.name } : {}),
        ...(call.arguments === undefined ? {} : { rawInput: call.arguments }),
        status: "in_progress",
      };
    } else {
      const sessionUpdate =
        kind === "user_message"
          ? "user_message"
          : kind === "assistant_message"
            ? "agent_message"
            : kind === "reasoning_message"
              ? "agent_thought"
              : undefined;
      if (!sessionUpdate) return [];
      const raw = m.content ?? m.reasoning;
      const content = blocks(raw);
      if (!content.length) return [];
      update = { sessionUpdate, messageId: m.id, content };
    }
    return Schema.is(RecordUpdate)(update) ? [{ id: m.id, update }] : [];
  });
};
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
export const launchCommand = (
  directory: string,
  token: string,
  agentId: string,
) =>
  `cd -- ${quote(directory)} && DELTA_LETTA_HANDOFF=${quote(token)} letta --agent ${quote(agentId)} --new`;
