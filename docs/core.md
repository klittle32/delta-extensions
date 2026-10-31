# Built core boundary

This is a deterministic foundation, not an installable mod or parity certification.
The core now includes scoped subprocess JSON/JSONL transport, alongside pure command
parsing, Effect Schema validation and durable producer storage. Transport requires the injected Effect
`ChildProcessSpawner` service; the separate `@delta-extensions/core/node` entry
exports `nodeProcessLayer` backed by exact-pinned `@effect/platform-node` 4.1.1.
Core creates no runtime. Tests run real Node fixture processes and inject spawner
layers and TestClock. There is still no authentication, upload, installation,
Delta binary invocation, submission, host adapter or workflow implementation.

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
- `StateRecord`, `DeltaRecord` / `RecordBatch` cover record `schemaVersion: 1`: running/idle, user/assistant/thought messages, tool input/result (all emitted content blocks and add/modify git diffs), and titles. They enforce positive safe sequences, original turn associations,
  and nonempty consecutive batches. Unscoped history is permitted. A turn may
  name its own sequence only for its running start. Allocation and persistence are provided separately by the outbox below.
- `Receipt` and `correlateReceipts` validate each append receipt, including thread,
  sequence, frontier, version, disposition, and exact nullable original turn.
  A valid shorter receipt list returns the pending suffix; fenced turn sequences
  are reported without rewriting late output. Invalid, reordered, extra or
  mismatched receipts fail visibly; this helper deletes nothing and assumes no
  delivery after a validation failure. Callers must retain records until their
  durable receipt handling succeeds. The transport below supplies JSONL framing,
  but does not persist or correlate receipts automatically.
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

## Emitted content blocks

Message and wrapped tool-result content validate every block variant emitted by
pinned `hooks/recording/content.ts`: text, base64 image, base64 audio,
`resource` with text or base64 blob, and `resource_link`. Document inputs are
already converted upstream to resources/links; raw `document`, image `source`,
and other input-only shapes are deliberately not additional wire variants here.
This leaf validates emitted records; it does not implement host capture/conversion.

Payload strings, URI strings, JSON extension fields and metadata are preserved.
Canonical padded base64 (including pad-bit validation) follows the pinned emitter;
bytes are not decoded/reencoded. Empty payloads/strings remain accepted where the
emitter accepts them. URI/MIME strings are opaque, not normalized or fetched.
Known optional annotation, icon, size and metadata structures are validated;
nullable optional fields emitted by upstream remain accepted. Missing resource
payloads, malformed base64, invalid audience/priority/size/icon types and unknown
block discriminants fail visibly without a lossy text fallback. This does not
read local files, inspect media bytes or verify URI access/MIME truth.

The adapted fixture links directly to
[the pinned MCP content test](https://github.com/zed-industries/delta-claude/blob/ac769c681ba7a95ec7347b591f0858857a1a9e80/hooks/recording/content.test.ts#L115)
and [emission/validation](https://github.com/zed-industries/delta-claude/blob/ac769c681ba7a95ec7347b591f0858857a1a9e80/hooks/recording/content.ts#L60).
Local additions exercise annotations, icons, null optionals and opaque extensions.
All four existing message/tool envelope kinds are schema-tested; real temporary
storage tests prove exact bytes survive stage/replay/reopen. An oversized image
record is refused before sequence allocation. The 16 MiB serialized JSONL record
limit matches pinned `outboxChunks`; base64 overhead counts toward it. No limit
was raised. Existing local JSON serialization also rejects nesting deeper than
128 levels; the pinned emitter has no corresponding explicit depth cap, so very
deep metadata can still be rejected locally. This pre-existing semantic bound
remains deliberate and visible. Local total-store retention/read limits described
below remain unchanged.

## Process transport

`runJson(request, schema)` returns an Effect containing one decoded JSON document.
It drains stdout and stderr concurrently, accepts pretty-printed JSON, waits for
both pipe EOFs and the actual exit result, and returns success only for exit zero.
A valid structured CLI error takes precedence over a nonzero code; a nonzero
exit without usable JSON retains the exit code and bounded stderr diagnostics.

`watchJsonLines(request, schema)` returns a Stream, spawning a fresh scoped child
per materialization. It frames raw bytes before strict UTF-8 and Schema decoding;
CRLF, multiple lines per chunk, multibyte splits, and an unterminated final line
work. Blank or malformed JSON, unsupported schema discriminants, and malformed
UTF-8 fail visibly. Valid preceding frames remain delivered when a later frame
fails. Output frames can arrive **before exit**; only natural stream completion
proves exit zero. `Stream.take`, interruption, and error/timeout teardown do not
certify that the command succeeded or that an unreceived record was delivered.

Requests require an executable, explicit argv, and cwd. The command sets
`shell: false`, piped output, ignored stdin, and `extendEnv: true`: optional env
overrides preserve inheritance; an explicitly undefined value removes its key.
There is no stdin upload/batch writer in this leaf. The spawner owns acquisition
and termination; the enclosing Effect/Stream scope runs its release finalizer.
No transport runtime, global process instance, background watcher, unscoped fiber,
or manual `child_process` implementation is introduced.

| Request option | Default and meaning |
| --- | --- |
| `timeoutMs` | 120,000 ms total acquisition/read/exit lifetime, not idle time |
| `maxOutputBytes` | 16 MiB total across stdout **and stderr**, for either operation |
| `maxFrameBytes` | 16 MiB per JSONL line, excluding LF but including CR |
| `maxDiagnosticBytes` | 4,096 retained stderr suffix bytes; zero disables retention |
| `forceKillAfterMs` | 250 ms SIGTERM grace before platform SIGKILL escalation |

Limits must be safe integers; time/output/frame limits must be positive, diagnostic
retention/grace may be zero. Watch lifetime and cumulative output are finite too;
callers must deliberately select suitable budgets. No automatic reconnect/retry
is implied. These defaults are a tested transport boundary, not a claim of complete
upstream watch policy. Stderr is always drained even when retention is disabled.
Retention keeps only suffix bytes and decodes diagnostics with replacement; a
cut multibyte suffix can render a replacement character. Frame buffers grow within
the configured bound; there is no unbounded line queue or whole watch collection
inside core. One-shot output is collected within the aggregate byte limit.

`TransportError` distinguishes configuration, output/frame limit, encoding, I/O,
nonzero exit and timeout failures. It carries no argv, environment, or stdout;
platform failure details are not copied into it. Schema failures remain
`SchemaError`; structured CLI failures remain `DeltaFailure` with retry hints and
extensions. No failures are blindly retried. Normal signal termination cannot
produce a successful numeric exit from the public spawner and fails as I/O.

Tests prove direct-child exit using the Node handle's exit result plus `isRunning`
and OS PID checks, including a SIGTERM-ignoring child, early consumption stop,
parent-fiber interruption, malformed/oversized output, and deadlines. Closed
stdout/stderr pipes alone are explicitly tested as insufficient exit proof.
TestClock advances transport deadlines, including blocked injected acquisition;
a decorator deterministically splits bytes from real child pipes to exercise
UTF-8 boundaries independent of OS chunk coalescing. No descendant-tree or Windows
termination guarantee has been proved. The official Node backend can take its
granted termination grace plus additional platform cleanup time; a deadline starts
cleanup, it does not promise an instantaneous wall-clock return.

## Durable local producer outbox

`openOutbox({ root, identity, mode })` is scoped; `ProducerOutbox` / `outboxLayer`
provide the same operations as an injected service. Supply Effect FileSystem,
Path and Digest services; core creates no runtime. `root` must be an explicit
absolute private host-storage directory with an existing parent, never an implicit
checkout directory. `mode: "create"` requires a new directory; `"reopen"` requires
intact existing state. Identity binds source, externalId, threadId and scopeId. Its serialized UTF-8
JSON is limited to 32 KiB, checked before creating storage, reserving room for the
checkpoint envelope within its 64 KiB read limit.

- `stage(id, { update, turnSequence? })` allocates consecutive sequences starting
  at one, persists immutable JSON+LF bytes, then returns those exact replay bytes.
  Same ID and same bytes is idempotent; conflicting bytes fail. Late output keeps
  its original turnSequence. MAX_SAFE_INTEGER is reserved as the final frontier.
- `replay` is an Effect returning the unacknowledged suffix; `snapshot` exposes
  identity, next sequence, pending sequences, fences and persisted pause state.
- `applyReceipts(receipts)` commits each validated receipt separately. A later
  invalid receipt does not undo the acknowledged prefix or delete the suffix.
  Errors retain applied-count/fence information; replayed receipts are idempotent.
  Receipt object key order is immaterial; array order and scalar values remain significant.
- `pauseForReload(error)` persists a structured `reload_required` pause. Stage and
  replay then fail paused, including after reopen. No automatic retry or reset.

Local journal format 1 is separate from CLI contract 8 and record schemaVersion 1.
Each numbered immutable transaction chains SHA256 to its predecessor. Commit writes
and syncs the transaction, syncs the directory, writes/syncs `head.next`, renames it
over `head.json`, then syncs the directory before returning. Root/lock directories
use mode 0700; files use 0600, exclusive creation and no-follow opens. Reads reject
nonprivate files, malformed/noncanonical state, broken chains and unexpected files.
Record bytes are limited to 16 MiB; transaction reads to 64 MiB. All transactions,
including acknowledged records, remain retained: no compaction/GC or total-store
quota is implemented. Revalidation on every operation trades speed for a small,
conservative persistence owner; this is not a high-volume database.

An exclusive `.writer` directory rejects concurrent local writers. A semaphore
serializes operations and teardown waits for an active commit. Device/inode checks
reject replaced locks. Real validation/read failures conservatively poison the handle and retain the
lock, even without a write. Interrupt-only cancellation during a guard read or
while queued does not poison ownership. Commits remain uninterruptible until
publication completes or fails ambiguously; interrupted callers must replay to
discover committed records. Ambiguous writes poison the handle and retain the lock;
crashes leave the lock intact. Missing/unreadable state never creates a replacement
producer or reuses sequences. There is deliberately no automatic stale-lock reclaim
or recovery API: an owner must inspect preserved files and decide recovery explicitly.
A lock-release finalizer failure becomes a defect via `orDie`, rather than a
normal typed operation failure. This is cooperative local POSIX ownership, not protection from malicious writers,
NFS/distributed coordination or proof of power-loss behavior.

Tests use real temporary files, injected write/rename/read faults and two actual
Bun-child SIGKILL cases (completed stage and prepared checkpoint before rename).
Test-only explicit lock removal demonstrates intact reopen versus refusal of an
ambiguous journal; production code never does this. No raw Node persistence syscall
or hidden runtime was needed. No submission/network operation is provided.

## Verification record

Foundation CI passed **48 tests** at
[`5f8de2579be95bf7b95ab7c0a651018b01ab347b`](https://github.com/klittle32/delta-extensions/commit/5f8de2579be95bf7b95ab7c0a651018b01ab347b),
[run 41245700377](https://github.com/klittle32/delta-extensions/actions/runs/41245700377).
Process CI passed **74 tests** at `3bdc8c0`,
[run 41247550048](https://github.com/klittle32/delta-extensions/actions/runs/41247550048).
Outbox/tooling CI passed at `c46899830de034aa0d16f7f1974eb1477cc4b516`,
[run 41250090689](https://github.com/klittle32/delta-extensions/actions/runs/41250090689).
The parent watcher confirmed all three runs. The outbox checkpoint also passed
121 local tests/build/frozen install and independent blocker recheck.
Those runs do not cover this subsequent content leaf. Outbox verification adds
47 tests: **121 across eight suites**.
Red runs exposed missing implementation, empty-lock removal, teardown racing an
active commit, cached replay hiding corruption, and lost fencing after a later bad
receipt; each was fixed before green. Review regressions additionally exposed
interrupt-only guard poisoning (stage/replay/snapshot), oversized identity acceptance
and receipt object-order conflicts. Tests now cover queued and in-commit cancellation,
reuse/close/reopen, and continued fail-closed behavior for real read failures. Tooling verification also used a temporary
floating-Effect probe: Oxlint failed with two Effect-rule errors; the probe was
removed. See [Effect tooling](effect.md) for exact versions and visible warnings.

Content leaf TDD: six expected initial failures (four envelope variants, durable
replay and malformed optional fields), then seven content tests green. Current
local suite: **128 tests across nine suites**. Frozen installation and full checks
are run with generated output present; this is not live Delta/host acceptance.

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
| Transport invariants | `hooks/cli/command-reader.ts`; new Effect implementation and original Node fixtures |
| Record envelope, turn constraints and durable outbox semantics | `hooks/recording/outbox.ts`, `hooks/recording/delivery.ts` |
| Emitted content blocks, tool/title updates and adapted record-content fixture | `hooks/recording/content.ts`, `hooks/recording/title.ts` |
| Six unchanged JSON test fixtures | `hooks/testing/fixtures/cli/thread-status.*.json`, `thread-append.*.json` |

Fixtures are deterministic upstream contract examples, not evidence of installed
CLI execution or live collaboration. Only Linux x64, Bun 1.4.4 and Node 22.23.4
have been exercised here; no host/backend/UI, Windows, macOS, real Delta, or
multi-client behavior has been verified. CI defines the same provider-free checks;
the two checkpoint CI runs identified above have been observed; neither covers this leaf.
