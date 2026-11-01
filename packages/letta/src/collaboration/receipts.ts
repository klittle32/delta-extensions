// AGPL-3.0-only; receipt validation adapted from pinned cli/command-outcomes.ts.
import { Schema } from "effect";
const id = Schema.String.check(Schema.isMinLength(1));
export const Created = Schema.Struct({
  operation: Schema.Literal("created"),
  thread_id: id,
  created: Schema.Boolean,
});
export const WorktreeCreated = Schema.Struct({
  operation: Schema.Literal("created"),
  worktree_id: id,
  reference: id,
}).check(Schema.makeFilter((v) => v.reference === v.worktree_id));
export const Attached = Schema.Struct({
  operation: Schema.Literal("attached"),
  thread_id: id,
  reference: id,
});
export const Mounted = Schema.Struct({
  operation: Schema.Literal("mounted"),
  thread_id: id,
  owner: id,
  directory: id,
  worktrees: Schema.Array(
    Schema.Struct({
      reference: id,
      name: Schema.String,
      directory: id,
      state: id,
    }),
  ),
});
export const CheckoutMounted = Schema.Struct({
  operation: Schema.Literal("mounted"),
  reference: id,
  directory: id,
});
export const Published = Schema.Struct({
  operation: Schema.Literal("shared"),
  thread_id: id,
  url: id,
}).check(
  Schema.makeFilter((v) => {
    try {
      const url = new URL(v.url);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  }),
);
export const Invitations = Schema.Struct({
  operation: Schema.Literal("invited"),
  thread_id: id,
  url: id,
  results: Schema.Array(
    Schema.Struct({
      email: Schema.String,
      status: Schema.Literals(["invited", "failed"]),
      message: Schema.optionalKey(Schema.String),
      reason: Schema.optionalKey(Schema.String),
    }),
  ),
});
export const Organizations = Schema.Struct({
  organizations: Schema.Array(
    Schema.Struct({
      id,
      name: Schema.String,
      current: Schema.Boolean,
      personal: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
