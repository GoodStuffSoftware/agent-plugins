// Typed D1 helpers and row types (ARCHITECTURE s.4). M6 adds the core rows.

import { randomId, type Sealed, type TokenKind } from "./crypto";

/** Unix seconds, the unit of every time column. */
export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export function first<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  return db
    .prepare(sql)
    .bind(...params)
    .first<T>();
}

export async function all<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const { results } = await db
    .prepare(sql)
    .bind(...params)
    .all<T>();
  return results;
}

export function run(db: D1Database, sql: string, ...params: unknown[]): Promise<D1Result> {
  return db
    .prepare(sql)
    .bind(...params)
    .run();
}

// migrations/0001_auth.sql

export interface OwnerRow {
  /** `o_` plus 16 base32 characters; never contains `:` (it is the OAuth `userId`). */
  id: string;
  default_account_id: string | null;
  /** 0 or 1. */
  send_kill_switch: number;
  next_short_id: number;
  created_at: number;
}

export interface OwnerIdentityRow {
  /** Lowercase. */
  email: string;
  owner_id: string;
  /** Google `sub`, NULL until pinned in setup mode. */
  sub: string | null;
  pinned_at: number | null;
  last_login_at: number | null;
}

export type FlowKind = "signin" | "link";

export interface FlowStateRow {
  /** Hex SHA-256 of the `state` parameter. */
  id: string;
  kind: FlowKind;
  /** JSON text. */
  payload: string;
  /** Hash of the `__Host-` flow cookie. */
  binding: string;
  expires_at: number;
}

// migrations/0002_core.sql

export type AccountProvider = "google" | "msgraph" | "imap";

export type AccountStatus = "ok" | "needs_relink";

export interface AccountRow {
  /** `ac_` plus 16 base32 characters; never contains the AAD separator `|`. */
  id: string;
  owner_id: string;
  /** Per owner, from `owners.next_short_id`; never reused after unlink (s.3.4). */
  short_id: number;
  label: string;
  /** Lowercase. */
  address: string;
  provider: AccountProvider;
  /** The provider's stable user id (Google `sub`). */
  provider_sub: string | null;
  /** JSON array of enabled components. */
  components: string;
  /** Space-separated scopes the provider granted. */
  granted_scopes: string;
  status: AccountStatus;
  send_as_fetched_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface NewAccount {
  ownerId: string;
  label: string;
  /** Lowercased on insert. */
  address: string;
  provider: AccountProvider;
  providerSub?: string | null;
  components?: readonly string[];
  grantedScopes?: string;
}

export interface AccountTokenRow extends Sealed {
  account_id: string;
  kind: TokenKind;
  expires_at: number | null;
  updated_at: number;
}

export interface SendAsRow {
  account_id: string;
  /** Lowercase. */
  email: string;
  display_name: string | null;
  /** 0 or 1. */
  is_default: number;
  /** 0 or 1. */
  is_primary: number;
  /** Gmail `verificationStatus`; NULL for the primary address. */
  verification_status: string | null;
  reply_to: string | null;
}

export interface AuditLogRow {
  id: number;
  at: number;
  /** NULL for a refused sign-in. */
  owner_id: string | null;
  account_id: string | null;
  tool: string;
  client_id: string | null;
  grant_id: string | null;
  from_addr: string | null;
  to_addrs: string | null;
  cc_addrs: string | null;
  bcc_addrs: string | null;
  subject: string | null;
  provider_ref: string | null;
  result: string;
  detail: string | null;
}

export interface RateCounterRow {
  /** `send:h:<accountId>`, `send:d:<accountId>`, `calls:m:<grantId>`. */
  bucket: string;
  window_start: number;
  count: number;
}

export type PendingStatus = "pending" | "approved" | "rejected" | "expired" | "executed" | "failed";

export interface PendingActionRow {
  /** `pa_` plus random. */
  id: string;
  owner_id: string;
  tool: string;
  account_id: string | null;
  /** JSON text. */
  params: string;
  /** JSON text. */
  preview: string;
  client_id: string;
  grant_id: string;
  status: PendingStatus;
  created_at: number;
  /** `created_at` + 24 h. */
  expires_at: number;
  decided_at: number | null;
  /** JSON text. */
  result: string | null;
}

/**
 * Inserts an account under the owner's next short id and advances `owners.next_short_id`, in one
 * transaction. Returns null when the owner does not exist; throws on a duplicate label or address
 * (and then consumes no short id).
 */
export async function insertAccount(
  db: D1Database,
  a: NewAccount,
  now = nowSeconds(),
): Promise<AccountRow | null> {
  const [inserted] = await db.batch([
    db
      .prepare(
        `INSERT INTO accounts (id, owner_id, short_id, label, address, provider, provider_sub,
           components, granted_scopes, created_at, updated_at)
         SELECT ?1, id, next_short_id, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8 FROM owners WHERE id = ?9
         RETURNING *`,
      )
      .bind(
        randomId("ac_"),
        a.label,
        a.address.toLowerCase(),
        a.provider,
        a.providerSub ?? null,
        JSON.stringify(a.components ?? []),
        a.grantedScopes ?? "",
        now,
        a.ownerId,
      ),
    db.prepare("UPDATE owners SET next_short_id = next_short_id + 1 WHERE id = ?").bind(a.ownerId),
  ]);
  return (inserted?.results[0] as AccountRow | undefined) ?? null;
}

/** One account of one owner; null if it is not that owner's. */
export function getAccount(
  db: D1Database,
  ownerId: string,
  accountId: string,
): Promise<AccountRow | null> {
  return first<AccountRow>(
    db,
    "SELECT * FROM accounts WHERE owner_id = ? AND id = ?",
    ownerId,
    accountId,
  );
}

/** The owner's accounts, by short id. */
export function listAccounts(db: D1Database, ownerId: string): Promise<AccountRow[]> {
  return all<AccountRow>(
    db,
    "SELECT * FROM accounts WHERE owner_id = ? ORDER BY short_id",
    ownerId,
  );
}

/** Stores a sealed token for (account, kind), replacing any earlier one. */
export async function upsertToken(
  db: D1Database,
  t: { accountId: string; kind: TokenKind; sealed: Sealed; expiresAt?: number | null },
  now = nowSeconds(),
): Promise<void> {
  await run(
    db,
    `INSERT INTO account_tokens (account_id, kind, ciphertext, iv, key_version, expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (account_id, kind) DO UPDATE SET
       ciphertext = excluded.ciphertext, iv = excluded.iv, key_version = excluded.key_version,
       expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
    t.accountId,
    t.kind,
    t.sealed.ciphertext,
    t.sealed.iv,
    t.sealed.key_version,
    t.expiresAt ?? null,
    now,
  );
}

type StoredTokenRow = Omit<AccountTokenRow, "ciphertext" | "iv"> & {
  ciphertext: unknown;
  iv: unknown;
};

/** The sealed token for (account, kind), with its BLOB columns as bytes; pass it to `open()`. */
export async function getToken(
  db: D1Database,
  accountId: string,
  kind: TokenKind,
): Promise<AccountTokenRow | null> {
  const row = await first<StoredTokenRow>(
    db,
    "SELECT * FROM account_tokens WHERE account_id = ? AND kind = ?",
    accountId,
    kind,
  );
  return row ? { ...row, ciphertext: blobBytes(row.ciphertext), iv: blobBytes(row.iv) } : null;
}

/** D1 can return a BLOB as an ArrayBuffer or as an array of numbers. */
function blobBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  throw new Error("expected a BLOB column");
}

/**
 * Counts one hit in the fixed window (`bucket`, `windowStart`) and returns the window's new
 * count. One statement, so concurrent hits never lose an increment.
 */
export async function incrementCounter(
  db: D1Database,
  bucket: string,
  windowStart: number,
): Promise<number> {
  const row = await first<{ count: number }>(
    db,
    `INSERT INTO rate_counters (bucket, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1
     RETURNING count`,
    bucket,
    windowStart,
  );
  if (!row) throw new Error("rate counter upsert returned no row");
  return row.count;
}
