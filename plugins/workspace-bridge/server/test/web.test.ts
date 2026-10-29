import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { VERSION } from "../src/version";
import { escapeHtml, html } from "../src/web/html";

const ISSUER = "https://mcp.example.com";

async function withEnv(path: string, overrides: Partial<Cloudflare.Env>): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(ISSUER + path), { ...env, ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("GET /health", () => {
  it("reports ok, name and version", async () => {
    const res = await exports.default.fetch(`${ISSUER}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: "workspace-bridge", version: VERSION });
  });

  it("uses a semver version constant", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("pages", () => {
  it("serves / and /privacy with security headers and the contact", async () => {
    for (const path of ["/", "/privacy"]) {
      const res = await exports.default.fetch(ISSUER + path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
      expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
      expect(res.headers.get("Strict-Transport-Security")).toContain("max-age=");
      expect(await res.text()).toContain("Contact: https://example.com/contact");
    }
  });

  it("states the privacy terms", async () => {
    const text = await (await exports.default.fetch(`${ISSUER}/privacy`)).text();
    expect(text).toContain("encrypted at rest");
    expect(text).toContain("Limited Use");
    expect(text).toContain("Nothing is shared with or sold to anyone");
    expect(text).toContain("myaccount.google.com/connections");
  });

  it("hides the contact line when OWNER_CONTACT is empty", async () => {
    const res = await withEnv("/privacy", { OWNER_CONTACT: "" });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("Contact:");
  });

  it("escapes the contact", async () => {
    const res = await withEnv("/", { OWNER_CONTACT: '<script>alert("x")</script>' });
    const text = await res.text();
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });

  it("adds security headers to unknown paths too", async () => {
    const res = await exports.default.fetch(`${ISSUER}/nope`);
    expect(res.status).toBe(404);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });
});

describe("sign-in not configured", () => {
  it.each<[string, Partial<Cloudflare.Env>]>([
    ["no GOOGLE_CLIENT_ID", { GOOGLE_CLIENT_ID: "" }],
    ["no GOOGLE_CLIENT_SECRET", { GOOGLE_CLIENT_SECRET: "" }],
    ["a short COOKIE_SECRET", { COOKIE_SECRET: "short" }],
  ])("answers 503 with %s while the rest keeps working", async (_name, overrides) => {
    for (const path of ["/authorize", "/oauth/google/callback"]) {
      const res = await withEnv(path, overrides);
      expect(res.status).toBe(503);
      expect(res.headers.get("Set-Cookie")).toBeNull();
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
      expect(await res.text()).toContain("Sign-in not configured");
    }
    expect((await withEnv("/health", overrides)).status).toBe(200);
    expect((await withEnv("/.well-known/oauth-authorization-server", overrides)).status).toBe(200);
    expect((await withEnv("/mcp", overrides)).status).toBe(401);
  });
});

describe("html template", () => {
  it("escapes values and passes nested templates through", () => {
    const name = `a&b<"c">'`;
    expect(escapeHtml(name)).toBe("a&amp;b&lt;&quot;c&quot;&gt;&#39;");
    const out = html`<p>${name}</p>${[html`<i>${1}</i>`, null, false, undefined]}`;
    expect(out.value).toBe("<p>a&amp;b&lt;&quot;c&quot;&gt;&#39;</p><i>1</i>");
  });
});
