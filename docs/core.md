# Built core boundary

This is a deterministic foundation, not an installable mod or parity certification.
The core now includes scoped subprocess JSON/JSONL transport, alongside pure command
parsing, Effect Schema validation, durable producer storage and one-attempt append delivery. Transport requires the injected Effect
`ChildProcessSpawner` service; the separate `@delta-extensions/core/node` entry
exports `nodeProcessLayer` backed by exact-pinned `@effect/platform-node` 4.1.1.
Core creates no runtime. Tests run real Node fixture processes and inject spawner
layers and TestClock. There is still no authentication, upload, installation,
live Delta binary invocation, host adapter or end-to-end workflow implementation.

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
  but does not persist or correlate receipts automatically. The append delivery
  owner below explicitly validates and persists receipts for its selected batch.
- `WatchEvent` covers all pinned contract-8 watch data variants (including
  `ProducerTurnEvent`), with explicit known/future-event wrappers. See the
  readonly watch boundary below; snapshot reconstruction is not implemented.
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
both pipe EOFs, input-sink completion and the actual exit result, and returns
success only for exit zero without a detected input write failure.
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
`shell: false`, piped output, and `extendEnv: true`: optional env
overrides preserve inheritance; an explicitly undefined value removes its key.
The input contract follows [pinned threadAppend](https://github.com/zed-industries/delta-claude/blob/ac769c681ba7a95ec7347b591f0858857a1a9e80/hooks/cli/delta-cli.ts#L384).
Optional immutable string `stdin` is encoded once as UTF-8 with no newline
changes. Absence keeps stdin ignored; an empty string opens a pipe and sends EOF.
Lone UTF-16 surrogates are configuration errors rather than silently replaced.
Input size/configuration are checked before spawn. The public process handle
stdin sink receives lazy 64 KiB byte views with backpressure and closes on
completion (`endOnDone: true`). Writing runs concurrently with both output drains
inside the existing total deadline/scope. No additional runtime or raw Node
process implementation is used. The spawner owns acquisition
and termination; the enclosing Effect/Stream scope runs its release finalizer.
No transport runtime, global process instance, background watcher, unscoped fiber,
or manual `child_process` implementation is introduced.

| Request option | Default and meaning |
| --- | --- |
| `timeoutMs` | 120,000 ms total acquisition/read/exit lifetime, not idle time |
| `stdin` | Optional exact string input; absent ignores stdin, empty sends EOF |
| `maxInputBytes` | 16 MiB total UTF-8 input; zero allows only empty input |
| `maxOutputBytes` | 16 MiB total across stdout **and stderr**, for either operation |
| `maxFrameBytes` | 16 MiB per JSONL line, excluding LF but including CR |
| `maxDiagnosticBytes` | 4,096 retained stderr suffix bytes; zero disables retention |
| `forceKillAfterMs` | 250 ms SIGTERM grace before platform SIGKILL escalation |

Limits must be safe integers; time/output/frame limits must be positive, diagnostic
retention/grace/input budgets may be zero. Watch lifetime and cumulative output are finite too;
callers must deliberately select suitable budgets. No automatic reconnect/retry
is implied. These defaults are a tested transport boundary, not a claim of complete
upstream watch policy. Stderr is always drained even when retention is disabled.
Retention keeps only suffix bytes and decodes diagnostics with replacement; a
cut multibyte suffix can render a replacement character. Frame buffers grow within
the configured bound; there is no unbounded line queue or whole watch collection
inside core. One-shot output is collected within the aggregate byte limit.

`TransportError` distinguishes configuration, input/output/frame limit, encoding,
input write failure (`kind: "input"`), I/O,
nonzero exit and timeout failures. It carries no argv, environment, or stdout;
platform failure details are not copied into it. Schema failures remain
`SchemaError`; structured CLI failures remain `DeltaFailure` with retry hints and
extensions. No failures are blindly retried. Normal signal termination cannot
produce a successful numeric exit from the public spawner and fails as I/O.

Input write failures are retained while output drains, so valid JSONL prefixes
remain observed. A structured CLI error retains precedence; otherwise nonzero
exit retains precedence over input failure. A valid success response with exit
zero still fails if the sink detected a write/early-close error. Malformed output
can instead surface a Schema/encoding/frame error before the final input check;
that error does not establish successful input delivery. Callers must retain
unacknowledged records regardless of which failure is reported. A blocked writer,
including a child that never reads stdin, is bounded by the same timeout;
interruption or early consumer stop cancels the writer and finalizes the child.
If a child stays alive after a write failure, draining/exit can reach that timeout.
Core never adds request input or environment to TransportError; bounded child
stderr remains diagnostic data as before. No automatic retry is performed.

Sink completion proves successful writes/EOF at the platform pipe boundary, not
that the child parsed, consumed or durably accepted every byte. In particular a
small buffered write can finish before a child closes its read end. No submission
or per-record delivery acknowledgment is inferred; future callers still need
validated receipts. The default 16 MiB total input fits one maximum outbox record;
multiple records must fit the configured total budget. No append workflow exists.

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

## One-attempt append delivery

`makeAppendDelivery(options)` requires the bound `ProducerOutbox` and a Scope;
`AppendDelivery` / `appendDeliveryLayer(options)` provide the same functional
owner through Effect services. `attempt` is an Effect using the injected process
spawner at execution; `progress` returns a defensive copy of the latest in-memory
attempt progress, including after cancellation. Core creates no runtime, persistent worker,
watcher or retry loop. Each invocation uses a fiber forked into the owner Scope;
caller interruption is forwarded to that fiber and awaits its cleanup. Create one
owner for an outbox; attempts are single-flight within that owner. This is a
caller obligation, not a globally enforced registry: two owners can submit
overlapping batches. Exact repeated receipts can still be durably idempotent;
that does not serialize two owners' subprocesses. Concurrent calls wait interruptibly, then select fresh pending
records. Owner teardown interrupts its invocation fibers, waits for child cleanup and
closes admission. Admission also reads public `Scope.state`: it is `Closed`
from the start of closing, before the late boolean finalizer runs. Calls during
a blocked mid-close finalizer fail closed without spawning. Process scopes own
child finalization, including calls made
from an outer caller fiber.

Options require an explicit executable, cwd, reference, expected threadId,
producerName and acknowledgement (`local` or `server`). Expected threadId must
match the bound store before any subprocess; source/externalId come exclusively
from that store, never a hard-coded Claude identity. Reference **must be an already
verified binding/locator for the expected thread**. It is not independently
resolved here; no URL shape proves its identity. Receipt validation happens after
CLI side effects and cannot protect against a caller routing bytes to the wrong
thread. This operation does not establish a sharing/binding workflow.

An empty replay performs no subprocess work. A nonempty attempt first runs
`--json thread contract` and negotiates contract 8, with no version/cache guess.
It selects whole immutable replay lines up to **2,000,000 UTF-8 bytes**; one larger
record is allowed alone up to the existing **16 MiB** maximum. It neither rewrites
bytes nor splits/resequences records. The selected prefix is fixed before contract
negotiation; later staged records are never treated as sent. Invocation is:

```text
--json thread append REFERENCE --source SOURCE --external-id EXTERNAL_ID
[--acknowledge local] --producer-name PRODUCER_NAME
```

`server` selects the CLI's default acknowledgement behavior (omits that option).
`local` explicitly asks for local persistence; neither result is an independent
upload-status check. Transport budgets may be configured; each command has its
own total deadline. The attempt can therefore take a contract deadline plus an
append deadline and filesystem finalization time. There is no whole-workflow timer.

Receipts are decoded incrementally with the existing Schema/transport. Each must
match the exact next sent sequence, thread and nullable original turn before it
can reach outbox receipt application. One receipt is durably applied at a time.
The matched observation, write and progress update are uninterruptible together;
interruption/timeout can wait for filesystem work, and is never turned into a
successful result. Malformed, wrong, repeated/reordered or extra receipts cannot
acknowledge an unsent record. Valid `duplicate` and `fenced` dispositions count as
accounted-for records, with fenced turns retained for the future host to stop.
This leaf does not perform that host cancellation.

A result is `empty` or `complete` **for the selected batch**, not for the current
queue, server upload or all records ever staged. Progress contains:

- `batch`: exact selected sequences; `deferred`: the original unsent suffix at
  selection time, excluding records staged afterward.
- `observed`: the ordered matching receipt prefix; `committed`: its confirmed
  durable prefix; `remainingBatch`: selected sequences not confirmed durable.
- `fenced`: matching observed fences, retained even when their receipt persistence
  fails; `reloadObserved`: a valid reload envelope was decoded inside the process
  lifetime, not merely written/read as bytes; `pausePersisted`: this attempt
  confirmed a durable reload pause.
- `phase` and explicit acknowledgement choice. Phase identifies the attempted
  operation, not proof that a child started or the server accepted input.

`DeliveryAttemptError` carries the typed underlying `failure`, progress and explicit
retry hint (`retryDecision` for structured CLI errors; otherwise `unknown`). No
retry occurs. For append, a valid `reload_required` is observed and its pause
attempted uninterruptibly **inside the frame decoder and process resource Scope**,
before the error can trigger child teardown. Decode and observation are masked
together; caller cancellation or owner close during SIGTERM/SIGKILL grace cannot
skip persistence by bypassing an outer error handler. This is not an outer
`tapError` after resource release. `reloadObserved` may be true while
`pausePersisted` is false during persistence or after its failure. If pause
persistence fails, `pauseFailure` is retained alongside the original CLI failure;
no pause is claimed. Ambiguous filesystem writes keep the existing poisoned
outbox/lock behavior. In-memory progress is not a replacement recovery journal.

If timeout or cancellation wins during child teardown, the terminal failure may
not name the already-observed reload; a timeout can carry an `unknown` retry hint.
Callers must honor `reloadObserved`, `pausePersisted` and the durable outbox pause
rather than treating the retry hint alone as permission to continue. The timeout
case is covered by a real-child SIGTERM-grace regression.

Empty or shortened successful output is an explicit `incomplete` failure, never an
inferred receipt. A previously committed prefix remains committed through later
schema/correlation errors, structured failures, nonzero exit, output limit,
interruption or child crash. On persistence failure, an observed receipt may
already have reached disk without confirmation: `committed` is a conservative
confirmed prefix, not a claim that other records were unaccepted. Pending records
can also have reached Delta despite absent receipts. Do not infer non-acceptance
or manufacture new records/sequences from any attempt failure.

### Remaining append parity differences

This is not full append parity. The public generic watch contract remains
fail-fast and unchanged. Two append-specific differences are explicitly tested:

- **Malformed line before a later reload envelope:** a malformed JSON/frame/schema
  failure ends this receipt stream, so a later envelope may never be decoded or
  paused. Pinned `appendFailure` scans captured raw stdout from the end on nonzero
  exit and can find that later error. Here `reloadObserved` stays false for an
  unexamined envelope; the confirmed receipt prefix survives and the suffix stays
  pending/uncertain. There is no claim that raw bytes prove a decoded reload.
- **Valid error envelope with exit zero:** the generic stream treats it as a
  `DeltaFailure` and a decoded reload pauses the outbox regardless of exit status.
  Pinned append delivery classifies error envelopes only for nonzero exits; its
  zero-exit acknowledgment mismatch is `invalid_acknowledgment`. No append-specific
  raw-output scanner or exit-dependent envelope classifier is implemented here.

Pinned authorities:
[threadContract/threadAppend](https://github.com/zed-industries/delta-claude/blob/ac769c681ba7a95ec7347b591f0858857a1a9e80/hooks/cli/delta-cli.ts#L384),
[appendPending](https://github.com/zed-industries/delta-claude/blob/ac769c681ba7a95ec7347b591f0858857a1a9e80/hooks/recording/delivery.ts#L324),
and [batching](https://github.com/zed-industries/delta-claude/blob/ac769c681ba7a95ec7347b591f0858857a1a9e80/hooks/recording/outbox.ts#L44).
The new implementation persists each validated receipt incrementally rather than
waiting to save a captured stdout prefix. Fixtures are original actual Node child
programs; test-only file gates make post-receipt failure/crash ordering deterministic.
No real Delta executable/service/account, installation, authentication, watch,
retry loop, snapshot or adapter workflow was exercised or implemented in the append leaf.

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
Content checkpoint CI passed at `7078fa2435bba08822feae76353fa5d3e872652f`,
[run 41250546873](https://github.com/klittle32/delta-extensions/actions/runs/41250546873),
with 128 tests/nine suites, independently rechecked by the parent.
Stdin checkpoint CI passed at `beb0ed328e305dea33afaaad4d6af903b3a81b54`,
[run 41251535751](https://github.com/klittle32/delta-extensions/actions/runs/41251535751),
with 142 tests, independently reviewed and fullchecked by the parent.
None of those checkpoint runs covers this append-delivery leaf. Outbox verification adds
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
replay and malformed optional fields), then seven content tests green: **128 tests across nine suites**. Frozen installation and full checks
are run with generated output present; this is not live Delta/host acceptance.

Stdin leaf TDD: five initial failures with six existing-behavior passes, then
14 stdin tests green: **142 tests across ten suites**. Tests cover exact Unicode,
CRLF/final-line bytes, absent/empty/zero-budget input, pre-spawn rejection,
duplex pressure, early close with success/nonzero/structured output, observed
JSONL prefixes, TestClock deadline, blocked one-shot input, interruption and
consumer-stop cleanup with actual direct-child exit evidence. No live Delta call.

Append-delivery TDD began with a missing-module failure. Three later red tests
caught lost reload pause on interruption, lost observed fence on persistence
failure, and owner teardown failing to cancel an outer caller's active attempt;
all were corrected. That checkpoint had **33 new tests; 175 total across fourteen suites**.
Coverage includes real argv/metadata, contract refusal, byte-exact Unicode batch
boundaries/maximum record, receipt prefix errors, actual output limits, concurrent
staging/single-flight, interrupted direct-child teardown, child SIGKILL/reopen,
partial receipt/pause reopen, ambiguous injected writes and real service/layer use.
Review task71 reproduced a further gap: a decoded reload was lost when
interruption arrived during SIGTERM grace before the outer catch. A red run
showed two lost-pause failures (caller/owner) plus mid-close admission failing
the typed-closed check; the no-interruption control passed. Inner-scope decode/
pause ownership fixes both teardown paths; mid-close admission now checks public
Scope state. Six review tests cover these cases and the two disclosed parity
differences: **181 tests across fifteen suites**. Real-child tests use a SIGTERM
marker, a 1,500 ms forced-kill grace and interruption 200 ms into teardown, and
check actual handle exit plus OS PID absence. Full checks and frozen installation
run with build output present. The append checkpoint
[`2d03ad9`](https://github.com/klittle32/delta-extensions/commit/2d03ad97fd7e8bd3b50e056348f1ac626493262f)
passed [CI 41254238387](https://github.com/klittle32/delta-extensions/actions/runs/41254238387).

## Readonly watch wire boundary

`watchThread({ executable, cwd, binding, transport? })` is a cold Effect Stream.
Each materialization negotiates contract 8, then runs exactly
`--json thread watch REFERENCE --source SOURCE --external-id EXTERNAL_ID`.
The explicit caller binding supplies all identity; there is no Claude identity,
`--participate`, stdin, runtime, retry, reconnect or background daemon. The
reference must already be a verified binding for the intended thread; neither
URL shape nor subsequent event decoding proves correct routing. Transport
limits/deadlines apply to each child operation, not a combined two-command budget.

`decodeWatchEvent` validates ready/item/item.append/remove/live/turn/producer.turn/
presence/children/child/child.remove/worktrees/comment/comment.remove and terminal
structured errors. Ready requires a nullable producer; live remains a literal wire
boundary. Item content is an opaque object; item/child kinds and child statuses
remain open. Users, producer frontiers, turns, nullable fields, comments, worktrees
and file/transcript target structures are checked against the pinned validators.
Unknown future events become `UnknownWatchEvent` values (upstream skips them),
and unknown comment targets become `UnknownCommentTarget`. Consumers must ignore
unknown event wrappers explicitly. Malformed known types cannot enter these future
branches. Encoders restore the raw wire shape. Extension fields are preserved,
including event/child/worktree extras which the pinned parser sometimes projects
away; no opaque content is converted to text or local files opened.

The existing generic transport remains fail-fast: malformed JSON/schema errors,
nonzero exits, structured failures, limits, timeout and cancellation remain visible.
Already emitted frames do not imply successful completion. Structured failures retain
retry hints without retrying. Unlike the upstream line reader, blank lines are
rejected; the core accepts a final unterminated JSON line and rejects malformed
UTF-8. Malformed error envelopes remain visible schema failures. No ready ordering,
duplicate-ready detection, producer binding/frontier reconciliation, snapshot
reducer, live-state transition, host watch workflow or full parity is claimed.

Additional compatibility limits are explicit: any top-level `error` key is
treated as an envelope, so even `error: null` rejects an otherwise valid frame.
Invalid optional error fields reject the envelope rather than preserving its
code and dropping the bad hint as upstream does. A bare `{type: "error"}` also
fails instead of being ignored. The exported wire codecs include the error
variant, but `decodeWatchEvent` and `watchThread` surface valid envelopes as
`DeltaFailure`, not event values. Default transport budgets terminate the child
at 120 seconds or 16 MiB cumulative output; a future long-lived owner must choose
appropriate finite budgets explicitly. Configuration is read on each cold-stream
materialization; callers must not mutate it during use.

Watch TDD first failed on missing decoder/invocation modules; the completed leaf
adds 17 tests (199 total across seventeen suites). Tests adapt all 18 pinned frames,
roundtrip retained fields/targets, reject malformed known variants, and use bounded
real Node fixtures for exact argv/cwd/identity, contract refusal, errors, limits,
timeout, consumer stop and interruption. Cleanup checks child exit and PID absence;
this proves direct-child ownership on Linux, not descendant-tree termination.
No live Delta or host call is made. No remote CI for this watch leaf is claimed.

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
| Transport invariants | `hooks/cli/command-reader.ts`, `hooks/cli/delta-cli.ts:384` (exact append stdin); new Effect implementation and original Node fixtures |
| Record envelope, turn constraints, batching and append-delivery semantics | `hooks/recording/outbox.ts`, `hooks/recording/delivery.ts` |
| Emitted content blocks, tool/title updates and adapted record-content fixture | `hooks/recording/content.ts`, `hooks/recording/title.ts` |
| Watch schemas and adapted 18-frame fixture | `hooks/cli/thread-commands.ts`, `hooks/cli/delta-cli.ts:407–440`, `hooks/testing/fixtures/cli/thread-watch.frames.jsonl`; consumers `hooks/watch/watch.ts` |
| Six unchanged JSON test fixtures | `hooks/testing/fixtures/cli/thread-status.*.json`, `thread-append.*.json` |

Fixtures are deterministic upstream contract examples, not evidence of installed
CLI execution or live collaboration. Only Linux x64, Bun 1.4.4 and Node 22.23.4
have been exercised here; no host/backend/UI, Windows, macOS, real Delta, or
multi-client behavior has been verified. CI defines the same provider-free checks;
the five checkpoint CI runs identified above have been observed; none covers this leaf.
