// M7a: `/accounts`, the link leg and unlink (plan s.4.3, ARCHITECTURE s.6). Google is faked at
// `fetch`: the token endpoint (from the sign-in fake, with fresh refresh and access tokens per code
// and the requested scopes echoed back), Gmail's sendAs list and the revoke endpoint.

import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFlow, FLOW_COOKIE } from "../src/auth/flow-state";
import { GOOGLE_AUTHORIZE_URL, GOOGLE_TOKEN_URL } from "../src/auth/google-oidc";
import { SESSION_COOKIE } from "../src/auth/session";
import { base64url, open, randomBytes, type TokenKind } from "../src/core/crypto";
import { type AccountRow, getToken } from "../src/core/db";
import { GOOGLE_REVOKE_URL } from "../src/providers/google/base";
import { FakeGoogle, type GoogleUser } from "./helpers/google";
import { Browser, ISSUER } from "./helpers/session";

const OWNER = { email: "owner@example.com", sub: "100000000000000000001" };
const STRANGER = { email: "stranger@example.com", sub: "100000000000000000099" };
const WORK = { email: "work@example.com", sub: "100000000000000000010" };
const OTHER = { email: "other@example.com", sub: "100000000000000000011" };

const SEND_AS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs";
const CALLBACK = `${ISSUER}/oauth/google/callback`;
const API = "https://www.googleapis.com/auth/";
const ALL = ["mail", "mail.send", "calendar", "files", "contacts"];

const form = async (req: Request): Promise<URLSearchParams> =>
  new URLSearchParams(new TextDecoder().decode(await req.arrayBuffer()));

/** The sign-in fake plus what the link leg needs from Google. */
class LinkGoogle extends FakeGoogle {
  private readonly asked = new Map<string, string>();
  private n = 0;
  /** Codes from a link redirect (offline access) that reached the token endpoint. */
  readonly linkExchanges: string[] = [];
  /** Every refresh and access token handed out, in order. */
  readonly issued: { refresh: string; access: string }[] = [];
  /** Tokens posted to the revoke endpoint. */
  readonly revoked: string[] = [];
  /** `Authorization` headers of sendAs requests. */
  readonly sendAsAuth: (string | null)[] = [];
  /** Replaces the granted `scope` (default: the scopes asked for). */
  grant: string | undefined;
  revokeStatus = 200;

  override approve(authorizeUrl: string | URL, user: GoogleUser): string {
    const callback = super.approve(authorizeUrl, user);
    const code = new URL(callback).searchParams.get("code") ?? "";
    this.asked.set(code, new URL(authorizeUrl).searchParams.get("scope") ?? "");
    return callback;
  }

  override async token(req: Request): Promise<Response> {
    const code = (await form(req.clone())).get("code") ?? "";
    const scope = this.asked.get(code) ?? "";
    if (scope !== "openid email") this.linkExchanges.push(code);
    const res = await super.token(req);
    if (!res.ok) return res;
    const body = await res.json<Record<string, unknown>>();
    const tag = `${++this.n}-${base64url(randomBytes(9))}`;
    const pair = { refresh: `1//refresh-${tag}`, access: `ya29.access-${tag}` };
    this.issued.push(pair);
    return Response.json({
      ...body,
      access_token: pair.access,
      refresh_token: pair.refresh,
      scope: this.grant ?? scope,
    });
  }

  async route(req: Request): Promise<Response> {
    if (req.method === "POST" && req.url === GOOGLE_TOKEN_URL) return this.token(req);
    if (req.method === "POST" && req.url === GOOGLE_REVOKE_URL) {
      this.revoked.push((await form(req)).get("token") ?? "");
      return new Response(null, { status: this.revokeStatus });
    }
    if (req.method === "GET" && req.url === SEND_AS_URL) {
      this.sendAsAuth.push(req.headers.get("Authorization"));
      return Response.json({
        sendAs: [
          { sendAsEmail: "Me@Example.com", displayName: "Me", isPrimary: true, isDefault: true },
          {
            sendAsEmail: "alias@example.com",
            displayName: "Alias",
            replyToAddress: "reply@example.com",
            verificationStatus: "accepted",
          },
        ],
      });
    }
    throw new Error(`unexpected fetch: ${req.method} ${req.url}`);
  }
}

let google: LinkGoogle;
let logs: string[];

beforeEach(async () => {
  google = new LinkGoogle();
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    google.route(new Request(input, init)),
  );
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  // Storage is shared by the tests in this file; each starts with no linked account.
  await env.DB.batch([
    env.DB.prepare("UPDATE owners SET default_account_id = NULL"),
    env.DB.prepare("DELETE FROM accounts"),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const count = async (table: string): Promise<number> =>
  (await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0;

const accounts = async (): Promise<AccountRow[]> =>
  (await env.DB.prepare("SELECT * FROM accounts ORDER BY short_id").all<AccountRow>()).results;

const linkFlows = async (): Promise<number> =>
  (
    await env.DB.prepare("SELECT count(*) AS n FROM flow_states WHERE kind = 'link'").first<{
      n: number;
    }>()
  )?.n ?? 0;

async function ownerId(): Promise<string> {
  const row = await env.DB.prepare("SELECT owner_id FROM owner_identities WHERE email = ?")
    .bind(OWNER.email)
    .first<{ owner_id: string }>();
  if (!row) throw new Error("owner not signed in yet");
  return row.owner_id;
}

/** `GET /accounts` without a session, through Google sign-in, back to `/accounts`. */
async function signIn(overrides: Partial<Cloudflare.Env> = {}): Promise<Browser> {
  const browser = new Browser(overrides);
  const start = await browser.fetch(`${ISSUER}/accounts`);
  expect(start.status).toBe(302);
  const back = await browser.fetch(google.approve(start.headers.get("Location") ?? "", OWNER));
  expect(back.status).toBe(302);
  expect(back.headers.get("Location")).toBe(`${ISSUER}/accounts`);
  return browser;
}

async function accountsPage(browser: Browser): Promise<{ html: string; csrf: string }> {
  const res = await browser.fetch(`${ISSUER}/accounts`);
  expect(res.status).toBe(200);
  const html = await res.text();
  return { html, csrf: html.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "" };
}

function post(browser: Browser, path: string, fields: [string, string][]): Promise<Response> {
  return browser.fetch(ISSUER + path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

interface LinkForm {
  label: string;
  components?: string[];
  loginHint?: string;
  csrf?: string;
}

/** Posts the link form; returns the response (a redirect to Google when accepted). */
async function postLink(browser: Browser, form: LinkForm): Promise<Response> {
  const csrf = form.csrf ?? (await accountsPage(browser)).csrf;
  const fields: [string, string][] = [
    ["csrf", csrf],
    ["label", form.label],
    ...(form.components ?? ALL).map((c): [string, string] => ["components", c]),
  ];
  if (form.loginHint) fields.push(["login_hint", form.loginHint]);
  return post(browser, "/accounts/link", fields);
}

async function startLink(browser: Browser, form: LinkForm): Promise<URL> {
  const res = await postLink(browser, form);
  expect(res.status).toBe(302);
  const url = new URL(res.headers.get("Location") ?? "");
  expect(url.origin + url.pathname).toBe(GOOGLE_AUTHORIZE_URL);
  return url;
}

/** The whole link: form, Google as `user`, callback. Returns the callback response. */
async function link(browser: Browser, form: LinkForm, user: GoogleUser): Promise<Response> {
  return browser.fetch(google.approve(await startLink(browser, form), user));
}

async function opened(account: AccountRow, kind: TokenKind): Promise<string | undefined> {
  const row = await getToken(env.DB, account.id, kind);
  if (!row) return undefined;
  return open(row, { ownerId: account.owner_id, accountId: account.id, kind }, env);
}

function expectNoTokens(text: string): void {
  for (const pair of google.issued) {
    expect(text).not.toContain(pair.refresh);
    expect(text).not.toContain(pair.access);
  }
  expect(text).not.toMatch(/ya29\.|1\/\/refresh/);
}

describe("/accounts", () => {
  it("starts owner sign-in without a session and lists nothing until signed in", async () => {
    const browser = new Browser();
    const res = await browser.fetch(`${ISSUER}/accounts`);
    expect(res.status).toBe(302);
    const google_ = new URL(res.headers.get("Location") ?? "");
    expect(google_.searchParams.get("scope")).toBe("openid email");
    expect(browser.cookie(FLOW_COOKIE)).toBeTruthy();

    const back = await browser.fetch(google.approve(google_, OWNER));
    expect(back.headers.get("Location")).toBe(`${ISSUER}/accounts`);
    const page = await browser.fetch(`${ISSUER}/accounts`);
    expect(page.status).toBe(200);
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    const html = await page.text();
    expect(html).toContain("Signed in as owner@example.com");
    expect(html).toContain("No mailbox is linked yet.");
    expect(html).toContain('action="/accounts/link"');
  });

  it("answers 503 without account data when Google sign-in is not configured", async () => {
    await link(await signIn(), { label: "personal" }, OWNER);
    const res = await new Browser({ GOOGLE_CLIENT_ID: undefined }).fetch(`${ISSUER}/accounts`);
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain("Sign-in not configured");
    expect(html).not.toContain(OWNER.email);
    expect(html).not.toContain("personal");
  });
});

describe("link leg", () => {
  it("links a mailbox: account row, sealed tokens, granted scopes and sendAs", async () => {
    const browser = await signIn();
    const oid = await ownerId();
    const before = await env.DB.prepare("SELECT next_short_id FROM owners WHERE id = ?")
      .bind(oid)
      .first<{ next_short_id: number }>();

    const url = await startLink(browser, { label: "Personal", loginHint: OWNER.email });
    const p = url.searchParams;
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("prompt")).toBe("consent");
    expect(p.get("include_granted_scopes")).toBe("true");
    expect(p.get("login_hint")).toBe(OWNER.email);
    expect(p.get("response_type")).toBe("code");
    expect(p.get("redirect_uri")).toBe(CALLBACK);
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("client_id")).toBe("test-client");

    const res = await browser.fetch(google.approve(url, OWNER));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${ISSUER}/accounts`);
    expect(browser.cookie(FLOW_COOKIE)).toBeUndefined();

    const [account] = await accounts();
    expect(await count("accounts")).toBe(1);
    expect(account).toMatchObject({
      owner_id: oid,
      short_id: before?.next_short_id,
      label: "personal",
      address: OWNER.email,
      provider: "google",
      provider_sub: OWNER.sub,
      status: "ok",
    });
    if (!account) throw new Error("no account");
    expect(JSON.parse(account.components)).toEqual(ALL);
    expect(account.granted_scopes.split(" ")).toEqual(
      expect.arrayContaining([`${API}gmail.modify`, `${API}drive`, `${API}calendar`]),
    );
    expect(account.send_as_fetched_at).toBeGreaterThan(0);
    const after = await env.DB.prepare("SELECT next_short_id FROM owners WHERE id = ?")
      .bind(oid)
      .first<{ next_short_id: number }>();
    expect(after?.next_short_id).toBe((before?.next_short_id ?? 0) + 1);

    // Sealed: the stored bytes are not the token, and they open to what Google issued.
    const issued = google.issued.at(-1);
    const stored = await env.DB.prepare(
      "SELECT kind, ciphertext, expires_at FROM account_tokens WHERE account_id = ? ORDER BY kind",
    )
      .bind(account.id)
      .all<{ kind: string; ciphertext: ArrayBuffer | number[]; expires_at: number | null }>();
    expect(stored.results.map((r) => r.kind)).toEqual(["access", "refresh"]);
    for (const row of stored.results) {
      const bytes = new Uint8Array(row.ciphertext as ArrayBuffer);
      expectNoTokens(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
    }
    expect(stored.results[0]?.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000) + 3000);
    expect(stored.results[1]?.expires_at).toBeNull();
    expect(await opened(account, "refresh")).toBe(issued?.refresh);
    expect(await opened(account, "access")).toBe(issued?.access);

    // sendAs: fetched with the new access token, stored lowercase.
    expect(google.sendAsAuth).toEqual([`Bearer ${issued?.access}`]);
    const sendAs = await env.DB.prepare(
      "SELECT email, display_name, is_primary, is_default, verification_status, reply_to FROM send_as WHERE account_id = ? ORDER BY email",
    )
      .bind(account.id)
      .all();
    expect(sendAs.results).toEqual([
      {
        email: "alias@example.com",
        display_name: "Alias",
        is_primary: 0,
        is_default: 0,
        verification_status: "accepted",
        reply_to: "reply@example.com",
      },
      {
        email: "me@example.com",
        display_name: "Me",
        is_primary: 1,
        is_default: 1,
        verification_status: null,
        reply_to: null,
      },
    ]);

    const { html } = await accountsPage(browser);
    expect(html).toContain("<td>personal</td>");
    expect(html).toContain(`<td>${OWNER.email}</td>`);
    expect(html).toContain('action="/accounts/unlink"');
    expectNoTokens(html);
    expectNoTokens(logs.join("\n"));
    expect(logs.join("\n")).toContain('"event":"account_linked"');
  });

  it.each([
    [["mail"], ["gmail.modify", "gmail.settings.basic"]],
    [["mail.send"], ["gmail.send"]],
    [
      ["mail", "mail.send"],
      ["gmail.modify", "gmail.settings.basic"],
    ],
    [["calendar"], ["calendar"]],
    [["files"], ["drive"]],
    [["contacts"], ["contacts.readonly", "contacts.other.readonly"]],
    [
      ["calendar", "contacts"],
      ["calendar", "contacts.readonly", "contacts.other.readonly"],
    ],
    [
      ALL,
      [
        "gmail.modify",
        "gmail.settings.basic",
        "calendar",
        "drive",
        "contacts.readonly",
        "contacts.other.readonly",
      ],
    ],
  ])("asks Google for exactly the scopes of %j", async (components, scopes) => {
    const browser = await signIn();
    const url = await startLink(browser, { label: "scopes", components });
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      "openid",
      "email",
      ...scopes.map((s) => API + s),
    ]);
  });

  it("refuses a link form with no known component, a bad label or a bad address", async () => {
    const browser = await signIn();
    const flows = await linkFlows();
    for (const form of [
      { label: "x", components: ["admin"] },
      { label: "x", components: [] },
      { label: "all" },
      { label: "two words" },
      { label: "" },
      { label: "x".repeat(33) },
      { label: "x", loginHint: "not-an-address" },
    ]) {
      const res = await postLink(browser, form);
      expect(res.status).toBe(400);
    }
    expect(await linkFlows()).toBe(flows);
  });

  it("stores the scopes Google granted and leaves components without them off", async () => {
    const browser = await signIn();
    google.grant = `openid ${API}userinfo.email ${API}calendar`;
    const res = await link(browser, { label: "partial", components: ["mail", "calendar"] }, OWNER);
    expect(res.status).toBe(302);
    const [account] = await accounts();
    expect(JSON.parse(account?.components ?? "")).toEqual(["calendar"]);
    expect(account?.granted_scopes).toBe(`openid ${API}userinfo.email ${API}calendar`);
    expect(account?.send_as_fetched_at).toBeNull();
    expect(google.sendAsAuth).toEqual([]);
  });

  it("refuses a mailbox that is not on LINKABLE_EMAILS and stores nothing", async () => {
    const browser = await signIn();
    const res = await link(browser, { label: "stranger" }, STRANGER);
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain("Not allowed");
    expectNoTokens(html);

    // LINKABLE_EMAILS is its own list: an owner address not on it is refused too.
    const narrow = await signIn({ LINKABLE_EMAILS: WORK.email });
    expect((await link(narrow, { label: "owner" }, OWNER)).status).toBe(403);

    expect(await count("accounts")).toBe(0);
    expect(await count("account_tokens")).toBe(0);
    expect(await count("send_as")).toBe(0);
    expect(google.sendAsAuth).toEqual([]);
    const text = logs.join("\n");
    expect(text).toContain('"reason":"not_linkable"');
    expect(text).not.toContain(STRANGER.email);
    expectNoTokens(text);
  });

  it("refuses a callback for a flow another owner started, before exchanging the code", async () => {
    const browser = await signIn();
    const { state, setCookie } = await createFlow(env.DB, "link", {
      ownerId: "o_aaaaaaaaaaaaaaaa",
      label: "hijack",
      components: ["mail"],
      verifier: "v",
      nonce: "n",
    });
    browser.setCookie(FLOW_COOKIE, setCookie.split(";")[0]?.split("=")[1] ?? "");
    const res = await browser.fetch(`${CALLBACK}?state=${state}&code=attacker-code`);
    expect(res.status).toBe(403);
    expect(google.linkExchanges).toHaveLength(0);
    expect(await count("accounts")).toBe(0);
    expect(logs.join("\n")).toContain('"reason":"owner_mismatch"');
  });

  it("refuses a callback without the owner session", async () => {
    const browser = await signIn();
    const url = await startLink(browser, { label: "nosession" });
    const anonymous = new Browser();
    anonymous.setCookie(FLOW_COOKIE, browser.cookie(FLOW_COOKIE) ?? "");
    const res = await anonymous.fetch(google.approve(url, OWNER));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Sign-in expired");
    expect(google.linkExchanges).toHaveLength(0);
    expect(await count("accounts")).toBe(0);
  });

  it("refuses a callback without the flow cookie, and the state cannot be retried", async () => {
    const browser = await signIn();
    const url = await startLink(browser, { label: "nocookie" });
    const callback = google.approve(url, OWNER);
    const sessionOnly = new Browser();
    sessionOnly.setCookie(SESSION_COOKIE, browser.cookie(SESSION_COOKIE) ?? "");
    const res = await sessionOnly.fetch(callback);
    expect(res.status).toBe(400);
    // The row went with the first try, so the right browser cannot finish it either.
    expect((await browser.fetch(callback)).status).toBe(400);
    expect(google.linkExchanges).toHaveLength(0);
    expect(await count("accounts")).toBe(0);
  });

  it("refuses a replayed state", async () => {
    const browser = await signIn();
    const url = await startLink(browser, { label: "replay" });
    const flowCookie = browser.cookie(FLOW_COOKIE) ?? "";
    const callback = google.approve(url, OWNER);
    expect((await browser.fetch(callback)).status).toBe(302);
    const [first] = await accounts();
    const tokenBefore = first ? await opened(first, "refresh") : undefined;

    browser.setCookie(FLOW_COOKIE, flowCookie);
    const replay = await browser.fetch(callback);
    expect(replay.status).toBe(400);
    expect(google.linkExchanges).toHaveLength(1);
    expect(await count("accounts")).toBe(1);
    if (first) expect(await opened(first, "refresh")).toBe(tokenBefore);
  });

  it("relinking the same address updates the account in place", async () => {
    const browser = await signIn({ LINKABLE_EMAILS: WORK.email });
    await link(browser, { label: "work", components: ["mail"] }, WORK);
    const [before] = await accounts();
    if (!before) throw new Error("no account");
    const next = await env.DB.prepare("SELECT next_short_id FROM owners WHERE id = ?")
      .bind(before.owner_id)
      .first<{ next_short_id: number }>();

    const res = await link(browser, { label: "job", components: ["mail", "calendar"] }, WORK);
    expect(res.status).toBe(302);
    const rows = await accounts();
    expect(rows).toHaveLength(1);
    const [after] = rows;
    if (!after) throw new Error("no account");
    expect(after.id).toBe(before.id);
    expect(after.short_id).toBe(before.short_id);
    expect(after.created_at).toBe(before.created_at);
    expect(after.label).toBe("job");
    expect(JSON.parse(after.components)).toEqual(["mail", "calendar"]);
    expect(await opened(after, "refresh")).toBe(google.issued.at(-1)?.refresh);
    expect(await opened(after, "access")).toBe(google.issued.at(-1)?.access);
    expect(await count("account_tokens")).toBe(2);
    expect(google.revoked).toEqual([]);
    const nextAfter = await env.DB.prepare("SELECT next_short_id FROM owners WHERE id = ?")
      .bind(after.owner_id)
      .first<{ next_short_id: number }>();
    expect(nextAfter?.next_short_id).toBe(next?.next_short_id);
    expect(await count("send_as")).toBe(2);

    // A relink without mail drops the sendAs cache.
    expect((await link(browser, { label: "job", components: ["calendar"] }, WORK)).status).toBe(
      302,
    );
    const [noMail] = await accounts();
    expect(noMail?.send_as_fetched_at).toBeNull();
    expect(await count("send_as")).toBe(0);
  });

  it("answers 503 and starts nothing when the token key is missing", async () => {
    const browser = await signIn({ TOKEN_KEK: undefined });
    const flows = await linkFlows();
    const res = await postLink(browser, { label: "nokey", components: ["mail"] });
    expect(res.status).toBe(503);
    expect(res.headers.get("Location")).toBeNull();
    expect(await linkFlows()).toBe(flows);
    expect(google.linkExchanges).toHaveLength(0);
  });

  it("refuses a label another mailbox already has", async () => {
    const browser = await signIn({ LINKABLE_EMAILS: `${WORK.email},${OTHER.email}` });
    expect((await link(browser, { label: "shared" }, WORK)).status).toBe(302);
    const res = await link(browser, { label: "shared" }, OTHER);
    expect(res.status).toBe(409);
    const rows = await accounts();
    expect(rows.map((a) => a.address)).toEqual([WORK.email]);
    expect(await count("account_tokens")).toBe(2);
  });
});

describe("CSRF", () => {
  it("refuses the link form without the session's CSRF token", async () => {
    const browser = await signIn();
    const other = await signIn();
    const flows = await linkFlows();
    for (const csrf of ["", "wrong", (await accountsPage(other)).csrf]) {
      const res = await postLink(browser, { label: "csrf", csrf });
      expect(res.status).toBe(403);
      expect(res.headers.get("Location")).toBeNull();
    }
    const missing = await post(browser, "/accounts/link", [
      ["label", "csrf"],
      ["components", "mail"],
    ]);
    expect(missing.status).toBe(403);
    const noSession = await post(new Browser(), "/accounts/link", [
      ["csrf", (await accountsPage(browser)).csrf],
      ["label", "csrf"],
      ["components", "mail"],
    ]);
    expect(noSession.status).toBe(403);
    expect(await linkFlows()).toBe(flows);
  });

  it("refuses unlink without the session's CSRF token", async () => {
    const browser = await signIn();
    await link(browser, { label: "keep" }, OWNER);
    const [account] = await accounts();
    if (!account) throw new Error("no account");
    for (const csrf of [undefined, "", "wrong", (await accountsPage(await signIn())).csrf]) {
      const fields: [string, string][] = [["account", account.id]];
      if (csrf !== undefined) fields.push(["csrf", csrf]);
      expect((await post(browser, "/accounts/unlink", fields)).status).toBe(403);
    }
    expect(await count("accounts")).toBe(1);
    expect(await count("account_tokens")).toBe(2);
    expect(google.revoked).toEqual([]);
  });
});

describe("unlink", () => {
  it("revokes the refresh token at Google and removes the rows", async () => {
    const browser = await signIn();
    await link(browser, { label: "gone" }, OWNER);
    const [account] = await accounts();
    if (!account) throw new Error("no account");
    await env.DB.prepare("UPDATE owners SET default_account_id = ? WHERE id = ?")
      .bind(account.id, account.owner_id)
      .run();
    const { html, csrf } = await accountsPage(browser);
    expect(html).toContain("<td>default</td>");

    const res = await post(browser, "/accounts/unlink", [
      ["csrf", csrf],
      ["account", account.id],
    ]);
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("Mailbox unlinked");
    expect(page).toContain("revoked");
    expectNoTokens(page);
    expect(google.revoked).toEqual([google.issued.at(-1)?.refresh]);
    expect(await count("accounts")).toBe(0);
    expect(await count("account_tokens")).toBe(0);
    expect(await count("send_as")).toBe(0);
    const owner = await env.DB.prepare("SELECT default_account_id FROM owners WHERE id = ?")
      .bind(account.owner_id)
      .first<{ default_account_id: string | null }>();
    expect(owner?.default_account_id).toBeNull();
    expect((await accountsPage(browser)).html).toContain("No mailbox is linked yet.");
  });

  it("removes the rows when Google does not confirm, and says so", async () => {
    const browser = await signIn();
    await link(browser, { label: "flaky" }, OWNER);
    const [account] = await accounts();
    google.revokeStatus = 503;
    const res = await post(browser, "/accounts/unlink", [
      ["csrf", (await accountsPage(browser)).csrf],
      ["account", account?.id ?? ""],
    ]);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("did not confirm");
    expect(google.revoked).toHaveLength(1);
    expect(await count("accounts")).toBe(0);
  });

  it("answers 404 for an account that is not the owner's", async () => {
    const browser = await signIn();
    const res = await post(browser, "/accounts/unlink", [
      ["csrf", (await accountsPage(browser)).csrf],
      ["account", "ac_aaaaaaaaaaaaaaaa"],
    ]);
    expect(res.status).toBe(404);
    expect(google.revoked).toEqual([]);
  });
});

// M7b: component toggles, default account, relink, re-link minimal, re-encrypt, and the M7a review
// nits (a refused link drops the new grant; an identity-only grant is refused).

const calls = (): number => vi.mocked(globalThis.fetch).mock.calls.length;

const componentsOf = async (): Promise<string[]> =>
  JSON.parse((await accounts())[0]?.components ?? "[]");

const defaultAccount = async (): Promise<string | null> =>
  (await env.DB.prepare("SELECT default_account_id AS d FROM owners").first<{ d: string | null }>())
    ?.d ?? null;

async function control(
  browser: Browser,
  path: string,
  account: AccountRow,
  extra: [string, string][] = [],
): Promise<Response> {
  return post(browser, `/accounts/${path}`, [
    ["csrf", (await accountsPage(browser)).csrf],
    ["account", account.id],
    ...extra,
  ]);
}

const toggle = (browser: Browser, account: AccountRow, component: string, on: boolean) =>
  control(browser, "component", account, [
    ["component", component],
    ["on", on ? "1" : "0"],
  ]);

async function linked(browser: Browser, label: string, components = ALL): Promise<AccountRow> {
  expect((await link(browser, { label, components }, OWNER)).status).toBe(302);
  const account = (await accounts()).find((a) => a.label === label);
  if (!account) throw new Error("no account");
  return account;
}

/** A browser with the same session but another environment (key rotation, missing key). */
function sameSession(browser: Browser, overrides: Record<string, string | undefined>): Browser {
  const other = new Browser(overrides as Partial<Cloudflare.Env>);
  other.setCookie(SESSION_COOKIE, browser.cookie(SESSION_COOKIE) ?? "");
  return other;
}

describe("component toggles", () => {
  it("turning a component on asks Google for only the added scopes and stores what it returns", async () => {
    const browser = await signIn();
    const account = await linked(browser, "grow", ["calendar"]);
    const before = google.issued.length;

    const res = await toggle(browser, account, "files", true);
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("Location") ?? "");
    expect(url.origin + url.pathname).toBe(GOOGLE_AUTHORIZE_URL);
    expect(url.searchParams.get("scope")).toBe(`openid email ${API}drive`);
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("login_hint")).toBe(OWNER.email);
    // Nothing changes until Google answers.
    expect(await componentsOf()).toEqual(["calendar"]);

    // Google returns everything granted so far, not only what was asked now.
    google.grant = `openid email ${API}calendar ${API}drive`;
    const back = await browser.fetch(google.approve(url, OWNER));
    expect(back.status).toBe(302);
    expect(back.headers.get("Location")).toBe(`${ISSUER}/accounts`);
    const rows = await accounts();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(account.id);
    expect(rows[0]?.label).toBe("grow");
    expect(await componentsOf()).toEqual(["calendar", "files"]);
    expect(rows[0]?.granted_scopes.split(" ")).toEqual(
      expect.arrayContaining([`${API}calendar`, `${API}drive`]),
    );
    expect(google.issued).toHaveLength(before + 1);
    expect(await opened(rows[0] as AccountRow, "refresh")).toBe(google.issued.at(-1)?.refresh);
    expect((await accountsPage(browser)).html).toContain("Drive files: on");
  });

  it("turning a component on needs no consent when Google already granted its scopes", async () => {
    const browser = await signIn();
    const account = await linked(browser, "regrow");
    expect((await toggle(browser, account, "calendar", false)).status).toBe(303);
    expect(await componentsOf()).not.toContain("calendar");
    const flows = await linkFlows();
    const before = calls();

    const res = await toggle(browser, account, "calendar", true);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`${ISSUER}/accounts`);
    expect(await componentsOf()).toEqual(ALL);
    expect(await linkFlows()).toBe(flows);
    expect(calls()).toBe(before);
  });

  it("turning a component off updates D1 at once and does not call Google", async () => {
    const browser = await signIn();
    const account = await linked(browser, "shrink");
    const page = await accountsPage(browser);
    const before = calls();
    const issued = google.issued.length;

    const res = await toggle(browser, account, "mail.send", false);
    expect(res.status).toBe(303);
    expect(await componentsOf()).toEqual(["mail", "calendar", "files", "contacts"]);
    expect(calls()).toBe(before);
    expect(google.issued).toHaveLength(issued);
    expect(google.revoked).toEqual([]);
    expect(page.html).toContain("Mail: send: on");
    expect((await accountsPage(browser)).html).toContain("Mail: send: off");
    // A repeat is harmless.
    expect((await toggle(browser, account, "mail.send", false)).status).toBe(303);
    expect(await componentsOf()).not.toContain("mail.send");
  });

  it("keeps a component off that was switched off while the owner was at Google", async () => {
    const browser = await signIn();
    const account = await linked(browser, "race", ["mail", "calendar"]);
    const url = new URL(
      (await toggle(browser, account, "files", true)).headers.get("Location") ?? "",
    );
    expect((await toggle(browser, account, "calendar", false)).status).toBe(303);

    google.grant = `openid email ${API}gmail.modify ${API}gmail.settings.basic ${API}calendar ${API}drive`;
    expect((await browser.fetch(google.approve(url, OWNER))).status).toBe(302);
    expect(await componentsOf()).toEqual(["mail", "files"]);
  });

  it("asks for every component that is on when the account needs a relink", async () => {
    const browser = await signIn();
    const account = await linked(browser, "dead", ["calendar"]);
    await env.DB.prepare("UPDATE accounts SET status = 'needs_relink' WHERE id = ?")
      .bind(account.id)
      .run();
    const res = await toggle(browser, account, "files", true);
    const url = new URL(res.headers.get("Location") ?? "");
    expect(url.searchParams.get("scope")).toBe(`openid email ${API}calendar ${API}drive`);
  });

  it("refuses an unknown component, a missing choice and another owner's account", async () => {
    const browser = await signIn();
    const account = await linked(browser, "odd");
    expect((await toggle(browser, account, "admin", true)).status).toBe(400);
    const none = await control(browser, "component", account, [["component", "mail"]]);
    expect(none.status).toBe(400);
    const stranger = await toggle(
      browser,
      { ...account, id: "ac_aaaaaaaaaaaaaaaa" },
      "mail",
      false,
    );
    expect(stranger.status).toBe(404);
    expect(await componentsOf()).toEqual(ALL);
  });
});

describe("re-link minimal", () => {
  it("revokes the grant, then asks again for only the components that are on", async () => {
    const browser = await signIn();
    const account = await linked(browser, "trim");
    expect((await accountsPage(browser)).html).not.toContain("/accounts/relink-minimal");
    for (const c of ["mail.send", "calendar", "files", "contacts"]) {
      await toggle(browser, account, c, false);
    }
    expect(await componentsOf()).toEqual(["mail"]);
    expect((await accountsPage(browser)).html).toContain("/accounts/relink-minimal");
    const oldRefresh = google.issued.at(-1)?.refresh;

    const res = await control(browser, "relink-minimal", account);
    expect(res.status).toBe(302);
    expect(google.revoked).toEqual([oldRefresh]);
    const url = new URL(res.headers.get("Location") ?? "");
    expect(url.searchParams.get("scope")).toBe(
      `openid email ${API}gmail.modify ${API}gmail.settings.basic`,
    );
    expect(url.searchParams.get("login_hint")).toBe(OWNER.email);
    // Until the owner answers, the old tokens are dead and tools must refuse.
    expect((await accounts())[0]?.status).toBe("needs_relink");
    expect(await count("account_tokens")).toBe(0);

    expect((await browser.fetch(google.approve(url, OWNER))).status).toBe(302);
    const [after] = await accounts();
    expect(after).toMatchObject({ id: account.id, status: "ok" });
    expect(await componentsOf()).toEqual(["mail"]);
    expect(after?.granted_scopes.split(" ")).toEqual([
      "openid",
      "email",
      `${API}gmail.modify`,
      `${API}gmail.settings.basic`,
    ]);
    expect(await opened(after as AccountRow, "refresh")).toBe(google.issued.at(-1)?.refresh);
    expect((await accountsPage(browser)).html).not.toContain("/accounts/relink-minimal");
  });

  it("changes nothing when Google does not confirm the revocation", async () => {
    const browser = await signIn();
    const account = await linked(browser, "stuck");
    await toggle(browser, account, "files", false);
    google.revokeStatus = 503;
    const res = await control(browser, "relink-minimal", account);
    expect(res.status).toBe(502);
    expect(res.headers.get("Location")).toBeNull();
    expect((await accounts())[0]?.status).toBe("ok");
    expect(await count("account_tokens")).toBe(2);
  });

  it("starts nothing, and revokes nothing, when the token key is missing", async () => {
    const browser = await signIn();
    const account = await linked(browser, "nokey");
    await toggle(browser, account, "files", false);
    const nokey = sameSession(browser, { TOKEN_KEK: undefined });
    const res = await control(nokey, "relink-minimal", account);
    expect(res.status).toBe(503);
    expect(google.revoked).toEqual([]);
    expect(await count("account_tokens")).toBe(2);
  });
});

describe("relink", () => {
  it("runs the link leg for the address and resets needs_relink to ok", async () => {
    const browser = await signIn();
    const account = await linked(browser, "stale", ["mail", "calendar"]);
    await env.DB.prepare("UPDATE accounts SET status = 'needs_relink' WHERE id = ?")
      .bind(account.id)
      .run();
    await env.DB.prepare("DELETE FROM account_tokens WHERE kind = 'access'").run();
    const page = (await accountsPage(browser)).html;
    expect(page).toContain("needs re-link");
    expect(page).toContain("/accounts/relink");

    const res = await control(browser, "relink", account);
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("Location") ?? "");
    expect(url.searchParams.get("login_hint")).toBe(OWNER.email);
    expect(url.searchParams.get("scope")).toBe(
      `openid email ${API}gmail.modify ${API}gmail.settings.basic ${API}calendar`,
    );
    expect((await browser.fetch(google.approve(url, OWNER))).status).toBe(302);
    const [after] = await accounts();
    expect(after).toMatchObject({ id: account.id, status: "ok" });
    expect(await componentsOf()).toEqual(["mail", "calendar"]);
    expect(await opened(after as AccountRow, "refresh")).toBe(google.issued.at(-1)?.refresh);
    expect(await opened(after as AccountRow, "access")).toBe(google.issued.at(-1)?.access);
    expect((await accountsPage(browser)).html).not.toContain("needs re-link");
  });

  it("refuses another Google account, stores nothing and drops that grant", async () => {
    const browser = await signIn({ LINKABLE_EMAILS: `${OWNER.email},${OTHER.email}` });
    const account = await linked(browser, "pinned");
    await env.DB.prepare("UPDATE accounts SET status = 'needs_relink' WHERE id = ?")
      .bind(account.id)
      .run();
    const before = await opened(account, "refresh");

    const url = new URL((await control(browser, "relink", account)).headers.get("Location") ?? "");
    const res = await browser.fetch(google.approve(url, OTHER));
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("Wrong Google account");
    expect((await accounts())[0]?.status).toBe("needs_relink");
    expect(await opened(account, "refresh")).toBe(before);
    expect(await count("accounts")).toBe(1);
    expect(google.revoked).toEqual([google.issued.at(-1)?.refresh]);
  });

  it("refuses a relink of a mailbox with no component on", async () => {
    const browser = await signIn();
    const account = await linked(browser, "empty", ["calendar"]);
    await toggle(browser, account, "calendar", false);
    expect((await control(browser, "relink", account)).status).toBe(400);
    expect((await control(browser, "relink-minimal", account)).status).toBe(400);
  });
});

describe("default account", () => {
  it("is set and cleared from the page, and unlink clears it", async () => {
    const browser = await signIn({ LINKABLE_EMAILS: `${OWNER.email},${WORK.email}` });
    const a = await linked(browser, "first");
    expect((await link(browser, { label: "second" }, WORK)).status).toBe(302);
    const b = (await accounts()).find((x) => x.label === "second") as AccountRow;
    expect(await defaultAccount()).toBeNull();

    expect((await control(browser, "default", b)).status).toBe(303);
    expect(await defaultAccount()).toBe(b.id);
    let html = (await accountsPage(browser)).html;
    expect(html).toContain("<td>default</td>");
    expect(html).toContain(`<option value="${b.id}" selected>`);

    expect((await control(browser, "default", a)).status).toBe(303);
    expect(await defaultAccount()).toBe(a.id);

    const clear = await post(browser, "/accounts/default", [
      ["csrf", (await accountsPage(browser)).csrf],
      ["account", ""],
    ]);
    expect(clear.status).toBe(303);
    expect(await defaultAccount()).toBeNull();

    // Only the owner's own accounts, and unlink of the default clears it.
    const foreign = await control(browser, "default", { ...a, id: "ac_aaaaaaaaaaaaaaaa" });
    expect(foreign.status).toBe(404);
    expect(await defaultAccount()).toBeNull();
    await control(browser, "default", b);
    expect(await defaultAccount()).toBe(b.id);
    expect((await control(browser, "unlink", b)).status).toBe(200);
    expect(await defaultAccount()).toBeNull();
    html = (await accountsPage(browser)).html;
    expect(html).not.toContain("<td>default</td>");
  });
});

describe("re-encrypt all", () => {
  const key2 = btoa(String.fromCharCode(...randomBytes(32)));

  it("moves v1 rows to v2 when CURRENT_KEY_VERSION is 2, and reports the count only", async () => {
    const browser = await signIn();
    const account = await linked(browser, "rotate");
    const issued = google.issued.at(-1);
    const versions = async () =>
      (
        await env.DB.prepare("SELECT key_version AS v FROM account_tokens ORDER BY kind").all<{
          v: number;
        }>()
      ).results.map((r) => r.v);
    expect(await versions()).toEqual([1, 1]);

    const rotated = sameSession(browser, { CURRENT_KEY_VERSION: "2", TOKEN_KEK_v2: key2 });
    const { html, csrf } = await accountsPage(rotated);
    expect(html).toContain("key version 2");
    expect(html).toContain("2 stored token(s) use another version");

    const res = await post(rotated, "/accounts/reencrypt", [["csrf", csrf]]);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("2 token(s) moved to key version 2; 0 already used it.");
    expectNoTokens(text);
    expect(await versions()).toEqual([2, 2]);
    const rotatedEnv = { ...env, CURRENT_KEY_VERSION: "2", TOKEN_KEK_v2: key2 };
    for (const [kind, token] of [
      ["refresh", issued?.refresh],
      ["access", issued?.access],
    ] as const) {
      const row = await getToken(env.DB, account.id, kind);
      if (!row) throw new Error("no row");
      expect(
        await open(row, { ownerId: account.owner_id, accountId: account.id, kind }, rotatedEnv),
      ).toBe(token);
    }
    expectNoTokens(logs.join("\n"));

    // A second run has nothing left to move.
    const again = await post(rotated, "/accounts/reencrypt", [
      ["csrf", (await accountsPage(rotated)).csrf],
    ]);
    expect(await again.text()).toContain("0 token(s) moved to key version 2; 2 already used it.");
  });

  it("refuses without the new key, and leaves rows it cannot open as they are", async () => {
    const browser = await signIn();
    await linked(browser, "broken");
    const nokey = sameSession(browser, { CURRENT_KEY_VERSION: "2" });
    const refused = await post(nokey, "/accounts/reencrypt", [
      ["csrf", (await accountsPage(nokey)).csrf],
    ]);
    expect(refused.status).toBe(503);

    await env.DB.prepare(
      "UPDATE account_tokens SET iv = randomblob(12) WHERE kind = 'access'",
    ).run();
    const rotated = sameSession(browser, { CURRENT_KEY_VERSION: "2", TOKEN_KEK_v2: key2 });
    const res = await post(rotated, "/accounts/reencrypt", [
      ["csrf", (await accountsPage(rotated)).csrf],
    ]);
    const text = await res.text();
    expect(text).toContain("1 token(s) moved");
    expect(text).toContain("1 could not be opened");
  });
});

describe("controls need the session and its CSRF token", () => {
  it("refuses every new POST without it, and changes nothing", async () => {
    const browser = await signIn();
    const account = await linked(browser, "guard");
    const other = await accountsPage(await signIn());
    const snapshot = async () =>
      JSON.stringify([
        (await env.DB.prepare("SELECT * FROM accounts").all()).results,
        (await env.DB.prepare("SELECT * FROM account_tokens").all()).results,
        await defaultAccount(),
      ]);
    const before = await snapshot();
    const flows = await linkFlows();
    const calls0 = calls();
    const bodies: Record<string, [string, string][]> = {
      component: [
        ["component", "mail"],
        ["on", "0"],
      ],
      relink: [],
      "relink-minimal": [],
      default: [],
      reencrypt: [],
    };
    for (const [path, extra] of Object.entries(bodies)) {
      for (const csrf of [undefined, "", "wrong", other.csrf]) {
        const fields: [string, string][] = [["account", account.id], ...extra];
        if (csrf !== undefined) fields.push(["csrf", csrf]);
        const res = await post(browser, `/accounts/${path}`, fields);
        expect(res.status, `${path} csrf=${csrf}`).toBe(403);
        expect(res.headers.get("Location")).toBeNull();
      }
      const fields: [string, string][] = [
        ["csrf", (await accountsPage(browser)).csrf],
        ["account", account.id],
        ...extra,
      ];
      expect((await post(new Browser(), `/accounts/${path}`, fields)).status).toBe(403);
    }
    expect(await snapshot()).toBe(before);
    expect(await linkFlows()).toBe(flows);
    expect(google.revoked).toEqual([]);
    expect(calls()).toBe(calls0);
  });
});

describe("a refused link drops the new grant", () => {
  it("revokes it when the address is not linkable and no account holds it", async () => {
    const browser = await signIn();
    expect((await link(browser, { label: "x" }, STRANGER)).status).toBe(403);
    expect(google.revoked).toEqual([google.issued.at(-1)?.refresh]);
    expect(logs.join("\n")).toContain('"event":"link_grant_discarded"');
    expectNoTokens(logs.join("\n"));
  });

  it("does not revoke when an account already holds the address", async () => {
    await linked(await signIn(), "held");
    const narrow = await signIn({ LINKABLE_EMAILS: WORK.email });
    expect((await link(narrow, { label: "again" }, OWNER)).status).toBe(403);
    expect(google.revoked).toEqual([]);
    expect(await count("account_tokens")).toBe(2);
  });

  it("revokes it on a label clash, but not when the address is already linked", async () => {
    const browser = await signIn({ LINKABLE_EMAILS: `${WORK.email},${OTHER.email}` });
    expect((await link(browser, { label: "shared" }, WORK)).status).toBe(302);
    expect((await link(browser, { label: "shared" }, OTHER)).status).toBe(409);
    expect(google.revoked).toEqual([google.issued.at(-1)?.refresh]);
    google.revoked.length = 0;
    expect((await link(browser, { label: "mine" }, OTHER)).status).toBe(302);
    // WORK is linked, so a clash on its relink must keep the grant it shares with the account.
    expect((await link(browser, { label: "mine" }, WORK)).status).toBe(409);
    expect(google.revoked).toEqual([]);
  });

  it("refuses an identity-only grant and drops it", async () => {
    const browser = await signIn();
    google.grant = `openid ${API}userinfo.email`;
    const res = await link(browser, { label: "bare" }, OWNER);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Nothing granted");
    expect(await count("accounts")).toBe(0);
    expect(await count("account_tokens")).toBe(0);
    expect(google.revoked).toEqual([google.issued.at(-1)?.refresh]);
  });

  it("names the components Google left out", async () => {
    const browser = await signIn();
    google.grant = `openid email ${API}calendar`;
    const res = await link(browser, { label: "part", components: ["mail", "calendar"] }, OWNER);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${ISSUER}/accounts?partial=mail`);
    const html = await (await browser.fetch(res.headers.get("Location") ?? "")).text();
    expect(html).toContain("Google did not grant everything");
    expect(html).toContain("Mail: read, organize, drafts, filters");
    expect(await componentsOf()).toEqual(["calendar"]);
  });

  it("logs a changed Google user id on a relink", async () => {
    const browser = await signIn({ LINKABLE_EMAILS: WORK.email });
    await link(browser, { label: "work" }, WORK);
    expect((await link(browser, { label: "work" }, { ...WORK, sub: "999" })).status).toBe(302);
    expect((await accounts())[0]?.provider_sub).toBe("999");
    expect(logs.join("\n")).toContain('"event":"sub_changed"');
  });

  it("words the flow failure page for sign-in and link alike", async () => {
    const browser = await signIn();
    const callback = google.approve(await startLink(browser, { label: "twice" }), OWNER);
    const flowCookie = browser.cookie(FLOW_COOKIE) ?? "";
    await browser.fetch(callback);
    browser.setCookie(FLOW_COOKIE, flowCookie);
    const replay = await browser.fetch(callback);
    expect(replay.status).toBe(400);
    const text = await replay.text();
    expect(text).toContain("Link not valid");
    expect(text).toContain("sign-in or link request");
  });
});
