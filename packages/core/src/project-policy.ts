// AGPL-3.0-only; adapted from Zed's hooks/setup/project-policy.ts. See NOTICE.
import { Effect, Predicate, Record, Schema } from "effect";

export const ThreadMode = Schema.Literals([
  "manual",
  "private",
  "organization",
]);
export type ThreadMode = typeof ThreadMode.Type;
export interface ProjectPolicy {
  readonly mode: ThreadMode;
  readonly organization?: string;
  readonly configured: boolean;
  readonly problem?: string;
}
export interface PolicyFile {
  readonly policy: ProjectPolicy;
  readonly document?: Record<string, unknown>;
  readonly malformed?: boolean;
}

const manual = (problem?: string): ProjectPolicy => ({
  mode: "manual",
  configured: false,
  ...(problem === undefined ? {} : { problem }),
});
const readDocument = (document: unknown): PolicyFile => {
  if (!Predicate.isObject(document))
    return {
      malformed: true,
      policy: manual("it does not contain a JSON object"),
    };
  const threads = document.threads;
  if (threads === undefined) return { document, policy: manual() };
  if (!Predicate.isObject(threads))
    return {
      document,
      policy: manual("its `threads` value is not an object"),
    };
  const mode = threads.mode;
  if (mode === undefined) return { document, policy: manual() };
  if (!Schema.is(ThreadMode)(mode))
    return {
      document,
      policy: manual("its mode must be one of manual, private, organization"),
    };
  const organization = threads.organization;
  const selected =
    typeof organization === "string" && organization.trim()
      ? { organization }
      : {};
  if (mode !== "manual" && selected.organization === undefined)
    return {
      document,
      policy: manual(`mode "${mode}" requires a non-empty organization`),
    };
  return { document, policy: { mode, configured: true, ...selected } };
};

export const readProjectPolicy = (
  text: string | undefined,
): Effect.Effect<PolicyFile> =>
  text === undefined
    ? Effect.succeed({ policy: manual() })
    : Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
        Effect.match({
          onFailure: () => ({
            malformed: true,
            policy: manual("it is not valid JSON"),
          }),
          onSuccess: readDocument,
        }),
      );

export const serializeProjectPolicy = (
  previous: Record<string, unknown> | undefined,
  mode: ThreadMode,
  organization?: string,
) => {
  const document = previous ?? {};
  const threads: Record<string, unknown> = {
    ...(Predicate.isObject(document.threads) ? document.threads : {}),
    mode,
  };
  return Schema.encodeEffect(
    Schema.fromJsonString(Schema.Unknown, { space: 2 }),
  )({
    ...document,
    threads:
      organization === undefined
        ? Record.remove(threads, "organization")
        : { ...threads, organization },
  }).pipe(Effect.map((text) => `${text}\n`));
};

export const recordsAutomatically = (policy: ProjectPolicy): boolean =>
  policy.mode === "private" || policy.mode === "organization";
