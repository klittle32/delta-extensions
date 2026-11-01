import { homedir } from "node:os";
import { join } from "node:path";
import { Effect, Scope, Semaphore } from "effect";
import type { Digest } from "effect/crypto";
import type { Command } from "../../core/src/commands.js";
import {
  makeCollaboration,
  hasSavedBinding,
  automaticPolicy,
  CollaborationError,
} from "./collaboration/index.js";
import { discover } from "./discovery.js";
import type { makeHostBridge } from "./host.js";
import { makeInteraction } from "./interaction/index.js";
import { makeOperations } from "./operations/index.js";
import { executeOrganization } from "./organizations.js";
import type { Interaction, Session } from "./session.js";

export interface FeatureOptions {
  readonly interaction?: Interaction;
  readonly dataDirectory?: string;
}

export const makeFeatures = (
  bridge: ReturnType<typeof makeHostBridge>,
  options: FeatureOptions,
) =>
  Effect.gen(function* () {
    const interaction = options.interaction ?? (yield* makeInteraction());
    const owner = yield* Scope.Scope;
    const gate = yield* Semaphore.make(1);
    const dataDirectory =
      options.dataDirectory ??
      join(
        process.env.LETTA_CONFIG_DIR ?? join(homedir(), ".letta"),
        "mods",
        "delta-data",
      );
    const operations = yield* makeOperations({
      interaction,
      busy: bridge.busy,
      current: bridge.current,
      preferencesPath: join(dataDirectory, "preferences.json"),
      moduleUrl: import.meta.url,
    });
    type Collaboration = Effect.Success<ReturnType<typeof makeCollaboration>>;
    const clients = new Map<string, Collaboration>();
    const hasBinding = (session: Session) =>
      hasSavedBinding(dataDirectory, session);
    const initialized = new Set<string>();
    const identity = (session: Session) =>
      JSON.stringify([session.agentId, session.conversationId, session.cwd]);
    const checked = new Set<string>();
    const backgroundChecks = (session: Session) =>
      Effect.suspend(() => {
        if (checked.has(identity(session))) return Effect.void;
        checked.add(identity(session));
        const aborted = Effect.callback<never>((resume) => {
          const stop = () => resume(Effect.interrupt);
          if (session.signal.aborted) stop();
          else session.signal.addEventListener("abort", stop, { once: true });
          return Effect.sync(() =>
            session.signal.removeEventListener("abort", stop),
          );
        });
        return Effect.forkIn(
          operations.backgroundCheck({ ...session, interactive: false }).pipe(
            Effect.tap((notices) =>
              Effect.sync(() => {
                for (const notice of notices) session.notify(notice);
              }),
            ),
            Effect.raceFirst(aborted),
            Effect.catch(() => Effect.void),
          ),
          owner,
        ).pipe(Effect.asVoid);
      });
    let claimedHandoff = false;
    const get = (session: Session, explicit: boolean) =>
      Effect.gen(function* () {
        const executable = explicit
          ? yield* operations.ensureReady(session)
          : yield* discover(session.cwd);
        return yield* gate.withPermits(1)(
          Effect.gen(function* () {
            const previous = clients.get(executable);
            if (previous) return previous;
            const created = yield* makeCollaboration({
              interaction,
              executable,
              stateDirectory: dataDirectory,
              ready: (s) => operations.ensureReady(s).pipe(Effect.asVoid),
              idle: (s) =>
                Effect.sync(() => bridge.current(s) && !bridge.busy(s)),
              resumeOutbox: (store, observation) =>
                store.resumeAfterReload(observation).pipe(
                  Effect.asVoid,
                  Effect.mapError(
                    () =>
                      new CollaborationError({
                        message:
                          "The outbox could not be safely resumed against the recovered producer frontier. Its immutable records are preserved.",
                      }),
                  ),
                ),
            }).pipe(Effect.provideService(Scope.Scope, owner));
            clients.set(executable, created);
            return created;
          }),
        );
      });
    const passive = (session: Session) =>
      Effect.gen(function* () {
        const saved = yield* hasBinding(session);
        const audience = saved
          ? undefined
          : yield* automaticPolicy(session).pipe(
              Effect.catch(() => Effect.succeed(undefined)),
            );
        if (!saved && !audience) return undefined;
        const noninteractive = { ...session, interactive: false };
        const client = yield* get(noninteractive, false);
        if (!initialized.has(identity(session))) {
          if (saved) yield* client.restore(noninteractive);
          else if (audience)
            yield* client.share(noninteractive, [], undefined, audience);
          initialized.add(identity(session));
          yield* backgroundChecks(session);
        }
        return client;
      });
    const command = (
      session: Session,
      parsed: Command,
      form: string,
    ): Effect.Effect<
      string,
      unknown,
      Effect.Services<ReturnType<typeof get>> | Digest.Digest
    > =>
      Effect.gen(function* () {
        switch (parsed.kind) {
          case "share": {
            if (bridge.busy(session))
              return "Wait for the current turn and child work to finish before sharing.";
            const client = yield* get(session, true);
            const result = yield* client.share(
              session,
              parsed.emails,
              form === "delta" ? "delta_subcommand" : "dedicated_command",
            );
            if (result) {
              initialized.add(identity(session));
              yield* backgroundChecks(session);
            }
            return result
              ? `Delta thread: ${result}`
              : "Sharing cancelled; no new audience was selected.";
          }
          case "join": {
            if (bridge.busy(session))
              return "Wait for the current turn and child work to finish before joining.";
            const client = yield* get(session, true);
            const result = yield* client.join(
              session,
              parsed.locator ?? undefined,
              form === "delta" ? "delta_subcommand" : "dedicated_command",
            );
            return result
              ? `Start the fresh joined session with:\n${result.command}\nThis conversation and checkout are unchanged.`
              : "Join cancelled.";
          }
          case "setup": {
            const result = yield* operations.setup(session);
            if (result.shareCurrent) {
              const client = yield* get(session, true);
              yield* client.share(
                session,
                [],
                form === "delta" ? "delta_subcommand" : "dedicated_command",
                result.shareCurrent,
              );
              initialized.add(identity(session));
            }
            return result.text;
          }
          case "update":
            return yield* operations.update(session);
          case "plugin-update":
            return yield* operations.pluginUpdate(
              session,
              parsed.action === "notifications"
                ? `notifications ${parsed.enabled ? "on" : "off"}`
                : parsed.action === "check"
                  ? "check"
                  : "",
            );
          case "menu": {
            const answer = yield* interaction.ask(session, {
              title: "Delta",
              message: "Choose an action for this conversation and repository.",
              choices: [
                { value: "share", label: "Share this conversation" },
                { value: "join", label: "Join a shared thread" },
                { value: "setup", label: "Set up repository policy" },
                { value: "restore", label: "Restore current collaboration" },
                { value: "recover", label: "Recover paused recording" },
                { value: "update", label: "Update Delta" },
                { value: "plugin-update", label: "Update this mod" },
                { value: "org", label: "Organizations" },
              ],
            });
            if (!answer) return "Delta menu closed.";
            if (answer === "restore" || answer === "recover") {
              const client = yield* get(session, true);
              if (answer === "restore") yield* client.restore(session);
              else yield* client.recover(session);
              initialized.add(identity(session));
              return "Delta recovery action completed.";
            }
            const next: Command =
              answer === "share"
                ? { kind: "share", emails: [] }
                : answer === "join"
                  ? { kind: "join", locator: null }
                  : answer === "plugin-update"
                    ? { kind: "plugin-update", action: "update" }
                    : answer === "org"
                      ? { kind: "team-menu" }
                      : answer === "setup"
                        ? { kind: "setup" }
                        : { kind: "update" };
            return yield* command(session, next, form);
          }
          case "team-menu": {
            const answer = yield* interaction.ask(session, {
              title: "Delta organizations",
              message: "Choose an organization operation.",
              choices: ["list", "current", "switch", "invite", "manage"].map(
                (value) => ({ value, label: value }),
              ),
            });
            if (!answer) return "Organization menu closed.";
            let argument = "";
            if (answer === "switch" || answer === "invite") {
              const input = yield* interaction.ask(session, {
                title:
                  answer === "switch"
                    ? "Switch organization"
                    : "Invite members",
                message:
                  answer === "switch"
                    ? "Enter the organization ID."
                    : "Enter email addresses separated by spaces.",
                choices: [],
                allowText: true,
              });
              if (!input) return "Organization action cancelled.";
              argument = ` ${input}`;
            }
            const result = yield* executeOrganization("delta-org", {
              cwd: session.cwd,
              args: `${answer}${argument}`,
            });
            if (result.success === false)
              return yield* Effect.fail(new Error(result.output));
            return result.output;
          }
          case "org":
            return "Use /delta-org for organization operations.";
          case "usage":
            return parsed.usage;
        }
      });
    const open = (session: Session, reason: string) =>
      Effect.gen(function* () {
        const saved = yield* hasBinding(session);
        const token =
          !saved && !claimedHandoff
            ? process.env.DELTA_LETTA_HANDOFF
            : undefined;
        if (token) {
          const client = yield* get({ ...session, interactive: false }, false);
          yield* client.restore(
            { ...session, interactive: false },
            token,
            reason === "new" || reason === "startup",
          );
          initialized.add(identity(session));
          claimedHandoff = true;
          yield* backgroundChecks(session);
        } else {
          yield* passive(session);
          if (!saved)
            yield* operations
              .autoOnboard(session, false)
              .pipe(Effect.catch(() => Effect.void));
        }
      });
    const close = (session: Session) =>
      Effect.forEach(clients.values(), (client) => client.close(session), {
        discard: true,
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => initialized.delete(identity(session))),
        ),
      );
    return { command, open, close, passive, operations };
  });
