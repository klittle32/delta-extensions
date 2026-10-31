# Effect 4.1 direction

Research checked live npm metadata and published source on **October 31, 2026**.
The core foundation now compiles against these published versions; see the
workspace manifests and `bun.lock`. Platform packages remain uninstalled.

## Verified versions

| Dependency/tool | Version |
| --- | --- |
| `effect` | 4.1.1 |
| `@effect/platform-node` | 4.1.1 |
| `@effect/platform-bun` | 4.1.1 |
| `@effect/vitest` | 4.1.1 |
| `typescript` | 7.0.2 |
| `@effect/tsgo` | 0.63.0 |
| `vitest` | 5.0.5 |
| `@biomejs/biome` | 2.6.4 |

Pin the Effect package family consistently. `effect@beta` points to an older
pre-release, not stable 4.1.1. The published Effect 4 README requires Node 22.19+
and TypeScript 5.9+, recommending TypeScript 7. `@effect/vitest` 4.1.1 requires
Vitest 5. Select only the platform packages actually exercised by the product.

## Architecture

Start with a shared Delta core; add the Letta adapter when actual host integration starts. Keep the platform
implementation behind services within core; split another package only if reuse
or dependency boundaries justify it. Do not add an unrelated standalone CLI.

- `Context.Service` contracts and explicitly wired `Layer` implementations.
- `Schema` decoders for CLI results/events, persisted state and user inputs.
- Tagged domain errors, targeted recovery, and explicit defect reporting.
- Effect `FileSystem`/`Path` services for persistence and test substitutions.
- Scoped `ChildProcess`/`ChildProcessSpawner`, with simultaneous stdout/stderr
  consumption, bounded frames, inspected exit codes and owned termination.
- `Stream` for watch/mount output; bounded queues and serialization where durable
  record ordering demands them; owned fibers for session lifetimes.
- `Schedule`/clock-driven retries only where Delta declares retryability; honor
  `retry_after_ms` and retain exact immutable records.
- `ManagedRuntime` at the host boundary only; bridge host abort signals and close
  all scopes at teardown. Prove async shutdown fits Letta's disposer contract.
- Structured logs/spans with identifiers, not transcript dumps, credentials or
  full child environments. Keep model/human/persisted visibility distinct.

Use Effect primitives for the concurrency, resource ownership, validation and
error handling they provide. Pure strings and lookup tables need not be effects.
Effect cannot manufacture host capabilities that Letta does not expose.

## Version-specific API notes

- Process imports are from **`effect/process`**, not v3's
  `@effect/platform/Command` or the old beta `effect/unstable/process` path.
  Published process APIs are still annotated **unstable**: isolate and exact-pin
  them even though the overall Effect release is stable.
- `Context.Service`, not `Context.Tag` or `Effect.Service`; no generated
  `.Default` layer.
- Config constructors are capitalized: `Config.String`, `Config.Duration`, etc.
- `Schema.decodeUnknownEffect`, `Schema.fromJsonString`, `Schema.Literals([...])`.
- Tagged errors use `Schema.TaggedError`; general recovery is `Effect.catch`.
- Supplying child `env` replaces inheritance unless `extendEnv: true` is set.
  Prefer explicit argv and `shell: false`; do not rely on ambient shell parsing.
- Output convenience methods do not by themselves prove a successful exit.

## Developer tooling and tests

Use strict TypeScript, including unchecked-index and optional-property checks.
Prefer the documented native **`@effect/tsgo`** route for TypeScript 7, rather than
blindly applying the older JavaScript compiler-patching language-service workflow.
Its compiler invocation and Effect semantic diagnostics should be part of CI.
Configure editor support and Biome formatting/linting with the first code slice.

Use `@effect/vitest` with injected layers, TestClock, fixtures and property tests
where useful. Both `it.effect` and `it.live` provide a fresh scope in v4. Test
finalization, cancellation, retry timing and ordering, not only happy-path values.
Keep fake-protocol tests distinct from live host/Delta integration evidence.

The workspace now provides reproducible setup/build/test/typecheck/lint/format/Effect-check
commands (see below). Avoid a checklist claiming “all best
practices” without executable checks and a focused architectural review.

## References

- [Effect package](https://www.npmjs.com/package/effect)
- [Effect releases](https://github.com/Effect-TS/effect/releases)
- [Effect v4 API](https://effect.website/docs/v4/api/effect)
- [Effect v4 configuration](https://effect.website/docs/v4/configuration)
- [Effect v4 Schema](https://effect.website/docs/v4/api/effect/Schema)
- [Effect native TypeScript tooling](https://www.npmjs.com/package/@effect/tsgo)

## Executable foundation evidence

Verified npm metadata before installation: Effect and @effect/vitest 4.1.1,
TypeScript 7.0.2, @effect/tsgo 0.63.0, Vitest 5.0.5, Biome 2.6.4. Bun is 1.4.4;
Node tested is 22.23.4. No platform package is needed for pure core validation.
Published source confirmed `StructWithRest`, `optionalKey`, `check`/`makeFilter`,
`decodeUnknownEffect` and `Schema.TaggedError` signatures; compiled tests exercise them.

- `bun install --frozen-lockfile`: exact lockfile; prepare patches native TypeScript
  using published `effect-tsgo patch --typescript --no-oxlint` for editor support.
- `bun run typecheck`: `effect-tsgo tsc --noEmit`.
- `bun run effect-check`: `effect-tsgo diagnostics --project tsconfig.json --strict`.
- `bun run build`: `effect-tsgo tsc -p tsconfig.build.json`, JS plus declarations.
- `bun run test`: Vitest 5 with @effect/vitest effect tests and injected inputs.
- `bun run lint` / `bun run format`: Biome check / check --write.
- `bun run check`: all checks above except formatting mutations.

The plugin name is `@effect/language-service`, even with the native @effect/tsgo
route; using the package name as the plugin name silently skips semantic checks.
A temporary floating-Effect probe produced two semantic errors and nonzero exit;
it was removed. Diagnostics check every source/test file. The exact-pinned
@effect/vitest API carries an upstream unstable annotation; its diagnostic is
retained at message severity, while other warnings and all errors fail checks.
Suggestions remain advisory. A passing semantic check currently reports **0 errors,
0 warnings, and 17 informational messages/suggestions**, including the upstream
unstable test API notices and typed-decoder suggestions; this is not a claim of
zero diagnostics. No JS compiler-patching plugin is installed.
VS Code settings follow the published native setup preview; editor GUI behavior
has not been acceptance tested. CI uses no provider credentials.

Initial red run: two missing-module suites. A later regression test produced one
failure (44 passed) for accepted unsupported control keys; validation was corrected.
Final counts and full command results are reported with delivery. This slice owns
no runtime or resources, so it introduces no service/layer, TestClock, or shutdown
scaffold solely to demonstrate an API. See [core boundaries](core.md).
