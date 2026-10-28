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
