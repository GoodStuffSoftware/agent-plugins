// Owner session cookie and CSRF tokens for page forms (ARCHITECTURE s.2, plan s.4.3).
//
// `__Host-wb-session` holds `base64url(JSON payload) "." base64url(HMAC-SHA256)`, keyed with
// `COOKIE_SECRET`, for 30 minutes. The payload names the owner and the Google address that signed
// in; a session whose address has left `OWNER_EMAILS` stops working at once. CSRF tokens are an
// HMAC of the session's random id, so a form token is valid only with the session that rendered it.

import { base64url, hmacSha256, randomBytes, timingSafeEqual } from "../core/crypto";
import { nowSeconds } from "../core/db";
import { config, type Env } from "../env";

export const SESSION_COOKIE = "__Host-wb-session";
export const SESSION_TTL = 30 * 60;

/** `COOKIE_SECRET` must be at least this long; shorter counts as not configured. */
export const MIN_COOKIE_SECRET_LENGTH = 32;

export interface Session {
  /** Random per sign-in; CSRF tokens are derived from it. */
  sid: string;
  ownerId: string;
  /** Lowercase Google address the owner signed in with. */
  email: string;
  /** Unix seconds. */
  exp: number;
}

interface Payload {
  v: 1;
  sid: string;
  oid: string;
  em: string;
  exp: number;
}

const decoder = new TextDecoder();

/** The cookie secret, or undefined when it is missing or too short (callers fail closed). */
export function cookieSecret(env: Env): string | undefined {
  const secret = env.COOKIE_SECRET ?? "";
  return secret.length >= MIN_COOKIE_SECRET_LENGTH ? secret : undefined;
}

function requireSecret(env: Env): string {
  const secret = cookieSecret(env);
  if (!secret) throw new Error("COOKIE_SECRET is missing or shorter than 32 characters");
  return secret;
}

/** Value of one cookie from the request's `Cookie` header, or undefined. */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("Cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** A `__Host-` cookie: Secure, HttpOnly, SameSite=Lax, Path=/, no Domain. */
export function hostCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export const clearCookie = (name: string): string => hostCookie(name, "", 0);

function fromBase64url(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch {
    return undefined;
  }
}

async function mac(secret: string, purpose: string, data: string): Promise<string> {
  return base64url(await hmacSha256(secret, `${purpose}|${data}`));
}

/** Creates a session for `ownerId` and returns its `Set-Cookie` value. */
export async function createSession(
  env: Env,
  ownerId: string,
  email: string,
): Promise<{ session: Session; setCookie: string }> {
  const secret = requireSecret(env);
  const session: Session = {
    sid: base64url(randomBytes(16)),
    ownerId,
    email: email.toLowerCase(),
    exp: nowSeconds() + SESSION_TTL,
  };
  const payload: Payload = {
    v: 1,
    sid: session.sid,
    oid: session.ownerId,
    em: session.email,
    exp: session.exp,
  };
  const body = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const value = `${body}.${await mac(secret, "wb-session", body)}`;
  return { session, setCookie: hostCookie(SESSION_COOKIE, value, SESSION_TTL) };
}

/**
 * The request's valid owner session, or undefined: bad signature, expired, malformed, missing
 * secret, or an address no longer on `OWNER_EMAILS`.
 */
export async function readSession(req: Request, env: Env): Promise<Session | undefined> {
  const secret = cookieSecret(env);
  const value = readCookie(req, SESSION_COOKIE);
  if (!secret || !value) return undefined;
  const dot = value.indexOf(".");
  if (dot <= 0) return undefined;
  const body = value.slice(0, dot);
  if (!timingSafeEqual(value.slice(dot + 1), await mac(secret, "wb-session", body))) {
    return undefined;
  }
  const bytes = fromBase64url(body);
  if (!bytes) return undefined;
  let p: Partial<Payload>;
  try {
    p = JSON.parse(decoder.decode(bytes)) as Partial<Payload>;
  } catch {
    return undefined;
  }
  if (
    p.v !== 1 ||
    typeof p.sid !== "string" ||
    typeof p.oid !== "string" ||
    typeof p.em !== "string" ||
    typeof p.exp !== "number"
  ) {
    return undefined;
  }
  if (p.exp <= nowSeconds()) return undefined;
  if (!config(env).ownerEmails.includes(p.em)) return undefined;
  return { sid: p.sid, ownerId: p.oid, email: p.em, exp: p.exp };
}

/** The CSRF token page forms carry for this session. */
export function csrfToken(env: Env, session: Session): Promise<string> {
  return mac(requireSecret(env), "wb-csrf", session.sid);
}

/** Whether `token` is this session's CSRF token (constant time). */
export async function checkCsrf(
  env: Env,
  session: Session,
  token: string | null | undefined,
): Promise<boolean> {
  if (typeof token !== "string" || token === "") return false;
  return timingSafeEqual(token, await csrfToken(env, session));
}
