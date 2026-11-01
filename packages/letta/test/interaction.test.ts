import * as Http from "node:http";
import * as Net from "node:net";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const chrome = [
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((path) => existsSync(path));
import { Cause, Effect, Exit, Fiber, Scope } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  makeInteraction,
  type InteractionOptions,
} from "../src/interaction/index.js";
import { nativeOpener, openerArgv } from "../src/interaction/opener.js";
import { ChildProcessSpawner } from "effect/process";
import type { Question, Session } from "../src/session.js";

const servers = () =>
  process.getActiveResourcesInfo().filter((r) => r === "TCPServerWrap").length;
const baseline = servers();
// Node drops the closed handle from its active list on a later tick.
afterEach(() => expect.poll(servers, { timeout: 500 }).toBe(baseline));

const makeSession = (over: Partial<Session> = {}) => {
  const controller = new AbortController();
  const notices: string[] = [];
  const session: Session = {
    agentId: "agent-1",
    conversationId: "conv-1",
    cwd: "/work/repo",
    interactive: true,
    signal: controller.signal,
    getHistory: async () => [],
    notify: (m) => notices.push(m),
    ...over,
  };
  return { session, controller, notices };
};

const question: Question = {
  title: "Who should see this session?",
  message: "Delta syncs this conversation.",
  choices: [
    { value: "organization", label: "Share with Acme" },
    { value: "private", label: "Just me (sync privately)" },
  ],
  allowText: true,
};

interface Reply {
  status: number;
  headers: Http.IncomingHttpHeaders;
  body: string;
}
const send = (
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
    chunked?: boolean;
  } = {},
) =>
  new Promise<Reply>((resolve, reject) => {
    const target = new URL(url);
    const req = Http.request(
      {
        host: "127.0.0.1",
        port: target.port,
        path: target.pathname + target.search,
        method: options.method ?? "GET",
        agent: false,
        headers: { host: target.host, ...options.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) {
      if (options.chunked) {
        req.write(options.body);
        req.write(options.body);
      } else req.write(options.body);
    }
    req.end();
  });

const post = (
  url: string,
  body: string,
  headers: Record<string, string> = {},
) =>
  send(url, {
    method: "POST",
    body,
    headers: {
      origin: new URL(url).origin,
      "content-type": "application/x-www-form-urlencoded",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
  });

/** Starts a question in a maker-owned scope; the fake opener captures the URL. */
const start = async (
  q: Question = question,
  over: Partial<Session> = {},
  options: Omit<InteractionOptions, "open"> & { opened?: boolean } = {},
) => {
  const scope = Scope.makeUnsafe();
  const urls: string[] = [];
  let resolveUrl: (u: string) => void = () => {};
  const urlPromise = new Promise<string>((r) => (resolveUrl = r));
  const interaction = await Effect.runPromise(
    makeInteraction({
      ...options,
      open: (url) =>
        Effect.sync(() => {
          urls.push(url);
          resolveUrl(url);
          return options.opened ?? true;
        }),
    }).pipe(Scope.provide(scope)),
  );
  const s = makeSession(over);
  const fiber = Effect.runFork(interaction.ask(s.session, q));
  const result = Effect.runPromiseExit(Fiber.join(fiber));
  return {
    ...s,
    interaction,
    scope,
    urls,
    url: urlPromise,
    result,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
};

const refused = (url: string) =>
  expect(send(url)).rejects.toMatchObject({ code: "ECONNREFUSED" });

const failure = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

describe("browser question primitive", () => {
  it("has no side effects until a question is asked", async () => {
    const opened: string[] = [];
    const scope = Scope.makeUnsafe();
    await Effect.runPromise(
      makeInteraction({
        open: (u) => Effect.sync(() => (opened.push(u), true)),
      }).pipe(Scope.provide(scope)),
    );
    expect(servers()).toBe(baseline);
    expect(opened).toEqual([]);
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("refuses non-interactive sessions without serving or opening", async () => {
    const t = await start(question, { interactive: false });
    const exit = await t.result;
    expect(failure(exit)).toMatchObject({
      _tag: "InteractionError",
      kind: "unavailable",
    });
    expect(t.urls).toEqual([]);
    expect(t.notices).toEqual([]);
    await t.close();
  });

  it("serves an escaped, script-free page and returns the chosen value once", async () => {
    const t = await start();
    const url = await t.url;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/q\/[A-Za-z0-9_-]{43}$/);
    expect(t.notices[0]).toContain(url);
    const page = await send(url);
    expect(page.status).toBe(200);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["content-security-policy"]).toMatch(
      /default-src 'none'.*form-action 'self'/,
    );
    expect(page.headers["set-cookie"]).toBeUndefined();
    expect(page.body).not.toMatch(/<script/i);
    expect(page.body).toContain("Share with Acme");
    expect(page.body).toContain("Just me (sync privately)");
    expect(page.body).toContain('value="cancel"');
    const answer = await post(url, "choice=1&text=ignored");
    expect(answer.status).toBe(200);
    expect(answer.body).toContain("Answer sent");
    expect(await t.result).toEqual(Exit.succeed("private"));
    await refused(url);
    await t.close();
  });

  it("returns trimmed free text, re-asks on empty text, and honours Cancel", async () => {
    const t = await start({ ...question, initialText: "a@b.example" });
    const url = await t.url;
    expect((await send(url)).body).toContain(">a@b.example</textarea>");
    const empty = await post(url, "action=text&text=%20%20");
    expect(empty.status).toBe(422);
    expect(empty.body).toContain("Type an answer");
    expect(
      (
        await post(
          url,
          "action=text&text=%20x%40y.example%2C%20z%40w.example%20",
        )
      ).status,
    ).toBe(200);
    expect(await t.result).toEqual(Exit.succeed("x@y.example, z@w.example"));
    await t.close();

    const c = await start();
    expect((await post(await c.url, "action=cancel")).body).toContain(
      "Cancelled",
    );
    expect(await c.result).toEqual(Exit.succeed(undefined));
    await c.close();
  });

  it("rejects text answers when the question offers only choices", async () => {
    const t = await start({ ...question, allowText: false });
    const url = await t.url;
    expect((await send(url)).body).not.toContain("<textarea");
    expect((await post(url, "action=text&text=hi")).status).toBe(400);
    expect((await post(url, "choice=0")).status).toBe(200);
    expect(await t.result).toEqual(Exit.succeed("organization"));
    await t.close();
  });

  it("rejects forged, malformed and oversized requests without resolving", async () => {
    const t = await start();
    const url = await t.url;
    const { origin, port } = new URL(url);
    const wrongToken = url.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    expect((await send(wrongToken)).status).toBe(404);
    expect((await post(wrongToken, "choice=0")).status).toBe(404);
    expect((await send(`${origin}/`)).status).toBe(404);
    expect(
      (await send(url, { headers: { host: `localhost:${port}` } })).status,
    ).toBe(421);
    expect(
      (await send(url, { headers: { host: `evil.example:${port}` } })).status,
    ).toBe(421);
    expect(
      (await post(url, "choice=0", { origin: "http://evil.example" })).status,
    ).toBe(403);
    expect((await post(url, "choice=0", { origin: "null" })).status).toBe(403);
    expect(
      (await post(url, "choice=0", { "sec-fetch-site": "cross-site" })).status,
    ).toBe(403);
    expect(
      (
        await send(url, {
          method: "POST",
          body: "choice=0",
          headers: { "content-type": "application/x-www-form-urlencoded" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await post(url, '{"choice":0}', { "content-type": "application/json" }))
        .status,
    ).toBe(415);
    expect(
      (await post(url, `action=text&text=${"x".repeat(20_000)}`)).status,
    ).toBe(413);
    expect(
      (
        await send(url, {
          method: "POST",
          chunked: true,
          body: `text=${"y".repeat(9000)}`,
          headers: {
            origin,
            "content-type": "application/x-www-form-urlencoded",
            "transfer-encoding": "chunked",
          },
        })
      ).status,
    ).toBe(413);
    expect(
      (await post(url, `action=text&text=${"z".repeat(4001)}`)).status,
    ).toBe(422);
    expect(
      (
        await send(url, {
          method: "POST",
          body: Buffer.from([0x74, 0x3d, 0xff]),
          headers: {
            origin,
            "content-type": "application/x-www-form-urlencoded",
          },
        })
      ).status,
    ).toBe(400);
    for (const body of [
      "choice=2",
      "choice=-1",
      "choice=0x1",
      "choice=",
      "nothing=1",
    ])
      expect((await post(url, body)).status).toBe(400);
    expect((await send(url, { method: "PUT" })).status).toBe(405);
    expect((await send(url)).status).toBe(200);
    expect((await post(url, "choice=0")).status).toBe(200);
    expect(await t.result).toEqual(Exit.succeed("organization"));
    await t.close();
  });

  it("accepts exactly one of concurrent submissions", async () => {
    const t = await start();
    const url = await t.url;
    const replies = await Promise.allSettled([
      post(url, "choice=0"),
      post(url, "choice=1"),
      post(url, "action=cancel"),
    ]);
    const statuses = replies.map((r) =>
      r.status === "fulfilled" ? r.value.status : "refused",
    );
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    const exit = await t.result;
    const winner = replies.findIndex(
      (r) => r.status === "fulfilled" && r.value.status === 200,
    );
    expect(exit).toEqual(
      Exit.succeed(["organization", "private", undefined][winner]),
    );
    await refused(url);
    await t.close();
  });

  it("cuts stalled connections after a bounded drain instead of waiting for Node timeouts", async () => {
    const t = await start();
    const url = await t.url;
    const socket = Net.connect(Number(new URL(url).port), "127.0.0.1");
    socket.on("error", () => {});
    await new Promise((r) => socket.once("connect", r));
    socket.write("GET / HTTP/1.1\r\nHost: x"); // never finishes its headers
    const started = Date.now();
    expect((await post(url, "choice=0")).status).toBe(200);
    expect(await t.result).toEqual(Exit.succeed("organization"));
    expect(Date.now() - started).toBeLessThan(4000);
    await new Promise((r) =>
      socket.destroyed ? r(undefined) : socket.once("close", r),
    );
    await refused(url);
    await t.close();
  });

  it("escapes question content against markup injection", async () => {
    const t = await start(
      {
        title: "<script>alert(1)</script>",
        message: "</p><img src=x onerror=alert(1)>",
        choices: [{ value: "v", label: '"><b>bold</b>' }],
        allowText: true,
        initialText: "</textarea><script>x()</script>",
      },
      { cwd: "/tmp/<i>&" },
    );
    const body = (await send(await t.url)).body;
    expect(body).not.toMatch(/<script|<img|<b>|<i>|<\/textarea><script/i);
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).toContain("&quot;&gt;&lt;b&gt;bold&lt;/b&gt;");
    expect(body).toContain("/tmp/&lt;i&gt;&amp;");
    expect((await post(await t.url, "action=cancel")).status).toBe(200);
    await t.result;
    await t.close();
  });

  it("ends with a closed failure when the host aborts, and frees the port", async () => {
    const t = await start();
    const url = await t.url;
    t.controller.abort();
    expect(failure(await t.result)).toMatchObject({ kind: "closed" });
    await refused(url);
    await t.close();
  });

  it("ends pending questions when the interaction scope closes", async () => {
    const t = await start();
    const url = await t.url;
    await t.close();
    expect(failure(await t.result)).toMatchObject({ kind: "closed" });
    await refused(url);
  });

  it("keeps independent questions isolated and one pending per conversation", async () => {
    const a = await start(question, { conversationId: "a" });
    const b = await start(question, { conversationId: "b" });
    const [ua, ub] = [await a.url, await b.url];
    expect(new URL(ua).pathname).not.toBe(new URL(ub).pathname);
    // A's capability on B's server, and B's origin on A's server.
    expect(
      (await post(new URL(new URL(ua).pathname, ub).href, "choice=0")).status,
    ).toBe(404);
    expect(
      (await post(ua, "choice=0", { origin: new URL(ub).origin })).status,
    ).toBe(403);

    const dup = makeSession({ conversationId: "a" });
    const exit = await Effect.runPromiseExit(
      a.interaction.ask(dup.session, question),
    );
    expect(failure(exit)).toMatchObject({ kind: "unavailable" });

    expect((await post(ub, "choice=1")).status).toBe(200);
    expect(await b.result).toEqual(Exit.succeed("private"));
    expect((await send(ua)).status).toBe(200);
    expect((await post(ua, "choice=0")).status).toBe(200);
    expect(await a.result).toEqual(Exit.succeed("organization"));
    await Promise.all([a.close(), b.close()]);
  });

  it("keeps a usable link when the browser cannot be opened", async () => {
    const t = await start(question, {}, { opened: false });
    const url = await t.url;
    await expect.poll(() => t.notices.length).toBe(2);
    expect(t.notices[1]).toContain("Could not open a browser");
    expect(t.notices[1]).toContain(url);
    expect((await post(url, "choice=0")).status).toBe(200);
    await t.result;
    await t.close();
  });

  it("treats an unanswered question as dismissed after its timeout", async () => {
    const t = await start(question, {}, { timeout: "50 millis" });
    const url = await t.url;
    expect(await t.result).toEqual(Exit.succeed(undefined));
    expect(t.notices.at(-1)).toContain("expired");
    await refused(url);
    await t.close();
  });

  it("fails invalid questions with a typed error before serving anything", async () => {
    const bad: Array<[string, Question]> = [
      ["empty title", { ...question, title: "  " }],
      ["long title", { ...question, title: "t".repeat(201) }],
      ["long message", { ...question, message: "m".repeat(8001) }],
      ["no answers", { ...question, choices: [], allowText: false }],
      [
        "too many",
        {
          ...question,
          choices: Array.from({ length: 17 }, (_, i) => ({
            value: `${i}`,
            label: `${i}`,
          })),
        },
      ],
      [
        "duplicate values",
        {
          ...question,
          choices: [
            { value: "a", label: "A" },
            { value: "a", label: "B" },
          ],
        },
      ],
      ["empty label", { ...question, choices: [{ value: "a", label: " " }] }],
      ["long initial text", { ...question, initialText: "x".repeat(4001) }],
    ];
    for (const [, q] of bad) {
      const t = await start(q);
      expect(failure(await t.result)).toMatchObject({
        _tag: "InteractionError",
        kind: "invalid-question",
      });
      expect(t.urls).toEqual([]);
      expect(t.notices).toEqual([]);
      await t.close();
    }
    // A free-text-only question is valid.
    const ok = await start({ ...question, choices: [] });
    expect((await post(await ok.url, "action=text&text=hi")).status).toBe(200);
    expect(await ok.result).toEqual(Exit.succeed("hi"));
    await ok.close();
  });

  it("keeps the capability out of referrers on every page, including completion", async () => {
    const t = await start();
    const url = await t.url;
    const form = await send(url);
    const done = await post(url, "choice=0");
    for (const reply of [form, done]) {
      // same-origin, not no-referrer: Chrome sends `Origin: null` on a form
      // POST from a no-referrer page, which the exact Origin check must refuse.
      expect(reply.headers["referrer-policy"]).toBe("same-origin");
      expect(reply.headers["cache-control"]).toBe("no-store");
      expect(reply.body).toContain(
        '<meta name="referrer" content="same-origin">',
      );
      expect(reply.body).not.toMatch(/<a\s|src=|href=/i);
    }
    expect(done.body).not.toContain(new URL(url).pathname);
    await t.result;
    await t.close();
  });

  it.skipIf(!chrome)(
    "accepts a native form submission from real headless Chrome",
    async () => {
      const t = await start();
      const url = await t.url;
      const profile = mkdtempSync(join(tmpdir(), "delta-chrome-"));
      const browser = spawn(
        chrome!,
        [
          "--headless=new",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-extensions",
          "--disable-gpu",
          "--no-sandbox",
          `--user-data-dir=${profile}`,
          "--remote-debugging-port=0",
          "about:blank",
        ],
        { stdio: "ignore", detached: true },
      );
      try {
        const portFile = join(profile, "DevToolsActivePort");
        await expect
          .poll(() => existsSync(portFile), { timeout: 15_000 })
          .toBe(true);
        const port = readFileSync(portFile, "utf8").split("\n")[0];
        const targets = (await (
          await fetch(`http://127.0.0.1:${port}/json/list`)
        ).json()) as { type: string; webSocketDebuggerUrl: string }[];
        const page = targets.find((target) => target.type === "page")!;
        const socket = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve) =>
          socket.addEventListener("open", resolve, { once: true }),
        );
        let id = 0;
        const send = (method: string, params: object = {}) =>
          new Promise<unknown>((resolve) => {
            const current = ++id;
            const listener = (message: MessageEvent) => {
              const data = JSON.parse(String(message.data));
              if (data.id === current) {
                socket.removeEventListener("message", listener);
                resolve(data.result);
              }
            };
            socket.addEventListener("message", listener);
            socket.send(JSON.stringify({ id: current, method, params }));
          });
        await send("Page.enable");
        await send("Page.navigate", { url });
        await expect
          .poll(
            async () =>
              (
                (await send("Runtime.evaluate", {
                  expression:
                    "document.readyState + ':' + !!document.querySelector('button[name=choice]')",
                  returnByValue: true,
                })) as { result: { value: string } }
              ).result.value,
            { timeout: 10_000 },
          )
          .toBe("complete:true");
        // A real user-equivalent click: the browser builds the POST and its Origin.
        await send("Runtime.evaluate", {
          expression:
            "document.querySelector('button[name=choice][value=\"1\"]').click()",
        });
        expect(await t.result).toEqual(Exit.succeed("private"));
        await expect
          .poll(
            async () =>
              (
                (await send("Runtime.evaluate", {
                  expression: "document.body.innerText",
                  returnByValue: true,
                })) as { result: { value: string } }
              ).result.value,
            { timeout: 10_000 },
          )
          .toContain("Answer sent");
        socket.close();
      } finally {
        try {
          process.kill(-browser.pid!, "SIGKILL");
        } catch {}
        await new Promise((resolve) =>
          browser.exitCode !== null
            ? resolve(undefined)
            : browser.once("exit", resolve),
        );
        rmSync(profile, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
        await t.close();
      }
    },
    40_000,
  );

  it("checks Host on GET and rejects unsupported methods with a valid origin", async () => {
    const t = await start();
    const url = await t.url;
    const { origin, port } = new URL(url);
    for (const host of [
      "127.0.0.1",
      `127.0.0.1:${Number(port) + 1}`,
      `[::1]:${port}`,
      `localhost:${port}`,
    ])
      expect((await send(url, { headers: { host } })).status).toBe(421);
    for (const method of ["PUT", "DELETE", "PATCH", "OPTIONS"])
      expect(
        (
          await send(url, {
            method,
            body: "choice=0",
            headers: {
              origin,
              "content-type": "application/x-www-form-urlencoded",
            },
          })
        ).status,
      ).toBe(405);
    expect((await send(url)).status).toBe(200);
    expect((await post(url, "action=cancel")).status).toBe(200);
    expect(await t.result).toEqual(Exit.succeed(undefined));
    await t.close();
  });

  it("accepts only the field shapes the page submits", async () => {
    const t = await start();
    const url = await t.url;
    for (const body of [
      "choice=0&action=cancel",
      "choice=0&action=text&text=hi",
      "choice=0&choice=1",
      "action=cancel&action=text",
      "action=text&text=a&text=b",
      "choice=0&extra=1",
      "text=only",
      "action=submit",
      "",
    ])
      expect((await post(url, body)).status, body).toBe(400);
    expect((await send(url)).status).toBe(200);
    expect((await post(url, "action=cancel&text=draft")).status).toBe(200);
    expect(await t.result).toEqual(Exit.succeed(undefined));
    await t.close();

    const choicesOnly = await start({ ...question, allowText: false });
    const curl = await choicesOnly.url;
    expect((await post(curl, "choice=0&text=smuggled")).status).toBe(400);
    expect((await post(curl, "choice=1")).status).toBe(200);
    expect(await choicesOnly.result).toEqual(Exit.succeed("private"));
    await choicesOnly.close();
  });

  it("opens links with fixed system helpers and literal argv, never a shell", () => {
    const url = "http://127.0.0.1:1/q/x;rm -rf ~";
    expect(openerArgv("darwin", url, {})).toEqual(["/usr/bin/open", url]);
    expect(openerArgv("linux", url, {})).toEqual(["xdg-open", url]);
    expect(openerArgv("win32", url, { SystemRoot: "C:\\Windows" })).toEqual([
      "C:\\Windows\\System32\\rundll32.exe",
      "url.dll,FileProtocolHandler",
      url,
    ]);
    for (const SystemRoot of [
      undefined,
      "",
      "Windows",
      "\\Windows",
      "C:Windows",
      "\\\\host\\share",
      "C:\\Win\ndows",
      'C:\\W"',
    ])
      expect(
        openerArgv(
          "win32",
          url,
          SystemRoot === undefined ? {} : { SystemRoot },
        ),
      ).toBeUndefined();
  });

  it("reports an unresolvable Windows helper as not opened without spawning", async () => {
    const spawned: unknown[] = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => spawned.push(command)).pipe(
        Effect.andThen(Effect.never),
      ),
    );
    expect(
      await Effect.runPromise(
        nativeOpener(spawner, "win32", { SystemRoot: "Windows" })("http://x"),
      ),
    ).toBe(false);
    expect(spawned).toEqual([]);
  });
});
