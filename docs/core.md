# Built core boundary

This is a deterministic foundation, not an installable mod or parity certification.
The core now includes scoped subprocess JSON/JSONL transport, alongside pure command
parsing and Effect Schema validation. Transport requires the injected Effect
`ChildProcessSpawner` service; the separate `@delta-extensions/core/node` entry
exports `nodeProcessLayer` backed by exact-pinned `@effect/platform-node` 4.1.1.
Core creates no runtime. Tests run real Node fixture processes and inject spawner
layers and TestClock. There is still no authentication, upload, installation,
Delta binary invocation, persistence, host adapter or workflow implementation.

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

## Verification record

The foundation's **48-test** GitHub Actions Core checks succeeded at
[`5f8de2579be95bf7b95ab7c0a651018b01ab347b`](https://github.com/klittle32/delta-extensions/commit/5f8de2579be95bf7b95ab7c0a651018b01ab347b),
[run 41245700377](https://github.com/klittle32/delta-extensions/actions/runs/41245700377),
as confirmed by the parent watcher. That run does **not** verify this process leaf.
Local process verification adds 26 transport/lifecycle tests to the 48 foundation
tests: **74 total across five suites**. The initial process suite failed for a
missing implementation module. Later red runs exposed three failures (acquisition
deadlines and lost valid frame prefixes), then one failure for missing nonzero-exit
diagnostics; each was corrected before the passing checks. Native checks also
caught use of a source-only Schema export; implementation now uses the published
`Schema.fromJsonString(Schema.Unknown)` API and compiles against declarations.

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
| Record envelope and turn constraints | `hooks/recording/outbox.ts`, `hooks/recording/delivery.ts` |
| Six unchanged JSON test fixtures | `hooks/testing/fixtures/cli/thread-status.*.json`, `thread-append.*.json` |

Fixtures are deterministic upstream contract examples, not evidence of installed
CLI execution or live collaboration. Only Linux x64, Bun 1.4.4 and Node 22.23.4
have been exercised here; no host/backend/UI, Windows, macOS, real Delta, or
multi-client behavior has been verified. CI defines the same provider-free checks;
only the foundation CI run identified above has been observed.
