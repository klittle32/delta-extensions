# Letta host-capability findings

Reviewed October 31, 2026, independently of the Delta requirements research.
This is source evidence, not a live-host compatibility certification.

## Sources

Installed Letta Code: **0.34.36**. Reviewed public source commit:
**`8b713fe8f339a2f998b9d3ee339e185d5d409146`**.

- [Mod API and command validation](https://github.com/letta-ai/letta-code/blob/8b713fe8f339a2f998b9d3ee339e185d5d409146/src/mods/mod-engine.ts)
- [Mod contexts, events and UI types](https://github.com/letta-ai/letta-code/blob/8b713fe8f339a2f998b9d3ee339e185d5d409146/src/mods/types.ts)
- [Scoped conversation handles](https://github.com/letta-ai/letta-code/blob/8b713fe8f339a2f998b9d3ee339e185d5d409146/src/mods/conversation-handle.ts)
- [Local model/compaction event wiring](https://github.com/letta-ai/letta-code/blob/8b713fe8f339a2f998b9d3ee339e185d5d409146/src/cli/mods/local-backend-mod-events.ts)
- [Exported question data helpers](https://github.com/letta-ai/letta-code/blob/8b713fe8f339a2f998b9d3ee339e185d5d409146/src/ask-user-question.ts)
- [Delta's host adapter and hooks](https://github.com/zed-industries/delta-claude/blob/ac769c681ba7a95ec7347b591f0858857a1a9e80/hooks/register.tsx)
- [Delta join/handoff implementation](https://github.com/zed-industries/delta-claude/blob/ac769c681ba7a95ec7347b591f0858857a1a9e80/hooks/sharing/join.ts)

## Confirmed public API gaps

### Active-turn cancellation

`turn_start` can refuse a new turn. `tool_start` can prevent a pending tool from
executing. Neither stops an already running turn or tool. The event-context
signal belongs to the mod's activation lifetime, not an exposed turn controller.

The cloud client does have a server-run cancellation endpoint. That is not proof
of cancellation of local tools/children or a local-backend run. Delta fencing
requires the host's actual execution to stop, not merely future prompts to fail.

Needed: a conversation/turn-scoped host interrupt operation with expected-turn
identity, owned-child handling and an observable settled outcome.

### Passive context and transcript append

The public scoped handle exposes history, fork, send, title and configuration
operations. Sending starts inference; no passive append operation is exposed.
Delta requires collaborator activity to be available without starting a turn.

Needed: durable, ordered append with stable IDs and explicit human/model
visibility, routed through the active backend. Human-only panels are already
possible, but are not durable transcript rows.

### Active conversation and trusted workspace transition

A fork returns another conversation handle; it does not activate that conversation
in the UI. A send's working-directory option is not an active workspace change.
Mod command APIs register/unregister commands, not execute host `/clear`/`/cd`
equivalents. Mutating a context snapshot or a process cwd is not a safe substitute.

Needed: host-owned new/activate-conversation and workspace transition preserving
trust, approvals, lifecycle ordering and resumability. A narrow transactional
handoff is preferable to unrestricted arbitrary command execution.

### Native interactive input

The inspected mod UI exposes notifications and string-rendered panels, not an
ask/select/form operation. The public `@letta-ai/letta-code/ask-user-question`
module validates/parses receipts and serializes response notifications; it does
not open a question from a mod. Prose docs describe broader interaction than this
inspected API exposes.

Needed for a native interactive port: scoped questions/menus with cancellation
and correct conversation ownership. Alternate text-command UI would be an
explicit adaptation, not proof that the existing wizard controls are available.

## Qualified coverage gaps

- `ctx.subagents.list()` exists and exposes lifecycle snapshots. It does not
  expose complete child conversation identity, a message subscription, or child
  cancellation. Parent Agent receipts and known cloud conversation reads can
  support some recording. Complete lossless local/cloud/remote child observation
  is **unproven**, not established impossible. Trace actual child event paths
  before choosing the smallest extension.
- Turn/tool events and history can capture completed main-conversation content.
  They do not establish full live message/thought capture. Provider/compaction
  callbacks are local-backend-only, and provider events contain metadata rather
  than reasoning chunks.
- Human-only remote thought/status display is possible through panels without
  model submission. Durable human-only transcript insertion remains missing.

## Capabilities already usable

All seven command IDs; capability-guarded registration; permission overlays;
pre-turn/pre-tool checks; scoped history/fork/send/title/config; status panels;
ordinary process/filesystem/network access; Effect-managed durable state,
outboxes, JSONL streams, retries and process ownership.

## Decision boundary

The recommended route preserves full parity: add minimal generic, tested public
host capabilities, then build the Letta adapter against them. Host modifications
are outside the originally requested monorepo/mod scope and await owner approval.
No host patch or upstream issue/PR has been created. A reduced mod-only milestone
also needs explicit approval and must not be called full parity.
