import { createHash } from "node:crypto";
import type { Question } from "../session.js";

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] ?? c,
  );

const style = `body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#1d1d1f;background:#fff}
h1{font-size:1.3rem}.m{white-space:pre-wrap}.c{color:#666;font-size:.85rem;overflow-wrap:anywhere}
.n{padding:.5rem .75rem;border-left:3px solid #c33;background:#fdf2f2}
form{display:flex;flex-direction:column;gap:.6rem}button{font:inherit;padding:.6rem;border-radius:6px;border:1px solid #888;background:#f4f4f6;cursor:pointer;text-align:left}
button.p{background:#1d4ed8;color:#fff;border-color:#1d4ed8}textarea{font:inherit;padding:.5rem;min-height:5rem}
@media (prefers-color-scheme:dark){body{background:#161618;color:#eee}button{background:#2a2a2e;color:#eee}textarea{background:#202024;color:#eee}.n{background:#3a1d1d}}`;

/** No script is served; the inline stylesheet is pinned by hash. */
export const securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy": `default-src 'none'; style-src 'sha256-${createHash("sha256").update(style).digest("base64")}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

const document = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="same-origin"><title>${escape(title)}</title><style>${style}</style></head><body>${body}</body></html>`;

export interface FormContext {
  readonly action: string;
  readonly cwd: string;
  readonly notice?: string;
  readonly text?: string;
}

export const questionPage = (question: Question, context: FormContext) => {
  const choices = question.choices
    .map(
      (choice, index) =>
        `<button type="submit" name="choice" value="${index}"${index === 0 ? ' class="p"' : ""}>${escape(choice.label)}</button>`,
    )
    .join("");
  const text = question.allowText
    ? `<label for="t">Or type an answer</label><textarea id="t" name="text" maxlength="4000">${escape(context.text ?? question.initialText ?? "")}</textarea><button type="submit" name="action" value="text">Submit text</button>`
    : "";
  return document(
    question.title,
    `<h1>${escape(question.title)}</h1><p class="m">${escape(question.message)}</p>${context.notice ? `<p class="n" role="alert">${escape(context.notice)}</p>` : ""}<form method="post" action="${escape(context.action)}" enctype="application/x-www-form-urlencoded">${choices}${text}<button type="submit" name="action" value="cancel">Cancel</button></form><p class="c">Asked by Letta Code in ${escape(context.cwd)}. This page works once and only on this computer.</p>`,
  );
};

export const statusPage = (title: string, message: string) =>
  document(
    title,
    `<h1>${escape(title)}</h1><p class="m">${escape(message)}</p>`,
  );
