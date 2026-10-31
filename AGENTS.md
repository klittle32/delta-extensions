# Development instructions

## Product requirements

- Read `docs/requirements.md` before implementing. Full upstream functional
  parity is the target; a command wrapper is not an acceptable substitute.
- Preserve the seven upstream slash-command names and their argument forms.
- The first adapter must be a Letta Code mod using documented public mod APIs.
  Do not import private host modules, access private symbols, or monkey-patch the
  harness to hide a missing capability.
- Ask the owner before expanding scope into changes to Letta Code itself or
  reducing feature parity. An external issue, release, deployment, or registry
  publication needs separate authorization.
- Future harness support belongs in separate adapters. Keep Delta protocol and
  persistence logic host-independent. Do not create placeholder implementations.

## TypeScript and Effect

- Use Effect **4.1**, not v3 or an old v4 beta. Research verified stable **4.1.1**.
  Read `docs/effect.md`; verify exact dependencies before installing.
- Use Effect services/layers, schemas, typed failures, scoped resources, streams,
  structured concurrency, and test services where they solve the actual problem.
- One owned runtime per adapter lifecycle; no hidden runtimes in shared services.
- Respect host cancellation and teardown. No unowned watchers, processes, timers,
  or fibers; no retries of non-idempotent operations without a protocol reason.
- Do not log credentials, full environments, or protected agent context.

## Test-driven delivery

Write tests first, observe the intended failure where practical, implement the
smallest passing behavior, then run relevant suites and static checks. Keep
deterministic protocol tests separate from real Delta and real-host acceptance.
Never present fake-CLI tests as live collaboration verification.

No package manager, dependency lock, implementation, build, or test commands have
been established yet. Add reproducible setup and check commands with the first
implementation slice; do not document commands that do not exist.

## Safety and disclosure

- Delta CLI owns authentication and DeltaDB access. Do not read/write its database.
- Explicitly disclose and obtain consent for conversation/file sharing.
- Never export Letta memory, system prompts, policy, or skill bodies to approximate
  an unavailable transcript interface.
- Preserve producer identities, immutable outbox records, per-record receipts,
  turn fencing, and original turn sequences for late output.
- Do not enable shared writes without a proven host turn/tool cancellation path.
- Keep a tested/untested distinction for platforms, hosts, and runtime surfaces.
- Preserve upstream AGPL-3.0-only licensing when adapting its code or fixtures.
