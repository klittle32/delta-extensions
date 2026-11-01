import { Effect, Layer } from "effect";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { expect, it } from "vitest";
import { nodeProcessLayer } from "../../core/src/node.js";
import { makeOperations } from "../src/operations/index.js";
import type { Session } from "../src/session.js";
const layer = Layer.mergeAll(
  NodeFileSystem.layer,
  NodePath.layer,
  nodeProcessLayer,
);
const session: Session = {
  agentId: "a",
  conversationId: "c",
  cwd: "/repo",
  signal: new AbortController().signal,
  interactive: true,
  getHistory: async () => [],
  notify: () => {},
};
const receipt = (status: string, extra = {}) =>
  JSON.stringify({
    schema_version: 1,
    status,
    can_install: true,
    current_version: "1",
    latest_version: "2",
    channel: "stable",
    message: status,
    ...extra,
  });
it("runs the Windows install argv only after download CLI exits and validates reboot outcome", async () => {
  const calls: string[][] = [];
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const ops = yield* makeOperations({
          platform: "win32",
          interaction: { ask: () => Effect.succeed("update") },
          discover: () => Effect.succeed("C:\\Delta\\delta.exe"),
          run: (r) => {
            calls.push([r.executable, ...r.args]);
            return Effect.succeed({
              exitCode: 0,
              stderr: "",
              stdout:
                r.executable === "C:\\installer.exe"
                  ? receipt("updated", { restart_required: true })
                  : receipt("install_ready", {
                      install_argv: [
                        "C:\\installer.exe",
                        "--json",
                        "--path",
                        "C:\\space dir",
                      ],
                    }),
            });
          },
        });
        return yield* ops.update(session);
      }),
    ).pipe(Effect.provide(layer)),
  );
  expect(calls).toEqual([
    ["C:\\Delta\\delta.exe", "update", "--download-only", "--json"],
    ["C:\\installer.exe", "--json", "--path", "C:\\space dir"],
  ]);
  expect(result).toBe("updated Restart required.");
});

it("rejects invalid install argv and does not execute any helper during check-only", async () => {
  for (const checkOnly of [false, true]) {
    let calls = 0;
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ops = yield* makeOperations({
            platform: "win32",
            interaction: { ask: () => Effect.succeed("update") },
            discover: () => Effect.succeed("delta"),
            run: () => {
              calls++;
              return Effect.succeed({
                exitCode: 0,
                stderr: "",
                stdout: receipt("install_ready", { install_argv: [] }),
              });
            },
          });
          return yield* Effect.result(ops.update(session, checkOnly));
        }),
      ).pipe(Effect.provide(layer)),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { kind: "invalid" },
    });
    expect(calls).toBe(1);
  }
});
it("refuses a helper when work becomes busy during download", async () => {
  let busy = false;
  let calls = 0;
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const ops = yield* makeOperations({
          platform: "win32",
          busy: () => busy,
          interaction: { ask: () => Effect.succeed("update") },
          discover: () => Effect.succeed("delta"),
          run: () =>
            Effect.sync(() => {
              calls++;
              busy = true;
              return {
                exitCode: 0,
                stderr: "",
                stdout: receipt("install_ready", {
                  install_argv: ["installer"],
                }),
              };
            }),
        });
        return yield* Effect.result(ops.update(session));
      }),
    ).pipe(Effect.provide(layer)),
  );
  expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "busy" } });
  expect(calls).toBe(1);
});
it("requires a complete typed installed receipt including restart_required", async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const ops = yield* makeOperations({
          platform: "win32",
          interaction: { ask: () => Effect.succeed("update") },
          discover: () => Effect.succeed("delta"),
          run: (r) =>
            Effect.succeed({
              exitCode: 0,
              stderr: "",
              stdout:
                r.executable === "installer"
                  ? receipt("updated")
                  : receipt("install_ready", { install_argv: ["installer"] }),
            }),
        });
        return yield* Effect.result(ops.update(session));
      }),
    ).pipe(Effect.provide(layer)),
  );
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { kind: "invalid" },
  });
});

import { it as effectIt } from "@effect/vitest";
import { Deferred, Fiber } from "effect";
import { TestClock } from "effect/testing";
effectIt.effect(
  "a long native installer remains owned and blocks replacement after the UI deadline",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let settled = false;
        const ops = yield* makeOperations({
          platform: "win32",
          interaction: { ask: () => Effect.succeed("update") },
          discover: () => Effect.succeed("delta"),
          run: (r) =>
            r.executable === "installer"
              ? Effect.gen(function* () {
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                  settled = true;
                  return {
                    exitCode: 0,
                    stderr: "",
                    stdout: receipt("updated", { restart_required: false }),
                  };
                })
              : Effect.succeed({
                  exitCode: 0,
                  stderr: "",
                  stdout: receipt("install_ready", {
                    install_argv: ["installer"],
                  }),
                }),
        });
        const update = yield* ops.update(session).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* TestClock.adjust("10 minutes");
        expect(yield* Fiber.join(update)).toContain("still running");
        expect(settled).toBe(false);
        expect(yield* Effect.result(ops.update(session))).toMatchObject({
          _tag: "Failure",
          failure: { kind: "busy" },
        });
        yield* Deferred.succeed(release, undefined);
      }),
    ).pipe(Effect.provide(layer)),
);
it("preserves typed installer refusal and cancelled-elevation outcomes", async () => {
  for (const [code, kind] of [
    ["app_running", "busy"],
    ["installation_cancelled", "cancelled"],
  ]) {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ops = yield* makeOperations({
            platform: "win32",
            interaction: { ask: () => Effect.succeed("update") },
            discover: () => Effect.succeed("delta"),
            run: (r) =>
              Effect.succeed(
                r.executable === "installer"
                  ? {
                      exitCode: 1,
                      stderr: "",
                      stdout: JSON.stringify({
                        error: {
                          code,
                          message: "Installer needs human action",
                          retryable: true,
                        },
                      }),
                    }
                  : {
                      exitCode: 0,
                      stderr: "",
                      stdout: receipt("install_ready", {
                        install_argv: ["installer"],
                      }),
                    },
              ),
          });
          return yield* Effect.result(ops.update(session));
        }),
      ).pipe(Effect.provide(layer)),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        kind,
        code,
        retryable: true,
        message: "Installer needs human action",
      },
    });
  }
});
effectIt.effect(
  "local cancellation stops waiting while teardown settles the owned native installer",
  () =>
    Effect.gen(function* () {
      let settled = false;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const controller = new AbortController();
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const ops = yield* makeOperations({
            platform: "win32",
            interaction: { ask: () => Effect.succeed("update") },
            discover: () => Effect.succeed("delta"),
            run: (r) =>
              r.executable === "installer"
                ? Effect.gen(function* () {
                    yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(release);
                    settled = true;
                    return {
                      exitCode: 0,
                      stderr: "",
                      stdout: receipt("updated", { restart_required: false }),
                    };
                  })
                : Effect.succeed({
                    exitCode: 0,
                    stderr: "",
                    stdout: receipt("install_ready", {
                      install_argv: ["installer"],
                    }),
                  }),
          });
          const active = yield* Effect.result(
            ops.update({ ...session, signal: controller.signal }),
          ).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          controller.abort();
          expect(yield* Fiber.join(active)).toMatchObject({
            _tag: "Failure",
            failure: { kind: "cancelled" },
          });
          expect(settled).toBe(false);
          yield* Deferred.succeed(release, undefined);
        }),
      );
      expect(settled).toBe(true);
    }).pipe(Effect.provide(layer)),
);
