# Recording boundaries: source findings

Reviewed November 1, 2026 against personal-fork host
[`08fa6e2e6`](https://github.com/klittle32/letta-code/tree/08fa6e2e6273bfe320b53f24d4bb2e86cc1d2e4c)
and pinned Delta reference
[`ac769c6`](https://github.com/zed-industries/delta-claude/tree/ac769c681ba7a95ec7347b591f0858857a1a9e80).
This is source research, not implemented recording or live acceptance.

## What can be reused

The reference records settled transcript rows and tool/turn events, not every
streamed fragment (`hooks/register.tsx`, `hooks/recording/delivery.ts`). Its human
message rows are held while the local turn runs (`hooks/watch/rows.tsx`). Neither
a fragment-level UI ledger nor a new chunk-event framework is established as a
parity requirement.

The host already has captured TUI turn identity, once-only terminal events,
client-tool IDs/events, and history pagination. A recorder can retain a tool-ID
to original-turn mapping for late output rather than assigning it to whatever
turn is active later. Server-side tools do not use the same client-tool event
path. Per-turn observed run IDs remain private; multi-writer attribution must not
be inferred from a stale render-time `lastRunId`.

Native Letta child state already retains agent, conversation and parent-tool
identity, but the public lifecycle projection omits some of it. Native children
run with providers-only mods, so installing the parent recorder inside them is
not an existing capture path. Exact parent-owned child history is needed; parent
tool receipts alone do not establish complete child capture. External coding CLI
sessions are not Letta conversations and should not be mislabelled as native
children. Memory/reflection/init work remains excluded.

## Raw history is not a safe export view

OTIDs, message/tool IDs, run IDs and provider metadata establish correlation, not
original-human content provenance. `turn_start` mods can replace input while
retaining an OTID. Ordinary host reminders and skill injection have identifiable
production sites, but arbitrary trusted-mod replacement can be untagged.

The existing display helpers strip known reminder/skill wrappers and clip text.
That is presentation cleanup, not proof that a row contains no protected input.
The passive-context sidecar can exclude its own canonical context rows; it is
not a general archive of original human input. Secret scrubbing likewise does
not certify memory/system/skill provenance.

A host-owned export view needs explicit coverage/omission information and
positive selection of permitted source surfaces:

- Original human content captured before host/mod mutation, including supported
  multimedia parts rather than flattened text. Do not automatically dereference
  attachments or open files to reconstruct them.
- Safe operation identity/status can be retained for Skill and memory activity;
  injected skill bodies and memory contents must not be exported. Tool origin
  alone does not certify arbitrary arguments, shell output or file contents.
- Hidden/redacted reasoning, provider signatures/internals, system scaffolding
  and compaction summaries are not substitutes for missing conversation content.
- Legacy ambiguous rows must remain omitted or explicitly unavailable, not
  retrospectively certified by tag stripping.

Even source provenance cannot guarantee that arbitrary model output or trusted
code never copies protected information. Describe the enforced source boundary,
not a universal semantic non-disclosure guarantee.

## Full-history and child-read prerequisite

Local history has a bounded disk-tail reader, but fallback paths can use the
resident in-context shortcut. Missing cursors can be silently ignored, and an
unknown conversation can reach creating lookup behavior when strict access is
disabled. Existing pagination tests do not prove every compacted/resident state
or a newly created child in a second process.

Reuse the durable transcript reader with resident-tail overlay, an exact
noncreating scope lookup and explicit invalid-cursor behavior. A real two-process
child test is required before claiming cross-process freshness. Existing archived
image reads can substitute placeholders; do not claim original attachment bytes
were recovered. Cloud SDK list types expose cursors and message-type filters,
but no inspected `use_in_context` list option; live Cloud behavior is unverified.

## Smallest next steps

1. Prove the noncreating full-history path and cursor/child freshness behavior.
2. Add a host-owned, provenance-aware transcript view with explicit omissions,
   preserving raw history as a separate API. Capture future provenance at the
   producer boundary and reuse existing persistence rather than a new database.
3. Expose exact tracked native-child identity and scoped history using that view.
4. Prove recording coverage and original-turn attribution before enabling shared
   writes. No current finding establishes lossless recording or full parity.

Relevant host source: `src/mods/conversation-history.ts`,
`src/mods/mod-engine.ts`, `src/agent/message.ts`, `src/agent/subagent-state.ts`,
`src/agent/subagent-launcher.ts`, `src/cli/helpers/backfill.ts`,
`src/backend/local/local-store.ts`, `local-transcript-history.ts`,
`local-message.ts`, and `local-message-projection.ts`. These findings were
independently cross-checked at source level; no backend or user-history calls
were made for this research.
