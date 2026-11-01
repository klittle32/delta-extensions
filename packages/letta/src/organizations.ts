import { Effect, Schema } from "effect";
import { parseCommand } from "../../core/src/commands.js";
import { recognizeError } from "../../core/src/error-envelope.js";
import { TransportError } from "../../core/src/transport-errors.js";
import { discover } from "./discovery.js";
import { runText } from "./process.js";

// Structural subset of stock Letta Code 0.34.36's public mod API.
export interface CommandContext {
  args: string;
  cwd: string;
}
export interface CommandResult {
  type: "output";
  output: string;
  success?: boolean;
}
export const organizationUsage =
  "/delta-org list|current|switch <ID>|invite <email>…|manage (also /delta org …)";
const dashboard = "https://dashboard.zed.dev";
class OrganizationError extends Schema.TaggedError<
  OrganizationError,
  { readonly brand: unique symbol }
>()("OrganizationError", { message: Schema.String }) {}
const Organizations = Schema.Struct({
  organizations: Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString,
      name: Schema.String,
      current: Schema.Boolean,
    }),
  ),
});
const Envelope = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.optionalKey(Schema.Unknown),
    organizations: Schema.optionalKey(Schema.Unknown),
  }),
);
const message = (error: unknown): string =>
  typeof error === "string"
    ? error
    : error instanceof TransportError
      ? error.kind === "limit"
        ? "Delta team output was truncated; check the selection with /delta-org current"
        : `Delta CLI ${error.kind} failure`
      : error instanceof Error
        ? error.message
        : "Unexpected Delta failure";
export const executeOrganization = (name: string, ctx: CommandContext) =>
  Effect.gen(function* () {
    const command = parseCommand(name, ctx.args);
    if (command.kind !== "org") {
      if (
        command.kind === "menu" ||
        command.kind === "team-menu" ||
        command.kind === "usage"
      )
        return organizationUsage;
      return yield* new OrganizationError({
        message: organizationUsage,
      });
    }
    const executable = yield* discover(ctx.cwd);
    const args =
      command.action === "manage"
        ? ["--json", "org", "list"]
        : [
            "org",
            command.action,
            ...(command.action === "switch"
              ? ["--", command.id]
              : command.action === "invite"
                ? ["--", ...command.emails]
                : []),
          ];
    const result = yield* runText({
      executable,
      args,
      cwd: ctx.cwd,
      env: { DELTA_CLI_INTEGRATION: "letta_code" },
      timeoutMs: 20_000,
      maxOutputBytes: 4 * 1024 * 1024,
      maxDiagnosticBytes: 4 * 1024 * 1024,
    });
    const envelope =
      command.action === "manage"
        ? yield* Schema.decodeEffect(Envelope)(result.stdout)
        : undefined;
    const failure = recognizeError(envelope?.error);
    if (failure)
      return yield* new OrganizationError({ message: failure.message });
    if (result.exitCode !== 0)
      return yield* Effect.fail(
        result.stderr.trim() ||
          result.stdout.trim() ||
          `Delta exited with code ${result.exitCode}`,
      );
    if (command.action !== "manage") return result.stdout.trim();
    const listed = yield* Schema.decodeUnknownEffect(Organizations)(envelope);
    const current = listed.organizations.find((org) => org.current);
    return current
      ? `Manage ${current.name}'s members here: ${dashboard}/${encodeURIComponent(current.id)}/members`
      : `Delta has no team selected. Manage your teams here: ${dashboard}`;
  }).pipe(
    Effect.map((output): CommandResult => ({ type: "output", output })),
    Effect.catch((error) =>
      Effect.succeed({
        type: "output" as const,
        output: `Delta team command failed: ${message(error)}. Manage your teams here: ${dashboard}`,
        success: false,
      }),
    ),
  );
