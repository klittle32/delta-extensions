# delta-extensions

Delta CLI integrations for coding harnesses, starting with a **Letta Code mod**.
The intended implementation language is TypeScript, using **Effect 4.1** throughout
the shared engine and harness adapters.

## Status

**Host prerequisites in development. No installable mod exists yet.**

The target is full functional parity with Zed's
[Delta for Claude Code](https://github.com/zed-industries/delta-claude), not just
matching command names. Its collaboration protocol requires host capabilities
that are not all exposed by the current Letta mod API. Implementation must not
silently downgrade those requirements or bypass the host through private APIs.

The project owner approved **host APIs first** on October 31, 2026: develop
minimal generic public Letta APIs, then the mod. Host work is staged in the
[personal Letta Code fork](https://github.com/klittle32/letta-code), separately
from this monorepo. Upstream submission and deployment are not authorized by that
approval. The fork's existence does not mean the changes are published or ready.

Reference baseline: upstream **0.1.32**, commit
[`ac769c681ba7a95ec7347b591f0858857a1a9e80`](https://github.com/zed-industries/delta-claude/tree/ac769c681ba7a95ec7347b591f0858857a1a9e80),
reviewed October 31, 2026. Delta CLI contract **8**, introduced in Delta **0.22.0**.

## Planned layout

```text
packages/
  core/          # Effect schemas, durable protocol state, processes and workflows
  letta/         # Letta mod lifecycle, commands, context and UI adaptation
```

These packages are planned, not implemented. Later adapters may target Pi, Grok,
Codex, Prime Agent, and other harnesses. Add them only when their implementation
starts; do not create empty adapters or speculative framework layers.

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
distributed under compatible terms. No upstream implementation has been copied
into this repository at this stage.
