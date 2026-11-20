/// <reference types="vite/client" />

// The approvals page shows a held email as it will arrive: the stored view (core/held-view.ts), the
// HTML sanitizer (web/sanitize-html.ts), the preview markup (web/preview-views.ts) and the page
// itself through the guardrails routes. Also the shared layout: every HTML page comes from `page()`.
// Google is the route-table fake. All addresses are placeholders.

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCOPES } from "../src/auth/endpoints";
import { mcpHandler } from "../src/auth/mcp-factory";
import { createSession, SESSION_COOKIE } from "../src/auth/session";
import {
  buildHeldMailView,
  clip,
  clipHtml,
  MAX_VIEW_HTML,
  MAX_VIEW_TEXT,
  parseHeldView,
  VIEW_KEY,
  withoutView,
  withView,
} from "../src/core/held-view";
import type { Env } from "../src/env";
import { compileRegistry } from "../src/registry/compile";
import { FAMILIES } from "../src/tools";
import { app } from "../src/web/app";
import { guardrailsRoutes } from "../src/web/guardrails";
import {
  APPROVAL_PAGE_CSP,
  fileTypeLabel,
  mailPreviewView,
  PREVIEW_FRAME_CSP,
  previewDocument,
  previewFactRows,
} from "../src/web/preview-views";
import { safeHref, sanitizeCss, sanitizeEmailHtml } from "../src/web/sanitize-html";
import { BASE_CSS } from "../src/web/style";
import fx from "./fixtures/google/mail-send.json";
import {
  type GoogleRoute,
  googleJson,
  installGoogleRoutes,
  linkGoogleAccount,
  newOwner,
} from "./helpers/google";
import { ISSUER, mcpRequest, parseMcp, toolJson } from "./helpers/mcp";

const registry = compileRegistry(FAMILIES);

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const MESSAGE = `${BASE}/messages/m_orig`;

afterEach(() => {
  vi.restoreAllMocks();
});

// biome-ignore lint/suspicious/noExplicitAny: the JSON a tool answered, read loosely by the tests
type Json = any;

const HOLD_ALL = (): Env =>
  ({
    ...env,
    SEND_ENABLED: "true",
    SEND_REQUIRES_CONFIRM: "true",
    SEND_APPROVAL_MODE: undefined,
  }) as Env;

// ---- The sanitizer -------------------------------------------------------------------------------

describe("sanitizeEmailHtml", () => {
  const clean = (markup: string) => sanitizeEmailHtml(markup);

  it("keeps ordinary formatting", async () => {
    const out = await clean(
      '<p style="color:#123456">Hello <b>there</b></p><table><tr><td>cell</td></tr></table><blockquote>q</blockquote>',
    );
    expect(out).toContain("<p");
    expect(out).toContain("color:#123456");
    expect(out).toContain("<b>there</b>");
    expect(out).toContain("<td>cell</td>");
    expect(out).toContain("<blockquote>q</blockquote>");
  });

  it("drops script elements with their content", async () => {
    const out = await clean(
      "<p>a</p><script>alert(1)</script><SCRIPT src=//evil.example/x.js></SCRIPT><p>b</p>",
    );
    expect(out).not.toMatch(/script/i);
    expect(out).not.toContain("alert");
    expect(out).toContain("<p>a</p>");
    expect(out).toContain("<p>b</p>");
  });

  it("removes event handler attributes", async () => {
    const out = await clean(
      '<p onclick="x()" onmouseover=y()>t</p><b onerror="z()">u</b><img src="https://evil.example/a.png" onerror="alert(1)">',
    );
    expect(out).not.toMatch(/\son[a-z]+\s*=/i);
    expect(out).not.toContain("alert");
    expect(out).toContain("<p>t</p>");
  });

  it("removes javascript: links, whatever the casing or hidden characters", async () => {
    const out = await clean(
      [
        '<a href="javascript:alert(1)">a</a>',
        '<a href="JaVaScRiPt:alert(2)">b</a>',
        '<a href="java\tscript:alert(3)">c</a>',
        '<a href=" &#14;javascript:alert(4)">d</a>',
        '<a href="data:text/html,<script>alert(5)</script>">e</a>',
        '<a href="vbscript:x">f</a>',
      ].join(""),
    );
    expect(out).not.toMatch(/javascript:/i);
    expect(out).not.toContain("alert");
    expect(out).not.toMatch(/href=["']?(?:data|vbscript)/i);
    expect(out).not.toMatch(/href/i);
  });

  it("keeps http, https, mailto and tel links, but never makes them live in a new context", async () => {
    const out = await clean(
      '<a href="https://example.org/x">a</a><a href="mailto:a@example.org">b</a><a href="tel:+100">c</a>',
    );
    expect(out).toContain('href="https://example.org/x"');
    expect(out).toContain('href="mailto:a@example.org"');
    expect(out).toContain('href="tel:+100"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it("replaces a remote image with a placeholder and keeps an inline one", async () => {
    const out = await clean(
      '<img src="https://tracker.example/p.gif" alt="logo"><img src="//tracker.example/q.gif"><img srcset="https://tracker.example/r.gif 2x" src="x.gif"><img src="data:image/png;base64,iVBORw0KGgo=" alt="ok">',
    );
    expect(out).not.toContain("tracker.example");
    expect(out).not.toContain("srcset");
    expect(out).not.toContain("x.gif");
    expect(out).toContain("[image: logo]");
    expect(out).toContain('src="data:image/png;base64,iVBORw0KGgo="');
  });

  it("refuses an svg data image and a data image with a hostile body", async () => {
    const out = await clean(
      '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="><img src="data:image/png;base64,AAA&quot; onerror=&quot;x">',
    );
    expect(out).not.toContain("svg+xml");
    expect(out).not.toMatch(/onerror/i);
  });

  it("takes url() and @import out of style attributes and style blocks", async () => {
    const out = await clean(
      [
        '<div style="background:url(https://tracker.example/a.png);color:red">a</div>',
        '<div style="background: URL( &quot;https://tracker.example/b.png&quot; )">b</div>',
        '<div style="background:u\\rl(https://tracker.example/c.png)">c</div>',
        "<style>@import url(https://tracker.example/d.css); @import 'https://tracker.example/e.css'; p{background:url(//tracker.example/f.png);color:blue}</style>",
        "<div style=\"background:image-set('https://tracker.example/g.png' 1x)\">g</div>",
        '<div style="width:expression(alert(1))">h</div>',
        '<div style="behavior:url(x.htc);-moz-binding:url(x)">i</div>',
      ].join(""),
    );
    expect(out).not.toContain("tracker.example");
    expect(out).not.toMatch(/@import/i);
    expect(out).not.toMatch(/url\s*\(/i);
    expect(out).not.toMatch(/expression/i);
    expect(out).not.toMatch(/behavior|-moz-binding/i);
    expect(out).toContain("color:red");
    expect(out).toContain("color:blue");
  });

  it("cannot be closed out of a style block", async () => {
    const out = await clean(
      "<style>p{color:red}</style><script>alert(1)</script><style>q{}</sty<!-- -->le>",
    );
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toContain("alert");
  });

  it("drops iframe, object, embed, link, meta, base, svg and media with their content", async () => {
    const out = await clean(
      [
        '<iframe src="https://evil.example/f">inside-iframe</iframe>',
        '<object data="https://evil.example/o">inside-object</object>',
        '<embed src="https://evil.example/e">',
        '<link rel="stylesheet" href="https://evil.example/s.css">',
        '<meta http-equiv="refresh" content="0;url=https://evil.example/m">',
        '<base href="https://evil.example/">',
        '<svg onload="alert(1)"><script>alert(2)</script></svg>',
        '<video src="https://evil.example/v"></video><audio src="https://evil.example/a"></audio>',
        "<p>kept</p>",
      ].join(""),
    );
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("inside-");
    expect(out).not.toMatch(/<(?:iframe|object|embed|link|meta|base|svg|video|audio)/i);
    expect(out).toContain("<p>kept</p>");
  });

  it("drops a form and its controls but keeps the text around them", async () => {
    const out = await clean(
      '<form action="https://evil.example/post" method="post">Name <input name="n" value="v"><button>Go</button><select><option>o</option></select><textarea>t</textarea></form><p>after</p>',
    );
    expect(out).not.toMatch(/<(?:form|input|button|select|option|textarea)/i);
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("action=");
    expect(out).toContain("Name");
    expect(out).toContain("<p>after</p>");
  });

  it("removes comments, doctype, html, head and body wrappers", async () => {
    const out = await clean(
      "<!doctype html><html><head><title>t</title></head><body><!-- c --><p>x</p></body></html>",
    );
    expect(out).not.toMatch(/doctype|<html|<head|<body|<title|<!--/i);
    expect(out).toContain("<p>x</p>");
  });

  it("removes attributes that are not on the list", async () => {
    const out = await clean(
      '<p id="i" data-x="1" formaction="x" srcdoc="y" background="https://evil.example/b" class="k" align="center">t</p>',
    );
    expect(out).not.toMatch(/\sid=|data-x|formaction|srcdoc|background=|evil/i);
    expect(out).toContain('class="k"');
    expect(out).toContain('align="center"');
  });

  it("does not throw on broken markup", async () => {
    await expect(clean("<p><b>unclosed <a href=")).resolves.toBeTypeOf("string");
    await expect(clean("")).resolves.toBe("");
    await expect(clean("<<<>>>&&&")).resolves.toBeTypeOf("string");
  });
});

describe("safeHref and sanitizeCss", () => {
  it("accepts only four schemes", () => {
    expect(safeHref("https://example.org")).toBe("https://example.org");
    expect(safeHref("  mailto:a@example.org ")).toBe("mailto:a@example.org");
    expect(safeHref("javascript:alert(1)")).toBeUndefined();
    expect(safeHref("java\u200bscript:alert(1)")).toBeUndefined();
    expect(safeHref("/relative")).toBeUndefined();
    expect(safeHref("//evil.example")).toBeUndefined();
    expect(safeHref("data:text/html,x")).toBeUndefined();
  });

  it("removes loads and escapes from CSS", () => {
    expect(sanitizeCss("a{background:url(x)}")).not.toMatch(/url/i);
    expect(sanitizeCss("@import url(x);a{}")).not.toMatch(/import/i);
    expect(sanitizeCss("a{b:\\75rl(x)}")).not.toMatch(/url/i);
    expect(sanitizeCss("a{b:u/**/rl(x)}")).not.toMatch(/url/i);
    expect(sanitizeCss("p{color:red}")).toBe("p{color:red}");
  });
});

// ---- The stored view -----------------------------------------------------------------------------

describe("the held view", () => {
  const input = {
    action: "send" as const,
    from: "Work <work@example.com>",
    to: ["to@example.org"],
    cc: [],
    bcc: [],
    subject: "Hello",
    body: "text",
  };

  it("round-trips through the stored preview and is stripped for a client", () => {
    const view = buildHeldMailView({
      ...input,
      html: "<p>x</p>",
      files: [{ name: "a.txt", type: "text/plain", bytes: 3 }],
    });
    const stored = withView({ to: ["to@example.org"] }, view);
    const json = JSON.stringify(stored);
    expect(parseHeldView(json)).toEqual(view);
    expect(Object.hasOwn(withoutView(stored) as object, VIEW_KEY)).toBe(false);
    expect(withoutView({ to: ["a"] })).toEqual({ to: ["a"] });
    expect(withoutView(null)).toBeNull();
  });

  it("caps the stored body and html and names what was cut", () => {
    const view = buildHeldMailView({
      ...input,
      body: "x".repeat(MAX_VIEW_TEXT + 10),
      html: `<p>${"y".repeat(MAX_VIEW_HTML + 10)}</p>`,
      quote: { plain: "q".repeat(30_000), html: "" },
    });
    expect(view.body).toHaveLength(MAX_VIEW_TEXT);
    expect(view.html?.length).toBeLessThanOrEqual(MAX_VIEW_HTML);
    expect(view.truncated).toEqual(["body", "html", "quote"]);
  });

  it("cuts markup before an unfinished tag and text between surrogate halves", () => {
    expect(clipHtml("<p>abc</p><a href", 14).text).toBe("<p>abc</p>");
    expect(clip("ab\u{1f600}", 3).text).toBe("ab");
    expect(clip("abc", 3)).toEqual({ text: "abc", cut: false });
  });

  it("drops a view that is far too large, keeping the summary", () => {
    const big = { to: ["a"] };
    const view = { v: 1, kind: "mail", filler: "z".repeat(500_000) };
    expect(withView(big, view)).toBe(big);
  });

  it("reads nothing from a preview that has no view or a malformed one", () => {
    expect(parseHeldView("null")).toBeUndefined();
    expect(parseHeldView("{}")).toBeUndefined();
    expect(parseHeldView("not json")).toBeUndefined();
    expect(
      parseHeldView(JSON.stringify({ [VIEW_KEY]: { v: 1, kind: "mail", from: 1 } })),
    ).toBeUndefined();
    expect(parseHeldView(JSON.stringify({ [VIEW_KEY]: "x" }))).toBeUndefined();
  });
});

// ---- The preview markup --------------------------------------------------------------------------

describe("mailPreviewView", () => {
  const base = buildHeldMailView({
    action: "send",
    from: "Work <work@example.com>",
    to: ["to@example.org"],
    cc: ["cc@example.org"],
    bcc: ["bcc@example.org"],
    subject: "Quarterly numbers",
    body: "Line one\nLine two",
    files: [{ name: "plan.pdf", type: "application/pdf", bytes: 2048 }],
  });
  const render = (over: Partial<Parameters<typeof mailPreviewView>[0]> = {}) =>
    mailPreviewView({ view: base, safeHtml: undefined, safeQuoteHtml: undefined, ...over }).value;

  it("draws the header block, the files and the plain body", () => {
    const out = render();
    expect(out).toContain("<dt>From</dt><dd>Work &lt;work@example.com&gt;</dd>");
    expect(out).toContain("<dt>To</dt><dd>to@example.org</dd>");
    expect(out).toContain("<dt>Cc</dt><dd>cc@example.org</dd>");
    expect(out).toContain("<dt>Bcc</dt><dd>bcc@example.org</dd>");
    expect(out).toContain("Quarterly numbers");
    expect(out).toContain("plan.pdf");
    expect(out).toContain("2.0 KB");
    expect(out).toContain('<div class="mail-text">Line one\nLine two</div>');
    expect(out).not.toContain("<iframe");
  });

  it("lists several recipients", () => {
    const view = buildHeldMailView({
      ...base,
      to: ["a@example.org", "b@example.org"],
      cc: [],
      bcc: [],
      from: "w@example.com",
      subject: "s",
      body: "b",
      action: "send",
    });
    const out = mailPreviewView({ view, safeHtml: undefined, safeQuoteHtml: undefined }).value;
    expect(out).toContain("<li>a@example.org</li><li>b@example.org</li>");
    expect(out).not.toContain("<dt>Cc</dt>");
    expect(out).not.toContain("<dt>Bcc</dt>");
  });

  it("shows HTML only in a sandboxed srcdoc frame with its own CSP", () => {
    const out = render({ safeHtml: "<p>Hi <b>there</b></p>" });
    expect(out).toContain('<iframe class="mail-frame" sandbox=""');
    expect(out).toContain('referrerpolicy="no-referrer"');
    const srcdoc = /srcdoc="([^"]*)"/.exec(out)?.[1] ?? "";
    expect(srcdoc).not.toContain('"');
    const doc = srcdoc
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
    expect(doc).toContain("<p>Hi <b>there</b></p>");
    expect(doc).toContain(`http-equiv="Content-Security-Policy" content="${PREVIEW_FRAME_CSP}"`);
    // The plain body is not repeated beside the frame.
    expect(out).not.toContain("Line one");
  });

  it("never lets sanitized HTML break out of the srcdoc attribute", () => {
    const out = render({ safeHtml: '"><script>alert(1)</script><p title="x' });
    expect(out).not.toContain("<script>");
    expect(out.match(/srcdoc="/g)).toHaveLength(1);
  });

  it("puts the quoted original of a reply under the message", () => {
    const view = buildHeldMailView({
      ...base,
      action: "reply",
      quote: { plain: "> orig line", html: "" },
    });
    const text = mailPreviewView({ view, safeHtml: undefined, safeQuoteHtml: undefined }).value;
    expect(text).toContain("The reply as it will arrive");
    expect(text).toContain('<div class="mail-text mail-quote">&gt; orig line</div>');
    const withHtml = mailPreviewView({
      view,
      safeHtml: "<p>mine</p>",
      safeQuoteHtml: "<p>theirs</p>",
    }).value;
    const doc = /srcdoc="([^"]*)"/.exec(withHtml)?.[1] ?? "";
    expect(doc).toContain("mine");
    expect(doc).toContain("theirs");
    expect(doc.indexOf("mine")).toBeLessThan(doc.indexOf("theirs"));
  });

  it("names a forward, its carried files and an unreadable original", () => {
    const view = buildHeldMailView({
      ...base,
      action: "forward",
      files: [{ name: "orig.docx", type: "", bytes: 10, carried: true }],
      quoteUnavailable: true,
    });
    const out = mailPreviewView({ view, safeHtml: undefined, safeQuoteHtml: undefined }).value;
    expect(out).toContain("The forward as it will arrive");
    expect(out).toContain("orig.docx");
    expect(out).toContain("from the original message");
    expect(out).toContain("could not be read for this preview");
  });

  it("shows a held draft's file count, and a body that could not be read", () => {
    const view = buildHeldMailView({
      ...base,
      body: "",
      files: [],
      fileCount: 2,
      fileBytes: 5000,
      bodyUnavailable: true,
    });
    const out = mailPreviewView({ view, safeHtml: undefined, safeQuoteHtml: undefined }).value;
    expect(out).toContain("2 files, about 4.9 KB");
    expect(out).toContain("could not be read here");
  });

  it("says when the stored message was cut", () => {
    const view = buildHeldMailView({ ...base, body: "x".repeat(MAX_VIEW_TEXT + 1) });
    const out = mailPreviewView({ view, safeHtml: undefined, safeQuoteHtml: undefined }).value;
    expect(out).toContain("Shortened here.");
    expect(out).toContain("start of the text");
  });

  it("escapes hostile header values, file names and body text", () => {
    const evil = '<script>alert("x")</script>';
    const view = buildHeldMailView({
      action: "send",
      from: `${evil} <a@example.com>`,
      to: [`"${evil}" <b@example.org>`],
      cc: [evil],
      bcc: [evil],
      subject: `${evil}<img src=x onerror=alert(1)>`,
      body: `${evil}\n<b>bold</b>`,
      files: [{ name: `${evil}.txt`, type: evil, bytes: 1 }],
    });
    const out = mailPreviewView({ view, safeHtml: undefined, safeQuoteHtml: undefined }).value;
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<b>bold");
    expect(out).toContain("&lt;script&gt;");
  });

  it("previewDocument carries the no-load CSP and a light colour scheme", () => {
    const doc = previewDocument("<p>x</p>");
    expect(doc).toContain(PREVIEW_FRAME_CSP);
    expect(PREVIEW_FRAME_CSP).toContain("default-src 'none'");
    expect(PREVIEW_FRAME_CSP).toContain("img-src data:");
    expect(PREVIEW_FRAME_CSP).not.toMatch(/https?:|\*/);
    expect(doc).toContain('<meta name="color-scheme" content="light">');
  });

  it("labels a long MIME type briefly and keeps the full type in the tooltip", () => {
    const xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    expect(fileTypeLabel(xlsx, "numbers.xlsx")).toBe("Excel");
    expect(fileTypeLabel("application/pdf", "plan.pdf")).toBe("PDF");
    expect(fileTypeLabel("application/x-unknown-thing", "data.parq")).toBe("PARQ");
    expect(fileTypeLabel("application/octet-stream", "")).toBe("octet-stream");
    expect(fileTypeLabel("application/vnd.some-very-long-vendor-type", "")).toBe("some-very-l...");
    expect(fileTypeLabel("", "orig")).toBe("file");
    const view = buildHeldMailView({
      ...base,
      files: [{ name: "numbers.xlsx", type: xlsx, bytes: 2048 }],
    });
    const out = mailPreviewView({ view, safeHtml: undefined, safeQuoteHtml: undefined }).value;
    expect(out).toContain(`title="${xlsx}"`);
    expect(out).toContain("(Excel, about 2.0 KB)");
    expect(out).not.toContain(`(${xlsx}`);
  });

  it("sizes the preview frame by the viewport, taller on a desktop, and keeps the resize handle", () => {
    expect(BASE_CSS).toMatch(/\.mail-frame\{[^}]*height:max\(20rem,60vh\)/);
    expect(BASE_CSS).toMatch(/\.mail-frame\{height:max\(24rem,70vh\)\}/);
    expect(BASE_CSS).toMatch(/\.mail-frame\{[^}]*resize:vertical/);
    expect(BASE_CSS).not.toMatch(/\.mail-frame\{[^}]*height:30rem/);
  });
});

describe("previewFactRows (every other held kind)", () => {
  it("shares a file", () => {
    const rows = previewFactRows("share_file", {
      action: "Share a Drive file",
      account: "work",
      fileId: "a1:file_1",
      role: "reader",
      to: "anyone with the link",
      reason: "Anyone with the link can open it.",
    });
    expect(rows).toEqual([
      { label: "What", values: ["Share a Drive file"] },
      { label: "File", values: ["a1:file_1"] },
      { label: "Who gets access", values: ["anyone with the link"] },
      { label: "Role", values: ["reader"] },
    ]);
  });

  it("shares a calendar", () => {
    const rows = previewFactRows("share_calendar", {
      action: "Share a calendar",
      calendarId: "a1:cal_1",
      role: "freeBusyReader",
      to: "pat@example.org",
      notify: false,
    });
    expect(rows.map((r) => [r.label, r.values])).toEqual([
      ["What", ["Share a calendar"]],
      ["Calendar", ["a1:cal_1"]],
      ["Who gets access", ["pat@example.org"]],
      ["Role", ["freeBusyReader"]],
      ["Google emails them", ["no"]],
    ]);
  });

  it("creates a forwarding filter", () => {
    const rows = previewFactRows("create_filter", {
      summary:
        "Create a filter on work@example.com that forwards matching mail to fwd@example.org.",
      criteria: { from: "boss@example.org", subject: "invoice" },
      action: { forward: "fwd@example.org", addLabelIds: ["Label_1"], markRead: true },
    });
    const by = Object.fromEntries(rows.map((r) => [r.label, r.values]));
    expect(by.What?.[0]).toContain("forwards matching mail to fwd@example.org");
    expect(by["Mail that matches"]).toEqual(["from: boss@example.org", "subject: invoice"]);
    expect(by["Forwards it to"]).toEqual(["fwd@example.org"]);
    expect(by["Adds labels"]).toEqual(["Label_1"]);
    expect(by.Also).toEqual(["markRead: yes"]);
  });

  it("changes a calendar and names the tool when the preview has no action text", () => {
    const rows = previewFactRows("update_event", {
      calendarId: "a1:cal_1",
      eventId: "a1:ev_1",
      notify: "all",
      to: ["x@example.org", "y@example.org"],
      withComment: false,
    });
    expect(rows[0]).toEqual({ label: "What", values: ["Update an event"] });
    expect(rows.find((r) => r.label === "Google emails")?.values).toEqual([
      "x@example.org",
      "y@example.org",
    ]);
    expect(rows.some((r) => r.label === "Includes your comment")).toBe(false);
  });

  it("knows nothing about a tool it was not told about", () => {
    expect(previewFactRows("some_future_tool", { a: 1 })).toEqual([]);
    expect(previewFactRows("share_file", null)).toEqual([]);
    expect(previewFactRows("constructor", { a: 1 })).toEqual([]);
    expect(previewFactRows("__proto__", { a: 1 })).toEqual([]);
  });
});

// ---- The page ------------------------------------------------------------------------------------

async function setup() {
  const ownerId = await newOwner();
  const linked = await linkGoogleAccount(ownerId, {
    components: ["mail", "mail.send", "files", "calendar"],
  });
  await env.DB.prepare(
    "UPDATE accounts SET send_as_fetched_at = ?, signature_default = 0 WHERE id = ?",
  )
    .bind(Math.floor(Date.now() / 1000), linked.row.id)
    .run();
  return { ownerId, accountId: linked.row.id, key: `a${linked.row.short_id}` };
}

async function call(ownerId: string, name: string, args: Record<string, unknown>) {
  const exec = Object.assign(createExecutionContext(), {
    props: { ownerId },
    auth: {
      token: `${ownerId}:g_test:secret`,
      audience: `${ISSUER}/mcp`,
      scope: [...SCOPES.full],
      clientId: "client_test",
      userId: ownerId,
    },
  });
  const res = await mcpHandler("full", ISSUER, registry)(
    mcpRequest(undefined, "full", "tools/call", { name, arguments: args }),
    HOLD_ALL(),
    exec,
  );
  await waitOnExecutionContext(exec);
  const { result } = await parseMcp(res);
  return { text: JSON.stringify(result), json: toolJson(result) as Json };
}

const b64u = (s: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const originalRoute = (): GoogleRoute => ({
  url: MESSAGE,
  reply: () =>
    googleJson(200, {
      id: fx.original.id,
      threadId: fx.original.threadId,
      payload: {
        mimeType: "text/plain",
        headers: Object.entries(fx.original.headers).map(([name, value]) => ({ name, value })),
        body: { size: 10, data: b64u(fx.original.text) },
      },
    }),
});

/** The owner's browser. */
async function browser(ownerId: string) {
  const web = new Hono<{ Bindings: Env }>().route("/", guardrailsRoutes(registry));
  const { setCookie } = await createSession(env, ownerId, "owner@example.com");
  const cookie = setCookie.split(";")[0] ?? "";
  expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
  return async (path: string) => {
    const exec = createExecutionContext();
    const res = await web.fetch(
      new Request(`${ISSUER}${path}`, { headers: { Cookie: cookie } }),
      env,
      exec,
    );
    await waitOnExecutionContext(exec);
    return res;
  };
}

/** What a browser would put in an iframe's document, from the page's `srcdoc` attribute. */
const frameDocument = (page: string): string =>
  (/srcdoc="([^"]*)"/.exec(page)?.[1] ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

const rowOf = (id: string) =>
  env.DB.prepare("SELECT preview, params FROM pending_actions WHERE id = ?")
    .bind(id)
    .first<{ preview: string; params: string }>();

/** Inserts a pending action as an older server stored it: no view. */
async function insertPending(
  ownerId: string,
  accountId: string | null,
  tool: string,
  preview: unknown,
) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const id = `pa_${Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => alphabet[b % 32]).join("")}`;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO pending_actions (id, owner_id, tool, account_id, params, preview, client_id, grant_id, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, '{}', ?, 'c', 'g', 'pending', ?, ?)`,
  )
    .bind(id, ownerId, tool, accountId, JSON.stringify(preview), now, now + 3600)
    .run();
  return id;
}

describe("the approvals page for a held email", () => {
  it("shows a plain text send with its line breaks, header block and the reason", async () => {
    const { ownerId } = await setup();
    installGoogleRoutes([]);
    const held = await call(ownerId, "send_message", {
      to: ["to@example.org"],
      cc: ["cc@example.org"],
      bcc: ["bcc@example.org"],
      subject: "Quarterly numbers",
      body: "Line one\nLine two",
    });
    expect(held.json.status).toBe("pending_approval");
    const res = await (await browser(ownerId))(`/approvals/${held.json.pendingActionId}`);
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("The email as it will arrive");
    expect(page).toContain("<dt>From</dt><dd>work@example.com</dd>");
    expect(page).toContain("<dt>To</dt><dd>to@example.org</dd>");
    expect(page).toContain("<dt>Cc</dt><dd>cc@example.org</dd>");
    expect(page).toContain("<dt>Bcc</dt><dd>bcc@example.org</dd>");
    expect(page).toContain("Quarterly numbers");
    expect(page).toContain('<div class="mail-text">Line one\nLine two</div>');
    expect(page).toContain("Why it was held");
    // Reason before body, header before reason.
    expect(page.indexOf("Why it was held")).toBeLessThan(
      page.indexOf("The email as it will arrive"),
    );
    expect(page).not.toContain("<iframe");
  });

  it("sets a CSP on the page that allows the local frame and nothing remote", async () => {
    const { ownerId } = await setup();
    const held = await call(ownerId, "send_message", {
      to: ["to@example.org"],
      subject: "s",
      body: "b",
    });
    const res = await (await browser(ownerId))(`/approvals/${held.json.pendingActionId}`);
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toBe(APPROVAL_PAGE_CSP);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-src about:");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/https?:|\*|script-src/);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });

  it("keeps the real app's security headers off nothing: the page CSP survives the middleware", async () => {
    const { ownerId } = await setup();
    const held = await call(ownerId, "send_message", {
      to: ["to@example.org"],
      subject: "s",
      body: "b",
    });
    const web = new Hono<{ Bindings: Env }>().route("/", app);
    const { setCookie } = await createSession(env, ownerId, "owner@example.com");
    const exec = createExecutionContext();
    const res = await web.fetch(
      new Request(`${ISSUER}/approvals/${held.json.pendingActionId}`, {
        headers: { Cookie: setCookie.split(";")[0] ?? "" },
      }),
      env,
      exec,
    );
    await waitOnExecutionContext(exec);
    expect(res.headers.get("Content-Security-Policy")).toBe(APPROVAL_PAGE_CSP);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("sanitizes an HTML send into a sandboxed frame", async () => {
    const { ownerId } = await setup();
    const held = await call(ownerId, "send_message", {
      to: ["to@example.org"],
      subject: "News",
      body: "plain alternative",
      htmlBody:
        '<p onclick="x()">Hello <b>there</b></p><script>alert(1)</script><img src="https://tracker.example/p.gif" alt="pixel"><a href="javascript:alert(2)">go</a><div style="background:url(https://tracker.example/b.png)">z</div>',
    });
    const page = await (
      await (
        await browser(ownerId)
      )(`/approvals/${held.json.pendingActionId}`)
    ).text();
    expect(page).toContain('<iframe class="mail-frame" sandbox=""');
    const doc = frameDocument(page);
    expect(doc).toContain("<b>there</b>");
    expect(doc).toContain("[image: pixel]");
    expect(doc).not.toMatch(/<script|onclick|javascript:|tracker\.example|url\s*\(/i);
    // Nothing on the page is a live script, and the preview itself names no remote host (the
    // Details block below it quotes the exact arguments, escaped, so the host appears there).
    expect(page).not.toMatch(/<script/i);
    expect(page.slice(0, page.indexOf("<details"))).not.toContain("tracker.example");
  });

  it("shows attachment names and sizes", async () => {
    const { ownerId } = await setup();
    const held = await call(ownerId, "send_message", {
      to: ["to@example.org"],
      subject: "Files",
      body: "see attached",
      attachments: [
        { content: btoa("a".repeat(3000)), filename: "plan.txt", mimeType: "text/plain" },
        { content: btoa("hello"), filename: "notes.md" },
      ],
    });
    expect(held.json.status).toBe("pending_approval");
    const page = await (
      await (
        await browser(ownerId)
      )(`/approvals/${held.json.pendingActionId}`)
    ).text();
    expect(page).toContain("<dt>Attachments</dt>");
    expect(page).toContain("plan.txt");
    expect(page).toContain("notes.md");
    expect(page).toMatch(/about \d+(?:\.\d)? (?:B|KB)/);
  });

  it("shows a reply with the quoted original, and the view never reaches the client", async () => {
    const { ownerId, key } = await setup();
    installGoogleRoutes([originalRoute()]);
    const held = await call(ownerId, "reply", {
      messageId: `${key}:m_orig`,
      body: "Thanks, noted.",
    });
    expect(held.json.status).toBe("pending_approval");
    // Neither the answer nor the pending action as a client reads it carries the stored view.
    expect(held.text).not.toContain("Here is the plan for next quarter");
    expect(held.text).not.toContain(VIEW_KEY);
    const id = held.json.pendingActionId as string;
    const got = await call(ownerId, "get_pending_action", { pendingActionId: id });
    expect(got.text).not.toContain("Here is the plan for next quarter");
    expect(got.text).not.toContain(VIEW_KEY);
    // But it is stored, for the owner's page.
    expect((await rowOf(id))?.preview).toContain(VIEW_KEY);
    const page = await (await (await browser(ownerId))(`/approvals/${id}`)).text();
    expect(page).toContain("The reply as it will arrive");
    expect(page).toContain("Re: Quarterly plan");
    expect(page).toContain("sam@example.net");
    expect(page).toContain("Thanks, noted.");
    expect(page).toContain("Here is the plan for next quarter.");
  });

  it("shows a forward with the original it carries", async () => {
    const { ownerId, key } = await setup();
    installGoogleRoutes([originalRoute()]);
    const held = await call(ownerId, "forward", {
      messageId: `${key}:m_orig`,
      to: ["new@example.org"],
      forwardText: "FYI",
    });
    expect(held.json.status).toBe("pending_approval");
    const page = await (
      await (
        await browser(ownerId)
      )(`/approvals/${held.json.pendingActionId}`)
    ).text();
    expect(page).toContain("The forward as it will arrive");
    expect(page).toContain("new@example.org");
    expect(page).toContain("Fwd: Quarterly plan");
    expect(page).toContain("FYI");
    expect(page).toContain("Here is the plan for next quarter.");
  });

  it("keeps the raw JSON in a collapsed Details block", async () => {
    const { ownerId } = await setup();
    const held = await call(ownerId, "send_message", {
      to: ["to@example.org"],
      subject: "s",
      body: "b",
    });
    const page = await (
      await (
        await browser(ownerId)
      )(`/approvals/${held.json.pendingActionId}`)
    ).text();
    const m = /<details class="card">\s*<summary>Details/.exec(page);
    expect(m).not.toBeNull();
    // Not `open`, and the raw preview sits inside it.
    expect(page).not.toMatch(/<details class="card" open>\s*<summary>Details/);
    expect(page.indexOf("Details")).toBeGreaterThan(page.indexOf("as it will arrive"));
    // The stored view is not echoed into the raw preview.
    expect(page).not.toContain("&quot;_view&quot;");
  });

  it("escapes hostile header values on the real page", async () => {
    const { ownerId } = await setup();
    const held = await call(ownerId, "send_message", {
      to: ["to@example.org"],
      subject: '<script>alert("s")</script><img src=x onerror=alert(1)>',
      body: "<script>alert('b')</script>",
    });
    const page = await (
      await (
        await browser(ownerId)
      )(`/approvals/${held.json.pendingActionId}`)
    ).text();
    expect(page).not.toMatch(/<script|<img/i);
    expect(page).toContain("&lt;script&gt;alert(&quot;s&quot;)&lt;/script&gt;");
  });
});

describe("the approvals page for the other held kinds", () => {
  it("shows a file share's key fields", async () => {
    const { ownerId, accountId } = await setup();
    const id = await insertPending(ownerId, accountId, "share_file", {
      action: "Share a Drive file",
      account: "work",
      fileId: "a1:file_1",
      role: "reader",
      to: "anyone with the link",
      reason: "Anyone with the link could open it.",
    });
    const page = await (await (await browser(ownerId))(`/approvals/${id}`)).text();
    expect(page).toContain("<dt>What</dt><dd>Share a Drive file</dd>");
    expect(page).toContain("<dt>File</dt><dd>a1:file_1</dd>");
    expect(page).toContain("<dt>Who gets access</dt><dd>anyone with the link</dd>");
    expect(page).toContain("<dt>Role</dt><dd>reader</dd>");
    expect(page).toContain("Why it was held");
    expect(page).toContain("Anyone with the link could open it.");
    expect(page).not.toContain("as it will arrive");
  });

  it("shows a calendar share's key fields", async () => {
    const { ownerId, accountId } = await setup();
    const id = await insertPending(ownerId, accountId, "share_calendar", {
      action: "Share a calendar",
      calendarId: "a1:cal_1",
      role: "freeBusyReader",
      to: "pat@example.org",
      notify: false,
      reason: "pat@example.org is not in your contacts.",
    });
    const page = await (await (await browser(ownerId))(`/approvals/${id}`)).text();
    expect(page).toContain("<dt>Calendar</dt><dd>a1:cal_1</dd>");
    expect(page).toContain("<dt>Who gets access</dt><dd>pat@example.org</dd>");
    expect(page).toContain("<dt>Role</dt><dd>freeBusyReader</dd>");
    expect(page).toContain("<dt>Google emails them</dt><dd>no</dd>");
  });

  it("shows a forwarding filter's criteria and target", async () => {
    const { ownerId, accountId } = await setup();
    const id = await insertPending(ownerId, accountId, "create_filter", {
      summary:
        "Create a filter on work@example.com that forwards matching mail to fwd@example.org.",
      account: "work@example.com",
      criteria: { from: "boss@example.org" },
      action: { forward: "fwd@example.org" },
    });
    const page = await (await (await browser(ownerId))(`/approvals/${id}`)).text();
    expect(page).toContain("<dt>Mail that matches</dt><dd>from: boss@example.org</dd>");
    expect(page).toContain("<dt>Forwards it to</dt><dd>fwd@example.org</dd>");
  });

  it("shows a calendar change that emails people", async () => {
    const { ownerId, accountId } = await setup();
    const id = await insertPending(ownerId, accountId, "create_event", {
      action: "Calendar change that makes Google email people",
      tool: "create_event",
      calendarId: "a1:cal_1",
      notify: "all",
      to: ["guest@example.org"],
      newRecipients: ["guest@example.org"],
      heldBecause: "guest@example.org is a new recipient.",
    });
    const page = await (await (await browser(ownerId))(`/approvals/${id}`)).text();
    expect(page).toContain("<dt>Google emails</dt><dd>guest@example.org</dd>");
    expect(page).toContain("<dt>Notification level</dt><dd>all</dd>");
    expect(page).toContain("guest@example.org is a new recipient.");
  });

  it("escapes what a non-mail preview holds", async () => {
    const { ownerId, accountId } = await setup();
    const id = await insertPending(ownerId, accountId, "share_file", {
      action: "<script>alert(1)</script>",
      fileId: "<img src=x onerror=alert(1)>",
      to: ["<b>x</b>"],
    });
    const page = await (await (await browser(ownerId))(`/approvals/${id}`)).text();
    expect(page).not.toMatch(/<script|<img|<b>x/i);
  });

  it("still renders a row stored before the view existed", async () => {
    const { ownerId, accountId } = await setup();
    const id = await insertPending(ownerId, accountId, "send_message", {
      to: ["old@example.org"],
      cc: [],
      bcc: [],
      subject: "Old subject",
      from: "work@example.com",
      newRecipients: ["old@example.org"],
      heldBecause: "old@example.org is a new recipient.",
    });
    const res = await (await browser(ownerId))(`/approvals/${id}`);
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).not.toContain("as it will arrive");
    expect(page).toContain("old@example.org");
    expect(page).toContain("Old subject");
    expect(page).toContain("old@example.org is a new recipient.");
    expect(page).toContain("Details");
  });

  it("still renders an unknown tool and a null preview", async () => {
    const { ownerId, accountId } = await setup();
    const a = await insertPending(ownerId, accountId, "some_future_tool", {
      summary: "Do a thing",
      x: 1,
    });
    const b = await insertPending(ownerId, accountId, "some_future_tool", null);
    const c = await insertPending(ownerId, accountId, "send_message", {
      _view: { v: 1, kind: "mail", from: 5 },
      subject: "S",
    });
    const web = await browser(ownerId);
    for (const id of [a, b, c]) {
      const res = await web(`/approvals/${id}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Approve an action");
    }
  });
});

// ---- One layout ----------------------------------------------------------------------------------

describe("the shared layout", () => {
  const MARK = '<header class="site-header">';

  async function fetchApp(path: string, cookie?: string) {
    const exec = createExecutionContext();
    const res = await app.fetch(
      new Request(`${ISSUER}${path}`, {
        headers: cookie ? { Cookie: cookie } : {},
        redirect: "manual",
      }),
      env,
      exec,
    );
    await waitOnExecutionContext(exec);
    return res;
  }

  it("is used by every page the web app serves", async () => {
    const { ownerId } = await setup();
    const { setCookie } = await createSession(env, ownerId, "owner@example.com");
    const cookie = setCookie.split(";")[0] ?? "";
    const held = await call(ownerId, "send_message", {
      to: ["to@example.org"],
      subject: "s",
      body: "b",
    });
    const paths = [
      "/",
      "/privacy",
      "/accounts",
      "/accounts/audit",
      `/approvals/${held.json.pendingActionId}`,
      "/approvals/pa_aaaaaaaaaaaaaaaa",
      "/no/such/page",
    ];
    for (const path of paths) {
      const res = await fetchApp(path, cookie);
      expect(res.headers.get("content-type"), path).toContain("text/html");
      const text = await res.text();
      expect(text, path).toContain(MARK);
      expect(text, path).toContain("<main>");
      expect(text, path).toMatch(/<style>[\s\S]*--wb-page-bg/);
      expect(text.match(/<!doctype/gi) ?? [], path).toHaveLength(1);
    }
  });

  it("is used by the error page, and a sign-in redirect is not a page at all", async () => {
    const notFound = await fetchApp("/no/such/page");
    expect(notFound.status).toBe(404);
    expect(await notFound.text()).toContain(MARK);
    const anon = await fetchApp("/accounts");
    expect(anon.status).toBeGreaterThanOrEqual(300);
    expect(anon.status).toBeLessThan(400);
  });

  // The sources as text (Vite's raw import: the Workers test pool has no file system).
  const sources = import.meta.glob("../src/**/*.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;
  const sourceFiles = Object.entries(sources).filter(([p]) => !p.endsWith("theme.generated.ts"));

  it("is the only place that writes a document, apart from the email frame", () => {
    expect(sourceFiles.length).toBeGreaterThan(20);
    const allowed = ["web/html.ts", "web/preview-views.ts", "web/sanitize-html.ts"];
    const offenders = sourceFiles
      .filter(([p]) => !allowed.some((a) => p.endsWith(a)))
      .filter(([, src]) => /<!doctype|<html[\s>]/i.test(src))
      .map(([p]) => p);
    expect(offenders).toEqual([]);
  });

  it("wraps every htmlResponse in page()", () => {
    const bad: string[] = [];
    let seen = 0;
    for (const [p, src] of sourceFiles) {
      if (p.endsWith("web/html.ts")) continue;
      for (const m of src.matchAll(/htmlResponse\(\s*(\S[^\n]{0,40})/g)) {
        seen += 1;
        if (!/^page\(/.test(m[1] ?? "")) bad.push(`${p}: ${m[0]}`);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(5);
    expect(bad).toEqual([]);
  });
});
