// AGPL-3.0-only; pinned validateThreadFrontier adaptation. See NOTICE.
import { Effect, Schema } from "effect";
import { Status } from "./protocol.js";
const id = Schema.String.check(Schema.isMinLength(1));
const sequence = Schema.Finite.check(
  Schema.makeFilter(Number.isSafeInteger),
  Schema.isGreaterThan(0),
);
const BoundIdentity = Schema.Struct({
  threadId: id,
  source: id,
  externalId: id,
});
const Local = Schema.Struct({
  identity: BoundIdentity,
  nextSequence: sequence,
  pending: Schema.Array(sequence),
}).check(
  Schema.makeFilter((value) =>
    value.pending.every((n) => n < value.nextSequence),
  ),
);
// Only the shared ready/status facts are consumed. Full producer structure is
// validated, including its nullable turn, without interpreting it as authority.
const Observation = Schema.Struct({
  thread_id: id,
  producer: Status.schema.fields.producer,
});
export class ProducerFrontierError extends Schema.TaggedError<
  ProducerFrontierError,
  { readonly brand: unique symbol }
>()("ProducerFrontierError", {
  kind: Schema.Literals([
    "invalid-local",
    "invalid-observation",
    "thread-mismatch",
    "producer-mismatch",
    "behind",
    "ahead",
  ]),
}) {}
export interface ProducerFrontierFacts {
  readonly identity: typeof BoundIdentity.Type;
  /** Exclusive locally acknowledged prefix boundary: min(pending, nextSequence). */
  readonly acknowledgedBefore: number;
  readonly nextSequence: number;
  readonly reportedNextSequence: number;
}
const detach = (
  input: unknown,
  kind: "invalid-local" | "invalid-observation",
) =>
  Effect.gen(function* () {
    const value = yield* Effect.try({
      try: () => structuredClone(input),
      catch: () => new ProducerFrontierError({ kind }),
    });
    yield* Schema.decodeUnknownEffect(Schema.Json)(value).pipe(
      Effect.mapError(() => new ProducerFrontierError({ kind })),
    );
    return value;
  });
/** Compare supplied facts, not their freshness or ACK scope. Success grants no write
 * authority, acknowledges nothing and cannot clear a pause or repair either ledger.
 * Values are detached when the Effect executes; results contain only frozen facts.
 */
export const checkProducerFrontier = (
  localInput: unknown,
  observationInput: unknown,
) =>
  Effect.gen(function* () {
    const local = yield* Schema.decodeUnknownEffect(Local)(
      yield* detach(localInput, "invalid-local"),
    ).pipe(
      Effect.mapError(
        () => new ProducerFrontierError({ kind: "invalid-local" }),
      ),
    );
    const remote = yield* Schema.decodeUnknownEffect(Observation)(
      yield* detach(observationInput, "invalid-observation"),
    ).pipe(
      Effect.mapError(
        () => new ProducerFrontierError({ kind: "invalid-observation" }),
      ),
    );
    if (remote.thread_id !== local.identity.threadId)
      return yield* new ProducerFrontierError({ kind: "thread-mismatch" });
    const producer = remote.producer;
    if (
      !producer ||
      producer.source !== local.identity.source ||
      producer.external_id !== local.identity.externalId
    )
      return yield* new ProducerFrontierError({ kind: "producer-mismatch" });
    const acknowledgedBefore = local.pending.reduce(
      (a, n) => Math.min(a, n),
      local.nextSequence,
    );
    const reportedNextSequence = producer.next_sequence;
    if (reportedNextSequence < acknowledgedBefore)
      return yield* new ProducerFrontierError({ kind: "behind" });
    if (reportedNextSequence > local.nextSequence)
      return yield* new ProducerFrontierError({ kind: "ahead" });
    return Object.freeze({
      identity: Object.freeze({ ...local.identity }),
      acknowledgedBefore,
      nextSequence: local.nextSequence,
      reportedNextSequence,
    }) satisfies ProducerFrontierFacts;
  });
