// The audit log of sends and other guarded actions (ARCHITECTURE s.2, s.4; plan s.10.2): one
// `audit_log` row per action, never a body, an attachment or a token. Rows outlive an unlink and
// are trimmed after `AUDIT_RETENTION_DAYS` (365) by the daily cleanup.

import type { Env } from "../env";
import type { Grant } from "../registry/types";
import type { AccountRef } from "../services/types";
import { type AuditLogRow, all, nowSeconds, run } from "./db";

/** One audited action. Never a body, an attachment or a token. */
export interface AuditEntry {
  tool: string;
  account?: AccountRef | null;
  from?: string | null;
  to?: readonly string[];
  cc?: readonly string[];
  bcc?: readonly string[];
  subject?: string | null;
  /** The provider's id for what was created or changed, such as a Gmail message id. */
  providerRef?: string | null;
  /** For example `ok`, `error`, `pending`. */
  result: string;
  /** A short reason, never a provider response body. */
  detail?: string | null;
}

/** What `ctx.audit` is (s.3.2): bound to the call's owner and grant. */
export interface AuditLog {
  write(entry: AuditEntry): Promise<void>;
  /** The owner's entries, newest first; `before` is Unix seconds. */
  read(opts?: { limit?: number; before?: number }): Promise<AuditLogRow[]>;
}

export interface AuditDeps {
  env: Env;
  ownerId: string;
  grant: Grant;
  /** Milliseconds. */
  now: () => number;
}

/** One row as stored. `ownerId` is null only for a refused sign-in. */
export interface AuditRecord {
  at: number;
  ownerId: string | null;
  accountId?: string | null;
  tool: string;
  clientId?: string | null;
  grantId?: string | null;
  from?: string | null;
  to?: readonly string[];
  cc?: readonly string[];
  bcc?: readonly string[];
  subject?: string | null;
  providerRef?: string | null;
  result: string;
  detail?: string | null;
}

const TEXT_MAX = 300;
const LIST_MAX = 100;

const clip = (s: string | null | undefined, max = TEXT_MAX): string | null =>
  s === undefined || s === null ? null : s.slice(0, max);

const list = (xs: readonly string[] | undefined): string | null =>
  xs === undefined || xs.length === 0
    ? null
    : JSON.stringify(xs.slice(0, LIST_MAX).map((x) => x.slice(0, TEXT_MAX)));

/** Writes one row. `ctx.audit` and the owner pages use it; long values are cut, lists capped. */
export async function writeAudit(db: D1Database, r: AuditRecord): Promise<void> {
  await run(
    db,
    `INSERT INTO audit_log (at, owner_id, account_id, tool, client_id, grant_id, from_addr,
       to_addrs, cc_addrs, bcc_addrs, subject, provider_ref, result, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    r.at,
    r.ownerId,
    r.accountId ?? null,
    r.tool.slice(0, 64),
    clip(r.clientId),
    clip(r.grantId),
    clip(r.from),
    list(r.to),
    list(r.cc),
    list(r.bcc),
    clip(r.subject),
    clip(r.providerRef),
    r.result.slice(0, 32),
    clip(r.detail),
  );
}

/** The audit row for a refused sign-in (s.2): the address only as its HMAC, and the country. */
export function auditRefusedSignin(
  env: Env,
  f: { reason: string; emailHash: string; country: string | null },
): Promise<void> {
  return writeAudit(env.DB, {
    at: nowSeconds(),
    ownerId: null,
    tool: "signin",
    result: "refused",
    detail: JSON.stringify({ reason: f.reason, emailHash: f.emailHash, country: f.country }),
  });
}

/**
 * The owner's rows and the refused sign-ins (no owner; one owner in v1), newest first. `before`
 * (Unix seconds) pages back; `limit` is 1 to 200, 50 by default.
 */
export function readAudit(
  db: D1Database,
  ownerId: string,
  opts: { limit?: number; before?: number } = {},
): Promise<AuditLogRow[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200);
  const before = opts.before ?? null;
  return all<AuditLogRow>(
    db,
    `SELECT * FROM audit_log WHERE (owner_id = ? OR owner_id IS NULL) AND (? IS NULL OR at < ?)
     ORDER BY at DESC, id DESC LIMIT ?`,
    ownerId,
    before,
    before,
    limit,
  );
}

export function createAuditLog(deps: AuditDeps): AuditLog {
  const { env, ownerId, grant } = deps;
  return {
    write(e) {
      return writeAudit(env.DB, {
        at: Math.floor(deps.now() / 1000),
        ownerId,
        accountId: e.account?.accountId ?? null,
        tool: e.tool,
        clientId: grant.clientId,
        grantId: grant.grantId,
        from: e.from,
        to: e.to,
        cc: e.cc,
        bcc: e.bcc,
        subject: e.subject,
        providerRef: e.providerRef,
        result: e.result,
        detail: e.detail,
      });
    },
    read(opts) {
      return readAudit(env.DB, ownerId, opts);
    },
  };
}
