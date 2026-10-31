# Host implementation checkpoint

This is an **in-progress source checkpoint**, not a compatibility certification.
No installable Delta mod or live Delta collaboration test exists yet.

The generic Letta changes are being developed against Letta Code `0.34.36`,
upstream commit `8b713fe8f339a2f998b9d3ee339e185d5d409146`, on branch
`delta/mod-host-apis` for the [personal fork](https://github.com/klittle32/letta-code).
The first source checkpoint is committed and pushed as
[`3eacb8139`](https://github.com/klittle32/letta-code/commit/3eacb8139530907402382c69a2a252ac366f8d98).
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
- **Initial TUI turn integration:** public captured `ctx.turn` handles carry
  immutable identity through streaming/tool/approval continuations. Requests are
  synchronous and reentrant-safe; receipts separately observe owner/backend/tool/
  child settlement. Stale or disposed handles cannot retarget a replacement turn.
  Backend cancellation uses the observed exact run ID, followed by retrieval of
  that run's matching ID, agent, and terminal status. A cancellation ACK cannot
  override a still-running record. Known approval-pause and child limitations
  remain incomplete rather than being reported as settled.
- **Approval result recovery:** ordinary and always-allow approvals share one
  executor. Native TUI tests cover real result preservation, companion results,
  queued human input, and tools settling both within and beyond the abort grace.
- **Passive-context inbox:** immutable ordered host-local records, visibility,
  explicit submission bindings, and persisted uncertain acceptance state. Tests
  exercise concurrent writers, conflicting IDs, process-kill recovery, and a
  Node-targeted recovery bundle. This is neither immediate Cloud transcript
  append nor an unconditional exactly-once delivery guarantee.

Independent read-only review found no blocking safety defect in the three
primitives. Its callback-parity finding was reproduced and fixed with a
regression test. That review did not certify their eventual host integration.
Subsequent integration review exposed snapshot, stream-identity, and approval
recovery defects; those were corrected and rechecked. The last focused review
found no blockers in always-allow recovery or exact backend terminal evidence.

## Checkpoint verification

- **200 focused tests passed across 22 suites**, run in separate processes to
  respect the repository's TUI/global-state isolation requirements.
- **All 13 `bun run check` gates passed**, including TypeScript and file-size
  ratchets; no size limit was relaxed.
- **`bun run build` passed**, producing the Node-targeted distribution.
- Real source-TUI dialog interactions and built-Node pasted-input acceptance
  were exercised with isolated local storage and no model inference. Private
  recordings/screenshots were inspected; they are not live Delta proofs.

The initial combined test invocation failed because a deliberately isolated TUI
suite contaminated later adapter tests, plus an error-message regression. The
error was corrected and all 22 suites passed separately. This is focused host
validation, not the full repository test suite, a live Cloud cancellation test,
cross-platform certification, or Delta functional parity.

## In progress and remaining

1. Finish TUI interruption: retire an interrupted approval pause, emit terminal
   `turn_end` events on cancellation/error, and stop only precisely owned
   foreground children. Do not cancel independent background children when the
   parent turn loses execution; upstream gives them their own thread ownership.
2. Compose passive context only with explicitly identified user submissions;
   integrate acceptance/recovery and durable human-visible history separately.
3. Implement trusted, inert conversation/workspace handoff, preserving ownership,
   approvals, lifecycle order, and recovery of already-created conversations.
4. Establish sufficient main/child observation and recording coverage. Do not
   infer lossless coverage from parent tool receipts alone.
5. Repeat focused tests, full static gates, built-Node validation, independent
   integration review, and relevant native acceptance for subsequent slices.
6. Build the Effect 4.1 engine and Letta adapter against the resulting public APIs,
   then run the parity gates in [requirements.md](requirements.md).

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
