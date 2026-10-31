# Effect 4.1 direction

Research checked live npm metadata and published source on **October 31, 2026**.
These are design constraints, not a dependency manifest or compiled example.

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

Start with two packages, a shared Delta core and a Letta adapter. Keep the platform
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

Add reproducible workspace setup/build/test/typecheck/lint/format/Effect-check
commands when code exists; none exist yet. Avoid a checklist claiming “all best
practices” without executable checks and a focused architectural review.

## References

- [Effect package](https://www.npmjs.com/package/effect)
- [Effect releases](https://github.com/Effect-TS/effect/releases)
- [Effect v4 API](https://effect.website/docs/v4/api/effect)
- [Effect v4 configuration](https://effect.website/docs/v4/configuration)
- [Effect v4 Schema](https://effect.website/docs/v4/api/effect/Schema)
- [Effect native TypeScript tooling](https://www.npmjs.com/package/@effect/tsgo)

Research examples were checked against published signatures, not compiled in
this repository. Implementation must establish that evidence.
