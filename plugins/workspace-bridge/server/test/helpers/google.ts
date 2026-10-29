// Fake Google (ARCHITECTURE s.6). For the sign-in tests `fetch` is stubbed and only Google's
// token endpoint answers: it checks the client credentials, the redirect URI and the PKCE
// verifier, uses each code once, and returns an unsigned ID token with test claims. For tool
// tests, `installGoogleRoutes` answers a route table of Google API URLs and `linkGoogleAccount`
// seeds a linked account with sealed tokens. Any other outgoing request fails the test.

import { env } from "cloudflare:workers";
import { vi } from "vitest";
import { GOOGLE_AUTHORIZE_URL, GOOGLE_TOKEN_URL } from "../../src/auth/google-oidc";
import { base64url, randomBytes, randomId, seal, sha256 } from "../../src/core/crypto";
import { type AccountRow, insertAccount, nowSeconds, upsertToken } from "../../src/core/db";

export const GOOGLE_CLIENT_ID = "test-client";
export const GOOGLE_CLIENT_SECRET = "test-secret";

export interface GoogleUser {
  email: string;
  sub: string;
  /** Claims to add or replace in the ID token, such as `email_verified: false`. */
  claims?: Record<string, unknown>;
}

interface IssuedCode {
  user: GoogleUser;
  challenge: string;
  nonce: string;
  redirectUri: string;
}

const encode = (value: unknown): string =>
  base64url(new TextEncoder().encode(JSON.stringify(value)));

export class FakeGoogle {
  private readonly codes = new Map<string, IssuedCode>();
  /** Bodies posted to the token endpoint. */
  readonly tokenRequests: URLSearchParams[] = [];

  /**
   * The owner picks `user` on Google's page for `authorizeUrl` (the Worker's redirect to Google):
   * returns the callback URL Google would send the browser to.
   */
  approve(authorizeUrl: string | URL, user: GoogleUser): string {
    const url = new URL(authorizeUrl);
    if (url.origin + url.pathname !== GOOGLE_AUTHORIZE_URL) throw new Error(`not Google: ${url}`);
    const p = url.searchParams;
    const code = `code-${base64url(randomBytes(12))}`;
    this.codes.set(code, {
      user,
      challenge: p.get("code_challenge") ?? "",
      nonce: p.get("nonce") ?? "",
      redirectUri: p.get("redirect_uri") ?? "",
    });
    const callback = new URL(p.get("redirect_uri") ?? "");
    callback.searchParams.set("state", p.get("state") ?? "");
    callback.searchParams.set("code", code);
    return callback.toString();
  }

  /** The owner cancels on Google's page: the callback URL with `error=access_denied`. */
  cancel(authorizeUrl: string | URL): string {
    const p = new URL(authorizeUrl).searchParams;
    const callback = new URL(p.get("redirect_uri") ?? "");
    callback.searchParams.set("state", p.get("state") ?? "");
    callback.searchParams.set("error", "access_denied");
    return callback.toString();
  }

  async token(req: Request): Promise<Response> {
    const body = new URLSearchParams(new TextDecoder().decode(await req.arrayBuffer()));
    this.tokenRequests.push(body);
    const fail = (error: string) => Response.json({ error }, { status: 400 });
    const issued = this.codes.get(body.get("code") ?? "");
    if (!issued) return fail("invalid_grant");
    this.codes.delete(body.get("code") ?? "");
    if (body.get("grant_type") !== "authorization_code") return fail("unsupported_grant_type");
    if (
      body.get("client_id") !== GOOGLE_CLIENT_ID ||
      body.get("client_secret") !== GOOGLE_CLIENT_SECRET
    ) {
      return fail("invalid_client");
    }
    if (body.get("redirect_uri") !== issued.redirectUri) return fail("redirect_uri_mismatch");
    if (base64url(await sha256(body.get("code_verifier") ?? "")) !== issued.challenge) {
      return fail("invalid_grant");
    }
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: "https://accounts.google.com",
      azp: GOOGLE_CLIENT_ID,
      aud: GOOGLE_CLIENT_ID,
      sub: issued.user.sub,
      email: issued.user.email,
      email_verified: true,
      nonce: issued.nonce,
      iat: now,
      exp: now + 3600,
      ...issued.user.claims,
    };
    return Response.json({
      access_token: "ya29.fake",
      expires_in: 3599,
      token_type: "Bearer",
      scope: "openid https://www.googleapis.com/auth/userinfo.email",
      id_token: `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}.${encode("unsigned")}`,
    });
  }
}

/** Stubs `fetch` with a fresh fake Google; restore with `vi.restoreAllMocks()`. */
export function installFakeGoogle(): FakeGoogle {
  const google = new FakeGoogle();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    if (req.method === "POST" && req.url === GOOGLE_TOKEN_URL) return google.token(req);
    throw new Error(`unexpected fetch: ${req.method} ${req.url}`);
  });
  return google;
}

/** One route of the fake Google APIs. */
export interface GoogleRoute {
  /** `GET` by default. */
  method?: string;
  /** Matched against the URL without its query; a trailing `*` matches a prefix. */
  url: string;
  /** `n` counts the calls this route has answered before, from 0. */
  reply: (req: Request, n: number) => Response | Promise<Response>;
}

/** A request the fake answered: what a test may assert on. */
export interface GoogleCall {
  method: string;
  /** The full URL, query included. */
  url: string;
  authorization: string | null;
  body: string;
}

/** A Google JSON answer, such as an error body `{ error: { code, status, errors } }`. */
export const googleJson = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

/** The token endpoint's answer to a refresh: `access_token` is the token handed out. */
export const tokenRoute = (access_token: string): GoogleRoute => ({
  method: "POST",
  url: GOOGLE_TOKEN_URL,
  reply: () =>
    googleJson(200, { access_token, expires_in: 3599, token_type: "Bearer", scope: "openid" }),
});

/**
 * Stubs `fetch` with a route table; restore with `vi.restoreAllMocks()`. The first matching route
 * answers; an unmatched request throws. Returns the calls made, in order.
 */
export function installGoogleRoutes(routes: readonly GoogleRoute[]): GoogleCall[] {
  const calls: GoogleCall[] = [];
  const counts = new Map<GoogleRoute, number>();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const bare = url.origin + url.pathname;
    calls.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.get("Authorization"),
      body: await req.clone().text(),
    });
    const route = routes.find(
      (r) =>
        (r.method ?? "GET") === req.method &&
        (r.url.endsWith("*") ? bare.startsWith(r.url.slice(0, -1)) : bare === r.url),
    );
    if (!route) throw new Error(`unexpected fetch: ${req.method} ${req.url}`);
    const n = counts.get(route) ?? 0;
    counts.set(route, n + 1);
    return route.reply(req, n);
  });
  return calls;
}

/** A new owner row; storage is not rolled back between tests, so each test makes its own. */
export async function newOwner(): Promise<string> {
  const id = randomId("o_");
  await env.DB.prepare("INSERT INTO owners (id, created_at) VALUES (?, 0)").bind(id).run();
  return id;
}

export interface LinkedGoogle {
  row: AccountRow;
  accessToken: string;
  refreshToken: string;
}

/**
 * A linked Google account with sealed tokens: an access token valid for an hour, so the first
 * call needs no refresh, and a refresh token. Components default to every component, with the
 * scopes stored as granted.
 */
export async function linkGoogleAccount(
  ownerId: string,
  opts: { label?: string; components?: readonly string[]; grantedScopes?: string } = {},
): Promise<LinkedGoogle> {
  const label = opts.label ?? "work";
  const row = await insertAccount(env.DB, {
    ownerId,
    label,
    address: `${label}@example.com`,
    provider: "google",
    components: opts.components ?? ["mail", "mail.send", "calendar", "files", "contacts"],
    grantedScopes: opts.grantedScopes ?? "",
  });
  if (!row) throw new Error("account insert failed");
  const accessToken = `ya29.${randomId("at-")}`;
  const refreshToken = `1//${randomId("rt-")}`;
  const who = { ownerId, accountId: row.id };
  await upsertToken(env.DB, {
    accountId: row.id,
    kind: "refresh",
    sealed: await seal(refreshToken, { ...who, kind: "refresh" }, env),
  });
  await upsertToken(env.DB, {
    accountId: row.id,
    kind: "access",
    sealed: await seal(accessToken, { ...who, kind: "access" }, env),
    expiresAt: nowSeconds() + 3600,
  });
  return { row, accessToken, refreshToken };
}

/** The MIME text of a draft as `drafts.get?format=raw` carries it, base64url-encoded. */
export function rawDraft(
  over: {
    id?: string;
    from?: string;
    to?: string;
    cc?: string;
    subject?: string;
    threadId?: string;
    /** Extra header lines, such as `["Bcc", "x@example.org"]`. */
    headers?: [string, string][];
  } = {},
): { id: string; message: { threadId?: string; raw: string } } {
  const lines = [
    `From: ${over.from ?? "work@example.com"}`,
    `To: ${over.to ?? "dan@example.net"}`,
    ...(over.cc ? [`Cc: ${over.cc}`] : []),
    `Subject: ${over.subject ?? "Draft subject"}`,
    ...(over.headers ?? []).map(([k, v]) => `${k}: ${v}`),
    "Content-Type: text/plain; charset=UTF-8",
  ];
  const mime = `${lines.join("\r\n")}\r\n\r\nDraft body\r\n`;
  return {
    id: over.id ?? "d1",
    message: {
      ...(over.threadId ? { threadId: over.threadId } : {}),
      raw: base64url(new TextEncoder().encode(mime)),
    },
  };
}
