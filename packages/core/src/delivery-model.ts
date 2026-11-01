// AGPL-3.0-only; pinned batching/append semantics and modifications: NOTICE.
import { Data, type Schema } from "effect";
import type { OutboxError } from "./outbox.js";
import type { StoredRecord } from "./outbox-model.js";
import type {
  DeltaFailure,
  ErrorDetail,
  retryDecision,
  UnsupportedContract,
} from "./protocol.js";
import type { ProcessRequest, TransportError } from "./transport-errors.js";
export interface DeliveryOptions {
  readonly executable: string;
  readonly cwd: string;
  /** Must already be verified to resolve to threadId; receipt checks are too late to prevent misrouting. */
  readonly reference: string;
  /** Explicit expected thread; source/externalId are always from the outbox. */
  readonly threadId: string;
  readonly producerName: string;
  readonly acknowledgement: "local" | "server";
  readonly transport?: Pick<
    ProcessRequest,
    | "env"
    | "timeoutMs"
    | "maxOutputBytes"
    | "maxFrameBytes"
    | "maxDiagnosticBytes"
    | "forceKillAfterMs"
  >;
}
export interface AttemptProgress {
  readonly acknowledgement: "local" | "server";
  readonly phase: "preflight" | "contract" | "append" | "done";
  readonly batch: readonly number[];
  /** Matched receipts observed; can exceed confirmed durable prefix on storage failure. */
  readonly observed: readonly number[];
  readonly committed: readonly number[];
  readonly remainingBatch: readonly number[];
  /** Records present at selection but beyond this batch; not a current queue inventory. */
  readonly deferred: readonly number[];
  /** Fences from matched observed receipts, even if their persistence fails. */
  readonly fenced: readonly number[];
  /** A valid reload envelope decoded inside the process lifetime, not just bytes read. */
  readonly reloadObserved: boolean;
  readonly pausePersisted: boolean;
  /** Last recognized append envelope; independent of exit classification/pause. */
  readonly lastError: typeof ErrorDetail.Type | null;
}
export class DeliveryValidationError extends Data.TaggedError(
  "DeliveryValidationError",
)<{
  readonly kind:
    | "configuration"
    | "identity"
    | "receipt"
    | "incomplete"
    | "closed";
}> {}
export type AttemptFailure =
  | DeliveryValidationError
  | OutboxError
  | Schema.SchemaError
  | DeltaFailure
  | UnsupportedContract
  | TransportError;
export class DeliveryAttemptError extends Data.TaggedError(
  "DeliveryAttemptError",
)<{
  readonly progress: AttemptProgress;
  readonly failure: AttemptFailure;
  readonly retry:
    | ReturnType<typeof retryDecision>
    | { readonly kind: "unknown" };
  readonly pauseFailure?: OutboxError;
}> {}
export interface AttemptResult {
  readonly status: "empty" | "complete";
  readonly progress: AttemptProgress;
}
export const selectBatch = (pending: readonly StoredRecord[]) => {
  const batch: StoredRecord[] = [];
  let bytes = 0;
  for (const record of pending) {
    const size = new TextEncoder().encode(record.line).length;
    if (batch.length && bytes + size > 2_000_000) break;
    batch.push(record);
    bytes += size;
    if (bytes >= 2_000_000) break;
  }
  return batch;
};
export const copyProgress = (progress: AttemptProgress): AttemptProgress => ({
  ...progress,
  lastError:
    progress.lastError === null ? null : structuredClone(progress.lastError),
  batch: [...progress.batch],
  observed: [...progress.observed],
  committed: [...progress.committed],
  remainingBatch: [...progress.remainingBatch],
  deferred: [...progress.deferred],
  fenced: [...progress.fenced],
});
