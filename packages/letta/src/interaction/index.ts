import { NodeHttpServer } from "@effect/platform-node";
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as Http from "node:http";
import { ByteSize, Deferred, Duration, Effect, Scope } from "effect";
import {
  HttpIncomingMessage,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import {
  type Interaction,
  InteractionError,
  type Question,
  type Session,
} from "../session.js";
import { nativeOpener } from "./opener.js";
import { questionPage, securityHeaders, statusPage } from "./page.js";

export interface InteractionOptions {
  /** Opens a link in the operator's browser; defaults to the scoped native opener. */
  readonly open?: (url: string) => Effect.Effect<boolean>;
  /** How long a question waits before it is treated as dismissed. */
  readonly timeout?: Duration.Input;
}

export const DEFAULT_TIMEOUT = Duration.minutes(15);
export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_TEXT_LENGTH = 4000;
const MAX_CHOICES = 16;
const DRAIN_GRACE = Duration.seconds(2);

type Outcome =
  | { readonly kind: "answer"; readonly value: string }
  | { readonly kind: "cancel" };

const fail = (kind: InteractionError["kind"], message: string) =>
  new InteractionError({ kind, message });

const invalidQuestion = (question: Question): string | undefined => {
  if (!question.title.trim() || question.title.length > 200)
    return "title must be 1-200 characters";
  if (question.message.length > 8000) return "message is too long";
  if (question.choices.length > MAX_CHOICES) return "too many choices";
  if (question.choices.length === 0 && !question.allowText)
    return "a question needs choices or free text";
  if (
    new Set(question.choices.map((c) => c.value)).size !==
    question.choices.length
  )
    return "choice values must be unique";
  if (question.choices.some((c) => !c.label.trim() || c.label.length > 200))
    return "choice labels must be 1-200 characters";
  if ((question.initialText?.length ?? 0) > MAX_TEXT_LENGTH)
    return "initial text is too long";
  return undefined;
};

const sameSecret = (candidate: string, secret: string) => {
  const a = Buffer.from(candidate);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
};

const page = (
  status: number,
  body: string,
  extra: Record<string, string> = {},
) =>
  HttpServerResponse.text(body, {
    status,
    contentType: "text/html; charset=utf-8",
    headers: { ...securityHeaders, ...extra },
  });

const reject = (status: number, message: string) =>
  page(status, statusPage("Delta question", message));

interface Pending {
  readonly question: Question;
  readonly session: Session;
  readonly path: string;
  readonly origin: string;
  readonly host: string;
  readonly outcome: Deferred.Deferred<Outcome>;
}

const decodeForm = (bytes: ArrayBuffer) => {
  try {
    return new URLSearchParams(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    return undefined;
  }
};

const submit = (
  pending: Pending,
  request: HttpServerRequest.HttpServerRequest,
) =>
  Effect.gen(function* () {
    const headers = request.headers;
    if (headers.origin !== pending.origin)
      return reject(403, "This answer did not come from the question page.");
    const site = headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin")
      return reject(403, "This answer did not come from the question page.");
    if (
      (headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() !==
      "application/x-www-form-urlencoded"
    )
      return reject(415, "Unsupported answer format.");
    if (Number(headers["content-length"] ?? 0) > MAX_BODY_BYTES)
      return reject(413, "The answer is too large.");
    const bytes = yield* request.arrayBuffer.pipe(
      Effect.provideService(
        HttpIncomingMessage.MaxBodySize,
        ByteSize.bytes(MAX_BODY_BYTES),
      ),
      Effect.option,
    );
    if (bytes._tag === "None") return reject(413, "The answer is too large.");
    const form = decodeForm(bytes.value);
    if (!form) return reject(400, "The answer could not be read.");
    const retry = (notice: string, text?: string) =>
      page(
        422,
        questionPage(pending.question, {
          action: pending.path,
          cwd: pending.session.cwd,
          notice,
          ...(text === undefined ? {} : { text }),
        }),
      );
    // Only the shapes the page itself submits: one choice button, or one
    // action button, each with at most the page's own text field.
    const keys = [...form.keys()];
    const allowed = new Set(
      pending.question.allowText
        ? ["choice", "action", "text"]
        : ["choice", "action"],
    );
    if (
      new Set(keys).size !== keys.length ||
      keys.some((key) => !allowed.has(key)) ||
      form.has("choice") === form.has("action")
    )
      return reject(400, "The answer could not be read.");
    const choice = form.get("choice");
    const action = form.get("action");
    let outcome: Outcome;
    if (choice !== null) {
      const selected = /^\d{1,2}$/.test(choice)
        ? pending.question.choices[Number(choice)]
        : undefined;
      if (!selected) return reject(400, "That choice is not offered.");
      outcome = { kind: "answer", value: selected.value };
    } else if (action === "cancel") outcome = { kind: "cancel" };
    else if (action === "text" && pending.question.allowText) {
      const text = (form.get("text") ?? "").trim();
      if (text.length > MAX_TEXT_LENGTH)
        return retry(
          `Answers are limited to ${MAX_TEXT_LENGTH} characters.`,
          text.slice(0, MAX_TEXT_LENGTH),
        );
      if (!text) return retry("Type an answer or choose an option.");
      outcome = { kind: "answer", value: text };
    } else return reject(400, "The answer could not be read.");
    // Exactly one submission wins; later or concurrent ones see a closed question.
    if (!(yield* Deferred.succeed(pending.outcome, outcome)))
      return reject(409, "This question was already answered.");
    return page(
      200,
      outcome.kind === "cancel"
        ? statusPage("Cancelled", "Nothing was chosen. You can close this tab.")
        : statusPage(
            "Answer sent",
            "Return to Letta Code. You can close this tab.",
          ),
      { connection: "close" },
    );
  });

const handler = (pending: Pending) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    // A rebinding name or proxy cannot reuse the capability: only the literal loopback host.
    if (request.headers.host !== pending.host)
      return reject(421, "Open the link exactly as Letta Code showed it.");
    const url = request.url;
    const path = url.split("?")[0] ?? "";
    if (!sameSecret(path, pending.path))
      return reject(404, "This question link is not valid.");
    if (yield* Deferred.isDone(pending.outcome))
      return reject(410, "This question is closed.");
    if (request.method === "GET")
      return page(
        200,
        questionPage(pending.question, {
          action: pending.path,
          cwd: pending.session.cwd,
        }),
      );
    if (request.method === "POST") return yield* submit(pending, request);
    return reject(405, "Method not allowed.");
  }).pipe(
    Effect.catchCause(() =>
      Effect.succeed(reject(500, "Something went wrong.")),
    ),
  );

const aborted = (signal: AbortSignal) =>
  Effect.callback<never, InteractionError>((resume) => {
    const onAbort = () =>
      resume(
        Effect.fail(
          fail(
            "closed",
            "The Letta session ended before the question was answered.",
          ),
        ),
      );
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });

/**
 * Starts nothing until `ask`; each question gets its own loopback server and
 * capability, which close when the answer is delivered or the question ends.
 */
export function makeInteraction(
  options: InteractionOptions & {
    readonly open: NonNullable<InteractionOptions["open"]>;
  },
): Effect.Effect<Interaction, never, Scope.Scope>;
export function makeInteraction(
  options?: InteractionOptions,
): Effect.Effect<
  Interaction,
  never,
  Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
>;
export function makeInteraction(options: InteractionOptions = {}) {
  return Effect.gen(function* () {
    const open =
      options.open ??
      nativeOpener(yield* ChildProcessSpawner.ChildProcessSpawner);
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    const closed = yield* Deferred.make<void>();
    yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
    const waiting = new Set<string>();

    const ask = (session: Session, question: Question) =>
      Effect.scoped(
        Effect.gen(function* () {
          if (!session.interactive)
            return yield* fail(
              "unavailable",
              "Delta needs an interactive Letta Code session to ask this question.",
            );
          if (yield* Deferred.isDone(closed))
            return yield* fail("closed", "The Delta mod is closed.");
          if (session.signal.aborted)
            return yield* fail(
              "closed",
              "The Letta session ended before the question was asked.",
            );
          const invalid = invalidQuestion(question);
          if (invalid)
            return yield* fail(
              "invalid-question",
              `Invalid Delta question: ${invalid}`,
            );
          const key = JSON.stringify([session.agentId, session.conversationId]);
          if (waiting.has(key))
            return yield* fail(
              "unavailable",
              "Another Delta question is already waiting in this conversation; answer or cancel it first.",
            );
          waiting.add(key);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => waiting.delete(key)),
          );

          const node = Http.createServer({
            requestTimeout: 30_000,
            headersTimeout: 10_000,
            keepAliveTimeout: 1_000,
            maxHeaderSize: 8 * 1024,
          });
          const server = yield* NodeHttpServer.make(() => node, {
            host: "127.0.0.1",
            port: 0,
            gracefulShutdownTimeout: DRAIN_GRACE,
          }).pipe(
            Effect.mapError(() =>
              fail("io", "Could not start the local question page."),
            ),
          );
          if (server.address._tag === "UnixPathAddress")
            return yield* fail(
              "io",
              "Could not start the local question page.",
            );
          const host = `127.0.0.1:${server.address.port}`;
          const pending: Pending = {
            question,
            session,
            path: `/q/${randomBytes(32).toString("base64url")}`,
            origin: `http://${host}`,
            host,
            outcome: yield* Deferred.make<Outcome>(),
          };
          yield* server.serve(handler(pending));
          // Registered last so it runs first: in-flight responses (the answer's
          // confirmation) get a bounded chance to finish before sockets are cut.
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(pending.outcome, { kind: "cancel" }).pipe(
              Effect.andThen(
                Effect.callback<void>((resume) => {
                  node.close(() => resume(Effect.void));
                  node.closeIdleConnections();
                }).pipe(
                  Effect.timeoutOrElse({
                    duration: DRAIN_GRACE,
                    orElse: () => Effect.void,
                  }),
                  Effect.ensuring(
                    Effect.sync(() => node.closeAllConnections()),
                  ),
                ),
              ),
            ),
          );
          const url = `${pending.origin}${pending.path}`;
          const notify = (message: string) =>
            Effect.sync(() => session.notify(message)).pipe(Effect.ignore);
          yield* notify(
            `Delta question “${question.title}” is waiting in your browser: ${url}`,
          );
          yield* Effect.forkScoped(
            open(url).pipe(
              Effect.flatMap((opened) =>
                opened
                  ? Effect.void
                  : notify(
                      `Could not open a browser automatically. Open ${url} on this computer to answer.`,
                    ),
              ),
            ),
          );
          const outcome = yield* Deferred.await(pending.outcome).pipe(
            Effect.raceFirst(aborted(session.signal)),
            Effect.raceFirst(
              Effect.andThen(
                Deferred.await(closed),
                Effect.fail(
                  fail(
                    "closed",
                    "The Delta mod closed before the question was answered.",
                  ),
                ),
              ),
            ),
            Effect.timeoutOrElse({
              duration: timeout,
              orElse: () =>
                notify(
                  `Delta question “${question.title}” expired without an answer.`,
                ).pipe(Effect.as<Outcome>({ kind: "cancel" })),
            }),
          );
          return outcome.kind === "answer" ? outcome.value : undefined;
        }),
      );

    return { ask } satisfies Interaction as Interaction;
  });
}

export type { Interaction, Question, Session } from "../session.js";
export { InteractionError } from "../session.js";
