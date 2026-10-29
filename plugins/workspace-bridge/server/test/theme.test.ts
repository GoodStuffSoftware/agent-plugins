import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { SECURITY_HEADERS } from "../src/web/html";
import { BASE_CSS } from "../src/web/style";
import { setTheme, type ThemeData } from "../src/web/theme";
import { type ApprovalViewData, approvalView } from "../src/web/views";

const ISSUER = "https://mcp.example.com";
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>';
const FONT_BYTES = [0x77, 0x4f, 0x46, 0x32, 1, 2, 3];

const theme = (over: Partial<ThemeData> = {}): ThemeData => ({
  css: ":root{--wb-accent:#ff00aa;--wb-radius:2px}",
  name: "Example Co",
  assets: {
    "logo.svg": { type: "image/svg+xml", text: SVG },
    "mark.woff2": { type: "font/woff2", base64: btoa(String.fromCharCode(...FONT_BYTES)) },
  },
  ...over,
});

const get = (path: string) => exports.default.fetch(ISSUER + path);

afterEach(() => setTheme());

describe("default theme", () => {
  it("serves the shared layout and base sheet on every public page", async () => {
    for (const path of ["/", "/privacy"]) {
      const text = await (await get(path)).text();
      expect(text).toContain('<header class="site-header">');
      expect(text).toContain(
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
      );
      expect(text).toContain("--wb-accent:#2b5cc7");
      expect(text).toContain("@media (prefers-color-scheme:dark)");
      expect(text).toContain('<span class="brand-name">workspace-bridge</span>');
      expect(text).not.toContain("<img");
    }
  });

  it("gives every colour, font, radius, space and shadow as a custom property", () => {
    for (const name of [
      "--wb-bg",
      "--wb-page-bg",
      "--wb-surface",
      "--wb-text",
      "--wb-approve",
      "--wb-reject",
      "--wb-font-body",
      "--wb-font-heading",
      "--wb-radius",
      "--wb-space-m",
      "--wb-shadow-card",
    ]) {
      expect(BASE_CSS).toContain(`${name}:`);
    }
  });

  it("allows fonts and images from the Worker only", () => {
    const csp = SECURITY_HEADERS["Content-Security-Policy"] ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("img-src 'self'");
    expect(csp).toContain("font-src 'self'");
    expect(csp).not.toMatch(/https?:|\*/);
  });

  it("answers 404 for an asset the default theme does not have", async () => {
    expect((await get("/theme/assets/logo.svg")).status).toBe(404);
  });
});

describe("an override theme", () => {
  it("adds its CSS after the base sheet, its name and its logo", async () => {
    setTheme(theme());
    const text = await (await get("/")).text();
    expect(text).toContain(":root{--wb-accent:#ff00aa;--wb-radius:2px}");
    expect(text.indexOf("--wb-accent:#2b5cc7")).toBeLessThan(text.indexOf("--wb-accent:#ff00aa"));
    expect(text).toContain('<span class="brand-name">Example Co</span>');
    expect(text).toContain('<img class="brand-logo" src="/theme/assets/logo.svg" alt="">');
    expect(text).not.toContain('class="brand-mark"');
  });

  it("offers a dark logo to dark mode when it has one", async () => {
    setTheme(
      theme({
        assets: {
          "logo.svg": { type: "image/svg+xml", text: SVG },
          "logo-dark.svg": { type: "image/svg+xml", text: SVG },
        },
      }),
    );
    const text = await (await get("/")).text();
    expect(text).toContain(
      '<source media="(prefers-color-scheme: dark)" srcset="/theme/assets/logo-dark.svg">',
    );
  });

  it("serves its svg and font from the Worker, locked down", async () => {
    setTheme(theme());
    const svg = await get("/theme/assets/logo.svg");
    expect(svg.status).toBe(200);
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect(svg.headers.get("content-security-policy")).toContain("sandbox");
    expect(svg.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await svg.text()).toBe(SVG);
    const font = await get("/theme/assets/mark.woff2");
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect([...new Uint8Array(await font.arrayBuffer())]).toEqual(FONT_BYTES);
  });

  it("answers 404 for names the theme does not have", async () => {
    setTheme(theme());
    for (const name of ["nope.svg", "__proto__", "constructor", "..%2Ftheme.css"]) {
      expect((await get(`/theme/assets/${name}`)).status).toBe(404);
    }
  });

  it("escapes the product name and cannot close the style tag", async () => {
    setTheme(theme({ name: '<script>alert("x")</script>', css: "a{}</style>b{}" }));
    const text = await (await get("/")).text();
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(text).toContain("a{}<\\/style>b{}");
    expect(text.match(/<\/style>/g)).toHaveLength(2);
  });
});

const approval = (over: Partial<ApprovalViewData> = {}): ApprovalViewData => ({
  id: "pa_abcdefghijklmnop",
  csrf: "token",
  tool: "send_message",
  status: "pending",
  clientId: "client-1",
  requested: "2026-10-29T14:00:00.000Z",
  expires: "2026-10-29T15:00:00.000Z",
  account: { label: "Work", address: "me@example.com" },
  preview: {
    from: "me@example.com",
    to: ["new@acme.example"],
    subject: "Hello <img src=x onerror=alert(1)>",
    heldBecause: "Held for the owner's approval: this recipient is new to the account.",
  },
  previewJson: "{}",
  args: "{}",
  resultJson: null,
  held: {
    fresh: [{ address: "new@acme.example", queryable: true }],
    mailbox: "me@example.com",
    domains: ["acme.example"],
  },
  ...over,
});

describe("approval page", () => {
  it("orders the buttons approve once, always allow, domain, reject, and escapes the summary", () => {
    const out = approvalView(approval()).value;
    const at = (s: string) => out.indexOf(s);
    expect(at("Approve once")).toBeGreaterThan(-1);
    expect(at("Approve once")).toBeLessThan(at("Approve and always allow new@acme.example"));
    expect(at("Approve and always allow new@acme.example")).toBeLessThan(
      at("Approve and always allow @acme.example"),
    );
    expect(at("Approve and always allow @acme.example")).toBeLessThan(at(">Reject<"));
    expect(out).toContain('class="btn-approve" name="decision" value="approve"');
    expect(out).toContain('class="btn-reject" name="decision" value="reject"');
    expect(out).not.toContain("<img src=x");
    expect(out).toContain("Hello &lt;img src=x onerror=alert(1)&gt;");
    for (const label of ["Account", "From", "To", "Subject", "Expires"]) {
      expect(out).toContain(`<dt>${label}</dt>`);
    }
    expect(out).toContain("Held for the owner&#39;s approval");
  });

  it("shows a plain approve and reject for an action with no new recipients", () => {
    const out = approvalView(approval({ held: null, preview: { note: "x" } })).value;
    expect(out).toContain(">Approve<");
    expect(out).toContain(">Reject<");
    expect(out).not.toContain("<dt>Subject</dt>");
  });

  it("shows the target of a Drive share and no From", () => {
    const out = approvalView(
      approval({
        tool: "share_file",
        held: null,
        preview: {
          action: "Share a Drive file",
          role: "writer",
          to: "anyone",
          reason: "Anyone with the link would get access.",
        },
      }),
    ).value;
    for (const text of ["Share a Drive file", "writer", "anyone", "Anyone with the link"]) {
      expect(out.split("<details")[0]).toContain(text);
    }
    expect(out).not.toContain("<dt>From</dt>");
  });

  it("shows where a filter forwards to, and keeps the exact arguments open", () => {
    const out = approvalView(
      approval({
        tool: "create_filter",
        held: null,
        preview: { summary: "Forwards mail.", action: { forward: "x@example.net" } },
      }),
    ).value;
    expect(out.split("<details")[0]).toContain("forward: x@example.net");
    expect(out).toContain('<details class="card" open>');
  });

  it("offers no buttons once decided", () => {
    const out = approvalView(approval({ status: "expired" })).value;
    expect(out).toContain("<dd>expired</dd>");
    expect(out).not.toContain("<button");
  });
});
