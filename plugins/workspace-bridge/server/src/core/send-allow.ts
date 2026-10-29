// The owner's send allow list (`send_allow`, migration 0004): addresses and domains an account may
// send to without approval under `SEND_APPROVAL_MODE=new_recipients`. Only the owner's browser
// edits it (no MCP tool does); every function checks that the account belongs to the owner.

import { all, first, nowSeconds, run } from "./db";
import { ToolError } from "./errors";
import { isQueryableAddress } from "./recipients";

export type AllowKind = "address" | "domain";

export interface AllowEntry {
  kind: AllowKind;
  /** Lowercase address, or lowercase domain without `@`. */
  value: string;
  /** Unix seconds. */
  createdAt: number;
}

/**
 * Domains that anyone can get a mailbox on: allowing one would allow the whole world, so a
 * `domain` entry for them is refused (an exact address on them is fine).
 */
const FREEMAIL_EXACT = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "mail.com",
  "ymail.com",
  "rocketmail.com",
  "zoho.com",
  "zohomail.com",
  "tutanota.com",
  "tuta.com",
  "tuta.io",
  "fastmail.com",
  "hey.com",
  "hushmail.com",
  "inbox.com",
  "web.de",
  "mail.ru",
  "qq.com",
  "163.com",
  "126.com",
  "naver.com",
  "comcast.net",
  "att.net",
  "verizon.net",
  "sbcglobal.net",
  "btinternet.com",
  "t-online.de",
  "orange.fr",
  "free.fr",
  "libero.it",
  "rediffmail.com",
]);
/** Providers with a domain per country: yahoo.co.uk, hotmail.fr, gmx.de, yandex.ru and so on. */
const FREEMAIL_FAMILY =
  /^(?:yahoo|hotmail|outlook|live|gmx|yandex|msn)\.[a-z]{2,}(?:\.[a-z]{2,})?$/;

/** True for a domain on the refusal list. */
export const isFreemailDomain = (domain: string): boolean =>
  FREEMAIL_EXACT.has(domain) || FREEMAIL_FAMILY.test(domain);

const DOMAIN = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A checked, lowercase entry, or `invalid_argument`. */
export function normalizeAllow(kind: AllowKind, raw: string): string {
  const value = (kind === "domain" ? raw.trim().replace(/^@/, "") : raw.trim()).toLowerCase();
  if (kind === "address") {
    if (!isQueryableAddress(value)) {
      throw new ToolError("invalid_argument", "That is not a plain email address.");
    }
    return value;
  }
  if (kind !== "domain") throw new ToolError("invalid_argument", "kind must be address or domain.");
  if (!DOMAIN.test(value)) {
    throw new ToolError("invalid_argument", "That is not a plain domain such as example.com.");
  }
  if (isFreemailDomain(value)) {
    throw new ToolError(
      "invalid_argument",
      `${value} is a public mail provider: allowing the whole domain would allow anyone. Allow single addresses instead.`,
    );
  }
  return value;
}

async function assertOwns(db: D1Database, ownerId: string, accountId: string): Promise<void> {
  const row = await first<{ id: string }>(
    db,
    "SELECT id FROM accounts WHERE id = ? AND owner_id = ?",
    accountId,
    ownerId,
  );
  if (!row) throw new ToolError("account_not_found", "No linked account matches.");
}

/** The account's allow list, domains first, then addresses, each sorted. */
export async function listSendAllow(
  db: D1Database,
  ownerId: string,
  accountId: string,
): Promise<AllowEntry[]> {
  await assertOwns(db, ownerId, accountId);
  const rows = await all<{ kind: AllowKind; value: string; created_at: number }>(
    db,
    "SELECT kind, value, created_at FROM send_allow WHERE account_id = ? ORDER BY kind DESC, value",
    accountId,
  );
  return rows.map((r) => ({ kind: r.kind, value: r.value, createdAt: r.created_at }));
}

/**
 * Adds an entry; false when it was already there. `invalid_argument` for a malformed value or a
 * `domain` on the freemail list; `account_not_found` for an account that is not the owner's.
 */
export async function addSendAllow(
  db: D1Database,
  ownerId: string,
  accountId: string,
  kind: AllowKind,
  raw: string,
): Promise<boolean> {
  const value = normalizeAllow(kind, raw);
  await assertOwns(db, ownerId, accountId);
  const res = await run(
    db,
    "INSERT OR IGNORE INTO send_allow (account_id, kind, value, created_at) VALUES (?, ?, ?, ?)",
    accountId,
    kind,
    value,
    nowSeconds(),
  );
  return (res.meta.changes ?? 0) > 0;
}

/** Removes an entry; false when it was not there. */
export async function removeSendAllow(
  db: D1Database,
  ownerId: string,
  accountId: string,
  kind: AllowKind,
  raw: string,
): Promise<boolean> {
  await assertOwns(db, ownerId, accountId);
  const value = raw.trim().replace(/^@/, "").toLowerCase();
  const res = await run(
    db,
    "DELETE FROM send_allow WHERE account_id = ? AND kind = ? AND value = ?",
    accountId,
    kind,
    value,
  );
  return (res.meta.changes ?? 0) > 0;
}
