# Built core boundary

This is a deterministic foundation, not an installable mod or parity certification.
It has no platform dependencies, runtime, subprocesses, filesystem access, timers,
authentication, upload, or host integration. Effect decoders own typed validation
failures; command parsing is pure. There is no resource-owning service to inject
in this slice: tests inject protocol values directly into Effect decoders/functions,
using `@effect/vitest` scopes. Services/layers become appropriate when I/O starts.

Command parsing retains dedicated-command context: bare `/delta-org` returns a
`team-menu` intent, and bare `/delta-join` returns a join prompt intent (null
locator). `/delta org` and `/delta join` return usage. Interactive execution and
noninteractive fallback still belong to the future adapter.

## Protocol coverage

- `Contract` validates `thread contract` output; `negotiate` accepts only a range
  containing CLI contract **8**. Malformed ranges are `SchemaError`; incompatible
  ranges are `UnsupportedContract`. No version-string compatibility inference.
- `Status` validates full contract-8 status: access, upload, worktree inspection,
  producer identity/frontier/turn and optional actor ID. Inspection unavailability
  remains data; it does not become an empty successful inventory.
- `StateRecord` / `RecordBatch` cover record `schemaVersion: 1` **state updates
  only**, running or idle, positive safe sequences, original turn associations,
  and nonempty consecutive batches. Unscoped history is permitted. A turn may
  name its own sequence only for its running start. This is validation, not
  sequence allocation or durable outbox handling.
- `Receipt` and `correlateReceipts` validate each append receipt, including thread,
  sequence, frontier, version, disposition, and exact nullable original turn.
  A valid shorter receipt list returns the pending suffix; fenced turn sequences
  are reported without rewriting late output. Invalid, reordered, extra or
  mismatched receipts fail visibly; this helper deletes nothing and assumes no
  delivery after a validation failure. Callers must retain records until their
  durable receipt handling succeeds. JSONL transport/framing is not implemented.
- `ProducerTurnEvent` covers only `producer.turn`, including supersession.
  Other watch events and full snapshot reconstruction are not supported yet.
- `decodeResponse(schema)` checks a structured `error` before success decoding.
  Invalid envelopes remain `SchemaError`; valid failures are `DeltaFailure` and
  retain code, diagnostic reason, retryability, delay and extension fields.
  `retryDecision` requires explicit retryability, preserves the declared delay,
  and surfaces `reload_required` as a separate repair decision. It performs no
  retry or repair. An omitted delay yields zero; callers still own scheduling.

Response/event objects, nested objects and update metadata retain unknown fields.
Record envelopes deliberately reject extra top-level keys, matching the pinned
pending-record boundary: unsupported control records cannot masquerade as updates.
Unknown discriminants and malformed known semantics fail; they are not dropped,
coerced to success, or presented as complete protocol support. These are decoded
object schemas, not canonical JSONL storage validation or a duplicate-key parser.

## Provenance and licensing

The root [LICENSE](../LICENSE) is AGPL-3.0-only; [NOTICE](../NOTICE) identifies
upstream ownership and modifications. No code was copied into the Letta host repo.

Authority: [public contract-8 documentation](https://delta.dev/docs/cli/build-a-plugin),
retrieved October 31, 2026. The CLI contract is separate from record schema version.
Pinned reference: [delta-claude ac769c6](https://github.com/zed-industries/delta-claude/tree/ac769c681ba7a95ec7347b591f0858857a1a9e80).

| Local material | Pinned upstream authority |
| --- | --- |
| Command grammar and email splitting | `hooks/register.tsx` (dedicated menu routing), `hooks/setup/commands.ts`, `hooks/setup/setup.ts` |
| Contract/status/receipt/error/producer-turn schemas | `hooks/cli/thread-commands.ts` |
| Record envelope and turn constraints | `hooks/recording/outbox.ts`, `hooks/recording/delivery.ts` |
| Six unchanged JSON test fixtures | `hooks/testing/fixtures/cli/thread-status.*.json`, `thread-append.*.json` |

Fixtures are deterministic upstream contract examples, not evidence of installed
CLI execution or live collaboration. Only Linux x64, Bun 1.4.4 and Node 22.23.4
have been exercised here; no host/backend/UI, Windows, macOS, real Delta, or
multi-client behavior has been verified. CI defines the same provider-free checks;
a remote CI run has not been observed.
