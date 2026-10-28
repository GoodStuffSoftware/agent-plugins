// Fake Google for the sign-in tests (ARCHITECTURE s.6): `fetch` is stubbed, and only Google's
// token endpoint answers. It checks the client credentials, the redirect URI and the PKCE
// verifier, uses each code once, and returns an unsigned ID token with test claims. Any other
// outgoing request fails the test.

import { vi } from "vitest";
import { GOOGLE_AUTHORIZE_URL, GOOGLE_TOKEN_URL } from "../../src/auth/google-oidc";
import { base64url, randomBytes, sha256 } from "../../src/core/crypto";

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
