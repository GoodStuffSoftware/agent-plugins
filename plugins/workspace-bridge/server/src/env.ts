// Bindings, vars and secrets, and the parsed configuration (ARCHITECTURE s.2).

import { currentKeyVersion } from "./core/crypto";

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  /** `ratelimits` binding for `/oauth/register`; registration is not limited when unbound. */
  DCR_LIMIT?: RateLimit;

  // Vars (wrangler.example.jsonc).
  PUBLIC_URL: string;
  OWNER_CONTACT?: string;
  SEND_ENABLED?: string;
  SETUP_MODE?: string;
  SEND_REQUIRES_CONFIRM?: string;
  SEND_PER_HOUR?: string;
  SEND_PER_DAY?: string;
  MAX_RECIPIENTS?: string;
  MAX_ATTACHMENT_BYTES?: string;
  MAX_SEND_ATTACHMENT_BYTES?: string;
  CURRENT_KEY_VERSION?: string;

  // Secrets (`wrangler secret put`).
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  TOKEN_KEK?: string;
  COOKIE_SECRET?: string;
  OWNER_EMAILS?: string;
  LINKABLE_EMAILS?: string;
}

type AppEnv = Env;

declare global {
  namespace Cloudflare {
    // Types `env` and `exports` from "cloudflare:workers" (ARCHITECTURE s.1.6).
    interface Env extends AppEnv {}
    interface GlobalProps {
      mainModule: typeof import("./index");
    }
  }
}

export interface Config {
  /** Canonical issuer and public origin, from `PUBLIC_URL`, with no trailing slash. */
  issuer: string;
  /** Contact line for `/` and `/privacy`; empty hides it. */
  ownerContact: string;
  setupMode: boolean;
  sendEnabled: boolean;
  sendRequiresConfirm: boolean;
  sendPerHour: number;
  sendPerDay: number;
  maxRecipients: number;
  maxAttachmentBytes: number;
  maxSendAttachmentBytes: number;
  currentKeyVersion: number;
  /** Lowercased sign-in allowlist; empty means nobody can sign in. */
  ownerEmails: readonly string[];
  /** Lowercased link allowlist; defaults to `ownerEmails`. */
  linkableEmails: readonly string[];
}

const parsed = new WeakMap<object, Config>();

/** Parses and validates the configuration once per `env` object; throws on a bad value. */
export function config(env: Env): Config {
  let c = parsed.get(env);
  if (!c) {
    c = parse(env);
    parsed.set(env, c);
  }
  return c;
}

function parse(env: Env): Config {
  const ownerEmails = emails("OWNER_EMAILS", env.OWNER_EMAILS);
  const linkable = emails("LINKABLE_EMAILS", env.LINKABLE_EMAILS);
  return Object.freeze({
    issuer: issuer(env.PUBLIC_URL),
    ownerContact: (env.OWNER_CONTACT ?? "").trim(),
    setupMode: flag("SETUP_MODE", env.SETUP_MODE, false),
    sendEnabled: flag("SEND_ENABLED", env.SEND_ENABLED, false),
    sendRequiresConfirm: flag("SEND_REQUIRES_CONFIRM", env.SEND_REQUIRES_CONFIRM, false),
    sendPerHour: count("SEND_PER_HOUR", env.SEND_PER_HOUR, 20),
    sendPerDay: count("SEND_PER_DAY", env.SEND_PER_DAY, 100),
    maxRecipients: count("MAX_RECIPIENTS", env.MAX_RECIPIENTS, 20),
    maxAttachmentBytes: count("MAX_ATTACHMENT_BYTES", env.MAX_ATTACHMENT_BYTES, 524288),
    maxSendAttachmentBytes: count(
      "MAX_SEND_ATTACHMENT_BYTES",
      env.MAX_SEND_ATTACHMENT_BYTES,
      524288,
    ),
    currentKeyVersion: currentKeyVersion(env),
    ownerEmails: Object.freeze(ownerEmails),
    linkableEmails: Object.freeze(linkable.length > 0 ? linkable : [...ownerEmails]),
  });
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function issuer(value: string | undefined): string {
  let url: URL;
  try {
    url = new URL(value ?? "");
  } catch {
    throw new Error("PUBLIC_URL must be an absolute URL such as https://mcp.example.com");
  }
  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
  if (!secure || url.origin !== value) {
    throw new Error("PUBLIC_URL must be an https origin with no path or trailing slash");
  }
  return url.origin;
}

function flag(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be "true" or "false"`);
}

function count(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  if (!/^\d{1,15}$/.test(value)) throw new Error(`${name} must be a non-negative integer`);
  return Number(value);
}

function emails(name: string, value: string | undefined): string[] {
  const list = (value ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e !== "");
  for (const e of list) {
    if (!/^[^\s@*]+@[^\s@*]+$/.test(e)) throw new Error(`${name} holds an invalid address`);
  }
  return [...new Set(list)];
}
