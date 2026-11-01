import { stripVTControlCharacters } from "node:util";
import type { Session } from "./session.js";

/** Structural subsets of the stock public mod API, not imports of host internals. */
export interface HostContext {
  readonly cwd: string;
  readonly memfs?: { readonly memoryDir: string | null };
  readonly conversationSummary?: string | null;
  readonly agent?: { readonly id: string | null };
  readonly conversation?: {
    readonly id: string | null;
    readonly getHistory: Session["getHistory"];
  };
  readonly subagents?: {
    readonly list: () => readonly { readonly status: string }[];
  };
  readonly signal?: AbortSignal;
}
export interface PanelContext {
  readonly agent: { readonly id: string | null };
  readonly sessionId: string | null;
  readonly cwd: string;
}
export interface Panel {
  readonly id: string;
  readonly order: number;
  readonly render: (ctx: PanelContext) => string;
}
export interface HostApi {
  readonly signal: AbortSignal;
  readonly capabilities: { readonly ui?: { readonly panels?: boolean } };
  readonly ui?: {
    readonly notify: (message: string) => void;
    readonly openPanel: (panel: Panel) => {
      readonly close: () => void;
      readonly update: () => void;
    };
  };
}
const key = (agent: string, conversation: string) =>
  JSON.stringify([agent, conversation]);
const text = (message: string) =>
  Array.from(stripVTControlCharacters(message))
    .filter(
      (character) =>
        character === "\n" ||
        character === "\t" ||
        (character.codePointAt(0)! >= 32 && character.codePointAt(0)! !== 127),
    )
    .join("");

/** JS ownership bridge at the synchronous public mod lifecycle boundary. */
export function makeHostBridge(api: HostApi) {
  type Entry = {
    controller: AbortController;
    signal: AbortSignal;
    cwd: string;
    context: HostContext;
    status: string;
    turning: boolean;
  };
  const entries = new Map<string, Entry>();
  let active: string | undefined;
  let closed = api.signal.aborted;
  let panel: ReturnType<NonNullable<HostApi["ui"]>["openPanel"]> | undefined;
  const closePanel = () => {
    panel?.close();
    panel = undefined;
  };
  const dispose = () => {
    if (closed) return;
    closed = true;
    api.signal.removeEventListener("abort", dispose);
    for (const entry of entries.values()) entry.controller.abort();
    entries.clear();
    active = undefined;
    closePanel();
  };
  api.signal.addEventListener("abort", dispose, { once: true });
  const identity = (ctx: HostContext) => {
    if (!ctx.agent?.id || !ctx.conversation?.id || !ctx.conversation.getHistory)
      throw new Error(
        "Delta requires an active agent and conversation with public history access.",
      );
    return {
      agentId: ctx.agent.id,
      conversationId: ctx.conversation.id,
      handle: ctx.conversation,
    };
  };
  const current = (s: Session) => {
    const entry = entries.get(key(s.agentId, s.conversationId));
    return (
      !closed &&
      !s.signal.aborted &&
      entry?.signal === s.signal &&
      entry.cwd === s.cwd
    );
  };
  const session = (ctx: HostContext): Session => {
    if (closed) throw new Error("Delta mod is closed.");
    const { agentId, conversationId, handle } = identity(ctx);
    const id = key(agentId, conversationId);
    let entry = entries.get(id);
    if (!entry || entry.cwd !== ctx.cwd || entry.signal.aborted) {
      entry?.controller.abort();
      const controller = new AbortController();
      entry = {
        controller,
        signal: AbortSignal.any([
          controller.signal,
          api.signal,
          ...(ctx.signal ? [ctx.signal] : []),
        ]),
        cwd: ctx.cwd,
        context: ctx,
        status: "",
        turning: false,
      };
      entries.set(id, entry);
    }
    entry.context = ctx;
    const owned = entry;
    const interactive = Boolean(api.capabilities.ui?.panels && api.ui);
    const result: Session = {
      agentId,
      conversationId,
      cwd: ctx.cwd,
      memoryDirectory: ctx.memfs?.memoryDir ?? null,
      title: ctx.conversationSummary ?? null,
      interactive,
      signal: entry.signal,
      getHistory: async (options) => {
        if (!current(result))
          throw new Error("Delta conversation changed or closed.");
        const history = await handle.getHistory(options);
        if (!current(result))
          throw new Error(
            "Delta conversation changed during history retrieval.",
          );
        return history;
      },
      notify(message) {
        if (!current(result)) return;
        owned.status = text(message);
        if (!interactive || !api.ui) return;
        panel ??= api.ui.openPanel({
          id: "delta-status",
          order: 10,
          render(rendered) {
            if (!rendered.agent.id || !rendered.sessionId) return "";
            const matching = entries.get(
              key(rendered.agent.id, rendered.sessionId),
            );
            return matching?.cwd === rendered.cwd ? matching.status : "";
          },
        });
        panel.update();
        // Native notifications are TUI-global. Only the explicit foreground owner may publish.
        if (active === id) api.ui.notify(owned.status);
      },
    };
    return result;
  };
  const open = (ctx: HostContext) => {
    const result = session(ctx);
    active = key(result.agentId, result.conversationId);
    return result;
  };
  const close = (ctx: HostContext) => {
    if (!ctx.agent?.id || !ctx.conversation?.id) return;
    const id = key(ctx.agent.id, ctx.conversation.id);
    entries.get(id)?.controller.abort();
    entries.delete(id);
    if (active === id) active = undefined;
    panel?.update();
  };
  const turning = (ctx: HostContext, value: boolean) => {
    const result = session(ctx);
    entries.get(key(result.agentId, result.conversationId))!.turning = value;
  };
  const busy = (s: Session) => {
    const entry = entries.get(key(s.agentId, s.conversationId));
    return Boolean(
      entry?.turning ||
        entry?.context.subagents
          ?.list()
          .some(
            (child) => child.status === "pending" || child.status === "running",
          ),
    );
  };
  return {
    session,
    open,
    close,
    current,
    busy,
    dispose,
    turnStarted: (ctx: HostContext) => turning(ctx, true),
    turnEnded: (ctx: HostContext) => turning(ctx, false),
  };
}
