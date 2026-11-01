import { describe, expect, it } from "vitest";
import {
  makeHostBridge,
  type HostContext,
  type HostApi,
  type Panel,
} from "../src/host.js";

const context = (
  agent = "agent-a",
  conversation = "conv-a",
  cwd = "/repo",
): HostContext => ({
  cwd,
  agent: { id: agent },
  conversation: {
    id: conversation,
    getHistory: async () => [{ id: conversation }],
  },
  subagents: { list: () => [] },
});
function host(panels = true) {
  const controller = new AbortController();
  const notices: string[] = [];
  let panel: Panel | undefined;
  let closed = false;
  const api: HostApi = {
    signal: controller.signal,
    capabilities: { ui: { panels } },
    ui: {
      notify: (text) => {
        notices.push(text);
      },
      openPanel: (definition) => {
        panel = definition;
        return {
          update: () => {},
          close: () => {
            closed = true;
          },
        };
      },
    },
  };
  return { api, controller, notices, panel: () => panel, closed: () => closed };
}
describe("scoped stock host bridge", () => {
  it("does nothing on creation and keeps history handles scoped", async () => {
    const h = host();
    const bridge = makeHostBridge(h.api);
    expect(h.panel()).toBeUndefined();
    const a = bridge.session(context());
    const b = bridge.session(context("agent-b", "conv-b"));
    expect(await a.getHistory()).toEqual([{ id: "conv-a" }]);
    expect(await b.getHistory()).toEqual([{ id: "conv-b" }]);
    expect(h.notices).toEqual([]);
    bridge.dispose();
  });
  it("never publishes a sibling session's private notifications into the active transcript", () => {
    const h = host();
    const bridge = makeHostBridge(h.api);
    const a = bridge.open(context());
    const b = bridge.session(context("agent-b", "conv-b"));
    a.notify("first");
    b.notify("other conversation");
    expect(h.notices).toEqual(["first"]);
    expect(
      h.panel()?.render({
        agent: { id: "agent-a" },
        sessionId: "conv-a",
        cwd: "/repo",
      }),
    ).toContain("first");
    expect(
      h.panel()?.render({
        agent: { id: "agent-b" },
        sessionId: "conv-b",
        cwd: "/repo",
      }),
    ).toContain("other conversation");
    bridge.dispose();
  });
  it("closes only the selected session and rejects retained or moved handles", () => {
    const h = host();
    const bridge = makeHostBridge(h.api);
    const a = bridge.open(context());
    const b = bridge.session(context("agent-b", "conv-b"));
    bridge.close(context());
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    expect(bridge.current(a)).toBe(false);
    const moved = bridge.session(context("agent-b", "conv-b", "/other"));
    expect(b.signal.aborted).toBe(true);
    expect(bridge.current(moved)).toBe(true);
    bridge.dispose();
    expect(moved.signal.aborted).toBe(true);
  });
  it("tracks foreground turns and live subagents without inventing child conversation IDs", () => {
    const h = host();
    const bridge = makeHostBridge(h.api);
    const ctx = context();
    const session = bridge.open(ctx);
    expect(bridge.busy(session)).toBe(false);
    bridge.turnStarted(ctx);
    expect(bridge.busy(session)).toBe(true);
    bridge.turnEnded(ctx);
    expect(bridge.busy(session)).toBe(false);
    const childContext = {
      ...ctx,
      subagents: { list: () => [{ status: "running" }] },
    };
    const refreshed = bridge.session(childContext);
    expect(bridge.busy(refreshed)).toBe(true);
    bridge.dispose();
  });
  it("guards optional UI and clears every resource on activation abort", () => {
    const h = host(false);
    const bridge = makeHostBridge(h.api);
    const session = bridge.open(context());
    expect(session.interactive).toBe(false);
    session.notify("not interactive");
    expect(h.notices).toEqual([]);
    expect(h.panel()).toBeUndefined();
    h.controller.abort();
    expect(session.signal.aborted).toBe(true);
    expect(() => bridge.session(context())).toThrow(/closed/);
    bridge.dispose();
  });
  it("rejects missing identities and terminal control injection", () => {
    const h = host();
    const bridge = makeHostBridge(h.api);
    expect(() => bridge.session({ cwd: "/repo" })).toThrow(
      /active.*conversation/i,
    );
    const session = bridge.open(context());
    session.notify("safe\x1b]52;c;secret\x07\x1b[2J text\x00");
    expect(h.notices).toEqual(["safe text"]);
    bridge.dispose();
    expect(h.closed()).toBe(true);
  });
});
