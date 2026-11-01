import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Layer } from "effect";
import { nodeProcessLayer } from "../../core/src/node.js";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { makeOperations, OperationError } from "../src/operations/index.js";
import type { Session } from "../src/session.js";
const testLayer = Layer.mergeAll(
  NodeFileSystem.layer,
  NodePath.layer,
  nodeProcessLayer,
);
const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | import("effect").Scope.Scope
    | import("effect").FileSystem.FileSystem
    | import("effect").Path.Path
    | import("effect/process/ChildProcessSpawner").ChildProcessSpawner
  >,
) => Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(testLayer)));
const session: Session = {
  agentId: "a",
  conversationId: "c",
  cwd: "/repo",
  interactive: true,
  signal: new AbortController().signal,
  getHistory: async () => [],
  notify: () => {},
};
describe("operations", () => {
  it("declining login never starts or cancels app authentication", async () => {
    const calls: readonly string[][] = [];
    const ops = await run(
      Effect.scoped(
        makeOperations({
          interaction: { ask: () => Effect.succeed(undefined) },
          discover: () => Effect.succeed("/delta"),
          run: (r) => {
            (calls as string[][]).push([...r.args]);
            return Effect.succeed({
              stdout: '{"status":"signed_out"}',
              stderr: "",
              exitCode: 1,
            });
          },
        }),
      ),
    );
    const result = await run(
      Effect.result(ops.auth(session)).pipe(Effect.provide(nodeProcessLayer)),
    );
    expect(result._tag).toBe("Failure");
    expect(calls).toEqual([["--json", "auth", "status"]]);
  });
  it("reports source updates honestly without invoking a package manager", async () => {
    const ops = await run(
      Effect.scoped(
        makeOperations({
          interaction: { ask: () => Effect.succeed(undefined) },
        }),
      ),
    );
    expect(await run(ops.pluginUpdate(session, "check"))).toContain("source");
  });
  it("has typed operation failures", () =>
    expect(new OperationError({ kind: "access", message: "denied" })._tag).toBe(
      "OperationError",
    ));
});

it("persists policy at checkout root and excludes it through the common Git dir", async () => {
  const data = new Map<string, string>([
    ["/repo/.delta/settings.json", '{"custom":1,"threads":{"future":true}}'],
  ]);
  const answers = ["team", "private", "later"];
  const ops = await run(
    makeOperations({
      interaction: { ask: () => Effect.succeed(answers.shift()) },
      discover: () => Effect.succeed("/delta"),
      files: {
        read: (path) => Effect.succeed(data.get(path)),
        write: (path, text) =>
          Effect.sync(() => {
            data.set(path, text);
          }),
      },
      run: (request) =>
        Effect.succeed({
          exitCode: 0,
          stderr: "",
          stdout:
            request.executable === "git"
              ? request.args.includes("--show-toplevel")
                ? "/repo\n"
                : request.args.includes("--git-common-dir")
                  ? "../common\n"
                  : "origin\n"
              : request.args.includes("contract")
                ? '{"operation":"contract","min":8,"max":8}'
                : request.args.includes("auth")
                  ? '{"status":"signed_in"}'
                  : '{"organizations":[{"id":"team","name":"Team","current":true}]}',
        }),
    }),
  );
  const outcome = await run(
    ops.setup(session).pipe(Effect.provide(nodeProcessLayer)),
  );
  expect(outcome).toEqual({ text: "Saved private repository policy." });
  expect(JSON.parse(data.get("/repo/.delta/settings.json")!)).toEqual({
    custom: 1,
    threads: { future: true, mode: "private", organization: "team" },
  });
  expect(data.get("/common/info/exclude")).toBe("/.delta/settings.json\n");
});
it("accepts an existing login without asking or starting login", async () => {
  let asked = false;
  const ops = await run(
    makeOperations({
      interaction: {
        ask: () =>
          Effect.sync(() => {
            asked = true;
            return undefined;
          }),
      },
      discover: () => Effect.succeed("/delta"),
      run: (r) =>
        Effect.succeed({
          exitCode: 0,
          stderr: "",
          stdout: r.args.includes("contract")
            ? '{"operation":"contract","min":8,"max":8}'
            : '{"status":"signed_in"}',
        }),
    }),
  );
  expect(
    await run(ops.ensureReady(session).pipe(Effect.provide(nodeProcessLayer))),
  ).toBe("/delta");
  expect(asked).toBe(false);
});
it("interrupts only the local auth waiter on session abort", async () => {
  const controller = new AbortController();
  const calls: string[][] = [];
  let waiting!: () => void;
  const entered = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  const ops = await run(
    makeOperations({
      interaction: { ask: () => Effect.succeed("login") },
      discover: () => Effect.succeed("/delta"),
      run: (r) => {
        calls.push([...r.args]);
        if (r.args.includes("wait"))
          return Effect.sync(waiting).pipe(Effect.andThen(Effect.never));
        return Effect.succeed({
          exitCode: 0,
          stderr: "",
          stdout: r.args.includes("login")
            ? '{"status":"pending","login_id":"id","url":"https://delta.dev/login/id","expires_at":"2099-01-01T00:00:00Z"}'
            : '{"status":"signed_out"}',
        });
      },
    }),
  );
  const result = run(
    Effect.result(ops.auth({ ...session, signal: controller.signal })).pipe(
      Effect.provide(nodeProcessLayer),
    ),
  );
  await entered;
  controller.abort();
  expect((await result)._tag).toBe("Failure");
  expect(calls).toEqual([
    ["--json", "auth", "status"],
    ["--json", "auth", "login", "--no-wait"],
    ["--json", "auth", "wait", "id"],
  ]);
});

const updateReceipt = (status = "up_to_date") =>
  JSON.stringify({
    schema_version: 1,
    status,
    can_install: true,
    current_version: "1",
    latest_version: "2",
    channel: "stable",
    message: "Checked",
  });
it("background update check never asks, authenticates, or installs", async () => {
  const calls: string[][] = [];
  const ops = await run(
    makeOperations({
      interaction: { ask: () => Effect.die("must not ask") },
      discover: () => Effect.succeed("/delta"),
      run: (r) => {
        calls.push([...r.args]);
        return Effect.succeed({
          stdout: updateReceipt(),
          stderr: "",
          exitCode: 0,
        });
      },
    }),
  );
  expect(await run(ops.checkUpdate(session))).toBe("Checked");
  expect(calls).toEqual([["update", "--check", "--json"]]);
});
it("refuses updates while a run or child is busy", async () => {
  const ops = await run(
    makeOperations({
      interaction: { ask: () => Effect.die("must not ask") },
      busy: () => true,
      discover: () => Effect.die("must not discover"),
    }),
  );
  const result = await run(Effect.result(ops.update(session)));
  expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "busy" } });
});
it("rejects a mutating receipt from a check-only command", async () => {
  const ops = await run(
    makeOperations({
      interaction: { ask: () => Effect.succeed(undefined) },
      discover: () => Effect.succeed("/delta"),
      run: () =>
        Effect.succeed({
          stdout: updateReceipt("updated"),
          stderr: "",
          exitCode: 0,
        }),
    }),
  );
  expect(await run(Effect.result(ops.checkUpdate(session)))).toMatchObject({
    _tag: "Failure",
    failure: { kind: "invalid" },
  });
});
it("preserves preference keys when disabling update notices", async () => {
  const data = new Map([["/preferences", '{"custom":true}']]);
  const ops = await run(
    makeOperations({
      interaction: { ask: () => Effect.succeed(undefined) },
      preferencesPath: "/preferences",
      files: {
        read: (p) => Effect.succeed(data.get(p)),
        write: (p, t) =>
          Effect.sync(() => {
            data.set(p, t);
          }),
      },
    }),
  );
  await run(ops.pluginUpdate(session, "notifications off"));
  expect(JSON.parse(data.get("/preferences")!)).toEqual({
    custom: true,
    notifications: false,
  });
});
it("keeps terms distinct from other access denial without launching login", async () => {
  for (const [reason, kind] of [
    ["terms_not_accepted", "terms"],
    ["no_access", "access"],
  ]) {
    const calls: string[][] = [];
    const ops = await run(
      makeOperations({
        interaction: { ask: () => Effect.succeed(undefined) },
        discover: () => Effect.succeed("/delta"),
        run: (r) => {
          calls.push([...r.args]);
          return Effect.succeed({
            stdout: JSON.stringify({ status: "access_denied", reason }),
            stderr: "",
            exitCode: 1,
          });
        },
      }),
    );
    expect(await run(Effect.result(ops.auth(session)))).toMatchObject({
      _tag: "Failure",
      failure: { kind },
    });
    expect(calls).toEqual([["--json", "auth", "status"]]);
  }
});
it("never installs a missing CLI after consent is declined", async () => {
  const ops = await run(
    makeOperations({
      interaction: { ask: () => Effect.succeed(undefined) },
      discover: () => Effect.fail("missing"),
      run: () => Effect.die("installer must not start"),
    }),
  );
  expect(await run(Effect.result(ops.ensureReady(session)))).toMatchObject({
    _tag: "Failure",
    failure: { kind: "cancelled" },
  });
});
it("suppresses configured, invalid, and busy onboarding before any auth", async () => {
  for (const text of [
    '{"threads":{"mode":"manual"}}',
    '{"threads":{"mode":"bad"}}',
  ]) {
    const ops = await run(
      makeOperations({
        interaction: { ask: () => Effect.die("must not ask") },
        files: {
          read: () => Effect.succeed(text),
          write: () => Effect.die("must not write"),
        },
        run: (r) =>
          Effect.succeed({
            stdout: r.args.includes("--show-toplevel") ? "/repo" : "/common",
            stderr: "",
            exitCode: 0,
          }),
        discover: () => Effect.die("must not authenticate"),
      }),
    );
    expect(await run(ops.autoOnboard(session))).toBeUndefined();
  }
});
it("rejects a stale interaction before executing login", async () => {
  let current = true;
  const calls: string[][] = [];
  const ops = await run(
    makeOperations({
      current: () => current,
      interaction: {
        ask: () =>
          Effect.sync(() => {
            current = false;
            return "login";
          }),
      },
      discover: () => Effect.succeed("/delta"),
      run: (r) => {
        calls.push([...r.args]);
        return Effect.succeed({
          stdout: '{"status":"signed_out"}',
          stderr: "",
          exitCode: 1,
        });
      },
    }),
  );
  expect(await run(Effect.result(ops.auth(session)))).toMatchObject({
    _tag: "Failure",
    failure: { kind: "stale" },
  });
  expect(calls).toHaveLength(1);
});
it("returns the explicit current-session sharing choice without creating a thread", async () => {
  const answers = ["team", "organization", "share"];
  const calls: string[][] = [];
  const data = new Map<string, string>();
  const ops = await run(
    makeOperations({
      interaction: { ask: () => Effect.succeed(answers.shift()) },
      discover: () => Effect.succeed("/delta"),
      files: {
        read: (p) => Effect.succeed(data.get(p)),
        write: (p, t) =>
          Effect.sync(() => {
            data.set(p, t);
          }),
      },
      run: (r) => {
        calls.push([...r.args]);
        return Effect.succeed({
          exitCode: 0,
          stderr: "",
          stdout:
            r.executable === "git"
              ? r.args.includes("--show-toplevel")
                ? "/repo"
                : r.args.includes("--git-common-dir")
                  ? "/common"
                  : "origin"
              : r.args.includes("contract")
                ? '{"operation":"contract","min":8,"max":8}'
                : r.args.includes("auth")
                  ? '{"status":"signed_in"}'
                  : '{"organizations":[{"id":"team","name":"Team","current":true}]}',
        });
      },
    }),
  );
  expect(await run(ops.setup(session))).toMatchObject({
    shareCurrent: { visibility: "organization", organization: "team" },
  });
  expect(calls.some((args) => args.includes("create"))).toBe(false);
});
it("does not replace malformed settings", async () => {
  const ops = await run(
    makeOperations({
      interaction: { ask: () => Effect.die("must not ask") },
      files: {
        read: () => Effect.succeed("{"),
        write: () => Effect.die("must not overwrite"),
      },
      run: (r) =>
        Effect.succeed({
          exitCode: 0,
          stderr: "",
          stdout: r.args.includes("--show-toplevel") ? "/repo" : "origin",
        }),
    }),
  );
  expect(await run(Effect.result(ops.setup(session)))).toMatchObject({
    _tag: "Failure",
    failure: { kind: "invalid" },
  });
});
it("declines update without running an installation command", async () => {
  const ops = await run(
    makeOperations({
      interaction: { ask: () => Effect.succeed("cancel") },
      discover: () => Effect.succeed("/delta"),
      run: () => Effect.die("must not install"),
    }),
  );
  expect(await run(ops.update(session))).toContain("cancelled");
});
it("honors notification opt-out without any discovery or background process", async () => {
  const ops = await run(
    makeOperations({
      interaction: { ask: () => Effect.die("must not ask") },
      preferencesPath: "/prefs",
      files: {
        read: () => Effect.succeed('{"notifications":false}'),
        write: () => Effect.die("must not write"),
      },
      discover: () => Effect.die("must not discover"),
    }),
  );
  expect(await run(ops.checkUpdates(session))).toBeUndefined();
});
it("persists a kept recovery fork before discarding the rejected original", async () => {
  const events: string[] = [];
  const ops = await run(
    makeOperations({
      interaction: { ask: () => Effect.succeed("fork") },
      discover: () => Effect.succeed("/delta"),
      run: (r) => {
        if (r.args.includes("fork")) events.push("fork");
        if (r.args.includes("discard")) events.push("discard");
        return Effect.succeed({
          exitCode: 0,
          stderr: "",
          stdout: r.args.includes("auth")
            ? '{"status":"signed_in"}'
            : r.args.includes("contract")
              ? '{"operation":"contract","min":8,"max":8}'
              : r.args.includes("fork")
                ? '{"thread_id":"kept"}'
                : "{}",
        });
      },
    }),
  );
  expect(
    await run(
      ops.recover(session, {
        thread: "original",
        persistFork: (id) =>
          Effect.sync(() => {
            events.push(`persist:${id}`);
          }),
      }),
    ),
  ).toEqual({ resolved: true, forkedThread: "kept" });
  expect(events).toEqual(["fork", "persist:kept", "discard"]);
});
it("reuses a durable recovery fork rather than creating another", async () => {
  const calls: string[][] = [];
  const ops = await run(
    makeOperations({
      interaction: { ask: () => Effect.succeed("fork") },
      discover: () => Effect.succeed("/delta"),
      run: (r) => {
        calls.push([...r.args]);
        return Effect.succeed({
          exitCode: 0,
          stderr: "",
          stdout: r.args.includes("auth")
            ? '{"status":"signed_in"}'
            : r.args.includes("contract")
              ? '{"operation":"contract","min":8,"max":8}'
              : "{}",
        });
      },
    }),
  );
  expect(
    await run(
      ops.recover(session, {
        thread: "original",
        forkedThread: "kept",
        persistFork: () => Effect.die("must not persist another fork"),
      }),
    ),
  ).toEqual({ resolved: true, forkedThread: "kept" });
  expect(calls).toContainEqual([
    "--json",
    "thread",
    "discard",
    "original",
    "--force",
  ]);
  expect(calls.some((args) => args.includes("fork"))).toBe(false);
});
it("keeping recovery paused starts no CLI or authentication", async () => {
  const ops = await run(
    makeOperations({
      interaction: { ask: () => Effect.succeed("cancel") },
      discover: () => Effect.die("must not discover"),
    }),
  );
  expect(
    await run(
      ops.recover(session, {
        thread: "original",
        persistFork: () => Effect.die("must not persist"),
      }),
    ),
  ).toEqual({ resolved: false });
});
it("creates a team only after confirmation and reports each invite outcome", async () => {
  const answers = [
    "New team",
    "create",
    "a@example.com,b@example.com",
    "manual",
  ];
  const notices: string[] = [];
  const calls: string[][] = [];
  const data = new Map<string, string>();
  const ops = await run(
    makeOperations({
      interaction: { ask: () => Effect.succeed(answers.shift()) },
      discover: () => Effect.succeed("/delta"),
      files: {
        read: (p) => Effect.succeed(data.get(p)),
        write: (p, t) =>
          Effect.sync(() => {
            data.set(p, t);
          }),
      },
      run: (r) => {
        calls.push([...r.args]);
        const stdout =
          r.executable === "git"
            ? r.args.includes("--show-toplevel")
              ? "/repo"
              : r.args.includes("--git-common-dir")
                ? "/common"
                : "origin"
            : r.args.includes("auth")
              ? '{"status":"signed_in"}'
              : r.args.includes("contract")
                ? '{"operation":"contract","min":8,"max":8}'
                : r.args.includes("create")
                  ? '{"operation":"created","organization":{"id":"new"}}'
                  : r.args.includes("invite")
                    ? '{"operation":"invited","results":[{"email":"a@example.com","status":"invited"},{"email":"b@example.com","status":"failed","reason":"not_allowed"}]}'
                    : '{"organizations":[]}';
        return Effect.succeed({ exitCode: 0, stderr: "", stdout });
      },
    }),
  );
  expect(
    await run(
      ops.setup({
        ...session,
        notify: (text) => {
          notices.push(text);
        },
      }),
    ),
  ).toEqual({ text: "Saved manual repository policy." });
  expect(calls).toContainEqual(["--json", "org", "create", "--", "New team"]);
  expect(calls).toContainEqual([
    "--json",
    "org",
    "invite",
    "--org",
    "new",
    "--",
    "a@example.com",
    "b@example.com",
  ]);
  expect(notices).toEqual([
    "a@example.com: invited",
    "b@example.com: failed (not_allowed)",
  ]);
});
it("offers onboarding once per common repository across linked worktrees and lifecycles", async () => {
  let asks = 0;
  const data = new Map<string, string>();
  const options = {
    interaction: {
      ask: () =>
        Effect.sync(() => {
          asks++;
          return "later";
        }),
    },
    files: {
      read: (p: string) => Effect.succeed(data.get(p)),
      write: (p: string, t: string) =>
        Effect.sync(() => {
          data.set(p, t);
        }),
    },
    run: (r: import("../../core/src/transport-errors.js").ProcessRequest) =>
      Effect.succeed({
        exitCode: 0,
        stderr: "",
        stdout: r.args.includes("--show-toplevel")
          ? r.cwd
          : r.args.includes("--git-common-dir")
            ? "/common"
            : "origin",
      }),
  };
  const first = await run(makeOperations(options));
  await run(first.autoOnboard(session));
  await run(first.autoOnboard({ ...session, cwd: "/linked" }));
  const second = await run(makeOperations(options));
  await run(second.autoOnboard({ ...session, cwd: "/another-linked" }));
  expect(asks).toBe(1);
  expect(data.get("/common/delta-letta-onboarding")).toBe("offered\n");
});
