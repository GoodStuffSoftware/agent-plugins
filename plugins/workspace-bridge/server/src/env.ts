// Bindings, vars and secrets, and the parsed configuration (ARCHITECTURE s.2).

import { currentKeyVersion } from "./core/crypto";

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  /** `ratelimits` binding for `/oauth/register`; registration is not limited when unbound. */
  DCR_LIMIT?: RateLimit;
  /** `ratelimits` binding for tool calls per grant; D1 counts them when unbound. */
  CALL_LIMIT?: RateLimit;

  // Vars (wrangler.example.jsonc).
  PUBLIC_URL: string;
  OWNER_CONTACT?: string;
  NOTIFY_EMAIL?: string;
  SEND_ENABLED?: string;
  SETUP_MODE?: string;
  SEND_REQUIRES_CONFIRM?: string;
  SEND_APPROVAL_MODE?: string;
  SEND_PER_HOUR?: string;
  SEND_PER_DAY?: string;
  MAX_RECIPIENTS?: string;
  MAX_ATTACHMENT_BYTES?: string;
  MAX_SEND_ATTACHMENT_BYTES?: string;
  CURRENT_KEY_VERSION?: string;
  AUDIT_RETENTION_DAYS?: string;

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
  /**
   * Where the fast notice of a held action goes: `NOTIFY_EMAIL`, else `OWNER_CONTACT` when that is
   * a single plain address. Empty means no notice is sent.
   */
  notifyEmail: string;
  setupMode: boolean;
  sendEnabled: boolean;
  sendRequiresConfirm: boolean;
  /**
   * Which sends wait for the owner: `new_recipients` (default) holds a send with at least one
   * recipient new to the sending account, `all` holds every send, `off` holds none. When
   * `SEND_APPROVAL_MODE` is unset, `SEND_REQUIRES_CONFIRM=true` means `all` (the old switch).
   */
  sendApprovalMode: SendApprovalMode;
  sendPerHour: number;
  sendPerDay: number;
  maxRecipients: number;
  maxAttachmentBytes: number;
  maxSendAttachmentBytes: number;
  currentKeyVersion: number;
  /** Days an audit row is kept; at least 1. */
  auditRetentionDays: number;
  /** Lowercased sign-in allowlist; empty means nobody can sign in. */
  ownerEmails: readonly string[];
  /** Lowercased link allowlist; defaults to `ownerEmails`. */
  linkableEmails: readonly string[];
}

export const SEND_APPROVAL_MODES = ["new_recipients", "all", "off"] as const;
export type SendApprovalMode = (typeof SEND_APPROVAL_MODES)[number];

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

function approvalMode(value: string | undefined, requiresConfirm: boolean): SendApprovalMode {
  if (value === undefined || value === "") return requiresConfirm ? "all" : "new_recipients";
  if ((SEND_APPROVAL_MODES as readonly string[]).includes(value)) return value as SendApprovalMode;
  throw new Error(`SEND_APPROVAL_MODE must be one of ${SEND_APPROVAL_MODES.join(", ")}`);
}

function parse(env: Env): Config {
  const ownerEmails = emails("OWNER_EMAILS", env.OWNER_EMAILS);
  const linkable = emails("LINKABLE_EMAILS", env.LINKABLE_EMAILS);
  const requiresConfirm = flag("SEND_REQUIRES_CONFIRM", env.SEND_REQUIRES_CONFIRM, false);
  return Object.freeze({
    issuer: issuer(env.PUBLIC_URL),
    ownerContact: (env.OWNER_CONTACT ?? "").trim(),
    notifyEmail: notifyAddress(env),
    setupMode: flag("SETUP_MODE", env.SETUP_MODE, false),
    sendEnabled: flag("SEND_ENABLED", env.SEND_ENABLED, false),
    sendRequiresConfirm: requiresConfirm,
    sendApprovalMode: approvalMode(env.SEND_APPROVAL_MODE, requiresConfirm),
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
    auditRetentionDays: Math.max(1, count("AUDIT_RETENTION_DAYS", env.AUDIT_RETENTION_DAYS, 365)),
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

const PLAIN_ADDRESS =
  /^[a-z0-9][a-z0-9._+-]{0,63}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function notifyAddress(env: Env): string {
  const given = (env.NOTIFY_EMAIL ?? "").trim().toLowerCase();
  if (given !== "") {
    if (!PLAIN_ADDRESS.test(given)) throw new Error("NOTIFY_EMAIL must be one plain email address");
    return given;
  }
  const contact = (env.OWNER_CONTACT ?? "").trim().toLowerCase();
  return PLAIN_ADDRESS.test(contact) ? contact : "";
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
