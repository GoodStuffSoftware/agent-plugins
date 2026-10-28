// M4b: Google sign-in, the owner allowlist, the owner session and the consent page
// (ARCHITECTURE s.6 "Required auth tests"). Google is faked at `fetch`; the OAuth library is real.

import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_SCOPES, type Kind, PATH, SCOPES } from "../src/auth/endpoints";
import { FLOW_COOKIE } from "../src/auth/flow-state";
import { checkIdToken } from "../src/auth/google-oidc";
import { getAuth } from "../src/auth/server";
import { SESSION_COOKIE } from "../src/auth/session";
import { base64url, hmacSha256, sha256Hex } from "../src/core/crypto";
import { type FakeGoogle, GOOGLE_CLIENT_ID, installFakeGoogle } from "./helpers/google";
import { Browser, ISSUER, mcpClient, redeem } from "./helpers/session";
import { REDIRECT_URI } from "./helpers/tokens";

// The default owners (`OWNER_EMAILS` in vitest.config.ts), each with its own Google account.
const OWNER = { email: "owner@example.com", sub: "100000000000000000001" };
const OWNER2 = { email: "owner2@example.com", sub: "100000000000000000002" };
const STRANGER = { email: "stranger@example.com", sub: "100000000000000000099" };

let google: FakeGoogle;
let logs: string[];
let seq = 0;

beforeEach(() => {
  google = installFakeGoogle();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A fresh address for tests that change the allowlist; storage is shared between tests. */
const fresh = (name: string) => `${name}-${++seq}-${Date.now()}@example.com`;

async function grantCount(): Promise<number> {
  return (await env.OAUTH_KV.list({ prefix: "grant:" })).keys.length;
}

async function ownerIdOf(email: string): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT owner_id FROM owner_identities WHERE email = ?")
    .bind(email)
    .first<{ owner_id: string }>();
  return row?.owner_id;
}

function unwrap(token: string) {
  return getAuth(env).as.getOAuthApi(env).unwrapToken<{ ownerId: string }>(token);
}

function initialize(kind: Kind, token: string): Promise<Response> {
  return exports.default.fetch(
    new Request(ISSUER + PATH[kind], {
      method: "POST",
      headers: {
        Host: new URL(ISSUER).host,
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.0" },
        },
      }),
    }),
  );
}

/** Sign-in, consent with the default boxes, code exchange: the owner's token for `kind`. */
async function ownerToken(
  user: { email: string; sub: string },
  kind: Kind = "full",
  browser = new Browser(),
): Promise<string> {
  const client = await mcpClient(kind);
  const form = await browser.signinAndConsent(google, client, user);
  return (await redeem(client, await browser.submit(form))).access_token;
}

describe("owner sign-in", () => {
  it("runs the full owner flow to a token that works at /mcp", async () => {
    const browser = new Browser();
    const client = await mcpClient("full");
    const callback = await browser.signin(google, client, OWNER);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toBe(client.authorizeUrl);
    expect(browser.cookie(SESSION_COOKIE)).toBeTruthy();
    expect(browser.cookie(FLOW_COOKIE)).toBeUndefined();

    const form = await browser.consent(client);
    expect(form.html).toContain("Example Client");
    expect(form.html).toContain("client.example.com");
    expect(form.html).toContain(OWNER.email);
    expect(form.offered).toEqual([...SCOPES.full]);
    expect(form.checked).toEqual([...SCOPES.full]);

    const approval = await browser.submit(form);
    const location = new URL(approval.headers.get("Location") ?? "");
    expect(location.searchParams.get("state")).toBe("client-state-full");
    expect(location.searchParams.get("iss")).toBe(ISSUER);
    const tokens = await redeem(client, approval);
    expect(tokens.scope.split(" ")).toEqual([...SCOPES.full]);

    const res = await initialize("full", tokens.access_token);
    expect(res.status).toBe(200);
    await res.body?.cancel();
    const ownerId = await ownerIdOf(OWNER.email);
    expect(ownerId).toMatch(/^o_[a-z2-7]{16}$/);
    const summary = await unwrap(tokens.access_token);
    expect(summary?.userId).toBe(ownerId);
    expect(summary?.grant.props).toEqual({ ownerId });
  });

  it("sends Google an openid email request with PKCE S256 and sets __Host- cookies", async () => {
    const browser = new Browser();
    const client = await mcpClient("full");
    const start = await browser.fetch(client.authorizeUrl);
    expect(start.status).toBe(302);
    expect(start.headers.get("Cache-Control")).toBe("no-store");
    const [flowCookie] = start.headers.getSetCookie();
    expect(flowCookie).toMatch(
      /^__Host-wb-flow=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/,
    );
    const to = new URL(start.headers.get("Location") ?? "");
    expect(to.origin + to.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const p = to.searchParams;
    expect(p.get("client_id")).toBe(GOOGLE_CLIENT_ID);
    expect(p.get("redirect_uri")).toBe(`${ISSUER}/oauth/google/callback`);
    expect(p.get("response_type")).toBe("code");
    expect(p.get("scope")).toBe("openid email");
    expect(p.get("prompt")).toBe("select_account");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // D1 holds only the hash of `state`.
    const row = await env.DB.prepare("SELECT * FROM flow_states WHERE id = ?")
      .bind(await sha256Hex(p.get("state") ?? ""))
      .first<{ kind: string; payload: string }>();
    expect(row?.kind).toBe("signin");
    expect(JSON.parse(row?.payload ?? "{}").returnTo).toBe(
      client.authorizeUrl.slice(ISSUER.length),
    );

    const callback = await browser.fetch(google.approve(to, OWNER));
    expect(callback.status).toBe(302);
    const cookies = callback.headers.getSetCookie();
    expect(cookies[0]).toMatch(
      /^__Host-wb-session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=1800$/,
    );
    expect(cookies[1]).toMatch(/^__Host-wb-flow=; .*Max-Age=0$/);
    const [exchange] = google.tokenRequests;
    expect(exchange?.get("redirect_uri")).toBe(`${ISSUER}/oauth/google/callback`);
    expect(exchange?.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("refuses a non-owner: 403, no cookie, no grant, and a log line without the address", async () => {
    const before = await grantCount();
    const browser = new Browser();
    const client = await mcpClient("full");
    const res = await browser.signin(google, client, STRANGER);
    expect(res.status).toBe(403);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(await res.text()).toContain("Not allowed");
    expect(browser.cookie(SESSION_COOKIE)).toBeUndefined();

    // Still no session: /authorize starts sign-in again instead of showing consent.
    const again = await browser.fetch(client.authorizeUrl);
    expect(again.status).toBe(302);
    expect(again.headers.get("Location")).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect(await grantCount()).toBe(before);
    expect(await ownerIdOf(STRANGER.email)).toBeUndefined();

    const refused = logs.map((l) => JSON.parse(l)).find((l) => l.event === "signin_refused");
    expect(refused).toMatchObject({ reason: "not_allowlisted" });
    expect(refused.email_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(logs.join("\n")).not.toContain("stranger");
  });

  it("refuses everyone when OWNER_EMAILS is empty", async () => {
    const browser = new Browser({ OWNER_EMAILS: "" });
    const res = await browser.signin(google, await mcpClient("full"), OWNER);
    expect(res.status).toBe(403);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("maps both owner addresses, in any case, to the same owner", async () => {
    const first = await unwrap(await ownerToken(OWNER));
    const second = await unwrap(await ownerToken({ email: "Owner2@Example.COM", sub: OWNER2.sub }));
    const ownerId = await ownerIdOf(OWNER.email);
    expect(ownerId).toBeTruthy();
    expect(await ownerIdOf(OWNER2.email)).toBe(ownerId);
    expect(first?.userId).toBe(ownerId);
    expect(second?.userId).toBe(ownerId);
    expect(second?.grant.props).toEqual({ ownerId });
  });

  it("after setup mode, refuses an unpinned address and a different sub", async () => {
    const pinned = fresh("pinned");
    const late = fresh("late");
    const client = await mcpClient("full");

    // Setup mode pins `pinned` to its Google account; a second account cannot take it over.
    const setup = { SETUP_MODE: "true", OWNER_EMAILS: `${pinned},${late}` };
    expect(
      (await new Browser(setup).signin(google, client, { email: pinned, sub: "p-1" })).status,
    ).toBe(302);
    const takeover = await new Browser(setup).signin(google, client, { email: pinned, sub: "p-2" });
    expect(takeover.status).toBe(403);

    const after = { SETUP_MODE: "false", OWNER_EMAILS: `${pinned},${late}` };
    for (const user of [
      { email: late, sub: "l-1" },
      { email: pinned, sub: "p-2" },
    ]) {
      const browser = new Browser(after);
      const res = await browser.signin(google, client, user);
      expect(res.status).toBe(403);
      expect(res.headers.get("Set-Cookie")).toBeNull();
      expect(browser.cookie(SESSION_COOKIE)).toBeUndefined();
    }
    expect(await ownerIdOf(late)).toBeUndefined();
    const reasons = logs
      .map((l) => JSON.parse(l))
      .filter((l) => l.event === "signin_refused")
      .map((l) => l.reason);
    expect(reasons).toEqual(["sub_mismatch", "not_pinned", "sub_mismatch"]);

    // The pinned account still signs in after setup mode.
    const ok = await new Browser(after).signin(google, client, { email: pinned, sub: "p-1" });
    expect(ok.status).toBe(302);
  });

  it("refuses a Google account already pinned to another address", async () => {
    const a = fresh("a");
    const b = fresh("b");
    const setup = { SETUP_MODE: "true", OWNER_EMAILS: `${a},${b}` };
    const client = await mcpClient("full");
    expect(
      (await new Browser(setup).signin(google, client, { email: a, sub: "same" })).status,
    ).toBe(302);
    const res = await new Browser(setup).signin(google, client, { email: b, sub: "same" });
    expect(res.status).toBe(403);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("refuses an ID token that fails a claim check", async () => {
    const browser = new Browser();
    const res = await browser.signin(google, await mcpClient("full"), {
      ...OWNER,
      claims: { email_verified: false },
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(browser.cookie(SESSION_COOKIE)).toBeUndefined();
  });

  it("sends access_denied to the client when the owner cancels at Google", async () => {
    const browser = new Browser();
    const client = await mcpClient("full");
    const res = await browser.fetch(google.cancel(await browser.startSignin(client)));
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location") ?? "");
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("client-state-full");
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });
});

describe("flow state", () => {
  it("refuses a replayed state, even with its cookie", async () => {
    const browser = new Browser();
    const client = await mcpClient("full");
    const googleUrl = await browser.startSignin(client);
    const flowCookie = browser.cookie(FLOW_COOKIE) ?? "";
    const callback = google.approve(googleUrl, OWNER);
    expect((await browser.fetch(callback)).status).toBe(302);

    const replayer = new Browser();
    replayer.setCookie(FLOW_COOKIE, flowCookie);
    const replay = await replayer.fetch(callback);
    expect(replay.status).toBe(400);
    expect(replay.headers.get("Set-Cookie")).toBeNull();
    expect(replayer.cookie(SESSION_COOKIE)).toBeUndefined();
    expect(google.tokenRequests).toHaveLength(1);
  });

  it("refuses a callback from another browser, and the state is then used up", async () => {
    const victim = new Browser();
    const client = await mcpClient("full");
    const callback = google.approve(await victim.startSignin(client), OWNER);

    const attacker = new Browser();
    await attacker.startSignin(client); // holds a flow cookie of its own
    const stolen = await attacker.fetch(callback);
    expect(stolen.status).toBe(400);
    expect(stolen.headers.get("Set-Cookie")).toBeNull();
    expect(attacker.cookie(SESSION_COOKIE)).toBeUndefined();

    const noCookie = await new Browser().fetch(callback);
    expect(noCookie.status).toBe(400);
    // One attempt uses the state up, so the right browser cannot finish either.
    expect((await victim.fetch(callback)).status).toBe(400);
    expect(google.tokenRequests).toHaveLength(0);
  });

  it("refuses an expired state", async () => {
    const browser = new Browser();
    const googleUrl = await browser.startSignin(await mcpClient("full"));
    await env.DB.prepare("UPDATE flow_states SET expires_at = 0 WHERE id = ?")
      .bind(await sha256Hex(googleUrl.searchParams.get("state") ?? ""))
      .run();
    const res = await browser.fetch(google.approve(googleUrl, OWNER));
    expect(res.status).toBe(400);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("refuses a callback with no state", async () => {
    const res = await new Browser().fetch(`${ISSUER}/oauth/google/callback?code=x`);
    expect(res.status).toBe(400);
  });
});

describe("consent", () => {
  it("serves the page with the full security headers and escapes the client name", async () => {
    const browser = new Browser();
    const client = await mcpClient("full", { clientName: '<img src=x onerror="alert(1)">' });
    const form = await browser.signinAndConsent(google, client, OWNER);
    const h = form.page.headers;
    expect(h.get("Cache-Control")).toBe("no-store");
    expect(h.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(h.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(h.get("X-Frame-Options")).toBe("DENY");
    expect(h.getSetCookie().some((c) => c.startsWith("__Host-oauth-consent-"))).toBe(true);
    expect(form.html).not.toContain("<img");
    expect(form.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(form.handle).not.toBe("");
    expect(form.csrf).not.toBe("");
  });

  it("on /mcp/ro never grants send, whatever is posted", async () => {
    const browser = new Browser();
    const client = await mcpClient("ro");
    const form = await browser.signinAndConsent(google, client, OWNER);
    expect(form.offered).toEqual([...SCOPES.ro]);
    expect(form.offered).not.toContain("mail.send");

    const tokens = await redeem(client, await browser.submit(form, { scopes: [...ALL_SCOPES] }));
    expect(tokens.scope.split(" ")).toEqual([...SCOPES.ro]);
    const summary = await unwrap(tokens.access_token);
    expect(summary?.grant.scope).toEqual([...SCOPES.ro]);
    expect(summary?.grant.scope).not.toContain("mail.send");
    const res = await initialize("ro", tokens.access_token);
    expect(res.status).toBe(200);
    await res.body?.cancel();
  });

  it("on /mcp/ro answers a send-only form with invalid_scope and writes no grant", async () => {
    const browser = new Browser();
    const client = await mcpClient("ro");
    const form = await browser.signinAndConsent(google, client, OWNER);
    const before = await grantCount();
    const res = await browser.submit(form, { scopes: ["mail.send", "admin"] });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location") ?? "");
    expect(location.searchParams.get("error")).toBe("invalid_scope");
    expect(location.searchParams.get("code")).toBeNull();
    expect(await grantCount()).toBe(before);
  });

  it("keeps admin to /mcp/admin and lets the owner narrow a /mcp grant", async () => {
    const browser = new Browser();
    const full = await mcpClient("full");
    const form = await browser.signinAndConsent(google, full, OWNER);
    const all = await redeem(full, await browser.submit(form, { scopes: [...ALL_SCOPES] }));
    expect(all.scope.split(" ")).toEqual([...SCOPES.full]);

    const narrow = await browser.consent(full);
    const one = await redeem(full, await browser.submit(narrow, { scopes: ["mail.read"] }));
    expect(one.scope).toBe("mail.read");

    const admin = await mcpClient("admin");
    const adminForm = await browser.consent(admin);
    expect(adminForm.offered).toEqual(["admin"]);
    const adminTokens = await redeem(admin, await browser.submit(adminForm));
    expect(adminTokens.scope).toBe("admin");
  });

  it("refuses a POST without the session's CSRF token, and the form still works after", async () => {
    const browser = new Browser();
    const client = await mcpClient("full");
    const form = await browser.signinAndConsent(google, client, OWNER);
    const other = new Browser();
    const otherForm = await other.signinAndConsent(google, await mcpClient("full"), OWNER2);
    const before = await grantCount();

    for (const csrf of [null, "", "forged", otherForm.csrf]) {
      const res = await browser.submit(form, { csrf });
      expect(res.status).toBe(403);
      expect(res.headers.get("Location")).toBeNull();
    }
    // A form posted by a browser without a session is refused the same way.
    const anonymous = await new Browser().submit(form);
    expect(anonymous.status).toBe(403);
    expect(await grantCount()).toBe(before);

    await redeem(client, await browser.submit(form));
  });

  it("sends access_denied to the client on deny", async () => {
    const browser = new Browser();
    const client = await mcpClient("full");
    const form = await browser.signinAndConsent(google, client, OWNER);
    const before = await grantCount();
    const res = await browser.submit(form, { decision: "deny" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location") ?? "");
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("client-state-full");
    expect(await grantCount()).toBe(before);
    // The handle is used up.
    expect((await browser.submit(form)).status).toBe(400);
  });
});

describe("authorization request", () => {
  it("refuses a request without PKCE S256, also from a confidential client", async () => {
    for (const confidential of [true, false]) {
      const browser = new Browser();
      const client = await mcpClient("full", { confidential, pkce: false });
      const res = await browser.fetch(client.authorizeUrl);
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get("Location") ?? "");
      expect(location.origin + location.pathname).toBe(REDIRECT_URI);
      expect(location.searchParams.get("error")).toBe("invalid_request");
      expect(res.headers.get("Set-Cookie")).toBeNull();
    }
  });

  it("renders a page, never a redirect, for an unknown client", async () => {
    const res = await new Browser().fetch(
      `${ISSUER}/authorize?response_type=code&client_id=nope&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
  });
});

describe("owner session", () => {
  async function forge(exp: number, email = OWNER.email): Promise<string> {
    const ownerId = (await ownerIdOf(OWNER.email)) ?? "o_aaaaaaaaaaaaaaaa";
    const body = base64url(
      new TextEncoder().encode(JSON.stringify({ v: 1, sid: "s", oid: ownerId, em: email, exp })),
    );
    const mac = base64url(await hmacSha256(env.COOKIE_SECRET ?? "", `wb-session|${body}`));
    return `${body}.${mac}`;
  }

  const shows = async (browser: Browser, client: { authorizeUrl: string }) => {
    const res = await browser.fetch(client.authorizeUrl);
    await res.body?.cancel();
    return res.status === 200 ? "consent" : res.headers.get("Location")?.split("?")[0];
  };

  it("holds only while signed, unexpired and on the allowlist", async () => {
    await ownerToken(OWNER);
    const client = await mcpClient("full");
    const now = Math.floor(Date.now() / 1000);
    const google = "https://accounts.google.com/o/oauth2/v2/auth";

    const valid = new Browser();
    valid.setCookie(SESSION_COOKIE, await forge(now + 600));
    expect(await shows(valid, client)).toBe("consent");

    const expired = new Browser();
    expired.setCookie(SESSION_COOKIE, await forge(now - 1));
    expect(await shows(expired, client)).toBe(google);

    const tampered = new Browser();
    const cookie = await forge(now + 600);
    tampered.setCookie(SESSION_COOKIE, `${cookie.slice(0, -1)}${cookie.endsWith("A") ? "B" : "A"}`);
    expect(await shows(tampered, client)).toBe(google);

    const removed = new Browser({ OWNER_EMAILS: OWNER2.email });
    removed.setCookie(SESSION_COOKIE, await forge(now + 600));
    expect(await shows(removed, client)).toBe(google);
  });
});

describe("checkIdToken", () => {
  const now = 1_800_000_000;
  const token = (claims: Record<string, unknown>) => {
    const enc = (v: unknown) => base64url(new TextEncoder().encode(JSON.stringify(v)));
    return `${enc({ alg: "RS256" })}.${enc({
      iss: "https://accounts.google.com",
      aud: GOOGLE_CLIENT_ID,
      exp: now + 60,
      nonce: "n",
      email: "Owner@Example.com",
      email_verified: true,
      sub: "1",
      ...claims,
    })}.sig`;
  };
  const check = (claims: Record<string, unknown>) =>
    checkIdToken(token(claims), { clientId: GOOGLE_CLIENT_ID, nonce: "n", now });

  it("accepts good claims and lowercases the address", () => {
    expect(check({})).toEqual({ ok: true, email: "owner@example.com", sub: "1" });
    expect(check({ iss: "accounts.google.com" }).ok).toBe(true);
    expect(check({ aud: [GOOGLE_CLIENT_ID, "other"], azp: GOOGLE_CLIENT_ID }).ok).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    ["iss", { iss: "https://evil.example.com" }],
    ["aud", { aud: "other-client" }],
    ["aud", { aud: [GOOGLE_CLIENT_ID, "other"] }],
    ["exp", { exp: now }],
    ["exp", { exp: undefined }],
    ["nonce", { nonce: "m" }],
    ["nonce", { nonce: undefined }],
    ["email_unverified", { email_verified: false }],
    ["email_unverified", { email_verified: "true" }],
    ["claims", { email: undefined }],
    ["claims", { sub: "" }],
  ])("refuses a bad %s claim: %o", (reason, claims) => {
    expect(check(claims)).toEqual({ ok: false, reason });
  });

  it("refuses a malformed token", () => {
    for (const bad of [undefined, "", "a.b", "a.!!.c", `x.${base64url(new Uint8Array([1]))}.y`]) {
      expect(checkIdToken(bad, { clientId: GOOGLE_CLIENT_ID, nonce: "n", now })).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });
});
