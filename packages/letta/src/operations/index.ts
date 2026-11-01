import { classifyModInstallation } from "./installation.js";
import { homedir } from "node:os";
export {
  classifyModInstallation,
  type ModInstallation,
} from "./installation.js";
import { runProgress } from "./progress.js";
import { ErrorDetail, negotiate } from "../../../core/src/protocol.js";
import { installWindows } from "./windows-install.js";
// AGPL-3.0-only; workflow semantics adapted from pinned delta-claude hooks.
import {
  Semaphore,
  Clock,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Path,
  Schema,
} from "effect";
import { discover } from "../discovery.js";
import { runText } from "../process.js";
import type { Interaction, Question, Session } from "../session.js";
import {
  readProjectPolicy,
  serializeProjectPolicy,
  ThreadMode,
} from "../../../core/src/project-policy.js";
import type { ProcessRequest } from "../../../core/src/transport-errors.js";

export class OperationError extends Schema.TaggedError<
  OperationError,
  { readonly brand: unique symbol }
>()("OperationError", {
  kind: Schema.Literals([
    "access",
    "terms",
    "cancelled",
    "invalid",
    "io",
    "busy",
    "stale",
    "unsupported",
  ]),
  message: Schema.String,
  code: Schema.optional(Schema.String),
  retryable: Schema.optional(Schema.Boolean),
}) {}
const failure = (kind: OperationError["kind"], message: string) =>
  new OperationError({ kind, message });
export interface OperationFiles {
  readonly read: (
    path: string,
  ) => Effect.Effect<string | undefined, OperationError>;
  readonly write: (
    path: string,
    text: string,
  ) => Effect.Effect<void, OperationError>;
}
const makeFiles = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const storage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError(() => failure("io", "Cannot access Delta settings.")),
    );
  const read = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(undefined),
      ),
      Effect.mapError(() => failure("io", "Cannot read Delta settings.")),
    );
  const write = (file: string, text: string) =>
    storage(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = path.dirname(file);
          yield* fs.makeDirectory(directory, { recursive: true });
          const temporary = yield* fs.makeTempDirectoryScoped({
            directory,
            prefix: ".delta-write-",
          });
          const staged = path.join(temporary, "settings");
          yield* Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* fs.open(staged, {
                flag: "wx",
                mode: 0o600,
                noFollow: true,
              });
              yield* handle.writeAll(new TextEncoder().encode(text));
              yield* handle.sync;
            }),
          );
          yield* Effect.uninterruptible(fs.rename(staged, file));
        }),
      ),
    );
  return { read, write } satisfies OperationFiles;
});
export interface OperationsOptions {
  readonly interaction: Interaction;
  readonly platform?: NodeJS.Platform;
  readonly discover?: typeof discover;
  readonly run?: (request: ProcessRequest) => Effect.Effect<
    {
      readonly stdout: string;
      readonly stderr: string;
      readonly exitCode: number;
    },
    import("../../../core/src/transport-errors.js").TransportError,
    import("effect/process/ChildProcessSpawner").ChildProcessSpawner
  >;
  readonly files?: OperationFiles;
  readonly busy?: (session: Session) => boolean;
  readonly current?: (session: Session) => boolean;
  readonly preferencesPath?: string;
  /** Pass the bundled adapter entry import.meta.url. */
  readonly moduleUrl?: string;
  readonly managedModsRoot?: string;
}
const ObjectReceipt = Schema.Record(Schema.String, Schema.Unknown);
const AuthReceipt = Schema.Struct({
  status: Schema.String,
  reason: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  login_id: Schema.optional(Schema.String),
  expires_at: Schema.optional(Schema.String),
});
const Organizations = Schema.Struct({
  organizations: Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString,
      name: Schema.String,
      current: Schema.Boolean,
      personal: Schema.optional(Schema.Boolean),
    }),
  ),
});
const UpdateReceipt = Schema.Struct({
  schema_version: Schema.Literal(1),
  status: Schema.Literals([
    "up_to_date",
    "update_available",
    "updated",
    "install_ready",
    "unsupported",
  ]),
  can_install: Schema.Boolean,
  current_version: Schema.NonEmptyString,
  latest_version: Schema.NullOr(Schema.NonEmptyString),
  channel: Schema.Literals(["dev", "trunk", "stable"]),
  message: Schema.String,
  restart_required: Schema.optional(Schema.Boolean),
  install_argv: Schema.optional(Schema.Array(Schema.NonEmptyString)),
});
const newerVersion = (installed: string, latest: string): boolean => {
  const pattern =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  const a = pattern.exec(installed),
    b = pattern.exec(latest);
  if (!a || !b) return false;
  if (
    [a[4], b[4]].some((pre) =>
      pre?.split(".").some((part) => /^0[0-9]+$/.test(part)),
    )
  )
    return false;
  for (const i of [1, 2, 3]) {
    if (BigInt(a[i]!) !== BigInt(b[i]!)) return BigInt(b[i]!) > BigInt(a[i]!);
  }
  if (a[4] === b[4]) return false;
  if (!b[4]) return true;
  if (!a[4]) return false;
  const left = a[4].split("."),
    right = b[4].split(".");
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i],
      y = right[i];
    if (x === y) continue;
    if (x === undefined) return true;
    if (y === undefined) return false;
    const nx = /^\d+$/.test(x),
      ny = /^\d+$/.test(y);
    return nx && ny ? BigInt(y) > BigInt(x) : nx !== ny ? nx : y > x;
  }
  return false;
};
export const makeOperations = (options: OperationsOptions) =>
  Effect.gen(function* () {
    const ownerScope = yield* Effect.scope;
    const platform = options.platform ?? process.platform;
    let installerRunning = false;
    const fs = options.files ?? (yield* makeFiles);
    const pathService = yield* Path.Path;
    const resolve = pathService.resolve;
    const run = options.run ?? runText;
    const locate = options.discover ?? discover;
    const offered = new Set<string>();
    let installing = false;
    const stopped = (session: Session) =>
      Effect.callback<never, OperationError>((resume) => {
        const abort = () =>
          resume(
            Effect.fail(
              failure(
                "cancelled",
                "Stopped waiting locally. Delta account sign-in remains unchanged.",
              ),
            ),
          );
        if (session.signal.aborted) abort();
        else session.signal.addEventListener("abort", abort, { once: true });
        return Effect.sync(() =>
          session.signal.removeEventListener("abort", abort),
        );
      });
    const check = (session: Session) =>
      Effect.suspend(() =>
        session.signal.aborted || options.current?.(session) === false
          ? Effect.fail(
              failure(
                "stale",
                "The conversation or workspace changed; retry there.",
              ),
            )
          : Effect.void,
      );
    const ask = (session: Session, question: Question) =>
      Effect.gen(function* () {
        yield* check(session);
        if (!session.interactive)
          return yield* Effect.fail(
            failure(
              "unsupported",
              "Run this command on an interactive surface.",
            ),
          );
        const answer = yield* options.interaction.ask(session, question);
        yield* check(session);
        return answer;
      });
    const command = (
      session: Session,
      executable: string,
      args: readonly string[],
      timeoutMs = 60_000,
      auth = false,
      execute = run,
    ) =>
      Effect.gen(function* () {
        yield* check(session);
        const result = yield* Effect.raceFirst(
          execute({
            executable,
            args,
            cwd: session.cwd,
            timeoutMs,
            env: { DELTA_CLI_INTEGRATION: "letta_code" },
          }),
          stopped(session),
        );
        yield* check(session);
        const value = yield* Schema.decodeEffect(
          Schema.fromJsonString(ObjectReceipt),
        )(result.stdout).pipe(
          Effect.mapError(() =>
            failure("invalid", "Delta returned an invalid JSON receipt."),
          ),
        );
        if (
          value.error !== undefined ||
          (result.exitCode !== 0 &&
            !(
              auth &&
              result.exitCode === 1 &&
              typeof value.status === "string"
            ))
        )
          return yield* Effect.fail(
            failure(
              "access",
              "Delta rejected the operation. Resolve access in Delta and retry.",
            ),
          );
        return value;
      });
    const auth = (session: Session, executable?: string) =>
      Effect.gen(function* () {
        const cli = executable ?? (yield* locate(session.cwd));
        const request = (args: readonly string[], timeout?: number) =>
          command(
            session,
            cli,
            ["--json", "auth", ...args],
            timeout,
            true,
          ).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(AuthReceipt)),
            Effect.mapError((error) =>
              error instanceof OperationError
                ? error
                : failure(
                    "invalid",
                    "Delta returned invalid authentication output.",
                  ),
            ),
          );
        let status = yield* request(["status"]);
        if (status.status === "signed_in") return cli;
        if (status.status === "signed_out" || status.status === "signing_in") {
          if (
            (yield* ask(session, {
              title: "Delta sign-in",
              message: "Sign in to Delta in your browser?",
              choices: [
                { value: "login", label: "Sign in" },
                { value: "cancel", label: "Not now" },
              ],
            })) !== "login"
          )
            return yield* Effect.fail(
              failure("cancelled", "Delta sign-in declined."),
            );
          status = yield* request(["login", "--no-wait"]);
          if (status.status === "pending") {
            if (
              !status.login_id ||
              !status.url ||
              !/^https?:\/\//.test(status.url) ||
              !status.expires_at ||
              !Number.isFinite(Date.parse(status.expires_at))
            )
              return yield* Effect.fail(
                failure("invalid", "Delta returned an invalid sign-in link."),
              );
            session.notify(
              `Finish Delta sign-in in your browser: ${status.url}`,
            );
            status = yield* request(["wait", status.login_id], 16 * 60_000);
          }
        }
        if (
          status.status === "access_denied" &&
          status.reason === "terms_not_accepted"
        ) {
          const url = status.url ?? "https://zed.dev/delta/terms";
          if (
            (yield* ask(session, {
              title: "Delta beta terms",
              message: `Accept Delta beta terms in your browser: ${url}. Wait for acceptance?`,
              choices: [
                { value: "wait", label: "Wait for acceptance" },
                { value: "cancel", label: "Not now" },
              ],
            })) !== "wait"
          )
            return yield* Effect.fail(
              failure(
                "terms",
                `Accept Delta beta terms at ${url}, then retry.`,
              ),
            );
          const deadline = (yield* Clock.currentTimeMillis) + 15 * 60_000;
          while ((yield* Clock.currentTimeMillis) < deadline) {
            yield* Effect.sleep("2 seconds");
            status = yield* request(["status"]);
            if (status.status === "signed_in") return cli;
            if (
              status.status !== "signing_in" &&
              !(
                status.status === "access_denied" &&
                status.reason === "terms_not_accepted"
              )
            )
              break;
          }
          return yield* Effect.fail(
            failure(
              "terms",
              "Delta beta terms remain unaccepted; retry after accepting them.",
            ),
          );
        }
        if (status.status !== "signed_in")
          return yield* Effect.fail(
            failure(
              "access",
              `Delta authentication: ${status.status}. Resolve access in the Delta app and retry.`,
            ),
          );
        return cli;
      });
    const install = (session: Session) =>
      Effect.gen(function* () {
        yield* check(session);
        if (installerRunning || installing || options.busy?.(session))
          return yield* failure(
            "busy",
            "Wait for running work and installations to finish.",
          );
        if (
          (yield* ask(session, {
            title: "Install Delta",
            message:
              "Download and run the official Delta installer? It installs the app and CLI and may request administrator permission.",
            choices: [
              { value: "install", label: "Install Delta" },
              { value: "cancel", label: "Cancel" },
            ],
          })) !== "install"
        )
          return yield* failure("cancelled", "Delta installation declined.");
        return yield* Effect.acquireUseRelease(
          Effect.suspend(() => {
            if (installerRunning || installing || options.busy?.(session))
              return Effect.fail(
                failure(
                  "busy",
                  "Another installation or run started; retry when idle.",
                ),
              );
            installing = true;
            return Effect.void;
          }),
          () =>
            Effect.gen(function* () {
              session.notify(
                "Installing Delta… Approve any installer prompts.",
              );
              const script = `set -eu
: "\${HOME:?HOME is required}"
mkdir -p "$HOME/.cache"
lock="$HOME/.cache/delta-claude-install.lock"
mkdir "$lock" || exit 1
work=$(mktemp -d)
trap 'rm -rf "$work"; rmdir "$lock"' EXIT
trap 'exit 1' HUP INT TERM
curl --fail --show-error --silent --location --connect-timeout 30 --max-time 120 https://delta.dev/install.sh -o "$work/install.sh"
if cli=$(sh "$work/install.sh" --locate-cli); then printf '%s\\n' "$cli"; else sh "$work/install.sh" --non-interactive; fi`;
              const result = yield* run({
                executable: platform === "win32" ? "powershell.exe" : "sh",
                args:
                  platform === "win32"
                    ? [
                        "-NoLogo",
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        installWindows,
                      ]
                    : ["-c", script],
                cwd: session.cwd,
                timeoutMs: 600_000,
              });
              if (result.exitCode !== 0)
                return yield* failure(
                  "io",
                  /requires a restart|initiated a Windows restart/i.test(
                    result.stderr,
                  )
                    ? "Windows restart is required to finish installing Delta. Restart Windows before retrying setup."
                    : /permission was cancelled/i.test(result.stderr)
                      ? "Delta installation elevation was cancelled. Retry when ready to approve the Windows prompt."
                      : /installation was cancelled/i.test(result.stderr)
                        ? "Delta installation was cancelled."
                        : /still running/i.test(result.stderr)
                          ? "The Delta installer is still running. Let it finish, then check the installation before retrying."
                          : "Delta installation did not finish. Check the installer before retrying; it may still be running.",
                );
              yield* check(session);
              return yield* locate(session.cwd);
            }),
          () =>
            Effect.sync(() => {
              installing = false;
            }),
        );
      });
    const ensureReady = (session: Session) =>
      Effect.gen(function* () {
        const cli = yield* locate(session.cwd).pipe(
          Effect.catch(() => install(session)),
        );
        yield* auth(session, cli);
        yield* negotiate(
          yield* command(session, cli, ["--json", "thread", "contract"]),
        );
        return cli;
      });
    const git = (session: Session, args: readonly string[]) =>
      Effect.gen(function* () {
        const result = yield* run({
          executable: "git",
          args,
          cwd: session.cwd,
          timeoutMs: 30_000,
        });
        if (result.exitCode !== 0)
          return yield* Effect.fail(
            failure(
              "invalid",
              "This operation requires an accessible Git checkout.",
            ),
          );
        return result.stdout.trim();
      });
    const setup = (session: Session) =>
      Effect.gen(function* () {
        const root = yield* git(session, ["rev-parse", "--show-toplevel"]);
        const remotes = (yield* git(session, ["remote"]))
          .split(/\r?\n/)
          .filter(Boolean);
        if (
          !remotes.length ||
          (remotes.length > 1 && !remotes.includes("origin"))
        )
          return yield* Effect.fail(
            failure(
              "invalid",
              "Delta requires a Git remote; multiple remotes require one named origin.",
            ),
          );
        const path = resolve(root, ".delta/settings.json");
        const original = yield* fs.read(path);
        const previous = yield* readProjectPolicy(original);
        if (previous.malformed)
          return yield* Effect.fail(
            failure(
              "invalid",
              "Repair malformed .delta/settings.json before setup; it has not been overwritten.",
            ),
          );
        const cli = yield* ensureReady(session);
        const organizations = yield* command(session, cli, [
          "--json",
          "org",
          "list",
        ]).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Organizations)));
        let organization = yield* ask(session, {
          title: "Delta team",
          message: "Choose a team, or enter a new team name.",
          choices: organizations.organizations.map((org) => ({
            value: org.id,
            label: `${org.name} (${org.id})`,
          })),
          allowText: true,
        });
        if (!organization) return { text: "Setup cancelled." };
        if (
          !organizations.organizations.some((org) => org.id === organization)
        ) {
          const name = organization.trim();
          if (
            !name ||
            (yield* ask(session, {
              title: "Create team",
              message: `Create team “${name}”?`,
              choices: [
                { value: "create", label: "Create team" },
                { value: "cancel", label: "Cancel" },
              ],
            })) !== "create"
          )
            return { text: "Setup cancelled." };
          const created = yield* command(session, cli, [
            "--json",
            "org",
            "create",
            "--",
            name,
          ]).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({
                  operation: Schema.Literal("created"),
                  organization: Schema.Struct({ id: Schema.NonEmptyString }),
                }),
              ),
            ),
          );
          organization = created.organization.id;
          const emails = yield* ask(session, {
            title: "Invite teammates",
            message:
              "Enter email addresses separated by commas or spaces, or skip.",
            choices: [{ value: "skip", label: "Skip" }],
            allowText: true,
          });
          if (emails && emails !== "skip") {
            const inviteOrganization = organization;
            const invitation = yield* Effect.result(
              Effect.gen(function* () {
                const addresses = [
                  ...new Set(emails.split(/[\s,;]+/).filter(Boolean)),
                ];
                if (
                  addresses.some(
                    (email) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email),
                  )
                )
                  return yield* Effect.fail(
                    failure(
                      "invalid",
                      "Invalid invite address; team already exists. Invite later with /delta-org invite.",
                    ),
                  );
                const receipt = yield* command(session, cli, [
                  "--json",
                  "org",
                  "invite",
                  "--org",
                  inviteOrganization,
                  "--",
                  ...addresses,
                ]).pipe(
                  Effect.flatMap(
                    Schema.decodeUnknownEffect(
                      Schema.Struct({
                        operation: Schema.Literal("invited"),
                        results: Schema.Array(
                          Schema.Struct({
                            email: Schema.String,
                            status: Schema.Literals(["invited", "failed"]),
                            message: Schema.optional(Schema.String),
                            reason: Schema.optional(Schema.String),
                          }),
                        ),
                      }),
                    ),
                  ),
                );
                for (const result of receipt.results)
                  session.notify(
                    `${result.email}: ${result.status}${result.message ? ` (${result.message})` : result.reason ? ` (${result.reason})` : ""}`,
                  );
              }),
            );
            if (invitation._tag === "Failure")
              session.notify(
                "Invitations did not finish. The team exists; invite later with /delta-org invite <email>.",
              );
            yield* check(session);
          }
        }
        const mode = yield* ask(session, {
          title: "Repository sharing policy",
          message:
            "Delta sync uploads conversations and nonignored checkout files. Choose the policy for new sessions.",
          choices: [
            { value: "manual", label: "Manual" },
            { value: "private", label: "Private sync" },
            ...(organizations.organizations.find((o) => o.id === organization)
              ?.personal
              ? []
              : [{ value: "organization", label: "Team sharing" }]),
          ],
        });
        if (!Schema.is(ThreadMode)(mode)) return { text: "Setup cancelled." };
        yield* check(session);
        if ((yield* fs.read(path)) !== original)
          return yield* Effect.fail(
            failure(
              "stale",
              "Repository settings changed during setup; retry.",
            ),
          );
        const common = resolve(
          session.cwd,
          yield* git(session, ["rev-parse", "--git-common-dir"]),
        );
        const excludePath = resolve(common, "info/exclude");
        const exclude = (yield* fs.read(excludePath)) ?? "";
        const entry = "/.delta/settings.json";
        if (!exclude.split(/\r?\n/).includes(entry))
          yield* fs.write(
            excludePath,
            `${exclude}${exclude && !exclude.endsWith("\n") ? "\n" : ""}${entry}\n`,
          );
        yield* fs.write(
          path,
          yield* serializeProjectPolicy(previous.document, mode, organization),
        );
        if (mode === "manual")
          return { text: "Saved manual repository policy." };
        const share = yield* ask(session, {
          title: "Sync current session",
          message:
            "The new policy applies to future sessions. Also upload this conversation and nonignored files now?",
          choices: [
            { value: "share", label: "Upload this session" },
            { value: "later", label: "Future sessions only" },
          ],
        });
        return {
          text: `Saved ${mode} repository policy.`,
          ...(share === "share"
            ? {
                shareCurrent: { visibility: mode, organization },
                shareAudience: { visibility: mode, organization },
              }
            : {}),
        };
      });
    const autoOnboard = (session: Session, prompt = true) =>
      Effect.gen(function* () {
        if (!session.interactive || options.busy?.(session)) return;
        const root = yield* git(session, ["rev-parse", "--show-toplevel"]);
        const common = resolve(
          session.cwd,
          yield* git(session, ["rev-parse", "--git-common-dir"]),
        );
        const remotes = (yield* git(session, ["remote"]))
          .split(/\r?\n/)
          .filter(Boolean);
        if (
          !remotes.length ||
          (remotes.length > 1 && !remotes.includes("origin"))
        )
          return;
        const policy = yield* readProjectPolicy(
          yield* fs.read(resolve(root, ".delta/settings.json")),
        );
        if (
          policy.policy.configured ||
          policy.policy.problem ||
          offered.has(common)
        )
          return;
        const marker = resolve(common, "delta-letta-onboarding");
        if ((yield* fs.read(marker)) !== undefined) return;
        offered.add(common);
        yield* fs.write(marker, "offered\n");
        if (!prompt) {
          session.notify(
            "Delta is available for this repository. Run /delta-setup to choose how conversations and files are shared.",
          );
          return;
        }
        if (
          (yield* ask(session, {
            title: "Set up Delta",
            message:
              "Configure conversation and file sharing for this repository?",
            choices: [
              { value: "setup", label: "Set up" },
              { value: "later", label: "Not now" },
            ],
          })) === "setup"
        )
          return yield* setup(session);
      });
    const update = (session: Session, checkOnly = false) =>
      Effect.gen(function* () {
        if (
          !checkOnly &&
          (installerRunning || installing || options.busy?.(session))
        )
          return yield* Effect.fail(
            failure(
              "busy",
              "Wait for running work and installations to finish before updating Delta.",
            ),
          );
        const cli = yield* locate(session.cwd);
        if (
          !checkOnly &&
          (yield* ask(session, {
            title: "Update Delta",
            message: "Install the available Delta application and CLI update?",
            choices: [
              { value: "update", label: "Update" },
              { value: "cancel", label: "Cancel" },
            ],
          })) !== "update"
        )
          return "Delta update cancelled.";
        return yield* Effect.acquireUseRelease(
          Effect.suspend(() => {
            if (
              installerRunning ||
              installing ||
              (!checkOnly && options.busy?.(session))
            )
              return Effect.fail(
                failure(
                  "busy",
                  "Another installation or run started; retry when idle.",
                ),
              );
            if (!checkOnly) installing = true;
            return Effect.void;
          }),
          () =>
            Effect.gen(function* () {
              if (!checkOnly) session.notify("Updating Delta…");
              const receipt = yield* command(
                session,
                cli,
                [
                  "update",
                  ...(checkOnly
                    ? ["--check"]
                    : platform === "win32"
                      ? ["--download-only"]
                      : []),
                  "--json",
                ],
                checkOnly ? 10_000 : 600_000,
                false,
                options.run ??
                  (checkOnly
                    ? runText
                    : (request) => runProgress(request, session.notify)),
              );
              const parsed =
                yield* Schema.decodeUnknownEffect(UpdateReceipt)(receipt);
              if (
                checkOnly &&
                (parsed.status === "updated" ||
                  parsed.status === "install_ready")
              )
                return yield* Effect.fail(
                  failure(
                    "invalid",
                    "Read-only update check reported an installation change.",
                  ),
                );
              if (parsed.status === "install_ready") {
                if (
                  platform !== "win32" ||
                  !parsed.can_install ||
                  !parsed.install_argv?.length ||
                  parsed.install_argv.some((arg) => arg.includes("\0"))
                )
                  return yield* failure(
                    "invalid",
                    "Delta returned an invalid Windows install-ready receipt.",
                  );
                yield* check(session);
                if (
                  options.busy?.(session) ||
                  ownerScope.state._tag === "Closed"
                )
                  return yield* failure(
                    "busy",
                    "Running work started before installation; retry when idle.",
                  );
                const [executable, ...args] = parsed.install_argv;
                const installer = (
                  options.run ??
                  ((request: ProcessRequest) =>
                    runProgress(request, session.notify, true))
                )({
                  executable: executable!,
                  args,
                  cwd: session.cwd,
                  timeoutMs: 600_000,
                });
                // Once native installation starts, let it settle even on local cancellation
                // or teardown. The adapter scope owns the waiter until it exits; a UI
                // deadline never releases the native installation lock or kills its helper.
                const fiber = yield* Effect.uninterruptible(
                  Effect.gen(function* () {
                    if (ownerScope.state._tag === "Closed")
                      return yield* failure(
                        "stale",
                        "Adapter teardown started before installation.",
                      );
                    installerRunning = true;
                    return yield* Effect.forkIn(
                      Effect.uninterruptible(installer).pipe(
                        Effect.ensuring(
                          Effect.sync(() => {
                            installerRunning = false;
                          }),
                        ),
                      ),
                      ownerScope,
                    );
                  }),
                );
                const finished = yield* Effect.raceFirst(
                  Fiber.join(fiber).pipe(Effect.timeoutOption("10 minutes")),
                  stopped(session),
                );
                if (Option.isNone(finished))
                  return "The Delta installer is still running after 10 minutes. Approve any Windows prompt and let it finish, then run delta update --check before retrying. The adapter continues owning its installer waiter.";
                const output = finished.value;
                const envelope = yield* Schema.decodeEffect(
                  Schema.fromJsonString(ObjectReceipt),
                )(output.stdout).pipe(
                  Effect.mapError(() =>
                    failure(
                      output.exitCode === 0 ? "invalid" : "io",
                      `Delta installer ${output.exitCode === 0 ? "returned invalid output" : `exited with code ${output.exitCode}`}. Run delta update --check before retrying.`,
                    ),
                  ),
                );
                if (envelope.error !== undefined) {
                  const detail = yield* Schema.decodeUnknownEffect(ErrorDetail)(
                    envelope.error,
                  ).pipe(
                    Effect.mapError(() =>
                      failure(
                        "invalid",
                        "Delta installer returned a malformed error receipt.",
                      ),
                    ),
                  );
                  return yield* new OperationError({
                    kind:
                      detail.code === "app_running"
                        ? "busy"
                        : /cancel/i.test(detail.code)
                          ? "cancelled"
                          : "io",
                    code: detail.code,
                    message: detail.message,
                    ...(detail.retryable === undefined
                      ? {}
                      : { retryable: detail.retryable }),
                  });
                }
                if (output.exitCode !== 0)
                  return yield* failure(
                    "io",
                    `Delta installer exited with code ${output.exitCode}. Run delta update --check before retrying.`,
                  );
                const installed = yield* Schema.decodeUnknownEffect(
                  Schema.Struct({
                    schema_version: Schema.Literal(1),
                    status: Schema.Literal("updated"),
                    can_install: Schema.Boolean,
                    current_version: Schema.NonEmptyString,
                    latest_version: Schema.NonEmptyString,
                    channel: Schema.Literals(["dev", "trunk", "stable"]),
                    message: Schema.String,
                    restart_required: Schema.Boolean,
                  }),
                )(envelope).pipe(
                  Effect.mapError(() =>
                    failure(
                      "invalid",
                      "Delta installer did not return a valid completion receipt. Run delta update --check before retrying.",
                    ),
                  ),
                );
                return `${installed.message}${installed.restart_required ? " Restart required." : ""}`;
              }
              return `${parsed.message}${parsed.restart_required ? " Restart required." : ""}`;
            }),
          () =>
            Effect.sync(() => {
              if (!checkOnly) installing = false;
            }),
        );
      });
    const checkManagedRelease = (
      session: Session,
      installation: { readonly source: string },
    ) =>
      Effect.gen(function* () {
        const request = installation.source.startsWith("npm:")
          ? {
              executable: "npm",
              args: ["view", installation.source.slice(4), "version", "--json"],
            }
          : {
              executable: "git",
              args: ["ls-remote", installation.source.slice(4), "HEAD"],
            };
        const release = yield* run({
          ...request,
          cwd: session.cwd,
          timeoutMs: 30_000,
          maxOutputBytes: 16 * 1024,
        });
        if (release.exitCode !== 0)
          return yield* failure(
            "io",
            "Could not check the managed mod source. Its installed files were left unchanged.",
          );
        const latest = installation.source.startsWith("npm:")
          ? yield* Schema.decodeEffect(
              Schema.fromJsonString(Schema.NonEmptyString),
            )(release.stdout)
          : release.stdout.match(/^([a-f0-9]{40,64})\s+HEAD\s*$/)?.[1];
        if (!latest)
          return yield* failure(
            "invalid",
            "Managed source returned an invalid release check.",
          );
        return latest;
      });
    const pluginUpdate = (session: Session, action = "") =>
      Effect.gen(function* () {
        if (action === "notifications on" || action === "notifications off") {
          if (!options.preferencesPath)
            return yield* Effect.fail(
              failure(
                "unsupported",
                "Adapter update preferences storage is unavailable.",
              ),
            );
          const text = yield* fs.read(options.preferencesPath);
          const previous =
            text === undefined
              ? {}
              : yield* Schema.decodeEffect(
                  Schema.fromJsonString(ObjectReceipt),
                )(text);
          yield* fs.write(
            options.preferencesPath,
            JSON.stringify({
              ...previous,
              notifications: action === "notifications on",
            }),
          );
          return `Delta mod update notifications are ${action.endsWith("on") ? "on" : "off"}.`;
        }
        if (action !== "" && action !== "check")
          return "Usage: /delta-plugin-update [check | notifications on | notifications off]";
        const manual =
          "This Delta mod is a local/source installation from an unpublished package. Update the source checkout, rebuild the bundle, reinstall it using Letta mods, and restart Letta Code. No registry release is available.";
        if (!options.moduleUrl) return manual;
        yield* check(session);
        const list = () =>
          Effect.gen(function* () {
            const output = yield* run({
              executable: "letta",
              args: ["mods", "list", "--agent", session.agentId],
              cwd: session.cwd,
              timeoutMs: 10_000,
              maxOutputBytes: 256 * 1024,
            });
            if (output.exitCode !== 0)
              return yield* failure(
                "io",
                "Stock Letta could not list installed mods; no update was attempted.",
              );
            return output.stdout;
          });
        const preferencesText = options.preferencesPath
          ? yield* fs.read(options.preferencesPath)
          : undefined;
        const preferences =
          preferencesText === undefined
            ? {}
            : yield* Schema.decodeEffect(Schema.fromJsonString(ObjectReceipt))(
                preferencesText,
              );
        const sourcePolicy =
          typeof preferences.pluginUpdateSource === "string"
            ? preferences.pluginUpdateSource
            : undefined;
        const installation = yield* classifyModInstallation(
          options.moduleUrl,
          yield* list(),
          fs,
          sourcePolicy,
          options.managedModsRoot,
        );
        if (installation.kind === "local") return manual;
        if (installation.kind === "pinned")
          return `Delta mod is pinned to ${installation.source}@${installation.version}. This update action leaves pinned installations unchanged.`;
        if (action === "check") {
          const latest = yield* checkManagedRelease(session, installation);
          return `Managed Delta mod ${installation.version}; ${installation.source.startsWith("npm:") ? "latest published version" : "remote HEAD"}: ${latest}.${installation.pin === "unknown" ? " Stock Letta does not retain the original install version/tag/ref. Updating requires explicitly choosing to track latest." : " Tracking latest."}`;
        }
        if (installerRunning || installing || options.busy?.(session))
          return yield* failure(
            "busy",
            "Wait for running work and installations before updating the mod.",
          );
        if (!installation.enabled)
          return "This managed Delta mod is disabled. Enable it using Letta mods before updating from this session.";
        if (installation.pin === "unknown") {
          if (!options.preferencesPath)
            return yield* failure(
              "unsupported",
              "A durable update preference path is required before adopting an unpinned managed source.",
            );
          const choice = yield* ask(session, {
            title: "Choose managed update policy",
            message: `Stock Letta does not retain the original version/tag/ref for ${installation.source}. Explicitly replace any previous pin by tracking the latest source and update now?`,
            choices: [
              { value: "latest", label: "Track latest and update" },
              { value: "cancel", label: "Keep installation unchanged" },
            ],
          });
          if (choice !== "latest")
            return "Managed mod update cancelled; installation unchanged.";
          yield* fs.write(
            options.preferencesPath,
            JSON.stringify({
              ...preferences,
              pluginUpdateSource: installation.source,
            }),
          );
        } else if (
          (yield* ask(session, {
            title: "Update managed Delta mod",
            message: `Update ${installation.source} through stock Letta mods and restart Letta Code afterward?`,
            choices: [
              { value: "update", label: "Update" },
              { value: "cancel", label: "Cancel" },
            ],
          })) !== "update"
        )
          return "Managed mod update cancelled.";
        return yield* Effect.acquireUseRelease(
          Effect.suspend(() => {
            if (
              installerRunning ||
              installing ||
              options.busy?.(session) ||
              ownerScope.state._tag === "Closed"
            )
              return Effect.fail(
                failure(
                  "busy",
                  "Installation or running work started; retry when idle.",
                ),
              );
            installing = true;
            return Effect.void;
          }),
          () =>
            Effect.gen(function* () {
              yield* check(session);
              session.notify(
                "Updating managed Delta mod through stock Letta mods…",
              );
              const result = yield* run({
                executable: "letta",
                args: ["mods", "update", installation.source],
                env: { LETTA_MODS_DIR: installation.modsRoot },
                cwd: session.cwd,
                timeoutMs: 120_000,
                maxOutputBytes: 256 * 1024,
              });
              if (result.exitCode !== 0)
                return yield* failure(
                  "io",
                  "Stock Letta mod update failed. Inspect letta mods list before retrying.",
                );
              const installed = yield* classifyModInstallation(
                options.moduleUrl!,
                yield* list(),
                fs,
                installation.source,
                options.managedModsRoot,
              );
              if (
                installed.kind !== "managed" ||
                installed.source !== installation.source ||
                installed.enabled !== installation.enabled
              )
                return yield* failure(
                  "invalid",
                  "Native mod update completed but the installed package could not be verified. Inspect letta mods list before retrying.",
                );
              return `Updated managed Delta mod to ${installed.version}. Restart Letta Code to load the updated bundle.`;
            }),
          () =>
            Effect.sync(() => {
              installing = false;
            }),
        );
      });
    const recovering = new Set<string>();
    const recover = (
      session: Session,
      target: {
        readonly thread: string;
        /** Durable fork receipt from a previous partially completed recovery. */
        readonly forkedThread?: string;
        /** Persist before discard, so retry never creates a second kept thread. */
        readonly persistFork: (
          thread: string,
        ) => Effect.Effect<void, OperationError>;
      },
    ) =>
      Effect.gen(function* () {
        yield* check(session);
        if (options.busy?.(session) || recovering.has(target.thread))
          return yield* failure(
            "busy",
            "Wait for running work or recovery to finish.",
          );
        const action = yield* ask(session, {
          title: "Recover rejected offline changes",
          message:
            "Delta rejected local offline changes. Fork & Restore keeps them in a new Delta thread, then restores the original to the server view. Discard permanently removes the rejected changes from the original. Unsent local outbox records remain preserved until the delivery owner reconciles them.",
          choices: [
            { value: "fork", label: "Fork & Restore" },
            { value: "discard", label: "Discard" },
            { value: "cancel", label: "Keep paused" },
          ],
        });
        if (action !== "fork" && action !== "discard")
          return { resolved: false };
        const cli = yield* ensureReady(session);
        return yield* Effect.acquireUseRelease(
          Effect.suspend(() => {
            if (recovering.has(target.thread) || options.busy?.(session))
              return Effect.fail(
                failure(
                  "busy",
                  "Recovery or running work started; retry when idle.",
                ),
              );
            recovering.add(target.thread);
            return Effect.void;
          }),
          () =>
            Effect.gen(function* () {
              let forkedThread = target.forkedThread;
              if (action === "fork" && !forkedThread) {
                // Receipt and durable handoff must settle together; never retry a lost fork response.
                forkedThread = yield* Effect.uninterruptible(
                  Effect.gen(function* () {
                    const result = yield* run({
                      executable: cli,
                      args: ["--json", "thread", "fork", target.thread],
                      cwd: session.cwd,
                      timeoutMs: 120_000,
                    });
                    if (result.exitCode !== 0)
                      return yield* failure(
                        "io",
                        "Delta fork did not finish. Check Delta before retrying; a kept thread may already exist.",
                      );
                    const receipt = yield* Schema.decodeEffect(
                      Schema.fromJsonString(
                        Schema.Struct({ thread_id: Schema.NonEmptyString }),
                      ),
                    )(result.stdout).pipe(
                      Effect.mapError(() =>
                        failure(
                          "invalid",
                          "Delta fork receipt was invalid. Check Delta before retrying; a kept thread may already exist.",
                        ),
                      ),
                    );
                    yield* target.persistFork(receipt.thread_id);
                    return receipt.thread_id;
                  }),
                );
                session.notify(
                  `Delta kept offline changes in thread ${forkedThread}.`,
                );
              }
              yield* check(session);
              yield* command(
                session,
                cli,
                ["--json", "thread", "discard", target.thread, "--force"],
                120_000,
              );
              return {
                resolved: true,
                ...(forkedThread ? { forkedThread } : {}),
              };
            }),
          () =>
            Effect.sync(() => {
              recovering.delete(target.thread);
            }),
        );
      });
    const backgroundGate = yield* Semaphore.make(1);
    const backgroundCheck = (session: Session) =>
      backgroundGate.withPermit(
        Effect.gen(function* () {
          const notices: string[] = [];
          yield* check(session);
          if (
            !options.preferencesPath ||
            installerRunning ||
            installing ||
            options.busy?.(session)
          )
            return Object.freeze(notices);
          const text = yield* fs.read(options.preferencesPath);
          const preferences =
            text === undefined
              ? {}
              : yield* Schema.decodeEffect(
                  Schema.fromJsonString(ObjectReceipt),
                )(text);
          if (preferences.notifications === false)
            return Object.freeze(notices);
          const now = yield* Clock.currentTimeMillis;
          const key = options.moduleUrl ?? null;
          const stored = preferences.backgroundUpdateCheck;
          const previous = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              checkedAt: Schema.Finite,
              moduleUrl: Schema.NullOr(Schema.String),
            }),
          )(stored).pipe(Effect.result);
          const hour = 60 * 60 * 1000;
          if (
            previous._tag === "Success" &&
            previous.success.moduleUrl === key &&
            Math.abs(now - previous.success.checkedAt) < hour
          )
            return Object.freeze(notices);
          // Persist before optional IO: failures are throttled too, as in the reference.
          yield* fs.write(
            options.preferencesPath,
            JSON.stringify({
              ...preferences,
              backgroundUpdateCheck: { checkedAt: now, moduleUrl: key },
            }),
          );
          const app = yield* Effect.result(
            Effect.gen(function* () {
              const cli = yield* locate(session.cwd);
              return yield* command(
                session,
                cli,
                ["update", "--check", "--json"],
                10_000,
              ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(UpdateReceipt)));
            }),
          );
          if (
            app._tag === "Success" &&
            app.success.status === "update_available" &&
            app.success.can_install &&
            app.success.latest_version &&
            newerVersion(
              app.success.current_version,
              app.success.latest_version,
            )
          )
            notices.push(
              `Delta ${app.success.latest_version} is available (installed: ${app.success.current_version}). Run /delta-update to update.`,
            );
          yield* check(session);
          if (options.moduleUrl) {
            const plugin = yield* Effect.result(
              Effect.gen(function* () {
                const module = yield* Effect.try(
                  () => new URL(options.moduleUrl!),
                );
                if (module.protocol !== "file:") return;
                const entry = yield* pathService.fromFileUrl(module);
                const root =
                  options.managedModsRoot ??
                  pathService.join(
                    process.env.LETTA_CONFIG_DIR ??
                      pathService.join(homedir(), ".letta"),
                    "mods",
                  );
                const relative = pathService.relative(
                  pathService.join(root, "packages"),
                  entry,
                );
                if (
                  !pathService.isAbsolute(root) ||
                  pathService.isAbsolute(relative) ||
                  relative === ".." ||
                  relative.startsWith(`..${pathService.sep}`)
                )
                  return;
                const listing = yield* run({
                  executable: "letta",
                  args: ["mods", "list", "--agent", session.agentId],
                  cwd: session.cwd,
                  timeoutMs: 10_000,
                  maxOutputBytes: 256 * 1024,
                });
                if (listing.exitCode !== 0) return;
                const installation = yield* classifyModInstallation(
                  options.moduleUrl!,
                  listing.stdout,
                  fs,
                  typeof preferences.pluginUpdateSource === "string"
                    ? preferences.pluginUpdateSource
                    : undefined,
                  options.managedModsRoot,
                );
                // Public Git listings don't report the installed commit when versioned by
                // a manifest, so a remote HEAD alone cannot prove an available update.
                if (
                  installation.kind !== "managed" ||
                  !installation.enabled ||
                  !installation.source.startsWith("npm:")
                )
                  return;
                const latest = yield* checkManagedRelease(
                  session,
                  installation,
                );
                if (newerVersion(installation.version, latest))
                  return `Delta mod ${latest} is available (installed: ${installation.version}). Run /delta-plugin-update to update.`;
              }),
            );
            if (plugin._tag === "Success" && plugin.success)
              notices.push(plugin.success);
          }
          yield* check(session);
          return Object.freeze(notices);
        }),
      );
    const checkUpdates = (session: Session) =>
      Effect.gen(function* () {
        yield* check(session);
        if (options.preferencesPath) {
          const text = yield* fs.read(options.preferencesPath);
          if (text !== undefined) {
            const preferences = yield* Schema.decodeEffect(
              Schema.fromJsonString(ObjectReceipt),
            )(text);
            if (preferences.notifications === false) return;
          }
        }
        const notice = yield* update(session, true);
        yield* check(session);
        session.notify(notice);
      });
    const menu = (session: Session) =>
      ask(session, {
        title: "Delta",
        message: "Choose an action",
        choices: [
          "share",
          "join",
          "setup",
          "update",
          "plugin-update",
          "org",
        ].map((value) => ({ value, label: value })),
      });
    return {
      ensureReady,
      install,
      auth,
      setup,
      autoOnboard,
      update,
      checkUpdate: (session: Session) => update(session, true),
      checkUpdates,
      backgroundCheck,
      pluginUpdate,
      recover,
      menu,
    };
  });
