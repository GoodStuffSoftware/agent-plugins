// Typed D1 helpers and row types (ARCHITECTURE s.4). M6 adds the core rows.

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
