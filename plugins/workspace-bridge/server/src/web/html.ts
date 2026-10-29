// Escaping `html` tagged template, page shell and security headers (ARCHITECTURE s.2).

import { BASE_CSS } from "./style";
import { assetUrl, getTheme, themeCss } from "./theme";

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

/** Markup that is already safe; only `html` and `raw` create it. */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export type HtmlValue = SafeHtml | string | number | boolean | null | undefined | HtmlValue[];

/** Trusted markup, never user input. */
export const raw = (markup: string): SafeHtml => new SafeHtml(markup);

/**
 * Escapes every interpolated string or number. `SafeHtml` passes through, arrays are joined,
 * and `null`, `undefined` and booleans render nothing, so `cond && html\`...\`` works.
 */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let out = strings[0] ?? "";
  values.forEach((v, i) => {
    out += render(v) + (strings[i + 1] ?? "");
  });
  return new SafeHtml(out);
}

function render(v: HtmlValue): string {
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  if (v === null || v === undefined || typeof v === "boolean") return "";
  return escapeHtml(String(v));
}

export type NavPage = "accounts" | "audit";

export interface PageOptions {
  /** Show the owner navigation in the header; the value marks the current page. */
  nav?: NavPage | "other";
}

function brand(): SafeHtml {
  const theme = getTheme();
  const name = theme.name === "" ? "workspace-bridge" : theme.name;
  if (!Object.hasOwn(theme.assets, "logo.svg")) {
    return html`<a class="brand" href="/"><span class="brand-mark" aria-hidden="true"></span><span class="brand-name">${name}</span></a>`;
  }
  const dark = Object.hasOwn(theme.assets, "logo-dark.svg")
    ? html`<source media="(prefers-color-scheme: dark)" srcset="${assetUrl("logo-dark.svg")}">`
    : "";
  return html`<a class="brand" href="/"><picture>${dark}<img class="brand-logo" src="${assetUrl("logo.svg")}" alt=""></picture><span class="brand-name">${name}</span></a>`;
}

function nav(current: PageOptions["nav"]): SafeHtml | "" {
  if (current === undefined) return "";
  const link = (target: NavPage, href: string, label: string) =>
    html`<a href="${href}"${current === target ? raw(' aria-current="page"') : ""}>${label}</a>`;
  return html`<nav class="site-nav" aria-label="Owner pages">${link("accounts", "/accounts", "Accounts")}${link("audit", "/accounts/audit", "Audit log")}</nav>`;
}

/** A complete HTML document: the shared layout, the base sheet, then the theme's CSS. */
export function page(title: string, body: SafeHtml, options: PageOptions = {}): SafeHtml {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<style>${raw(BASE_CSS)}</style>
<style>${raw(themeCss())}</style>
</head>
<body>
<header class="site-header"><div class="site-header-inner">${brand()}${nav(options.nav)}</div></header>
<main>${body}</main>
</body>
</html>`;
}

export function htmlResponse(doc: SafeHtml, status = 200): Response {
  return new Response(doc.value, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * Security headers for every page, Hono or not. No `form-action`: browsers apply it to the
 * redirect that follows the consent POST, which goes to the client's own redirect URI.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000",
  "Cross-Origin-Opener-Policy": "same-origin",
};

/** Copies the response (redirect headers are immutable) and adds any header not already set. */
export function withSecurityHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!out.headers.has(name)) out.headers.set(name, value);
  }
  return out;
}
