// Escaping `html` tagged template, page shell and security headers (ARCHITECTURE s.2).

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

const STYLE = raw(
  "body{font:16px/1.5 system-ui,sans-serif;margin:0;color:#1a1a1a;background:#fafafa}" +
    "main{max-width:42rem;margin:0 auto;padding:2rem 1rem}h1{font-size:1.6rem}" +
    "h2{font-size:1.15rem;margin-top:1.75rem}code{font-size:.9em}a{color:#0b57d0}",
);

/** A complete HTML document. */
export function page(title: string, body: SafeHtml): SafeHtml {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
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
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'",
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
