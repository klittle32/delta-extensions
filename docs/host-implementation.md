# Host implementation checkpoint

This is an **in-progress source checkpoint**, not a compatibility certification.
No installable Delta mod or live Delta collaboration test exists yet.

The generic Letta changes are being developed against Letta Code `0.34.36`,
upstream commit `8b713fe8f339a2f998b9d3ee339e185d5d409146`, on branch
`delta/mod-host-apis` for the [personal fork](https://github.com/klittle32/letta-code).
The changes have not yet been committed or pushed. No upstream submission,
release, or deployment is authorized.

## Implemented and locally exercised

- **Native questions:** `letta.ui.ask({ questions, signal? })` returns a direct
  answered/dismissed result. The TUI owns a scoped FIFO dialog queue, focus,
  disposal, and cancellation. Headless/listener hosts do not advertise support.
  The real source TUI slash-command path has been exercised for choice selection,
  dismissal, and ordinary free-text entry, with dark and narrow light terminals.
  Tests cover the engine path, owner reload, scope changes, unsupported hosts,
  command timeout, and background `handled` commands. A subsequently reproduced
  multi-character input bug has a tested fix; its final live retest is pending.
- **Actual tool settlement:** an opt-in execution owner tracks real tool work and
  checkpoint completion beyond the existing responsive abort grace. Cancellation
  fences queued and post-checkpoint starts. An interrupted display result is not
  treated as proof that the underlying work stopped.
- **Exact-turn coordination primitive:** immutable captured identity, synchronous
  interruption requests, reentrant receipt sharing, and independently observed
  owner/backend/tool/child settlement. This primitive alone does not establish
  public host interruption support.
- **Passive-context inbox:** immutable ordered host-local records, visibility,
  explicit submission bindings, and persisted uncertain acceptance state. Tests
  exercise concurrent writers, conflicting IDs, process-kill recovery, and a
  Node-targeted recovery bundle. This is neither immediate Cloud transcript
  append nor an unconditional exactly-once delivery guarantee.

Independent read-only review found no blocking safety defect in the three
primitives. Its callback-parity finding was reproduced and fixed with a
regression test. That review did not certify their eventual host integration.

## In progress and remaining

1. Wire exact-turn control into the TUI's real turn, approval, and cancellation
   lifecycle without widening an operation to a replacement turn or conversation.
2. Compose passive context only with explicitly identified user submissions;
   integrate acceptance/recovery and durable human-visible history separately.
3. Implement trusted, inert conversation/workspace handoff, preserving ownership,
   approvals, lifecycle order, and recovery of already-created conversations.
4. Establish sufficient main/child observation and recording coverage. Do not
   infer lossless coverage from parent tool receipts alone.
5. Run sequential full host checks, built-Node validation, independent integration
   review, and final native acceptance before publishing the host branch.
6. Build the Effect 4.1 engine and Letta adapter against the resulting public APIs,
   then run the parity gates in [requirements.md](requirements.md).

The host implementation follows Letta's existing conventions. Effect 4.1 owns
the extension engine and adapters; this work does not replatform the Letta host.

## Boundaries to retain

- Do not await turn settlement from a callback whose return is required for that
  same turn to settle. Request synchronously and observe the receipt externally.
- A settlement waiter finishing is not checkpoint success: inspect recorded
  errors. Unsupported child/backend coverage must remain visible.
- Bind context before dispatch and mark uncertainty before the network operation.
  Approval-only inputs, notifications, cron runs, and mod continuations are not
  explicit user submissions merely because their role is `user`.
- Host-local records are not fabricated SDK/Cloud messages. Server history,
  host overlays, and model-delivery state must remain distinguishable.
- Native Desktop dialogs and active-chat/workspace switching require client and
  transport support. TUI callbacks do not establish Desktop parity.
