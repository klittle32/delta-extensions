# Host implementation checkpoint

This is an **in-progress source checkpoint**, not a compatibility certification.
No installable Delta mod or live Delta collaboration test exists yet.

The generic Letta changes are being developed against Letta Code `0.34.36`,
upstream commit `8b713fe8f339a2f998b9d3ee339e185d5d409146`, on branch
`delta/mod-host-apis` for the [personal fork](https://github.com/klittle32/letta-code).
The source checkpoint is committed and pushed through
[`697c9c541`](https://github.com/klittle32/letta-code/commit/697c9c5414f84518e3a44294f784b36cf756dfde):

- `3eacb8139`: native questions and initial turn/context primitives.
- [`5b0cc744c`](https://github.com/klittle32/letta-code/commit/5b0cc744c63e0b21b3e4eb731bde6546a754ce7c): inactive scoped conversation creation.
- `5b5350f1a`: interruption retirement, terminal events, and precise child ownership.
- `870ee9951`: trusted fresh-session activation, history cursors, and captured
  passive-context transport/acceptance helpers.
- `08fa6e2e6`: scoped TUI model-only context records, frozen human-input delivery,
  original-scope reconciliation and human transcript/title projection.
- `697c9c541`: durable human/both context rows, whole-message placement,
  scope-fenced restoration and bounded rendering/identity-change handling.

This is a development branch, not an upstream submission, release, or deployment.
Those actions require separate authorization.

## Implemented and locally exercised

- **Native questions:** `letta.ui.ask({ questions, signal? })` returns a direct
  answered/dismissed result. The TUI owns a scoped FIFO dialog queue, focus,
  disposal, and cancellation. Headless/listener hosts do not advertise support.
  The real source TUI slash-command path has been exercised for choice selection,
  dismissal, and ordinary free-text entry, with dark and narrow light terminals.
  Tests cover the engine path, owner reload, scope changes, unsupported hosts,
  command timeout, and background `handled` commands. A subsequently reproduced
  multi-character input bug is fixed. The built Node application was then
  exercised with a pasted complete link through the native dialog and returned
  the intact answer without starting a model turn.
- **Actual tool settlement:** an opt-in execution owner tracks real tool work and
  checkpoint completion beyond the existing responsive abort grace. Cancellation
  fences queued and post-checkpoint starts. An interrupted display result is not
  treated as proof that the underlying work stopped.
- **TUI turn integration:** public captured `ctx.turn` handles carry
  immutable identity through streaming/tool/approval continuations. Requests are
  synchronous and reentrant-safe; receipts separately observe owner/backend/tool/
  child settlement. Stale or disposed handles cannot retarget a replacement turn.
  Backend cancellation uses the observed exact run ID, followed by retrieval of
  that run's matching ID, agent, and terminal status. A cancellation ACK cannot
  override a still-running record. Approval pauses retire independently of React
  effects, even if scope changes before a listener subscribes. Cancelled/error
  logical turns emit one terminal event with the original identity. Child stops
  require an unsettled tool ticket and exact foreground ownership; background
  children remain independent. Missing ownership/stop evidence remains incomplete.
- **Approval result recovery:** ordinary and always-allow approvals share one
  executor. Native TUI tests cover real result preservation, companion results,
  queued human input, and tools settling both within and beyond the abort grace.
  Retired approval recovery is retained under its original host/agent/conversation
  and revalidated against backend pending IDs before reuse. This retention is
  **host-lifetime only**, not a restart-durable checkpoint.
- **Inactive creation:** `ctx.conversation.create({ inheritModel?, title? })`
  creates a fresh scoped handle without copying history, sending a prompt, or
  activating a chat/workspace. Explicit inheritance preserves backend-specific
  effective settings and context-window behavior. Local merge semantics were
  tested against actual LocalBackend executor inputs, separately from Cloud
  replacement semantics. Known created IDs remain available if later preparation
  fails; pre-ID failures do not promise exactly-once creation.
- **Trusted TUI activation:** global mods can request
  `ctx.session.activate({ conversationId, workingDirectory })`. A host-authored
  trust dialog precedes destination settings and lifecycle hooks. The target
  must be the exact saved, unused same-agent conversation; retries and host
  restarts do not require a new ID. Scoped commands, turns, approvals, queued
  inputs and unsettled tools block admission. The path reuses `/new` and `/cd`
  machinery, not ordinary resume's recovery/dequeue behavior. Notifications
  arriving during transition are parked under their original scope, not replayed
  into the destination. The immediate result explicitly says initialization is
  pending; initialization has a ten-second deadline and fences late mod owners
  before unlocking input. This cannot physically terminate arbitrary JavaScript
  or hook processes, and completed hook effects cannot be rolled back.
- **History cursors:** public history options forward exclusive `before`/`after`
  message IDs. An actual LocalBackend fixture retrieves the newest 4,096 of 4,205
  persisted rows over nine pages without losing the oldest selected boundary.
- **Passive-context inbox:** immutable ordered host-local records, visibility,
  explicit submission bindings, and persisted uncertain acceptance state. Tests
  exercise concurrent writers, conflicting IDs, process-kill recovery, and a
  Node-targeted recovery bundle. This is neither immediate Cloud transcript
  append nor an unconditional exactly-once delivery guarantee.
- **Captured context session helpers:** private host helpers bind the inbox and
  message transport to a captured API endpoint/organization or actual local
  transcript-store identity. Store replacement, symlink retargeting, backend
  replacement and credential changes fence new work. Reconciliation retains the
  original binding; a failed fence never releases uncertain records. Positive
  acceptance evidence requires canonical context/human message identities in
  order.
- **Scoped passive-model delivery:** capability-guarded
  `ctx.conversation.context.record/list/submissions/reconcile` persists immutable
  records without inference. Only explicit human TUI input selects them. Normal
  automated/mod sends, approvals and continuations do not. The normalized request
  and message identities are frozen; uncertain dispatch is never blindly replayed.
  Only the positive typed Cloud-shutdown admission-rejection contract permits an
  exact retry. Original-scope chronological reconciliation can confirm acceptance
  without resending. Esc retains abort classification and queued human input.
- **Human projection:** model-only rows are excluded by persisted source OTIDs,
  not text, from resume/backfill and human-authored title/description seeds. Raw
  history remains canonical and assistant responses remain verbatim. Local
  classification does not need live metadata; pending delivery still verifies its
  principal. Human/both records now render as distinct labelled host-local rows,
  not fabricated user messages. Human-only text stays outside inference,
  reflection and title seeds; both keeps the existing next-explicit-human delivery.
  Atomic immutable placement and stable message/tool aliases survive restart.
  Same-owner invalidation retains the validated view, unchanged records do not
  repaint, and unrelated renders do no asynchronous identity I/O. New text still
  passes full captured authorization; a cheap owner change clears stale display.
  There is no cross-process live sync or background credential/store watcher.
  Missing/clipped anchors remain visibly unavailable rather than guessed.
  Corrupt snapshots fail closed; an unrelated corrupt inbox can also cause
  default-title fallback when classification lacks an agent ID. See the
  [host contract and limitations](https://github.com/klittle32/letta-code/blob/697c9c5414f84518e3a44294f784b36cf756dfde/docs/host-local-context.md).

Independent read-only review found no blocking safety defect in the three
primitives. Its callback-parity finding was reproduced and fixed with a
regression test. That review did not certify their eventual host integration.
Subsequent integration review exposed snapshot, stream-identity, and approval
recovery defects; those were corrected and rechecked. The last focused review
found no blockers in the corrected interruption lifecycle and creation boundary.
Review caught Local settings/window inheritance differences and a paused-owner
scope-replacement race; both were reproduced, fixed, and rechecked.
The trusted-activation review subsequently found turn-proxy loss, fallible
preparation after source close, unbounded initialization and notification-scope
risks. Those were fixed and independently rechecked with no remaining blocker.
Actual source-TUI testing also found an empty-transcript timestamp repair marking
a fresh local conversation as used; a regression test pins the corrected behavior.
Passive-context review then exposed capture poisoning, stale credentials,
pagination, unsafe retry, abort classification and metadata-dependent projection.
Regression tests and independent rechecks closed those findings. Conservative
replay fencing, exact-run-only cancellation and corrupt-file limitations remain
explicit; the recheck found no blocking issue in the model-only slice. Human/both
review then caught render-time I/O, redundant repaints, rotation restoration and
fallback-anchor issues. Those were corrected and independently rechecked without
weakening captured authorization; no blocking issue remained.

## Checkpoint verification

- **606 focused tests passed across 79 suites**, run in separate processes to
  respect the repository's TUI/global-state isolation requirements.
- **All 13 `bun run check` gates passed**, including TypeScript and file-size
  ratchets; no size limit was relaxed.
- **`bun run build` passed**, producing the Node-targeted distribution.
- Real source-TUI dialog interactions and built-Node pasted-input acceptance
  were exercised with isolated local storage and no model inference. Private
  recordings/screenshots were inspected; they are not live Delta proofs.
- The subsequent built Node application created an inactive conversation through
  the public mod API. A separate command verified unchanged active scope and
  empty source/target histories. The saved record/title and zero run files were
  also verified in the isolated store. The continuous recording was decoded and
  visually inspected.
- Trusted activation was then exercised in the restarted source TUI using the
  same saved target ID. The built Node TUI was exercised for fresh creation,
  denial, unchanged source scope, retry of the same ID, consent, destination
  lifecycle and exact target scope with empty history. The continuous 69-second
  desktop recording was fully decoded and visually inspected; dark and light
  terminal screenshots were checked. No model inference or live Delta operation
  was involved. This does not establish Cloud activation or Desktop parity.
- Passive context was exercised through the rebuilt Node TUI: recording alone
  created no server rows; an automated send created two rows without consuming
  context; the human turn added one context, human and assistant row. Canonical
  reconciliation confirmed acceptance without increasing the five-row history.
  Restart retained those rows while hiding the model-only bubble. The continuous
  47-second desktop recording and dark/light views were inspected. This used the
  deterministic local executor and a literal fake model-catalog key, not a live
  provider, Cloud or Delta service.
- Human/both followed in a continuous 59-second rebuilt-Node desktop walkthrough.
  Three visibility records initially left server history empty; automated activity
  did not bind them. Real human input delivered only model/both notes, with the
  human-only marker absent from the canonical context row. A later display-only
  note followed the completed response. Retry and restart preserved four records,
  five server rows and one accepted binding. Dark live and light resumed views,
  the decoded recording and checkpoint assertions passed. Native mid-tool timing
  and live credential rotation are not claimed from this idle/settled walkthrough.

The final tests ran with telemetry disabled. In this root Linux sandbox, the
unchanged installer permission-failure tests required normal DAC enforcement:
the test runner was launched with
`setpriv --bounding-set=-dac_override,-dac_read_search`. No tests were skipped
or host permissions changed to manufacture success. Earlier combined-process,
TypeScript, and permission-environment failures were corrected or reproduced
under the appropriate test isolation before the final pass.

This is focused host validation, not the full repository test suite, a live
Cloud cancellation test, cross-platform certification, or Delta functional
parity. No GitHub Actions run was returned for the development branch at this
checkpoint; the reported gates were run locally.

## In progress and remaining

1. Complete and prove noncreating full local-history reads, including resident
   compacted history, cursor errors and two-process child freshness. This is in
   progress; raw history still is not an export-safe transcript view.
2. Establish provenance-aware main/child recording coverage. Do not
   infer lossless coverage from parent tool receipts alone. The source-only
   [recording boundary findings](recording-boundaries.md) identify the safe-view
   and noncreating history-read prerequisites; they are not implemented yet.
3. Repeat focused tests, full static gates, built-Node validation, independent
   integration review, and relevant native acceptance for subsequent slices.
4. Complete the Effect 4.1 engine and build the Letta adapter against the resulting public APIs,
   then run the parity gates in [requirements.md](requirements.md).

Cloud freshness checks currently require explicit server evidence of an unused
conversation; omitted or ambiguous fields refuse activation. Live Cloud
activation, event-context activation and arbitrary hook-process termination have
not been verified. Parked notifications remain memory-only.

The host implementation follows Letta's existing conventions. Effect 4.1 owns
the extension engine and adapters; this work does not replatform the Letta host.

## Boundaries to retain

- Do not await turn settlement from a callback whose return is required for that
  same turn to settle. Request synchronously and observe the receipt externally.
- A settlement waiter finishing is not checkpoint success: inspect recorded
  errors. Unsupported child/backend coverage must remain visible.
- Stop settlement means host-observable execution is fenced/retired, local tool
  work and checkpoints have settled, and an exact dispatched backend run was
  observed terminal. It does not certify upstream compute/billing termination or
  roll back tool effects. This matches the upstream distinction between execution
  fencing and already-performed effects; do not invent a physical-provider-stop
  requirement or treat an untyped cancellation acknowledgement as terminal proof.
- Bind context before dispatch and mark uncertainty before the network operation.
  Approval-only inputs, notifications, cron runs, and mod continuations are not
  explicit user submissions merely because their role is `user`.
- Host-local records are not fabricated SDK/Cloud messages. Server history,
  host overlays, and model-delivery state must remain distinguishable.
- Native Desktop dialogs and active-chat/workspace switching require client and
  transport support. TUI callbacks do not establish Desktop parity.
