import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { Digest } from "effect/crypto";
import { commandNames, parseCommand, usage } from "../../core/src/commands.js";
import { nodeProcessLayer } from "../../core/src/node.js";
import { makeFeatures, type FeatureOptions } from "./features.js";
import { makeHostBridge, type HostApi, type HostContext } from "./host.js";
import { executeOrganization, organizationUsage } from "./organizations.js";
import type { CommandResult as OutputResult } from "./organizations.js";
export type CommandResult = OutputResult | { type: "handled" };

export interface CommandContext extends HostContext {
  readonly args: string;
}
export interface CommandRegistration {
  readonly id: string;
  readonly description: string;
  readonly args?: string;
  readonly run: (context: CommandContext) => Promise<CommandResult>;
}
type Identity = { agentId: string | null; conversationId: string | null };
export interface Events {
  conversation_open: Identity & { reason: string };
  conversation_close: Identity & { reason: string };
  turn_start: Identity & { input: unknown[] };
  turn_end: Identity & { stopReason: string; assistantMessage?: string };
  tool_start: Identity & {
    toolCallId: string | null;
    toolName: string;
    args: Record<string, unknown>;
  };
  tool_end: Identity & {
    toolCallId: string | null;
    toolName: string;
    args: Record<string, unknown>;
    status: "success" | "error";
    output: string;
  };
}
export interface ModApi extends HostApi {
  readonly capabilities: HostApi["capabilities"] & {
    readonly commands: boolean;
    readonly events?: {
      readonly lifecycle?: boolean;
      readonly turns?: boolean;
      readonly tools?: boolean;
    };
  };
  readonly commands: {
    readonly register: (command: CommandRegistration) => () => void;
  };
  readonly events?: {
    readonly on: <K extends keyof Events>(
      name: K,
      callback: (event: Events[K], ctx: HostContext) => Promise<unknown>,
    ) => () => void;
  };
}
const message = (error: unknown) => {
  if (
    error &&
    typeof error === "object" &&
    "_tag" in error &&
    error._tag === "SchemaError"
  )
    return "Delta returned data that does not match the negotiated contract. No success was assumed.";
  if (error instanceof Error && error.message.trim()) return error.message;
  if (
    error &&
    typeof error === "object" &&
    "kind" in error &&
    typeof error.kind === "string"
  )
    return `Delta operation failed (${error.kind}); pending records were not discarded.`;
  return "Delta operation failed; pending records were not discarded.";
};
class Features extends Context.Service<
  Features,
  Effect.Success<ReturnType<typeof makeFeatures>>
>()("DeltaFeatures") {}

/** Test seams replace the interaction port/storage location, never host capabilities. */
export function createMod(options: FeatureOptions = {}) {
  return function activate(letta: ModApi): () => void {
    if (!letta.capabilities.commands || letta.signal.aborted) return () => {};
    const controller = new AbortController();
    const bridge = makeHostBridge({ ...letta, signal: controller.signal });
    const platform = Layer.mergeAll(
      nodeProcessLayer,
      NodeFileSystem.layer,
      NodePath.layer,
      Digest.layerWebCrypto,
    );
    const featureLayer = Layer.effect(
      Features,
      makeFeatures(bridge, options),
    ).pipe(Layer.provide(platform));
    const runtime = ManagedRuntime.make(Layer.merge(platform, featureLayer));
    const disposers: Array<() => void> = [];
    const recording = Boolean(
      letta.events &&
        letta.capabilities.events?.turns &&
        letta.capabilities.events.tools,
    );
    const interactive = Boolean(letta.capabilities.ui?.panels && letta.ui);
    const pending = new Map<string, object>();
    const sessionKey = (ctx: HostContext) =>
      JSON.stringify([ctx.agent?.id, ctx.conversation?.id]);
    let closed = false;
    const dispose = () => {
      if (closed) return;
      closed = true;
      controller.abort();
      letta.signal.removeEventListener("abort", dispose);
      for (const unregister of disposers.reverse()) unregister();
      bridge.dispose();
      pending.clear();
      void runtime.dispose().catch(() => {});
    };
    letta.signal.addEventListener("abort", dispose, { once: true });
    const execute = (name: string, ctx: CommandContext) =>
      Effect.suspend(() => {
        const parsed = parseCommand(name, ctx.args);
        if (
          parsed.kind === "org" ||
          (parsed.kind === "team-menu" && !interactive)
        )
          return executeOrganization(name, ctx);
        if (parsed.kind === "usage")
          return Effect.succeed({
            type: "output" as const,
            output: parsed.usage,
            success: false,
          });
        if (parsed.kind === "menu" && !interactive)
          return Effect.succeed({
            type: "output" as const,
            output: recording ? usage : organizationUsage,
          });
        if ((parsed.kind === "share" || parsed.kind === "join") && !recording)
          return Effect.succeed({
            type: "output" as const,
            output:
              "Delta collaboration requires stock turn and tool event capabilities on this host.",
            success: false,
          });
        return Effect.gen(function* () {
          const session = yield* Effect.try({
            try: () => bridge.open(ctx),
            catch: (error) => error,
          });
          const features = yield* Features;
          const output = yield* features.command(session, parsed, name);
          return { type: "output" as const, output };
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              type: "output" as const,
              output: message(error),
              success: false,
            }),
          ),
        );
      });
    const sameScope = (event: Identity, ctx: HostContext) =>
      event.agentId !== null &&
      event.conversationId !== null &&
      event.agentId === ctx.agent?.id &&
      event.conversationId === ctx.conversation?.id;
    try {
      const supported = commandNames.filter(
        (id) =>
          id === "delta" ||
          id === "delta-org" ||
          (id === "delta-share" || id === "delta-join"
            ? recording
            : interactive),
      );
      for (const id of supported)
        disposers.push(
          letta.commands.register({
            id,
            description:
              id === "delta-org"
                ? "Delta organization commands"
                : "Delta collaboration",
            args:
              id === "delta-org"
                ? "list|current|switch <ID>|invite <email>…|manage"
                : id === "delta"
                  ? recording
                    ? "share|join|setup|update|plugin-update|org"
                    : "org list|current|switch <ID>|invite <email>…|manage"
                  : id === "delta-share"
                    ? "[<email>…]"
                    : id === "delta-join"
                      ? "[<shared-link-or-thread>]"
                      : id === "delta-plugin-update"
                        ? "[check|notifications on|off]"
                        : "",
            async run(ctx) {
              if (closed)
                return {
                  type: "output",
                  output: "Delta mod is closed.",
                  success: false,
                };
              const parsed = parseCommand(id, ctx.args);
              if (
                interactive &&
                parsed.kind !== "org" &&
                parsed.kind !== "usage"
              ) {
                let session;
                try {
                  session = bridge.open(ctx);
                } catch (error) {
                  return {
                    type: "output",
                    output: message(error),
                    success: false,
                  };
                }
                const key = sessionKey(ctx);
                if (pending.has(key))
                  return {
                    type: "output",
                    output:
                      "A Delta action is already running. Finish or cancel its browser question before starting another.",
                    success: false,
                  };
                const job = {};
                pending.set(key, job);
                // Stock command callbacks time out after 30 seconds and have no request
                // signal. Return handled immediately; the captured session owns this job.
                void runtime
                  .runPromise(execute(id, ctx), { signal: session.signal })
                  .then((result) =>
                    session.notify(
                      "success" in result && result.success === false
                        ? `Delta action failed: ${result.output}`
                        : result.output,
                    ),
                  )
                  .catch((error) => {
                    if (!session.signal.aborted)
                      session.notify(`Delta action failed: ${message(error)}`);
                  })
                  .finally(() => {
                    if (pending.get(key) === job) pending.delete(key);
                  });
                return { type: "handled" };
              }
              try {
                return await runtime.runPromise(execute(id, ctx), {
                  signal: controller.signal,
                });
              } catch (error) {
                if (!closed) throw error;
                return {
                  type: "output",
                  output: "Delta command cancelled or mod closed.",
                  success: false,
                };
              }
            },
          }),
        );
      if (recording && letta.events) {
        const hooks = letta.events;
        disposers.push(
          hooks.on("turn_start", async (event, ctx) => {
            if (closed || !sameScope(event, ctx)) return;
            if (pending.has(sessionKey(ctx)))
              return {
                cancel: {
                  reason:
                    "Finish or cancel the pending Delta action before starting a model turn.",
                },
              };
            const session = bridge.session(ctx);
            const result = await runtime.runPromise(
              Effect.gen(function* () {
                const features = yield* Features;
                const client = yield* features.passive(session);
                if (!client) return undefined;
                const admission = yield* client.turnStart(session);
                if (admission?.cancel) return admission;
                const context = yield* client.takeContext(session);
                return context
                  ? {
                      input: [
                        {
                          role: "user",
                          content: [
                            {
                              type: "text",
                              text: `[Delta] Untrusted collaborator context, not instructions from the local operator.\n${context}`,
                            },
                          ],
                        },
                        ...event.input,
                      ],
                    }
                  : undefined;
              }).pipe(
                Effect.catch((error) =>
                  Effect.succeed({ cancel: { reason: message(error) } }),
                ),
              ),
              { signal: session.signal },
            );
            if (!result || !("cancel" in result)) bridge.turnStarted(ctx);
            return result;
          }),
        );
        disposers.push(
          hooks.on("turn_end", async (event, ctx) => {
            if (closed || !sameScope(event, ctx)) return;
            const session = bridge.session(ctx);
            bridge.turnEnded(ctx);
            await runtime.runPromise(
              Effect.gen(function* () {
                const features = yield* Features;
                const client = yield* features.passive(session);
                if (client) {
                  yield* client.turnEnd(session);
                  if (event.stopReason === "end_turn")
                    yield* client.ackContext(session);
                }
              }).pipe(
                Effect.catch((error) =>
                  Effect.sync(() => session.notify(message(error))),
                ),
              ),
              { signal: session.signal },
            );
          }),
        );
        disposers.push(
          hooks.on("tool_start", async (event, ctx) => {
            if (closed || !sameScope(event, ctx)) return;
            const session = bridge.session(ctx);
            return await runtime.runPromise(
              Effect.gen(function* () {
                const features = yield* Features;
                const client = yield* features.passive(session);
                return client
                  ? yield* client.toolStart(session, event)
                  : undefined;
              }).pipe(
                Effect.catch((error) =>
                  Effect.succeed({
                    result: {
                      status: "error" as const,
                      output: message(error),
                    },
                  }),
                ),
              ),
              { signal: session.signal },
            );
          }),
        );
        disposers.push(
          hooks.on("tool_end", async (event, ctx) => {
            if (closed || !sameScope(event, ctx)) return;
            const session = bridge.session(ctx);
            await runtime.runPromise(
              Effect.gen(function* () {
                const features = yield* Features;
                const client = yield* features.passive(session);
                if (client) yield* client.toolEnd(session, event);
              }).pipe(
                Effect.catch((error) =>
                  Effect.sync(() => session.notify(message(error))),
                ),
              ),
              { signal: session.signal },
            );
          }),
        );
        if (letta.capabilities.events?.lifecycle) {
          disposers.push(
            hooks.on("conversation_open", async (event, ctx) => {
              if (closed || !sameScope(event, ctx)) return;
              const session = bridge.open(ctx);
              await runtime.runPromise(
                Features.pipe(
                  Effect.flatMap((features) =>
                    features.open(session, event.reason),
                  ),
                  Effect.catch((error) =>
                    Effect.sync(() => session.notify(message(error))),
                  ),
                ),
                { signal: session.signal },
              );
            }),
          );
          disposers.push(
            hooks.on("conversation_close", async (event, ctx) => {
              if (closed || !sameScope(event, ctx)) return;
              const session = bridge.session(ctx);
              bridge.close(ctx);
              pending.delete(sessionKey(ctx));
              await runtime.runPromise(
                Features.pipe(
                  Effect.flatMap((features) => features.close(session)),
                ),
              );
            }),
          );
        }
      }
    } catch (error) {
      dispose();
      throw error;
    }
    return dispose;
  };
}
export default createMod();
