// AGPL-3.0-only; pinned watch shapes and modifications: NOTICE, docs/core.md.
import { Schema, SchemaGetter } from "effect";
export const watchObject = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.StructWithRest(Schema.Struct(fields), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]);
export const taggedWatchValue = <T, E, const Tag extends string>(
  schema: Schema.Codec<T, E>,
  tag: Tag,
) =>
  schema.pipe(
    Schema.decodeTo(
      Schema.Struct({
        _tag: Schema.Literal(tag),
        value: Schema.toType(schema),
      }),
      {
        decode: SchemaGetter.transform((value) => ({ _tag: tag, value })),
        encode: SchemaGetter.transform((value) => value.value),
      },
    ),
  );
const id = Schema.String.check(Schema.isMinLength(1));
const nullableId = Schema.NullOr(id);
const integer = Schema.Finite.check(Schema.makeFilter(Number.isSafeInteger));
export const WatchUser = watchObject({
  user_id: nullableId,
  name: Schema.NullOr(Schema.String),
  actor_id: Schema.optionalKey(id),
});
export const WatchItem = watchObject({
  id,
  kind: id,
  after_id: nullableId,
  turn_id: nullableId,
  author: Schema.NullOr(WatchUser),
  created_at: Schema.NullOr(Schema.Finite),
  open: Schema.Boolean,
  content: Schema.Record(Schema.String, Schema.Unknown),
});
export const WatchChild = watchObject({
  thread_id: id,
  reference: id,
  kind: id,
  name: Schema.String,
  status: id,
});
export const WatchWorktree = watchObject({
  reference: id,
  name: Schema.String,
});
const TranscriptTarget = watchObject({
  kind: Schema.Literal("transcript"),
  item_id: nullableId,
  quote: Schema.String,
});
const FileTarget = watchObject({
  kind: Schema.Literal("file"),
  worktree: nullableId,
  path: Schema.String,
  view: Schema.String,
  selected: Schema.NullOr(Schema.String),
  regions: Schema.Array(
    watchObject({
      first_line: integer,
      last_line: integer,
      status: Schema.String,
      text: Schema.String,
    }),
  ),
});
const FutureTarget = watchObject({
  kind: Schema.String.check(
    Schema.makeFilter((kind) => kind !== "file" && kind !== "transcript"),
  ),
});
export const WatchCommentTarget = Schema.Union([
  taggedWatchValue(TranscriptTarget, "TranscriptTarget"),
  taggedWatchValue(FileTarget, "FileTarget"),
  taggedWatchValue(FutureTarget, "UnknownCommentTarget"),
]);
export const WatchComment = watchObject({
  id,
  chain: id,
  after_id: nullableId,
  delivered_with: id,
  routed_to: nullableId,
  author: WatchUser,
  co_authors: Schema.Array(WatchUser),
  agent: Schema.Boolean,
  created_at: Schema.NullOr(Schema.Finite),
  text: Schema.String,
  target: Schema.NullOr(WatchCommentTarget),
});
