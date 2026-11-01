# delta-extensions

Delta CLI integrations for coding harnesses, starting with a **Letta Code mod**.
The implementation language is TypeScript, using **Effect 4.1.1** throughout
the shared engine and harness adapters.

## Status

**A stock Letta Code mod is in development. Organization commands are implemented.**

The bundled mod supports `/delta-org list`, `current`, `switch <ID>`,
`invite <email>…`, and `manage`, also available through `/delta org …`.
`manage` returns the dashboard link. Sharing, joining, setup, updates, and the
remaining collaboration workflows are not implemented yet.

`packages/core` now provides command parsing and a tested, bounded contract-8
Schema subset, scoped subprocess JSON/JSONL transport, a durable local producer outbox, and one-attempt append delivery. See [the exact built boundary and provenance](docs/core.md).
This is not full parity certification.

The target is full functional parity with Zed's
[Delta for Claude Code](https://github.com/zed-industries/delta-claude), not just
matching command names. Its collaboration protocol requires host capabilities
that are not all exposed by the current Letta mod API. Implementation must not
silently downgrade those requirements or bypass the host through private APIs.

Only stock Letta Code's exposed mod APIs are allowed; no host fork is required
or used. Known parity gaps, including active-run cancellation, are recorded in
[the requirements](docs/requirements.md#host-feasibility-gate).

Reference baseline: upstream **0.1.32**, commit
[`ac769c681ba7a95ec7347b591f0858857a1a9e80`](https://github.com/zed-industries/delta-claude/tree/ac769c681ba7a95ec7347b591f0858857a1a9e80),
reviewed October 31, 2026. Delta CLI contract **8**, introduced in Delta **0.22.0**.

## Workspace layout

```text
packages/
  core/          # Host-independent Delta protocol, policy, transport, and persistence
  letta/         # Stock Letta Code mod
```

End-to-end Delta workflows and recovery UI are not built. Later adapters may target Pi, Grok,
Codex, Prime Agent, and other harnesses. Add them only when their implementation
starts; do not create empty adapters or speculative framework layers.

## Local development

Use Bun **1.4.4** and Node **22.23.4** (Effect requires Node 22.19+).

```sh
bun install --frozen-lockfile
bun run check
```

`check` runs strict native TypeScript, Effect type-aware Oxlint, Biome formatting, Vitest,
and builds `packages/core/dist` plus `packages/letta/dist/index.mjs`. Individual commands:
`bun run typecheck`, `bun run effect-check`, `bun run lint`, `bun run test`,
`bun run build`; `bun run format` applies formatting. `effect-check` aliases lint.
Setup patches native TypeScript and Oxlint; command checks use the documented
`effect-tsgo` wrappers. Oxlint owns lint/Effect diagnostics; the recommended preset
keeps upstream unstable-API warnings visible. LSP diagnostics
are disabled to avoid duplicates; native editor/compiler integration remains. No Delta account or provider credentials are needed.

To try the development mod, copy `packages/letta/dist/index.mjs` into your
Letta config directory's `mods/` folder as `delta.mjs`, then run `/reload`.
Install the official Delta CLI separately; the mod does not install it or log in
automatically. Tests use synthetic CLI processes, not a live Delta account.

## Command compatibility

Preserve all seven upstream slash names:

`/delta`, `/delta-share`, `/delta-join`, `/delta-setup`, `/delta-update`,
`/delta-plugin-update`, `/delta-org`.

`/delta` also accepts the upstream subcommands. Plugin-update must manage this
Letta mod, not the Claude plugin. Matching names alone is not feature parity.

## Project references

- [Parity requirements and acceptance gates](docs/requirements.md)
- [Letta host-capability findings](docs/host-capabilities.md)
- [Effect 4.1 implementation and tooling direction](docs/effect.md)
- [Contributor instructions](AGENTS.md)

## Upstream and licensing

This is an independent integration project, not an official Zed or Letta release.
The reference plugin is **AGPL-3.0-only**, copyright Zed Industries. Any adapted
source must retain its license and attribution, identify modifications, and be
distributed under compatible terms. This foundation adapts protocol definitions and command behavior and includes six
attributed upstream fixtures. The root [LICENSE](LICENSE) and [NOTICE](NOTICE)
cover this work under AGPL-3.0-only.
