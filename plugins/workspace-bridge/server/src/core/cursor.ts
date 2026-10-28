// Multi-account cursors (ARCHITECTURE s.3.5): the codec and the merge every `"all"` search shares.

import { base64url, sha256Hex } from "./crypto";
import { ToolError } from "./errors";

/** One account's place in a listing. `tok` is the provider page token (null = the first page). */
export type CursorEntry = { tok: string | null; skip: number };

export type Cursor = {
  v: 1;
  /** Tool name. */
  t: string;
  /** 16 hex of sha256(canonical query params). */
  q: string;
  /** Key `a<shortId>`; null = exhausted. */
  p: Record<string, CursorEntry | null>;
};

const ACCOUNT_KEY = /^a[1-9][0-9]{0,8}$/;
const MAX_TOKEN_CHARS = 8192;
const MAX_ENTRIES = 64;
const BAD_CURSOR = "Invalid pageToken for this call. Start again without it.";

const bad = (): ToolError => new ToolError("invalid_argument", BAD_CURSOR);

/** Canonical JSON: object keys sorted, `undefined` values dropped. */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) {
        const x = (v as Record<string, unknown>)[k];
        if (x !== undefined) out[k] = norm(x);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(value)) ?? "null";
}

/**
 * The 16-hex query fingerprint stored in a cursor. Pass the call's parameters that shape the
 * result (query, filters, limit, the account selector) and leave out `pageToken`.
 */
export async function queryHash(params: unknown): Promise<string> {
  return (await sha256Hex(canonicalJson(params))).slice(0, 16);
}

export function encodeCursor(c: Cursor): string {
  return base64url(new TextEncoder().encode(JSON.stringify(c)));
}

function fromBase64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

function isEntry(e: unknown): e is CursorEntry {
  if (e === null || typeof e !== "object") return false;
  const { tok, skip } = e as Record<string, unknown>;
  return (
    (tok === null || (typeof tok === "string" && tok.length <= MAX_TOKEN_CHARS)) &&
    typeof skip === "number" &&
    Number.isSafeInteger(skip) &&
    skip >= 0
  );
}

/**
 * Parses and checks a `pageToken`. Anything malformed, or issued for another tool or query, is
 * `invalid_argument` with a fixed message.
 */
export function decodeCursor(token: string, expect: { tool: string; query: string }): Cursor {
  let raw: unknown;
  try {
    if (token.length > MAX_TOKEN_CHARS * 4 || !/^[A-Za-z0-9_-]+$/.test(token)) throw bad();
    raw = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(fromBase64url(token)),
    );
  } catch {
    throw bad();
  }
  if (raw === null || typeof raw !== "object") throw bad();
  const c = raw as Record<string, unknown>;
  if (c.v !== 1 || c.t !== expect.tool || c.q !== expect.query) throw bad();
  const p = c.p;
  if (p === null || typeof p !== "object" || Array.isArray(p)) throw bad();
  const keys = Object.keys(p);
  if (keys.length === 0 || keys.length > MAX_ENTRIES) throw bad();
  const clean: Record<string, CursorEntry | null> = {};
  for (const k of keys) {
    const e = (p as Record<string, unknown>)[k];
    if (!ACCOUNT_KEY.test(k) || !(e === null || isEntry(e))) throw bad();
    clean[k] = e === null ? null : { tok: e.tok, skip: e.skip };
  }
  return { v: 1, t: expect.tool, q: expect.query, p: clean };
}

/** What `ctx.cursors` is (s.3.2). */
export interface CursorCodec {
  queryHash(params: unknown): Promise<string>;
  encode(c: Cursor): string;
  decode(token: string, expect: { tool: string; query: string }): Cursor;
}

export const cursors: CursorCodec = {
  queryHash,
  encode: encodeCursor,
  decode: decodeCursor,
};

/** One account the call must fetch from: its page token and how many of that page's items are done. */
export interface CursorStart {
  key: string;
  tok: string | null;
  skip: number;
}

/**
 * The accounts to fetch for a call, in `keys` order. With no cursor every account starts at its
 * first page. With one, exhausted accounts drop out, and a cursor whose accounts differ from
 * `keys` (a different `account` argument, or an account linked or unlinked since) is
 * `invalid_argument`.
 */
export function startFromCursor(cursor: Cursor | null, keys: readonly string[]): CursorStart[] {
  if (!cursor) return keys.map((key) => ({ key, tok: null, skip: 0 }));
  const have = Object.keys(cursor.p);
  if (have.length !== keys.length || !keys.every((k) => k in cursor.p)) throw bad();
  const starts: CursorStart[] = [];
  for (const key of keys) {
    const e = cursor.p[key];
    if (e) starts.push({ key, tok: e.tok, skip: e.skip });
  }
  return starts;
}

/** One account's fetched page, with the position it was fetched from. */
export interface AccountPage<T> {
  key: string;
  /** The token the page was fetched with (`CursorStart.tok`). */
  tok: string | null;
  /** `CursorStart.skip`: this many leading items were returned by an earlier call. */
  skip: number;
  /** In the call's sort order, as the provider returned them. */
  items: readonly T[];
  /** The provider's next page token; null or undefined when this was the last page. */
  next?: string | null;
}

export interface MergedPage<T> {
  items: T[];
  /** Items taken from each account in this call. */
  taken: Record<string, number>;
  /** Encoded cursor for the next call, or undefined when every account is exhausted. */
  nextPageToken: string | undefined;
}

/**
 * Merges per-account pages (each sorted by `compare`, negative = first) into one page of at most
 * `limit` items and the cursor that continues it.
 *
 * `skip` leading items of each page are dropped (already returned). An account whose current
 * page is used up but has a next page blocks the merge: its next items are unknown and might
 * sort before the rest, so the merge stops there and the next call fetches that page. Fetch at
 * least `limit + skip` items per account to keep pages full. Ties go to the earlier account in
 * `pages`. A page can come back short, and empty when a provider returns an empty page with a
 * next token; the cursor still advances, so a caller may loop on `nextPageToken`.
 */
export function mergePages<T>(
  pages: readonly AccountPage<T>[],
  opts: {
    tool: string;
    query: string;
    limit: number;
    /** Every account the call addresses, so those already exhausted stay in the cursor as null. */
    keys: readonly string[];
    compare: (a: T, b: T) => number;
  },
): MergedPage<T> {
  const limit = Math.max(0, Math.floor(opts.limit));
  const state = pages.map((pg) => ({
    pg,
    at: Math.min(Math.max(pg.skip, 0), pg.items.length),
    taken: 0,
  }));
  const hasMore = (s: (typeof state)[number]): boolean => s.at < s.pg.items.length;
  const blocked = (s: (typeof state)[number]): boolean => !hasMore(s) && s.pg.next != null;

  const items: T[] = [];
  while (items.length < limit && !state.some(blocked)) {
    let best: (typeof state)[number] | undefined;
    for (const s of state) {
      if (!hasMore(s)) continue;
      if (!best || opts.compare(s.pg.items[s.at] as T, best.pg.items[best.at] as T) < 0) best = s;
    }
    if (!best) break;
    items.push(best.pg.items[best.at] as T);
    best.at++;
    best.taken++;
  }

  const p: Record<string, CursorEntry | null> = Object.fromEntries(opts.keys.map((k) => [k, null]));
  const taken: Record<string, number> = {};
  for (const s of state) {
    taken[s.pg.key] = s.taken;
    if (hasMore(s)) p[s.pg.key] = { tok: s.pg.tok, skip: s.at };
    else p[s.pg.key] = s.pg.next != null ? { tok: s.pg.next, skip: 0 } : null;
  }
  const done = Object.values(p).every((e) => e === null);
  return {
    items,
    taken,
    nextPageToken: done ? undefined : encodeCursor({ v: 1, t: opts.tool, q: opts.query, p }),
  };
}
