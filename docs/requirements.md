# Delta parity requirements

Research baseline: **October 31, 2026**. This is an implementation contract and
feasibility record, not a claim that any feature has been built or tested live.

## Authorities

- [Delta CLI getting started](https://delta.dev/docs/cli/get-started)
- [Claude Code plugin documentation](https://delta.dev/docs/cli/claude-code)
- [Build a coding agent plugin](https://delta.dev/docs/cli/build-a-plugin)
- [Pinned reference implementation](https://github.com/zed-industries/delta-claude/tree/ac769c681ba7a95ec7347b591f0858857a1a9e80)
- [Letta mod documentation](https://docs.letta.com/configuration/mods/)
- [Reviewed Letta source](https://github.com/letta-ai/letta-code/tree/8b713fe8f339a2f998b9d3ee339e185d5d409146)

The reference manifest identifies version **0.1.32**, AGPL-3.0-only. It uses
TypeScript/TSX function hooks, not Markdown command prompts. Delta CLI contract
**8** is separate from record `schemaVersion: 1`. Negotiate contract compatibility;
do not infer it from a version string alone.

## Exact command surface

| Slash command | Arguments / behavior |
| --- | --- |
| `/delta` | Menu, or `share`, `join`, `setup`, `update`, `plugin-update`, `org` |
| `/delta-share` | Optional email addresses; audience selection otherwise |
| `/delta-join` | Shared link or thread locator; ask when omitted |
| `/delta-setup` | Configure repository policy |
| `/delta-update` | Update Delta application and CLI |
| `/delta-plugin-update` | Update this adapter; `check`, `notifications on`, `notifications off` |
| `/delta-org` | `list`, `current`, `switch ID`, `invite EMAIL…`, `manage` |

There are no colon command IDs and no separately registered `/delta-org-list`
command. All seven names satisfy Letta's command ID validator. Unknown arguments
return usage; noninteractive surfaces must not silently launch browser/dialog
flows. Upstream does not support Claude print mode, SDK sessions, or cloud runners;
that is not a restriction on where a Letta agent's identity is stored.

## Required behavior

Every row below is **not implemented** in this repository.

| Area | Required parity |
| --- | --- |
| Discovery and authentication | Platform-specific CLI discovery, compatibility checks, explicit installation/login interaction, cancellation of local waiting without signing out or cancelling another client's login. No installation/browser launch during background discovery. |
| Setup | Offer once per unconfigured repository; select/create team and optionally invite members; manual/private/organization policy in checkout-root `.delta/settings.json`; preserve unknown JSON keys; exclude via Git common-directory `info/exclude`; invalid policy falls back to manual. Automatic modes require an organization. |
| Sharing | Disclose uploads; choose private/team/email/existing audience; reuse stable source + external ID; persist thread/worktree bindings before attach/share; long-lived existing-checkout mount; bounded initial current-conversation export; continue recording; retry without duplicating export or narrowing audience. |
| Joining | Check access; idle/no-running-children gate; fresh conversation without exporting the old one; stable mount owner; mounted checkout readiness; host workspace/trust transition; no automatic model turn; safe retry/resume; release with upload-aware cleanup. |
| Recording | User/assistant/thought/tool/title/state updates; stable identities; durable immutable outbox before send; consecutive sequence numbers; per-record receipts, including partial batches; late output retains original turn; never recycle a lost producer sequence. |
| Turn ownership | Live running/idle boundaries, watcher participation, prompt admission, stop local agent/tool/child work on supersession or current-turn fencing. Blocking future prompts alone is insufficient. |
| Receiving | Fresh snapshots on reconnect; item replacement/append/remove/order; comments, presence, worktrees and children; deduplicated passive context delivery; no unsolicited inference; remote thoughts visible to humans but not inserted into model context. |
| Offline/recovery | Local acknowledgment; structured retryability/delay; paused recording on `reload_required`; explicit fork/restore/discard decision; preserve unresolved records and stable ownership. |
| Subagents | Eligible child threads, child IDs/turns/tool activity, parent sender attribution, shared/isolated worktrees, foreground/background calls and thread-directed runs. Keep returned child references verbatim. |
| Organizations | List/current/switch/invite/manage; individual invite outcomes; repository policy organization takes precedence over global selection. |
| Delta updates | Background check only; explicit installation; progress; reconnect; running-work refusal; Windows elevation/reboot/long installer outcomes. |
| Mod updates | Separate from Delta update; checks/notifications/update-later/mute; safe handling of pinned/local sources; Letta-native installation/reload rather than Claude marketplace commands. |
| UI and lifecycle | Interactive actions, progress/link/status/error display, human-only thought display, cleanup on reload/end, correct per-conversation/per-workspace isolation. |

### Bounds and privacy

- Initial export: newest **4,096 current API messages**, not all agent history.
- Remote context snapshot: **400,000 characters**, newest first, with an explicit
  route to older history instead of fabricated summaries.
- Human snapshot tail: **5 items**. Preserve meaningful bounded rendering rather
  than copying Claude-specific UI internals.
- Nonignored staged, unstaged, and untracked checkout files are shared. Ignored
  files and local Git state are not preserved in generated join checkouts.
- Protected host content is not ordinary transcript content. Do not export Letta
  core/deferred memory, system instructions, skill bodies, policy, or hidden
  scaffolding to fill an observation gap.

## Host-feasibility gate

Reviewed installed Letta Code **0.34.36** and the pinned public source above.
Letta provides command registration, tool/turn events, permission overlays,
panels, scoped conversation history/fork/send helpers, and lifecycle signals on
supporting surfaces. Those are useful but are not automatically equivalent to
Claude's function-hook contract.

Independent source review confirmed missing public controls for items 1–3 below.
Item 4 remains a qualified observation/coverage gap, not a blanket assertion that
child recording is impossible. See the [host findings](host-capabilities.md).

1. **Active execution cancellation:** stop and settle the actual current run,
   including in-flight tools and relevant children, when Delta fences it. A mod's
   abort signal is a host-to-mod teardown signal, not a mod-to-host stop control.
   Stock 0.34.36 exposes pre-turn cancellation, not active-run cancellation.
   This is an acknowledged parity gap; continue unrelated mod development without
   a host fork or claiming that prompt/tool admission guards stop running work.
2. **Fresh session and workspace handoff:** create/activate a fresh conversation,
   apply the mounted directory to the host and its tools, preserve trust/approval,
   and resume safely. Forking a handle or changing a child process cwd is not this.
3. **Passive transcript/context delivery:** append collaborators' activity without
   invoking inference, with separate human/model visibility and durable receipt
   semantics. `sendMessageStream` starts a run; it is not passive append.
4. **Complete recording and child observation:** safely observe permitted messages,
   thought/tool content, child lifecycle, and late output with correct attribution.
   End-of-turn history polling is not proof of complete live capture.

Public APIs must work on each advertised host/backend combination. A server-only
client call is not automatically a local-backend or active-UI equivalent. Do not
reach into host internals or claim prompt/tool blocking cancels already running
work. Native question-dialog availability also needs checking against the actual
host API, not just prose documentation. The inspected mod UI has no native
ask/select input contract; the exported question helper provides receipt parsers
and notification serialization, not an interactive mod API.

**Current constraint:** full parity through the API surface stock Letta Code
exposes to mods. No Letta Code fork, fork-dependent APIs, private-runtime
workarounds, or host changes. This supersedes the earlier host-API development
route. Missing APIs are blockers to disclose, not permission to reduce parity.

## Acceptance gates

1. Unit/Effect tests for command parsing, schemas, policy, stable bindings,
   sequence allocation, outbox persistence, receipts, retry decisions, snapshot
   reconstruction, deduplication, visibility filtering and isolation.
2. Real subprocess tests for JSONL chunking, both output pipes, nonzero exit,
   malformed/unknown frames, bounded output, timeout, abort and finalizers.
3. Host-contract tests for registration/disposal, capability guards, actual command
   routing, passive delivery, session/workspace transition and execution stop.
4. Installed/bundled mod acceptance with no source-tree-only dependencies.
5. Real Delta acceptance with two clients: sharing/joining, taking turns, file
   handoff, supersession, child recording, reconnect, offline conflicts, lost
   receipts, interrupted mount/share, resumed sessions and cleanup.
6. Separately report tested OS, runtime, backend and UI surfaces. Do not mark
   Windows, macOS, Desktop, Cloud, or two-computer behavior verified from Linux
   fixtures alone.

No Delta installation, authentication, sharing, or live two-client acceptance has
been performed during requirements research.
