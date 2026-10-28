// Google sign-in (OpenID Connect) for the owner: authorize URL, code exchange, ID token claim
// checks (ARCHITECTURE s.1.5, s.6; plan s.4.2). Scopes are `openid email` only: no mailbox access.
//
// The ID token comes straight from Google's token endpoint over TLS, in answer to our own
// authenticated request, so its signature is not checked (OpenID Connect Core 1.0 s.3.1.3.7,
// item 6); `iss`, `aud`, `exp`, `nonce` and `email_verified` are.

import { timingSafeEqual } from "../core/crypto";
import { nowSeconds } from "../core/db";
import type { Env } from "../env";

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_ISSUERS: readonly string[] = [
  "https://accounts.google.com",
  "accounts.google.com",
];
export const CALLBACK_PATH = "/oauth/google/callback";

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

/** The Google OAuth client, or undefined when either secret is missing (sign-in answers 503). */
export function googleClient(env: Env): GoogleClient | undefined {
  const clientId = (env.GOOGLE_CLIENT_ID ?? "").trim();
  const clientSecret = (env.GOOGLE_CLIENT_SECRET ?? "").trim();
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

export const callbackUrl = (issuer: string): string => issuer + CALLBACK_PATH;

/** The Google authorization URL for the owner sign-in. */
export function signinUrl(o: {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}): string {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: "code",
    scope: "openid email",
    state: o.state,
    nonce: o.nonce,
    code_challenge: o.codeChallenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return url.toString();
}

export class GoogleTokenError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GoogleTokenError";
  }
}

export interface GoogleTokenResponse {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

/** Exchanges an authorization code (with its PKCE verifier) at Google's token endpoint. */
export async function exchangeCode(
  client: GoogleClient,
  o: { code: string; verifier: string; redirectUri: string },
): Promise<GoogleTokenResponse> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: o.code,
      code_verifier: o.verifier,
      redirect_uri: o.redirectUri,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    }),
  });
  if (!res.ok) {
    // Google's error body is not echoed anywhere; only its status is kept.
    await res.body?.cancel();
    throw new GoogleTokenError(res.status, `Google token endpoint answered ${res.status}`);
  }
  return res.json<GoogleTokenResponse>();
}

export type IdTokenFailure =
  | "malformed"
  | "iss"
  | "aud"
  | "exp"
  | "nonce"
  | "email_unverified"
  | "claims";

export type IdTokenCheck =
  | { ok: true; email: string; sub: string }
  | { ok: false; reason: IdTokenFailure };

function decodeSegment(segment: string): unknown {
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Checks the ID token's claims for this client and flow; returns the lowercased email and `sub`. */
export function checkIdToken(
  idToken: unknown,
  expected: { clientId: string; nonce: string; now?: number },
): IdTokenCheck {
  if (typeof idToken !== "string") return { ok: false, reason: "malformed" };
  const parts = idToken.split(".");
  if (parts.length !== 3 || !parts[1] || !/^[A-Za-z0-9_-]+$/.test(parts[1])) {
    return { ok: false, reason: "malformed" };
  }
  let claims: Record<string, unknown>;
  try {
    const decoded = decodeSegment(parts[1]);
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      return { ok: false, reason: "malformed" };
    }
    claims = decoded as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (typeof claims.iss !== "string" || !GOOGLE_ISSUERS.includes(claims.iss)) {
    return { ok: false, reason: "iss" };
  }
  const aud = claims.aud;
  const audOk =
    aud === expected.clientId ||
    (Array.isArray(aud) &&
      aud.includes(expected.clientId) &&
      (aud.length === 1 || claims.azp === expected.clientId));
  if (!audOk) return { ok: false, reason: "aud" };
  const now = expected.now ?? nowSeconds();
  if (typeof claims.exp !== "number" || claims.exp <= now) return { ok: false, reason: "exp" };
  if (typeof claims.nonce !== "string" || !timingSafeEqual(claims.nonce, expected.nonce)) {
    return { ok: false, reason: "nonce" };
  }
  if (claims.email_verified !== true) return { ok: false, reason: "email_unverified" };
  if (
    typeof claims.email !== "string" ||
    !/^[^\s@]+@[^\s@]+$/.test(claims.email) ||
    typeof claims.sub !== "string" ||
    claims.sub === ""
  ) {
    return { ok: false, reason: "claims" };
  }
  return { ok: true, email: claims.email.toLowerCase(), sub: claims.sub };
}
