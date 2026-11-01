import { dirname, isAbsolute, join } from "node:path";
import { Effect, FileSystem } from "effect";
import type { Session } from "../session.js";
import { CollaborationError, externalId } from "./model.js";
import { readProjectPolicy } from "../../../core/src/project-policy.js";
export const bindingPath = (
  stateDirectory: string,
  session: Pick<Session, "agentId" | "conversationId">,
): string =>
  join(
    stateDirectory,
    `${encodeURIComponent(externalId(session.agentId, session.conversationId))}.json`,
  );
/** Existence only: a malformed binding still requires fail-closed restoration. */
export const hasSavedBinding = (
  stateDirectory: string,
  session: Pick<Session, "agentId" | "conversationId">,
) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.exists(bindingPath(stateDirectory, session)),
  );
export const checkoutRoot = (session: Pick<Session, "cwd">) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let current = session.cwd;
    if (!isAbsolute(current))
      return yield* new CollaborationError({
        message: "Checkout directory must be absolute.",
      });
    while (true) {
      if (yield* fs.exists(join(current, ".git"))) return current;
      const parent = dirname(current);
      if (parent === current)
        return yield* new CollaborationError({
          message: "Open a Git checkout before sharing with Delta.",
        });
      current = parent;
    }
  });
export const automaticPolicy = (session: Pick<Session, "cwd">) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* checkoutRoot(session).pipe(Effect.result);
    if (root._tag === "Failure") {
      if (root.failure instanceof CollaborationError) return undefined;
      return yield* root.failure;
    }
    const file = join(root.success, ".delta", "settings.json");
    const policy = (yield* readProjectPolicy(
      (yield* fs.exists(file)) ? yield* fs.readFileString(file) : undefined,
    )).policy;
    return policy.organization && policy.mode !== "manual"
      ? { organization: policy.organization, visibility: policy.mode }
      : undefined;
  });
