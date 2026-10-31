# delta-extensions

Delta CLI integrations for coding harnesses, starting with a **Letta Code mod**.
The intended implementation language is TypeScript, using **Effect 4.1** throughout
the shared engine and harness adapters.

## Status

**Core foundation built; host prerequisites in development. No installable mod exists yet.**

`packages/core` now provides command parsing and a tested, bounded contract-8
Schema subset, plus scoped subprocess JSON/JSONL transport. See [the exact built boundary and provenance](docs/core.md).
This is not full parity certification.

The target is full functional parity with Zed's
[Delta for Claude Code](https://github.com/zed-industries/delta-claude), not just
matching command names. Its collaboration protocol requires host capabilities
that are not all exposed by the current Letta mod API. Implementation must not
silently downgrade those requirements or bypass the host through private APIs.

The project owner approved **host APIs first** on October 31, 2026: develop
minimal generic public Letta APIs, then the mod. Host work is staged in the
[personal Letta Code fork](https://github.com/klittle32/letta-code), separately
from this monorepo. Upstream submission and deployment are not authorized by that
approval.

The tested source checkpoint is published on
[`delta/mod-host-apis`](https://github.com/klittle32/letta-code/tree/delta/mod-host-apis)
at [`5b5350f1a`](https://github.com/klittle32/letta-code/commit/5b5350f1aad683438b9fc62fd1812a602a720ce1).
It includes native questions, TUI interruption lifecycle, inactive conversation
creation, and passive-context primitives. Trusted activation and passive-context
delivery are not wired yet. See the [checkpoint](docs/host-implementation.md) for
verification and remaining work; this is not a complete host integration.

Reference baseline: upstream **0.1.32**, commit
[`ac769c681ba7a95ec7347b591f0858857a1a9e80`](https://github.com/zed-industries/delta-claude/tree/ac769c681ba7a95ec7347b591f0858857a1a9e80),
reviewed October 31, 2026. Delta CLI contract **8**, introduced in Delta **0.22.0**.

## Workspace layout

```text
packages/
  core/          # Built: command parsing, bounded schemas, scoped JSON/JSONL transport
```

Persistence, Delta workflows and the Letta adapter are not built. Later adapters may target Pi, Grok,
Codex, Prime Agent, and other harnesses. Add them only when their implementation
starts; do not create empty adapters or speculative framework layers.

## Local development

Use Bun **1.4.4** and Node **22.23.4** (Effect requires Node 22.19+).

```sh
bun install --frozen-lockfile
bun run check
```

`check` runs strict native TypeScript, Effect semantic diagnostics, Biome, Vitest,
and declaration/JavaScript build into `packages/core/dist`. Individual commands:
`bun run typecheck`, `bun run effect-check`, `bun run lint`, `bun run test`,
`bun run build`; `bun run format` applies Biome fixes. Setup patches the native
TypeScript binary for editor diagnostics; command checks use the direct
`effect-tsgo` wrapper. No Delta account or provider credentials are needed.

## Command compatibility

Preserve all seven upstream slash names:

`/delta`, `/delta-share`, `/delta-join`, `/delta-setup`, `/delta-update`,
`/delta-plugin-update`, `/delta-org`.

`/delta` also accepts the upstream subcommands. Plugin-update must manage this
Letta mod, not the Claude plugin. Matching names alone is not feature parity.

## Project references

- [Parity requirements and acceptance gates](docs/requirements.md)
- [Letta host-capability findings](docs/host-capabilities.md)
- [Host implementation checkpoint](docs/host-implementation.md)
- [Effect 4.1 implementation and tooling direction](docs/effect.md)
- [Contributor instructions](AGENTS.md)

## Upstream and licensing

This is an independent integration project, not an official Zed or Letta release.
The reference plugin is **AGPL-3.0-only**, copyright Zed Industries. Any adapted
source must retain its license and attribution, identify modifications, and be
distributed under compatible terms. This foundation adapts protocol definitions and command behavior and includes six
attributed upstream fixtures. The root [LICENSE](LICENSE) and [NOTICE](NOTICE)
cover this work under AGPL-3.0-only.
