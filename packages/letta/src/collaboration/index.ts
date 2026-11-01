import {
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Path,
  Schema,
  Schedule,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import {
  Contract,
  negotiate,
  Status,
  RecordUpdate,
  DeltaFailure,
} from "../../../core/src/protocol.js";
import { runJson, watchJsonLines } from "../../../core/src/transport.js";
import { openOutbox, ProducerOutbox } from "../../../core/src/outbox.js";
import {
  makeAppendDelivery,
  DeliveryAttemptError,
} from "../../../core/src/delivery.js";
import { watchCollaboration } from "./watch.js";
import { makeWatchProjection } from "../../../core/src/watch-projection.js";
import { readProjectPolicy } from "../../../core/src/project-policy.js";
import type { Interaction, Session } from "../session.js";
import { Binding, CollaborationError, externalId } from "./model.js";
import {
  launchCommand,
  snapshotUpdates,
  protectedTool,
  cleanText,
  type Update,
} from "./capture.js";
import {
  Created,
  WorktreeCreated,
  Attached,
  Mounted,
  CheckoutMounted,
  Published,
  Invitations,
  Organizations,
} from "./receipts.js";
import type { ChildProcessSpawner } from "effect/process";
import type { WatchProjectionState } from "../../../core/src/watch-projection-state.js";
import { remoteDelivery } from "./remote.js";
import { automaticPolicy, checkoutRoot } from "./bindings.js";
export { bindingPath, hasSavedBinding, automaticPolicy } from "./bindings.js";
export interface ShareAudience {
  readonly organization: string;
  readonly visibility: "private" | "organization";
}
export { CollaborationError } from "./model.js";
export interface CollaborationOptions {
  readonly interaction: Interaction;
  readonly executable: string;
  readonly stateDirectory: string;
  readonly organization?: (
    session: Session,
  ) => Effect.Effect<string | undefined, CollaborationError>;
  readonly idle?: (
    session: Session,
  ) => Effect.Effect<boolean, CollaborationError>;
  readonly resumeOutbox?: (
    store: Effect.Success<ReturnType<typeof openOutbox>>,
    observation: typeof Status.Type,
  ) => Effect.Effect<void, CollaborationError>;
  readonly ready: (
    session: Session,
  ) => Effect.Effect<
    void,
    string | Error,
    ChildProcessSpawner.ChildProcessSpawner
  >;
}
const fail = (message: string) =>
  Effect.fail(new CollaborationError({ message }));
const history = (s: Session) =>
  Effect.tryPromise({
    try: () => s.getHistory({ limit: 4096, order: "asc", includeErrors: true }),
    catch: () =>
      new CollaborationError({
        message: "Current conversation history could not be read.",
      }),
  });
const assertExportable = (s: Session, update: Update) => {
  if (
    update.sessionUpdate === "tool_call_update" &&
    update.name &&
    protectedTool(update.name, update.rawInput, s)
  )
    return fail(
      "Protected tool data exists in a saved export plan; the immutable queue was preserved and export was blocked.",
    );
  const text = JSON.stringify(update);
  if (
    /<(?:skill_content|system-reminder|letta-memory|skill-body|system-prompt)\b/i.test(
      text,
    )
  )
    return fail(
      "Protected injected content exists in a saved export plan; export was blocked without resetting its producer sequence.",
    );
  return Effect.void;
};
const worktreeHistory = (reference: string) =>
  reference.replace(/^delta:\/\/worktree\//, "").split("#")[0];
const receipt = Schema.Record(Schema.String, Schema.Unknown);
export const makeCollaboration = (options: CollaborationOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const ownerScope = yield* Effect.scope;
    const scopes = new Map<string, Scope.Closeable>();
    const sessionScope = (s: Session) =>
      Effect.gen(function* () {
        const old = scopes.get(key(s));
        if (old) return old;
        const owned = yield* Scope.make();
        scopes.set(key(s), owned);
        yield* Effect.addFinalizer(() => Scope.close(owned, Exit.void)).pipe(
          Scope.provide(ownerScope),
        );
        return owned;
      });
    const gate = yield* Semaphore.make(1);
    yield* fs.makeDirectory(options.stateDirectory, {
      recursive: true,
      mode: 0o700,
    });
    type Live = {
      binding: Binding;
      session: Session;
      store: Effect.Success<ReturnType<typeof openOutbox>>;
      delivery: Effect.Success<ReturnType<typeof makeAppendDelivery>>;
      projection: Effect.Success<ReturnType<typeof makeWatchProjection>>;
      turn?: number;
      fenced: boolean;
      snapshotReady: boolean;
      snapshotFailure?: CollaborationError;
      tools: Map<string, number>;
      historyIds: Set<string>;
      modelContext: { id: string; text: string }[];
      offered?: ReadonlySet<string>;
      offeredOmitted?: number;
      remoteSeen: Set<string>;
    };
    const live = new Map<string, Live>();
    const failedActivations = new Set<string>();
    let closed = false;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true;
      }),
    );
    const key = (s: Session) => externalId(s.agentId, s.conversationId);
    const filename = (id: string) =>
      path.join(options.stateDirectory, `${encodeURIComponent(id)}.json`);
    const save = (b: Binding) =>
      Effect.gen(function* () {
        const target = filename(b.externalId);
        const text = yield* Schema.encodeEffect(Schema.fromJsonString(Binding))(
          b,
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fs.open(`${target}.tmp`, {
              flag: "w",
              mode: 0o600,
              noFollow: true,
            });
            yield* file.writeAll(new TextEncoder().encode(text));
            yield* file.sync;
          }),
        );
        yield* fs.rename(`${target}.tmp`, target);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const directory = yield* fs.open(options.stateDirectory, {
              flag: "r",
              noFollow: true,
            });
            yield* directory.sync;
          }),
        );
      }).pipe(Effect.uninterruptible);
    const load = (s: Session) =>
      Effect.gen(function* () {
        const file = filename(key(s));
        if (!(yield* fs.exists(file))) return undefined;
        return yield* Schema.decodeEffect(Schema.fromJsonString(Binding))(
          yield* fs.readFileString(file),
        );
      });
    const check = (s: Session) =>
      closed || ownerScope.state._tag === "Closed" || s.signal.aborted
        ? fail("Collaboration session is closed")
        : Effect.void;
    const command = <S extends Schema.Constraint>(
      s: Session,
      args: readonly string[],
      schema: S,
      form?: string,
    ) =>
      Effect.gen(function* () {
        yield* check(s);
        return yield* runJson(
          {
            executable: options.executable,
            cwd: s.cwd,
            args: ["--json", ...args],
            env: {
              DELTA_CLI_INTEGRATION: "letta_code",
              ...(form ? { DELTA_CLI_COMMAND_FORM: form } : {}),
            },
          },
          schema,
        );
      });
    const status = (s: Session, b: Binding) =>
      command(
        s,
        [
          "thread",
          "status",
          b.thread!,
          "--source",
          "letta-code",
          "--external-id",
          b.externalId,
        ],
        Status,
      );
    const mounts = new Map<
      string,
      { scope: Scope.Closeable; ready: Record<string, unknown> }
    >();
    const mountKey = (s: Session, args: readonly string[]) =>
      JSON.stringify([key(s), args]);
    const mount = (
      s: Session,
      args: readonly string[],
      validate: (v: Record<string, unknown>) => boolean,
      form?: string,
    ) =>
      Effect.gen(function* () {
        const parent = yield* sessionScope(s);
        const resourceKey = mountKey(s, args);
        const existing = mounts.get(resourceKey);
        if (existing) return existing.ready;
        const scope = yield* Scope.make();
        yield* Scope.addFinalizer(parent, Scope.close(scope, Exit.void));
        const ready = yield* Deferred.make<
          Record<string, unknown>,
          CollaborationError
        >();
        const process = watchJsonLines(
          {
            executable: options.executable,
            cwd: s.cwd,
            args: ["--json", ...args],
            timeoutMs: 86_400_000,
            env: {
              DELTA_CLI_INTEGRATION: "letta_code",
              ...(form ? { DELTA_CLI_COMMAND_FORM: form } : {}),
            },
          },
          receipt,
        ).pipe(
          Stream.tap((value) =>
            validate(value) ? Deferred.succeed(ready, value) : Effect.void,
          ),
          Stream.runDrain,
          Effect.onError(() =>
            Deferred.fail(
              ready,
              new CollaborationError({
                message:
                  "Delta mount failed before readiness; retry explicitly.",
              }),
            ),
          ),
          Effect.onExit(() =>
            Effect.sync(() => mounts.delete(resourceKey)).pipe(
              Effect.andThen(
                Deferred.fail(
                  ready,
                  new CollaborationError({
                    message: "Mount ended before readiness",
                  }),
                ),
              ),
            ),
          ),
        );
        const fiber = yield* Effect.forkIn(process, scope);
        const value = yield* Deferred.await(ready).pipe(
          Effect.timeout("120 seconds"),
          Effect.onError(() => Fiber.interrupt(fiber)),
        );
        mounts.set(resourceKey, { scope, ready: value });
        return value;
      });
    const reconcileIntents = (
      s: Session,
      store: Effect.Success<ReturnType<typeof openOutbox>>,
      binding: Binding,
    ) =>
      Effect.gen(function* () {
        const rows = [...(binding.snapshot ?? [])];
        const ids = new Set(
          rows.flatMap((value) => {
            const parsed = Schema.decodeUnknownOption(
              Schema.Struct({ id: Schema.String }),
            )(value);
            return parsed._tag === "Some" ? [parsed.value.id] : [];
          }),
        );
        const counts = new Map<string, number>();
        for (const input of rows) {
          const parsed = Schema.decodeUnknownOption(
            Schema.Struct({ id: Schema.String }),
          )(input);
          if (parsed._tag === "Some")
            counts.set(parsed.value.id, (counts.get(parsed.value.id) ?? 0) + 1);
        }
        for (let index = 0; index < rows.length; index++) {
          const input = rows[index];
          const row = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              id: Schema.String,
              update: RecordUpdate,
              turnSequence: Schema.optionalKey(Schema.Finite),
            }),
          )(input);
          yield* assertExportable(s, row.update);
          const body = {
            update: row.update,
            ...(row.turnSequence === undefined
              ? {}
              : { turnSequence: row.turnSequence }),
          };
          // Only resolve conflicts for the known legacy duplicate thought/answer
          // shape. Other conflicts remain errors rather than hiding corruption.
          const duplicate =
            (counts.get(row.id) ?? 0) > 1 &&
            (row.update.sessionUpdate === "agent_thought" ||
              row.update.sessionUpdate === "agent_message") &&
            row.update.messageId === row.id &&
            rows.some((other) => {
              const parsed = Schema.decodeUnknownOption(
                Schema.Struct({ id: Schema.String, update: RecordUpdate }),
              )(other);
              return (
                parsed._tag === "Some" &&
                parsed.value.id === row.id &&
                ((row.update.sessionUpdate === "agent_thought" &&
                  parsed.value.update.sessionUpdate === "agent_message") ||
                  (row.update.sessionUpdate === "agent_message" &&
                    parsed.value.update.sessionUpdate === "agent_thought"))
              );
            });
          const result = yield* Effect.result(
            store.stage(`history:${row.id}`, body),
          );
          if (result._tag === "Failure") {
            if (!duplicate || result.failure.kind !== "conflict")
              return yield* result.failure;
            let suffix = 1;
            let id = `${row.id}:legacy:${suffix}`;
            while (ids.has(id)) id = `${row.id}:legacy:${++suffix}`;
            ids.add(id);
            rows[index] = { ...row, id };
            binding = { ...binding, snapshot: rows };
            // Persist the new identity before staging, so a crash can replay it.
            yield* save(binding);
            yield* store.stage(`history:${id}`, body);
          }
        }
        for (const [id, tool] of Object.entries(binding.tools ?? {})) {
          if (tool.omitted || protectedTool(tool.name, tool.input, s)) continue;
          if (tool.input !== undefined)
            yield* store.stage(`tool:${id}:start`, {
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: id,
                name: tool.name,
                rawInput: tool.input,
                status: "in_progress",
              },
              turnSequence: tool.turn,
            });
          if (tool.output !== undefined)
            yield* store.stage(`tool:${id}:end`, {
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: id,
                name: tool.name,
                status: tool.status === "error" ? "failed" : "completed",
                rawOutput: tool.output,
              },
              turnSequence: tool.turn,
            });
        }
        if (binding.pendingIdle !== undefined)
          yield* store.stage(`turn:${binding.pendingIdle}:end`, {
            update: { sessionUpdate: "state_update", state: "idle" },
            turnSequence: binding.pendingIdle,
          });
        return binding;
      });
    const titleRow = Schema.Struct({
      id: Schema.String,
      update: Schema.Struct({
        sessionUpdate: Schema.Literal("session_info_update"),
        title: Schema.String,
      }),
      turnSequence: Schema.optionalKey(Schema.Finite),
    });
    const captureTitle = (s: Session, state: Live) =>
      Effect.gen(function* () {
        if (s.title == null) return;
        const previous = state.binding.snapshot
          ?.filter(Schema.is(titleRow))
          .at(-1);
        const row =
          previous?.update.title === s.title
            ? previous
            : {
                id: `title:${(yield* state.store.snapshot).nextSequence}`,
                update: {
                  sessionUpdate: "session_info_update" as const,
                  title: s.title,
                },
                // Delta rejects a turnSequence on session-scoped title records.
              };
        if (row !== previous) {
          state.binding = {
            ...state.binding,
            snapshot: [...(state.binding.snapshot ?? []), row],
          };
          yield* save(state.binding);
        }
        yield* state.store.stage(`history:${row.id}`, {
          update: row.update,
          ...(row.turnSequence === undefined
            ? {}
            : { turnSequence: row.turnSequence }),
        });
        state.historyIds.add(row.id);
      });
    const activate = (s: Session, binding: Binding) =>
      Effect.gen(function* () {
        const old = live.get(key(s));
        if (old) return old;
        const parent = yield* sessionScope(s);
        const scope = yield* Scope.make();
        return yield* Effect.gen(function* () {
          if (!binding.thread)
            return yield* fail("Binding has no thread; retry sharing");
          const root = path.join(
            options.stateDirectory,
            `${encodeURIComponent(binding.externalId)}.outbox`,
          );
          const store = yield* openOutbox({
            root,
            identity: {
              source: "letta-code",
              externalId: binding.externalId,
              threadId: binding.thread,
              scopeId: binding.owner,
            },
            mode: (yield* fs.exists(root)) ? "reopen" : "create",
          }).pipe(
            Scope.provide(scope),
            Effect.retry({
              times: 3,
              while: (error) => error.kind === "locked",
              schedule: Schedule.spaced("50 millis"),
            }),
          );
          yield* store.checkFrontier(yield* status(s, binding));
          const delivery = yield* makeAppendDelivery({
            executable: options.executable,
            cwd: s.cwd,
            reference: binding.thread,
            threadId: binding.thread,
            producerName: "Letta Code",
            acknowledgement: "local",
            transport: { env: { DELTA_CLI_INTEGRATION: "letta_code" } },
          }).pipe(
            Effect.provideService(ProducerOutbox, store),
            Scope.provide(scope),
          );
          const projection = yield* makeWatchProjection(binding.thread);
          const openingSnapshot = yield* store.snapshot;
          if (!openingSnapshot.paused)
            binding = yield* reconcileIntents(s, store, binding);
          const state: Live = {
            binding,
            session: s,
            store,
            delivery,
            projection,
            fenced: false,
            snapshotReady: false,
            modelContext: [...(binding.remoteContext ?? [])],
            remoteSeen: new Set(binding.remoteReceipts ?? []),
            tools: new Map(
              Object.entries(binding.tools ?? {}).map(([id, tool]) => [
                id,
                tool.turn,
              ]),
            ),
            historyIds: new Set(
              (binding.snapshot ?? []).flatMap((row) =>
                typeof row === "object" &&
                row !== null &&
                "id" in row &&
                typeof row.id === "string"
                  ? [row.id]
                  : [],
              ),
            ),
          };
          live.set(key(s), state);
          const watchAttempt = projection
            .project(
              watchCollaboration({
                executable: options.executable,
                cwd: s.cwd,
                thread: binding.thread!,
                externalId: binding.externalId,
              }),
            )
            .pipe(
              Stream.tap((update) =>
                Effect.gen(function* () {
                  if (!update.snapshotComplete) state.snapshotReady = false;
                  if (update.event.type === "ready") {
                    yield* store.checkFrontier(update.event);
                    if (
                      state.turn !== undefined &&
                      update.event.producer?.turn?.sequence === state.turn &&
                      update.event.producer.turn.status === "superseded"
                    )
                      state.fenced = true;
                  }
                  if (
                    update.event.type === "producer.turn" &&
                    update.event.sequence === state.turn &&
                    update.event.status === "superseded"
                  )
                    state.fenced = true;
                  if (update.snapshotComplete) {
                    const snapshot = yield* projection.snapshot;
                    yield* gate.withPermits(1)(
                      Effect.gen(function* () {
                        const delivery = remoteDelivery(
                          snapshot,
                          state.remoteSeen,
                          state.historyIds,
                        );
                        const context = [...state.modelContext];
                        let omitted = state.binding.remoteOmitted ?? 0;
                        if (delivery.model) {
                          context.push({
                            id: crypto.randomUUID(),
                            text: delivery.model,
                          });
                          while (
                            context.length > 1 &&
                            context.reduce(
                              (size, item) => size + item.text.length,
                              0,
                            ) > 399_992
                          ) {
                            context.shift();
                            omitted++;
                          }
                        }
                        const receipts = new Set([
                          ...state.remoteSeen,
                          ...delivery.receipts,
                        ]);
                        if (delivery.receipts.length) {
                          const binding = {
                            ...state.binding,
                            remoteReceipts: [...receipts],
                            remoteContext: context,
                            remoteOmitted: omitted,
                          };
                          yield* save(binding);
                          state.binding = binding;
                          state.modelContext = context;
                          state.remoteSeen = receipts;
                        }
                        for (const notice of delivery.human) s.notify(notice);
                      }),
                    );
                  }
                  if (update.snapshotComplete) {
                    state.snapshotReady = true;
                  }
                }),
              ),
              Stream.runDrain,
            );
          yield* Effect.forkIn(
            Effect.gen(function* () {
              for (let attempt = 0; attempt < 3; attempt++) {
                state.snapshotReady = false;
                const result = yield* watchAttempt.pipe(Effect.result);
                state.snapshotReady = false;
                if (scope.state._tag === "Closed") return;
                if (
                  result._tag === "Failure" &&
                  result.failure instanceof DeltaFailure &&
                  result.failure.error.retryable !== true
                ) {
                  state.snapshotFailure = new CollaborationError({
                    message:
                      "Delta refused the snapshot; recover or restore before starting a turn.",
                  });
                  if (result.failure.error.code === "reload_required")
                    yield* store.pauseForReload(result.failure.error);
                  s.notify(
                    "Delta watch paused. Open /delta to recover; running tools were not aborted.",
                  );
                  return;
                }
                if (attempt < 2) {
                  const requested =
                    result._tag === "Failure" &&
                    result.failure instanceof DeltaFailure
                      ? (result.failure.error.retry_after_ms ?? 0)
                      : 0;
                  if (requested > 30_000) {
                    s.notify(
                      "Delta requested a longer reconnect delay; use /delta to retry later.",
                    );
                    return;
                  }
                  yield* Effect.sleep(Math.max(1000 * 2 ** attempt, requested));
                }
              }
              s.notify(
                "Delta watch is offline after three reconnect attempts with the same producer. Use /delta to restore.",
              );
            }),
            scope,
          );
          failedActivations.delete(key(s));
          return state;
        }).pipe(
          Effect.onError(() =>
            Effect.gen(function* () {
              live.delete(key(s));
              failedActivations.add(key(s));
              yield* Scope.close(scope, Exit.void);
            }),
          ),
          Effect.tap(() =>
            Scope.addFinalizer(parent, Scope.close(scope, Exit.void)),
          ),
        );
      });
    const awaitSnapshot = (s: Session) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 500; attempt++) {
          const state = live.get(key(s));
          if (!state || state.snapshotReady) return;
          if (state.snapshotFailure) return yield* state.snapshotFailure;
          yield* Effect.sleep(10);
        }
        return yield* fail(
          "Delta snapshot is still pending; model/tool admission remains blocked. Retry restore when connected.",
        );
      });
    const append = (
      state: Live,
      id: string,
      update: Update,
      turn = state.turn,
    ) =>
      state.store.stage(id, {
        update,
        ...(turn === undefined ? {} : { turnSequence: turn }),
      });
    const flush = (state: Live) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 3; attempt++) {
          for (const pending of yield* state.store.replay) {
            const row = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ update: RecordUpdate }),
            )(JSON.parse(pending.line));
            yield* assertExportable(state.session, row.update);
          }
          const result = yield* state.delivery.attempt.pipe(Effect.result);
          const snapshot = yield* state.store.snapshot;
          if (state.turn !== undefined && snapshot.fenced.includes(state.turn))
            state.fenced = true;
          if (result._tag === "Success") return result.success;
          const failure = result.failure;
          if (
            !(failure instanceof DeliveryAttemptError) ||
            failure.retry.kind !== "retry" ||
            failure.retry.afterMs > 30_000 ||
            attempt === 2
          )
            return yield* failure;
          yield* Effect.sleep(failure.retry.afterMs);
        }
        return yield* fail(
          "Delta append retries exhausted; immutable records remain queued.",
        );
      });
    const releaseSession = (s: Session) =>
      Effect.suspend(() => {
        const state = live.get(key(s));
        const owned = scopes.get(key(s));
        scopes.delete(key(s));
        live.delete(key(s));
        return Effect.gen(function* () {
          if (!state) return;
          state.binding = {
            ...state.binding,
            remoteReceipts: [...state.remoteSeen],
            remoteContext: [...state.modelContext],
          };
          yield* save(state.binding);
          const pending = yield* state.store.snapshot;
          if (pending.pending.length || pending.paused)
            s.notify(
              "Delta records remain durably queued. Mount release asks Delta to finish uploading; local checkouts are preserved.",
            );
        }).pipe(
          Effect.ensuring(owned ? Scope.close(owned, Exit.void) : Effect.void),
        );
      });
    const share = (
      s: Session,
      emails: readonly string[] = [],
      _form?: string,
      confirmedAudience?: ShareAudience,
    ) =>
      gate
        .withPermits(1)(
          Effect.gen(function* () {
            yield* options.ready(s).pipe(
              Effect.mapError(
                () =>
                  new CollaborationError({
                    message:
                      "Delta is not ready. Complete installation/sign-in with /delta, then retry.",
                  }),
              ),
            );
            yield* negotiate(
              yield* command(s, ["thread", "contract"], Contract),
            );
            const root = yield* checkoutRoot(s);
            const settings = path.join(root, ".delta", "settings.json");
            const policy = (yield* readProjectPolicy(
              (yield* fs.exists(settings))
                ? yield* fs.readFileString(settings)
                : undefined,
            )).policy;
            let binding = yield* load(s);
            if (binding && binding.cwd !== root)
              return yield* fail(
                "This session is bound to a different checkout. Its original checkout and outbox were preserved.",
              );
            const directory = options.organization
              ? undefined
              : yield* command(s, ["org", "list"], Organizations);
            const currentOrganization =
              directory?.organizations.find((org) => org.current) ??
              directory?.organizations[0];
            const organization =
              binding?.organization ??
              policy.organization ??
              confirmedAudience?.organization ??
              (options.organization
                ? yield* options.organization(s)
                : currentOrganization?.id);
            if (!s.interactive && !confirmedAudience)
              return yield* fail(
                "Sharing requires interactive consent or a previously confirmed automatic repository policy.",
              );
            let requestedEmails = [...emails];
            let audience =
              confirmedAudience?.visibility ??
              (yield* options.interaction.ask(s, {
                title: "Delta share",
                message:
                  "Delta uploads this conversation and nonignored checkout files, including staged, unstaged and untracked changes, to DeltaDB. Choose who can access them.",
                choices: [
                  ...(organization &&
                  !directory?.organizations.find(
                    (org) => org.id === organization,
                  )?.personal
                    ? [
                        {
                          value: "organization",
                          label: `Share with ${organization}`,
                        },
                      ]
                    : []),
                  {
                    value: binding?.uploaded ? "unchanged" : "private",
                    label: binding?.uploaded
                      ? "Keep current sharing"
                      : "Sync privately",
                  },
                  ...(emails.length
                    ? [
                        {
                          value: "invite",
                          label: `Invite ${emails.join(", ")}`,
                        },
                      ]
                    : []),
                  { value: "cancel", label: "Cancel" },
                ],
                allowText: true,
              }));
            if (!audience || audience === "cancel") return;
            if (binding?.uploaded && audience === "private")
              audience = "unchanged";
            if (
              !["organization", "private", "unchanged", "invite"].includes(
                audience,
              )
            ) {
              requestedEmails = audience
                .split(/[\s,;]+/)
                .filter((email) => /^[^@\s]+@[^@\s]+$/.test(email));
              if (requestedEmails.length) audience = "invite";
            }
            if (!s.interactive && !confirmedAudience)
              return yield* fail(
                "Sharing requires interactive consent or a previously confirmed automatic repository policy.",
              );
            if (live.get(key(s))?.turn !== undefined)
              return yield* fail("Finish the current turn before sharing.");
            if (live.has(key(s))) {
              yield* releaseSession(s);
              binding = yield* load(s);
            }
            if (audience === "private" && !organization)
              return yield* fail(
                "Choose a Delta organization with /delta-org before private sync.",
              );
            if (
              !["organization", "private", "unchanged", "invite"].includes(
                audience,
              )
            )
              return yield* fail("Invalid sharing audience");
            if (!binding) {
              binding = {
                version: 1,
                agent: s.agentId,
                conversation: s.conversationId,
                cwd: root,
                externalId: key(s),
                owner: crypto.randomUUID(),
                snapshotDone: false,
                uploaded: false,
              };
              yield* save(binding);
            }
            if (!binding.thread) {
              const created = yield* command(
                s,
                [
                  "thread",
                  "create",
                  "--source",
                  "letta-code",
                  "--external-id",
                  binding.externalId,
                  ...(organization
                    ? [
                        "--organization",
                        organization,
                        "--visibility",
                        "private",
                      ]
                    : []),
                ],
                Created,
              );
              if (typeof created.thread_id !== "string")
                return yield* fail("Invalid thread creation receipt");
              binding = {
                ...binding,
                thread: created.thread_id,
                ...(organization ? { organization } : {}),
              };
              yield* save(binding);
            }
            if (!binding.worktree) {
              const listed = yield* command(
                s,
                ["worktree", "list"],
                Schema.Struct({
                  operation: Schema.Literal("listed"),
                  worktrees: Schema.Array(
                    Schema.Struct({
                      reference: Schema.String,
                      directories: Schema.Array(
                        Schema.Struct({ directory: Schema.String }),
                      ),
                    }),
                  ),
                }),
              );
              const matches = listed.worktrees.filter((tree) =>
                tree.directories.some((d) => d.directory === root),
              );
              if (matches.length > 1)
                return yield* fail(
                  "Several Delta worktrees identify this checkout; resolve this in Delta before retrying.",
                );
              const tree =
                matches[0] ??
                (yield* command(
                  s,
                  ["worktree", "create", root],
                  WorktreeCreated,
                ));
              if (typeof tree.reference !== "string")
                return yield* fail("Invalid worktree creation receipt");
              binding = { ...binding, worktree: tree.reference };
              yield* save(binding);
            }
            /* owned checkout identity is durable before attachment */
            const attached = yield* command(
              s,
              [
                "worktree",
                "attach",
                binding.worktree!,
                "--thread",
                binding.thread!,
              ],
              Attached,
            );
            if (
              attached.thread_id !== binding.thread ||
              worktreeHistory(attached.reference) !==
                worktreeHistory(binding.worktree!)
            )
              return yield* fail(
                "Attachment receipt differs from the saved binding.",
              );
            if (!live.has(key(s)))
              yield* mount(
                s,
                [
                  "worktree",
                  "mount",
                  binding.worktree!,
                  root,
                  "--existing-checkout",
                ],
                (v) =>
                  Schema.is(CheckoutMounted)(v) &&
                  typeof v.reference === "string" &&
                  worktreeHistory(v.reference) ===
                    worktreeHistory(binding!.worktree!) &&
                  v.directory === root,
              );
            const state = yield* activate(s, binding);
            if (!binding.snapshotDone) {
              if (!binding.snapshot) {
                binding = {
                  ...binding,
                  snapshot: snapshotUpdates(yield* history(s), s).map(
                    (row) => ({
                      id: row.id,
                      update: row.update,
                    }),
                  ),
                };
                yield* save(binding);
              }
              for (const input of binding.snapshot!) {
                const row = yield* Schema.decodeUnknownEffect(
                  Schema.Struct({ id: Schema.String, update: RecordUpdate }),
                )(input);
                yield* state.store.stage(`history:${row.id}`, {
                  update: row.update,
                });
                state.historyIds.add(row.id);
              }
              binding = { ...binding, snapshotDone: true };
              yield* save(binding);
              state.binding = binding;
            }
            yield* captureTitle(s, state);
            yield* flush(state);
            if (
              audience === "organization" ||
              (audience === "unchanged" &&
                binding.visibility === "organization")
            ) {
              const published = yield* command(
                s,
                [
                  "thread",
                  "share",
                  binding.thread!,
                  "--visibility",
                  "organization",
                ],
                Published,
                _form,
              );
              if (published.thread_id !== binding.thread)
                return yield* fail(
                  "Publication receipt differs from the saved binding.",
                );
            }
            if (audience === "invite") {
              const invited = yield* command(
                s,
                ["thread", "invite", binding.thread!, "--", ...requestedEmails],
                Invitations,
                _form,
              );
              if (invited.thread_id !== binding.thread)
                return yield* fail(
                  "Invitation receipt differs from the saved thread.",
                );
              for (const result of invited.results)
                s.notify(
                  `${result.email}: ${result.status}${result.message ? ` (${result.message})` : result.reason ? ` (${result.reason})` : ""}`,
                );
            }
            binding = {
              ...state.binding,
              uploaded: true,
              ...(audience === "organization"
                ? { visibility: "organization" as const }
                : audience === "private"
                  ? { visibility: "private" as const }
                  : {}),
            };
            yield* save(binding);
            state.binding = binding;
            const observed = yield* status(s, binding);
            const link = observed.url ?? binding.thread;
            s.notify(`Delta thread: ${link}`);
            return link;
          }),
        )
        .pipe(
          Effect.tap((result) =>
            result === undefined ? Effect.void : awaitSnapshot(s),
          ),
        );
    const join = (s: Session, locator?: string, _form?: string) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          yield* options.ready(s).pipe(
            Effect.mapError(
              () =>
                new CollaborationError({
                  message:
                    "Delta is not ready. Complete installation/sign-in with /delta, then retry.",
                }),
            ),
          );
          if (
            live.get(key(s))?.turn !== undefined ||
            (options.idle && !(yield* options.idle(s)))
          )
            return yield* fail(
              "Finish the active turn and running children before joining.",
            );
          if (!options.idle)
            return yield* fail(
              "Join requires the adapter to verify active turns and background children through public context.",
            );
          const reference =
            locator ??
            (yield* options.interaction.ask(s, {
              title: "Join Delta",
              message:
                "Enter a Delta thread link. Joining prepares a new Letta session; this conversation stays unchanged.",
              choices: [],
              allowText: true,
            }));
          if (!reference) return;
          if (!s.interactive)
            return yield* fail("Join requires an interactive handoff surface.");
          const inspected = yield* command(
            s,
            [
              "thread",
              "status",
              reference,
              "--source",
              "letta-code",
              "--external-id",
              key(s),
            ],
            Status,
          );
          if (inspected.access.state !== "granted")
            return yield* fail(
              "Sign in with an account that has access to this thread.",
            );
          if (
            inspected.worktrees.status !== "available" ||
            !inspected.worktrees.items.length
          )
            return yield* fail(
              "Thread worktrees are unavailable or empty; retry when ready.",
            );
          const requestPath = filename(`join:${key(s)}`);
          const previous = (yield* fs.exists(requestPath))
            ? yield* Schema.decodeEffect(Schema.fromJsonString(Binding))(
                yield* fs.readFileString(requestPath),
              )
            : undefined;
          const now = yield* Clock.currentTimeMillis;
          const token =
            previous?.pending?.locator === reference &&
            now - previous.pending.created < 300_000 &&
            !(yield* fs.exists(
              `${filename(`handoff:${previous.pending.token}`)}.claim`,
            ))
              ? previous.pending.token
              : crypto.randomUUID();
          let pending: Binding =
            previous?.pending?.token === token
              ? previous
              : {
                  version: 1,
                  agent: s.agentId,
                  conversation: s.conversationId,
                  cwd: s.cwd,
                  externalId: `handoff:${token}`,
                  owner: crypto.randomUUID(),
                  thread: inspected.thread_id,
                  snapshotDone: true,
                  uploaded: true,
                  pending: {
                    token,
                    locator: reference,
                    claimed: false,
                    created: now,
                  },
                };
          pending = { ...pending, externalId: `handoff:${token}` };
          yield* save(pending);
          yield* save({ ...pending, externalId: `join:${key(s)}` });
          const mounted = yield* mount(
            s,
            ["thread", "mount", reference, "--owner", pending.owner, "--join"],
            (v) =>
              Schema.is(Mounted)(v) &&
              v.thread_id === inspected.thread_id &&
              v.owner === pending.owner,
            _form,
          );
          const mountReceipt =
            yield* Schema.decodeUnknownEffect(Mounted)(mounted);
          const readyStatus = yield* command(
            s,
            [
              "thread",
              "status",
              inspected.thread_id,
              "--source",
              "letta-code",
              "--external-id",
              key(s),
            ],
            Status,
          );
          if (
            readyStatus.access.state !== "granted" ||
            readyStatus.worktrees.status !== "available"
          )
            return yield* fail("Joined worktrees are not available.");
          const available = readyStatus.worktrees.items;
          if (
            mountReceipt.worktrees.some(
              (tree) =>
                !available.some(
                  (remote) =>
                    remote.reference === tree.reference &&
                    remote.checkouts.some(
                      (checkout) =>
                        checkout.directory === tree.directory &&
                        checkout.active === true &&
                        ["attached", "detached"].includes(checkout.state),
                    ),
                ),
            )
          )
            return yield* fail(
              "Joined worktrees are not ready; the pending join is preserved for retry.",
            );
          if (
            pending.pending?.directory &&
            pending.pending.directory !== mountReceipt.directory
          )
            return yield* fail(
              "The pending join moved directories; its old scope was preserved.",
            );
          pending = {
            ...pending,
            pending: { ...pending.pending!, directory: mountReceipt.directory },
          };
          yield* save(pending);
          yield* save({ ...pending, externalId: `join:${key(s)}` });
          const pendingMount = mounts.get(
            mountKey(s, [
              "thread",
              "mount",
              reference,
              "--owner",
              pending.owner,
              "--join",
            ]),
          );
          if (pendingMount)
            yield* Effect.forkIn(
              Effect.sleep("5 minutes").pipe(
                Effect.andThen(
                  Effect.gen(function* () {
                    if (
                      !(yield* fs.exists(
                        `${filename(`handoff:${token}`)}.claim`,
                      ))
                    ) {
                      yield* Scope.close(pendingMount.scope, Exit.void);
                      s.notify(
                        "Delta join handoff expired; retry /delta-join to mount it again.",
                      );
                    }
                  }),
                ),
              ),
              yield* sessionScope(s),
            );
          const commandLine = launchCommand(
            pending.pending!.directory!,
            token,
            s.agentId,
          );
          s.notify(
            `Open a NEW Letta session with this command. Your current session has not switched:\n${commandLine}`,
          );
          return {
            token,
            directory: pending.pending!.directory!,
            command: commandLine,
          };
        }),
      );
    const restore = (s: Session, token?: string, fresh = false) =>
      gate
        .withPermits(1)(
          Effect.gen(function* () {
            let binding = yield* load(s);
            if (token) {
              if (!fresh || binding)
                return yield* fail(
                  "Handoff requires an explicitly fresh, unbound session.",
                );
              if (snapshotUpdates(yield* history(s), s).length)
                return yield* fail(
                  "A handoff can only be adopted in a fresh conversation without authored history.",
                );
              const file = filename(`handoff:${token}`);
              const handoff = yield* Schema.decodeEffect(
                Schema.fromJsonString(Binding),
              )(yield* fs.readFileString(file));
              if (
                !handoff.pending ||
                handoff.agent !== s.agentId ||
                handoff.pending.token !== token ||
                handoff.pending.claimed ||
                (yield* Clock.currentTimeMillis) - handoff.pending.created >
                  300_000 ||
                handoff.pending.directory !== s.cwd
              )
                return yield* fail(
                  "Invalid, consumed, or wrong-directory handoff token.",
                );
              yield* fs.makeDirectory(`${file}.claim`, { mode: 0o700 });
              yield* save({
                ...handoff,
                pending: { ...handoff.pending, claimed: true },
              });
              binding = {
                ...handoff,
                agent: s.agentId,
                conversation: s.conversationId,
                externalId: key(s),
                cwd: s.cwd,
              };
              yield* save(binding);
            }
            if (!binding?.thread) return;
            if (live.get(key(s))?.turn !== undefined)
              return yield* fail(
                "Finish the current turn before restoring Delta.",
              );
            if (live.has(key(s))) {
              yield* releaseSession(s);
              binding = yield* load(s);
            }
            if (!binding?.thread) return;
            yield* options.ready(s).pipe(
              Effect.mapError(
                () =>
                  new CollaborationError({
                    message:
                      "Delta is not ready. Complete installation/sign-in with /delta, then retry.",
                  }),
              ),
            );
            if (!binding.worktree)
              yield* mount(
                s,
                ["thread", "mount", binding.thread, "--owner", binding.owner],
                (v) =>
                  v.operation === "mounted" &&
                  v.owner === binding!.owner &&
                  v.directory === s.cwd,
              );
            else
              yield* mount(
                s,
                [
                  "worktree",
                  "mount",
                  binding.worktree,
                  binding.cwd,
                  "--existing-checkout",
                ],
                (v) =>
                  v.directory === binding!.cwd &&
                  typeof v.reference === "string" &&
                  worktreeHistory(v.reference) ===
                    worktreeHistory(binding!.worktree!),
              );
            const state = yield* activate(s, binding);
            return yield* flush(state);
          }),
        )
        .pipe(Effect.tap(() => awaitSnapshot(s)));
    const turnStart = (s: Session) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          yield* check(s);
          const state = live.get(key(s));
          if (!state) {
            if (failedActivations.has(key(s)))
              return {
                cancel: {
                  reason:
                    "Delta activation failed; restore before starting a turn.",
                },
              };
            return;
          }
          if (!state.snapshotReady)
            return {
              cancel: {
                reason:
                  "Delta is waiting for a fresh complete snapshot; retry after synchronization.",
              },
            };
          const snapshot = yield* state.store.snapshot;
          if (state.fenced || snapshot.paused)
            return {
              cancel: {
                reason:
                  "Delta recording is fenced or paused; restore or recover before continuing.",
              },
            };
          const row = yield* state.store.stage(
            `turn:${snapshot.nextSequence}`,
            {
              update: { sessionUpdate: "state_update", state: "running" },
              turnSequence: snapshot.nextSequence,
            },
          );
          state.turn = row.sequence;
          yield* flush(state);
          if (state.fenced || (yield* state.store.snapshot).paused)
            return {
              cancel: {
                reason:
                  "Delta fenced this turn. Already running work cannot be cancelled by this mod.",
              },
            };
          return;
        }),
      );
    const toolStart = (
      s: Session,
      event: {
        toolCallId: string | null;
        toolName: string;
        args: Record<string, unknown>;
      },
    ) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          const state = live.get(key(s));
          if (!state) {
            if (failedActivations.has(key(s)))
              return {
                result: {
                  status: "error" as const,
                  output:
                    "Delta activation failed; restore before admitting tools.",
                },
              };
            return;
          }
          if (!state.snapshotReady)
            return {
              result: {
                status: "error" as const,
                output:
                  "Delta snapshot is pending or offline; tool admission is blocked. Existing tools were not aborted.",
              },
            };
          if (state.fenced || (yield* state.store.snapshot).paused)
            return {
              result: {
                status: "error" as const,
                output:
                  "Delta fenced future tool admission. Existing work was not aborted.",
              },
            };
          if (event.toolCallId && state.turn !== undefined) {
            if (state.binding.tools?.[event.toolCallId]) return;
            const omitted = protectedTool(event.toolName, event.args, s);
            state.binding = {
              ...state.binding,
              tools: {
                ...state.binding.tools,
                [event.toolCallId]: {
                  turn: state.turn,
                  name: event.toolName,
                  omitted,
                  ended: false,
                  ...(!omitted
                    ? { input: JSON.parse(JSON.stringify(event.args)) }
                    : {}),
                },
              },
            };
            yield* save(state.binding);
            state.tools.set(event.toolCallId, state.turn);
            if (!omitted)
              yield* append(state, `tool:${event.toolCallId}:start`, {
                sessionUpdate: "tool_call_update",
                toolCallId: event.toolCallId,
                name: event.toolName,
                rawInput: JSON.parse(JSON.stringify(event.args)),
                status: "in_progress",
              });
          }
          return;
        }),
      );
    const completeTool = (
      state: Live,
      id: string,
      output: Schema.Json,
      status: "success" | "error",
    ) =>
      Effect.gen(function* () {
        const tool = state.binding.tools?.[id];
        if (!tool)
          return yield* fail(
            "Tool output has no observed original turn; it remains unexported.",
          );
        if (tool.omitted || tool.ended) return;
        const keptOutput = tool.output ?? output;
        const keptStatus = tool.status ?? status;
        state.binding = {
          ...state.binding,
          tools: {
            ...state.binding.tools,
            [id]: { ...tool, output: keptOutput, status: keptStatus },
          },
        };
        yield* save(state.binding);
        yield* append(
          state,
          `tool:${id}:end`,
          {
            sessionUpdate: "tool_call_update",
            toolCallId: id,
            name: tool.name,
            status: keptStatus === "success" ? "completed" : "failed",
            rawOutput: keptOutput,
          },
          tool.turn,
        );
        state.binding = {
          ...state.binding,
          tools: {
            ...state.binding.tools,
            [id]: { ...state.binding.tools![id]!, ended: true },
          },
        };
        yield* save(state.binding);
      });
    const toolEnd = (
      s: Session,
      event: {
        toolCallId: string | null;
        toolName: string;
        status: "success" | "error";
        output: string;
      },
    ) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          const state = live.get(key(s));
          if (!state || !event.toolCallId) return;
          yield* completeTool(
            state,
            event.toolCallId,
            cleanText(event.output),
            event.status,
          );
          yield* flush(state);
        }),
      );
    const turnEnd = (s: Session) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          const state = live.get(key(s));
          if (!state || state.turn === undefined) return;
          yield* captureTitle(s, state);
          const messages = yield* history(s);
          const captured = snapshotUpdates(messages, s);
          for (const row of captured) {
            const update = row.update;
            if (
              update.sessionUpdate === "tool_call_update" &&
              state.binding.tools?.[update.toolCallId] &&
              update.status !== "in_progress" &&
              update.rawOutput !== undefined
            )
              yield* completeTool(
                state,
                update.toolCallId,
                update.rawOutput,
                update.status === "failed" ? "error" : "success",
              );
          }
          // Older snapshots used the unsuffixed message ID for thoughts. Keep
          // those immutable identities and give a newly observed answer its own.
          const legacyThoughts = new Set(
            (state.binding.snapshot ?? []).flatMap((input) => {
              const parsed = Schema.decodeUnknownOption(
                Schema.Struct({ id: Schema.String, update: RecordUpdate }),
              )(input);
              if (parsed._tag === "None") return [];
              const row = parsed.value;
              return row.update.sessionUpdate === "agent_thought" &&
                row.id === row.update.messageId
                ? [row.id]
                : [];
            }),
          );
          const additions = captured
            .map((row) => {
              if (
                row.update.sessionUpdate === "agent_thought" &&
                legacyThoughts.has(row.update.messageId ?? "")
              )
                return { ...row, id: row.update.messageId! };
              if (
                row.update.sessionUpdate === "agent_message" &&
                legacyThoughts.has(row.id)
              )
                return { ...row, id: `${row.id}:message` };
              return row;
            })
            .filter((row) => {
              if (state.historyIds.has(row.id)) return false;
              const update = row.update;
              if (
                (update.sessionUpdate === "agent_message" ||
                  update.sessionUpdate === "agent_thought") &&
                (state.binding.snapshot ?? []).some((input) => {
                  const parsed = Schema.decodeUnknownOption(
                    Schema.Struct({ update: RecordUpdate }),
                  )(input);
                  return (
                    parsed._tag === "Some" &&
                    parsed.value.update.sessionUpdate ===
                      update.sessionUpdate &&
                    parsed.value.update.messageId === update.messageId
                  );
                })
              )
                return false;
              const observed =
                update.sessionUpdate === "tool_call_update"
                  ? state.binding.tools?.[update.toolCallId]
                  : undefined;
              return !observed;
            });
          state.binding = {
            ...state.binding,
            snapshot: [
              ...(state.binding.snapshot ?? []),
              ...additions.map((row) => ({ ...row, turnSequence: state.turn })),
            ],
          };
          yield* save(state.binding);
          for (const row of additions) {
            yield* append(state, `history:${row.id}`, row.update);
            state.historyIds.add(row.id);
          }
          state.binding = { ...state.binding, pendingIdle: state.turn };
          yield* save(state.binding);
          yield* append(state, `turn:${state.turn}:end`, {
            sessionUpdate: "state_update",
            state: "idle",
          });
          delete state.turn;
          const { pendingIdle: _, ...finished } = state.binding;
          state.binding = finished;
          yield* save(finished);
          yield* flush(state);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              const state = live.get(key(s));
              if (state) delete state.turn;
            }),
          ),
        ),
      );
    const recover = (s: Session, choice?: "fork" | "discard" | "restore") =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          const binding = yield* load(s);
          if (!binding?.thread)
            return yield* fail("There is no saved Delta thread to recover.");
          const state = live.get(key(s)) ?? (yield* activate(s, binding));
          const snapshot = yield* state.store.snapshot;
          if (!snapshot.paused) {
            yield* flush(state);
            if (state.binding.recovery?.phase === "discarded") {
              const { recovery: _, ...finished } = state.binding;
              state.binding = finished;
              yield* save(finished);
            }
            return;
          }
          if (!options.resumeOutbox)
            return yield* fail(
              "The core outbox has no durable resume operation yet. The paused journal and unresolved records remain intact; do not reset its producer sequence.",
            );
          const selected =
            choice ??
            (yield* options.interaction.ask(s, {
              title: "Recover Delta",
              message:
                "Delta refused offline changes. Fork & Restore keeps those changes in a separate thread before restoring this thread from the server. Discard permanently discards those Delta offline changes. The immutable local records stay queued.",
              choices: [
                { value: "fork", label: "Fork & Restore" },
                { value: "discard", label: "Discard offline changes" },
                { value: "cancel", label: "Cancel" },
              ],
            }));
          if (!selected || selected === "cancel") return;
          if (selected === "restore")
            return yield* fail(
              "Choose Fork & Restore or Discard explicitly before restoring a reload-required thread.",
            );
          if (selected !== "fork" && selected !== "discard")
            return yield* fail("Unknown recovery choice.");
          let plan = state.binding.recovery;
          if (plan && plan.choice !== selected)
            return yield* fail(
              "A recovery is already pending; complete the saved choice before changing it.",
            );
          if (!plan) {
            plan = { choice: selected, phase: "planned" };
            state.binding = { ...state.binding, recovery: plan };
            yield* save(state.binding);
          }
          if (plan.phase === "fork-started" || plan.phase === "discard-started")
            return yield* fail(
              "The previous recovery mutation has an ambiguous outcome. Inspect the thread in Delta before reconciling it; it will not be retried blindly.",
            );
          if (plan.choice === "fork" && plan.phase === "planned") {
            state.binding = {
              ...state.binding,
              recovery: { ...plan, phase: "fork-started" },
            };
            yield* save(state.binding);
            const forked = yield* command(
              s,
              ["thread", "fork", binding.thread],
              Schema.Struct({
                thread_id: Schema.String.check(Schema.isMinLength(1)),
              }),
            );
            plan = { ...plan, phase: "forked", forked: forked.thread_id };
            state.binding = { ...state.binding, recovery: plan };
            yield* save(state.binding);
          }
          if (plan.phase !== "discarded") {
            state.binding = {
              ...state.binding,
              recovery: { ...plan, phase: "discard-started" },
            };
            yield* save(state.binding);
            yield* command(
              s,
              ["thread", "discard", binding.thread, "--force"],
              receipt,
            );
            plan = { ...plan, phase: "discarded" };
            state.binding = { ...state.binding, recovery: plan };
            yield* save(state.binding);
          }
          yield* options.resumeOutbox(
            state.store,
            yield* status(s, state.binding),
          );
          state.binding = yield* reconcileIntents(
            s,
            state.store,
            state.binding,
          );
          state.fenced = false;
          yield* flush(state);
          if (plan.forked)
            s.notify(
              `Delta kept the refused offline changes in thread ${plan.forked}.`,
            );
          const { recovery: _, ...restored } = state.binding;
          state.binding = restored;
          yield* save(restored);
        }),
      );
    const menu = (s: Session) =>
      options.interaction
        .ask(s, {
          title: "Delta",
          message:
            "Share this conversation, join in a new session, restore the current binding, or resolve refused offline changes.",
          choices: [
            { value: "share", label: "Share" },
            { value: "join", label: "Join" },
            { value: "restore", label: "Restore" },
            { value: "recover", label: "Recover offline changes" },
          ],
        })
        .pipe(
          Effect.flatMap((answer) =>
            answer === "share"
              ? share(s).pipe(Effect.asVoid)
              : answer === "join"
                ? join(s).pipe(Effect.asVoid)
                : answer === "restore"
                  ? restore(s).pipe(Effect.asVoid)
                  : answer === "recover"
                    ? recover(s)
                    : Effect.void,
          ),
        );
    const takeContext = (s: Session) =>
      gate.withPermits(1)(
        Effect.sync(() => {
          const state = live.get(key(s));
          if (!state) return "";
          state.offered = new Set(state.modelContext.map((item) => item.id));
          state.offeredOmitted = state.binding.remoteOmitted ?? 0;
          const selected: string[] = [];
          let remaining = 399_000;
          let shortened = false;
          for (const item of [...state.modelContext].reverse()) {
            if (item.text.length > remaining && selected.length) break;
            const text = item.text.slice(0, remaining);
            shortened ||= text.length !== item.text.length;
            selected.unshift(text);
            remaining -= text.length + 2;
            if (remaining <= 0) break;
          }
          const omitted =
            state.offeredOmitted + state.modelContext.length - selected.length;
          const note = [
            omitted
              ? `${omitted} earlier Delta context updates omitted to fit the context limit.`
              : "",
            shortened
              ? "The newest Delta context update was shortened to fit the limit."
              : "",
            omitted || shortened
              ? "Open the Delta thread's full history for omitted details."
              : "",
          ]
            .filter(Boolean)
            .join(" ");
          const context = [note, ...selected].filter(Boolean).join("\n\n");
          return context ? `[Delta]\n${context}` : "";
        }),
      );
    /** Call only after observing a completed model turn that received takeContext. */
    const ackContext = (s: Session) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          const state = live.get(key(s));
          if (!state?.offered) return;
          const remaining = state.modelContext.filter(
            (item) => !state.offered!.has(item.id),
          );
          const binding = {
            ...state.binding,
            remoteContext: remaining,
            remoteOmitted: Math.max(
              0,
              (state.binding.remoteOmitted ?? 0) - (state.offeredOmitted ?? 0),
            ),
          };
          yield* save(binding);
          state.binding = binding;
          state.modelContext = remaining;
          delete state.offered;
          delete state.offeredOmitted;
        }),
      );
    const autoStart = (s: Session) =>
      Effect.gen(function* () {
        if (yield* load(s)) return yield* restore(s).pipe(Effect.asVoid);
        const audience = yield* automaticPolicy(s);
        if (audience) yield* share(s, [], undefined, audience);
      });
    return {
      share,
      autoStart,
      takeContext,
      ackContext,
      join,
      restore,
      menu,
      turnStart,
      turnEnd,
      toolStart,
      toolEnd,
      recover,
      close: (s: Session) => gate.withPermits(1)(releaseSession(s)),
      drainRemoteContext: takeContext,
      onOpen: (s: Session, opening: { token?: string; fresh?: boolean } = {}) =>
        restore(s, opening.token, opening.fresh ?? false),
      remoteSnapshot: (
        s: Session,
      ): Effect.Effect<WatchProjectionState | undefined> =>
        live.get(key(s))?.projection.snapshot ?? Effect.succeed(undefined),
    };
  });
