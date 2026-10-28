// Which From addresses an account may send as (ARCHITECTURE s.2, s.3.2; plan s.10.1): the
// account's own address and the sendAs entries Gmail marks `accepted`, from the `send_as` rows.
// The rows are written on link and refreshed when older than 24 h; `list_send_as` refreshes now.

import type { Env } from "../env";
import type { Capability } from "../services/capability";
import { SENDAS, type SendAsEntry } from "../services/mail-sendas";
import type { AccountRef } from "../services/types";
import { all, first, type SendAsRow } from "./db";
import { ToolError } from "./errors";
import { accountKey } from "./ids";

export interface SendAsAddress {
  /** Lowercase. */
  email: string;
  displayName: string | null;
  isDefault: boolean;
  isPrimary: boolean;
  replyTo: string | null;
}

/** What `ctx.sendAs` is (s.3.2). */
export interface SendAsCache {
  /** The addresses the account may send as: its primary address and verified aliases. */
  list(a: AccountRef): Promise<SendAsAddress[]>;
  /**
   * The From address for a message: `from` (a bare address, any case) when the account may send
   * as it, the default address when `from` is omitted; else `sender_not_allowed`.
   */
  assertFrom(a: AccountRef, from?: string | null): Promise<SendAsAddress>;
  /** Fetches the provider's list now, stores it and returns the allowed addresses. */
  refresh(a: AccountRef): Promise<SendAsAddress[]>;
}

export interface SendAsDeps {
  env: Env;
  /** Milliseconds. */
  now: () => number;
  /** `ctx.use`, to reach the provider; without it the stored rows are never refreshed. */
  use?: <T>(cap: Capability<T>, a: AccountRef) => T;
}

/** How long stored sendAs rows are used before the next read refreshes them. */
export const SEND_AS_TTL_SECONDS = 24 * 3600;

const toAddress = (r: SendAsRow): SendAsAddress => ({
  email: r.email,
  displayName: r.display_name,
  isDefault: r.is_default === 1,
  isPrimary: r.is_primary === 1,
  replyTo: r.reply_to,
});

const primaryOf = (a: AccountRef, isDefault: boolean): SendAsAddress => ({
  email: a.address,
  displayName: null,
  isDefault,
  isPrimary: true,
  replyTo: null,
});

/** The primary entry and the `accepted` ones; the account's own address is always there. */
function allowed(a: AccountRef, rows: readonly SendAsRow[]): SendAsAddress[] {
  const out = rows
    .filter((r) => r.is_primary === 1 || r.verification_status === "accepted")
    .map(toAddress);
  if (!out.some((x) => x.email === a.address)) {
    out.unshift(primaryOf(a, !out.some((x) => x.isDefault)));
  }
  return out;
}

/** Replaces the account's rows and stamps `send_as_fetched_at`, in one batch. */
async function store(
  db: D1Database,
  accountId: string,
  entries: readonly SendAsEntry[],
  now: number,
): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM send_as WHERE account_id = ?").bind(accountId),
    ...entries.map((e) =>
      db
        .prepare(
          `INSERT INTO send_as (account_id, email, display_name, is_default, is_primary,
             verification_status, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          accountId,
          e.email,
          e.displayName,
          e.isDefault ? 1 : 0,
          e.isPrimary ? 1 : 0,
          e.verificationStatus,
          e.replyTo,
        ),
    ),
    db.prepare("UPDATE accounts SET send_as_fetched_at = ? WHERE id = ?").bind(now, accountId),
  ]);
}

export function createSendAsCache(deps: SendAsDeps): SendAsCache {
  const { env } = deps;
  const nowS = (): number => Math.floor(deps.now() / 1000);
  const rows = (a: AccountRef): Promise<SendAsRow[]> =>
    all<SendAsRow>(
      env.DB,
      "SELECT * FROM send_as WHERE account_id = ? ORDER BY email",
      a.accountId,
    );

  async function refresh(a: AccountRef): Promise<SendAsAddress[]> {
    if (!deps.use) throw new Error("sendAs.refresh needs ctx.use");
    const entries = await deps.use(SENDAS, a).list(a);
    await store(env.DB, a.accountId, entries, nowS());
    return allowed(a, await rows(a));
  }

  async function list(a: AccountRef): Promise<SendAsAddress[]> {
    const acc = await first<{ send_as_fetched_at: number | null }>(
      env.DB,
      "SELECT send_as_fetched_at FROM accounts WHERE id = ? AND owner_id = ?",
      a.accountId,
      a.ownerId,
    );
    const fetchedAt = acc?.send_as_fetched_at ?? null;
    if (deps.use && (fetchedAt === null || nowS() - fetchedAt >= SEND_AS_TTL_SECONDS)) {
      try {
        return await refresh(a);
      } catch (e) {
        // A provider failure (relink, component off, Google down) keeps the stored rows.
        if (!(e instanceof ToolError) || e.code === "internal") throw e;
      }
    }
    return allowed(a, await rows(a));
  }

  return {
    list,
    refresh,
    async assertFrom(a, from) {
      const addresses = await list(a);
      if (from === undefined || from === null) {
        return (
          addresses.find((x) => x.isDefault) ??
          addresses.find((x) => x.email === a.address) ??
          primaryOf(a, true)
        );
      }
      const wanted = from.trim().toLowerCase();
      const match = addresses.find((x) => x.email === wanted);
      if (match) return match;
      throw new ToolError(
        "sender_not_allowed",
        `Account ${accountKey(a.shortId)} may not send as that address. Call list_send_as for the addresses it may use.`,
      );
    },
  };
}
