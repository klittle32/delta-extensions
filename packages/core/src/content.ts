// AGPL-3.0-only. Emitted ACP blocks and base64 validation adapted from pinned
// hooks/recording/content.ts. See NOTICE and docs/core.md; no host conversion here.
import { Schema } from "effect";

const open = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.StructWithRest(Schema.Struct(fields), [
    Schema.Record(Schema.String, Schema.Json),
  ]);
const optional = <S extends Schema.Constraint>(schema: S) =>
  Schema.optionalKey(Schema.NullOr(schema));
const meta = Schema.Record(Schema.String, Schema.Json);
const annotations = open({
  audience: optional(Schema.Array(Schema.Literals(["user", "assistant"]))),
  priority: optional(
    Schema.Finite.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(1),
    ),
  ),
  lastModified: optional(Schema.String),
  _meta: optional(meta),
});
const common = { annotations: optional(annotations), _meta: optional(meta) };
/** Canonical padded base64, including pad bits; opaque bytes are never decoded/reencoded. */
const base64 = Schema.String.check(
  Schema.makeFilter((value) => {
    if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
      return false;
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    if (value.endsWith("=="))
      return (alphabet.indexOf(value.charAt(value.length - 3)) & 15) === 0;
    if (value.endsWith("="))
      return (alphabet.indexOf(value.charAt(value.length - 2)) & 3) === 0;
    return true;
  }),
);
const icon = open({
  src: Schema.String,
  mimeType: optional(Schema.String),
  sizes: optional(Schema.Array(Schema.String)),
  theme: optional(Schema.Literals(["light", "dark"])),
});
const resourceFields = {
  uri: Schema.String,
  mimeType: optional(Schema.String),
  _meta: optional(meta),
};
const resource = open({
  ...resourceFields,
  text: Schema.optionalKey(Schema.String),
  blob: Schema.optionalKey(base64),
}).check(
  Schema.makeFilter(
    (value) => value.text !== undefined || value.blob !== undefined,
  ),
);
export const ContentBlock = Schema.Union([
  open({ type: Schema.Literal("text"), text: Schema.String, ...common }),
  open({
    type: Schema.Literal("image"),
    data: base64,
    mimeType: Schema.String,
    ...common,
  }),
  open({
    type: Schema.Literal("audio"),
    data: base64,
    mimeType: Schema.String,
    ...common,
  }),
  open({ type: Schema.Literal("resource"), resource, ...common }),
  open({
    type: Schema.Literal("resource_link"),
    uri: Schema.String,
    name: Schema.String,
    title: optional(Schema.String),
    description: optional(Schema.String),
    mimeType: optional(Schema.String),
    size: optional(
      Schema.Finite.check(
        Schema.makeFilter(Number.isSafeInteger),
        Schema.isGreaterThanOrEqualTo(0),
      ),
    ),
    icons: optional(Schema.Array(icon)),
    ...common,
  }),
]);
