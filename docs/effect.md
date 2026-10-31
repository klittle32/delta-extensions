# Effect 4.1 implementation and tooling

Verified npm metadata, published declarations and installed source on October 31,
2026. Current manifests and `bun.lock` exact-pin direct dependencies. Stable 4.1.1
is required; the `effect@beta` tag is not the intended release.

| Dependency/tool | Exact version |
| --- | --- |
| `effect` | 4.1.1 |
| `@effect/platform-node` | 4.1.1 |
| `@effect/platform-node-shared` (lockfile) | 4.1.1 |
| `@effect/vitest` | 4.1.1 |
| `typescript` | 7.0.2 |
| `@effect/tsgo` | 0.63.0 |
| `oxlint` | 1.90.0 |
| `oxlint-tsgolint` | 7.0.2005 |
| `vitest` | 5.0.5 |
| `@biomejs/biome` (formatter only) | 2.6.4 |
| Bun | 1.4.4 |
| Node tested | 22.23.4 |

Effect requires Node 22.19+ and TypeScript 5.9+, recommending TS 7. The installed
@effect/tsgo 0.63.0 supported matrix explicitly includes TypeScript 7.0.2, Oxlint
1.90.0 and oxlint-tsgolint 7.0.2005. Versions were checked before installation.
The Bun platform package is not installed; Node platform services are exercised
by actual process/filesystem tests. No additional persistence dependencies exist.

## Native TypeScript and Oxlint

Kyle requested native tsgo and the documented Effect Oxlint integration. Read the
[live Effect Oxlint setup](https://raw.githubusercontent.com/Effect-TS/tsgo/main/docs/README.md)
and the installed 0.63.0 README/matrix. The resulting configuration uses:

- `prepare`: `effect-tsgo patch --typescript --oxlint`, validating and patching
  native TypeScript, the Oxlint binding/declarations and tsgolint.
- `.oxlintrc.json`: the shipped `oxlint-schema.json` and
  `oxlint-presets/recommended.json`, which enable type-aware mode and `effecttsgo`.
- `lint`: `effect-tsgo oxlint --type-aware .`, the documented direct wrapper.
  Oxlint owns both general lint and Effect semantic diagnostics.
- tsconfig plugin `@effect/language-service` with `diagnostics: false`, as the
  live guide recommends to avoid duplicate LSP diagnostics. Native compilation,
  quick information and editor integration remain enabled.
- Biome formatting only: its linter and assists are disabled. No duplicate Biome
  lint pass or separate tsgo semantic-diagnostics pass runs in `check`.

No Oxlint rule is suppressed. Real findings were corrected: typed decoders for
known encoded values, selective `catchIf`, concrete test error channels, and
Effect-valued `replay`/`snapshot` service members instead of lazy zero-argument
functions. The remaining **122 warnings**, all `effecttsgo/unstable-api-usage`,
are intentionally visible: the required exact-pinned Effect process, filesystem,
path, digest and Node services, and @effect/vitest APIs carry upstream unstable
annotations. These warnings are not zero diagnostics and do not certify API
stability. The shipped recommended severity policy fails errors and reports
warnings; this project has not disabled rules or promoted away these annotations.

A temporary floating-Effect source probe made `bun run lint` exit nonzero with
**two `effecttsgo/floating-effect` errors**, even with LSP diagnostics disabled.
The probe was then removed. This proves the actual Effect Oxlint rules execute,
rather than relying only on a successful compiler or an unpatched lint binary.

VS Code recommendations retain the native TypeScript extension and Biome
formatter, add `oxc.oxc-vscode`, enable type-aware Oxlint, point it at the patched
workspace binary, and disable Oxfmt to keep one formatter. The settings were
checked against the official extension manifest; editor GUI behavior remains
untested. CLI and CI use the executable checks below.

## Commands

```sh
bun install --frozen-lockfile
bun run check
```

`check` runs `typecheck`, `lint`, `format:check`, `test`, then `build`, once each.

| Script | Actual command |
| --- | --- |
| `typecheck` | `effect-tsgo tsc --noEmit` |
| `lint` | `effect-tsgo oxlint --type-aware .` |
| `effect-check` | Compatibility alias for `bun run lint`; omitted from `check` to avoid duplication |
| `format:check` | `biome format .` |
| `format` | `biome format --write .` |
| `test` | `vitest run` |
| `build` | `effect-tsgo tsc -p tsconfig.build.json` |

Generated `dist` files are excluded from TS, Oxlint and formatting. Source/tests
remain checked, including original process fixtures. Provider-free GitHub CI runs
frozen installation and the same `check`; no Delta or model-provider credentials
are needed. Full checks and frozen installation are repeated with output present.

## Ownership and API choices

Keep protocol/persistence host-independent. Use public Effect services, typed
Schema failures, scoped resources and structured concurrency where they solve the
problem. Pure command grammar stays pure. Core contains no runtime or global
process singleton; a future host adapter owns its runtime and abort bridge.

- `Context.Service` and explicit `Layer` wiring; no old Context.Tag or hidden
  generated Default layers. Effect 4 Schema uses `decodeUnknownEffect` at unknown
  boundaries and `decodeEffect` for known encoded strings.
- Process imports are `effect/process`, not v3 Command or beta unstable paths.
  Explicit argv/cwd, shell false, inherited env plus overrides, concurrent output
  draining and actual exit checks are exercised. Scopes own termination.
- `FileSystem`, `Path`, `Semaphore` and `Digest` services own durable producer
  state. `File.sync`, directory sync, exclusive opens, atomic rename and scoped
  finalizers use public APIs; no raw Node persistence syscall was needed.
- JSON schemas distinguish CLI contract 8, record schemaVersion 1 and local
  journal format 1. All content blocks emitted by the pinned recorder are validated within the
  supported message/tool/title/state envelope subset,
  not permissive acceptance of unknown controls or complete protocol support.
- No retries of non-idempotent writes or automatic recovery. A local writer lock
  fails closed after crashes, real validation/read failures or ambiguous persistence.
  Interrupt-only guard cancellation does not poison ownership; commits remain
  uninterruptible. Lock-release finalizer failures become defects via `orDie`.
  Late records retain the
  caller's original turn sequence. Recovery/workflows remain outside this leaf.

Actual Node process fixtures use raw stdout/env/timers only inside test child
programs to exercise pipe/lifecycle boundaries. The outbox crash fixture runs an
owned test runtime in a real Bun child; the parent kills it via the Effect
spawner. These are test programs, not library subprocess implementations or
hidden production runtimes. Test-only explicit lock removal demonstrates recovery
boundaries; core never reclaims a stale lock on its own.

## Evidence and limits

Foundation CI: **48 tests**, commit `5f8de2579be95bf7b95ab7c0a651018b01ab347b`,
[run 41245700377](https://github.com/klittle32/delta-extensions/actions/runs/41245700377).
Process checkpoint CI: **74 tests**, commit `3bdc8c0`,
[run 41247550048](https://github.com/klittle32/delta-extensions/actions/runs/41247550048).
Outbox/tooling checkpoint CI: commit `c46899830de034aa0d16f7f1974eb1477cc4b516`,
[run 41250090689](https://github.com/klittle32/delta-extensions/actions/runs/41250090689).
All three runs were confirmed by the parent watcher. Parent outbox verification
also covered 121 local tests/build/frozen install and independent blocker recheck.
This subsequent content leaf adds seven tests (128 total); current local results
are reported with delivery. No remote CI for this leaf is claimed.

The process and outbox tests use real local files/processes and injected services
for failure/deadline boundaries. They are not live Delta or Letta acceptance.
Linux direct-child cleanup and local POSIX storage have been exercised; no Windows,
macOS, NFS, distributed locking, descendant-tree termination or power-cut test has
been performed. Full parity remains the product target. See [core boundaries](core.md).

## References

- [Effect v4 API](https://effect.website/docs/v4/api/effect)
- [Schema](https://effect.website/docs/v4/api/effect/Schema)
- [Native tsgo tooling](https://www.npmjs.com/package/@effect/tsgo)
- [Effect Oxlint setup](https://github.com/Effect-TS/tsgo/blob/main/docs/README.md)
