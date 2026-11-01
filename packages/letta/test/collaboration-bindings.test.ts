import { Effect, FileSystem } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { platform } from "../../core/test/delivery-support.js";
import {
  automaticPolicy,
  bindingPath,
  hasSavedBinding,
} from "../src/collaboration/bindings.js";
it.live(
  "checks bindings without a CLI and reads automatic policy from the checkout root",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const identity = {
        agentId: "agent/one",
        conversationId: "conversation/two",
      };
      expect(yield* hasSavedBinding(root, identity)).toBe(false);
      yield* fs.writeFileString(bindingPath(root, identity), "malformed");
      expect(yield* hasSavedBinding(root, identity)).toBe(true);
      expect(yield* automaticPolicy({ cwd: root })).toBeUndefined();
      yield* fs.makeDirectory(`${root}/.git`);
      yield* fs.makeDirectory(`${root}/.delta`);
      yield* fs.makeDirectory(`${root}/nested`);
      yield* fs.writeFileString(
        `${root}/.delta/settings.json`,
        JSON.stringify({
          threads: { mode: "organization", organization: "repo" },
        }),
      );
      expect(yield* automaticPolicy({ cwd: `${root}/nested` })).toEqual({
        organization: "repo",
        visibility: "organization",
      });
      yield* fs.writeFileString(
        `${root}/.delta/settings.json`,
        JSON.stringify({ threads: { mode: "private" } }),
      );
      expect(yield* automaticPolicy({ cwd: root })).toBeUndefined();
    }).pipe(Effect.provide(platform)),
);
