// "Hold sends to new recipients" (ARCHITECTURE s.2; plan s.10): which recipients of a send are
// new to the sending account. A send with at least one new recipient waits for the owner
// (`SEND_APPROVAL_MODE=new_recipients`, the default); one whose recipients are all known goes out.
//
// A recipient is KNOWN to an account when, checked in this order and the network only for what is
// left: (a) it is one of the owner's own addresses (a linked account, OWNER_EMAILS,
// LINKABLE_EMAILS, the account's verified send-as aliases); (b) it is on the account's allow list
// (`send_allow`, by address or exact domain); (c) it is in `known_recipients` (sent to before,
// from this server, or confirmed once below); (d) it is in the account's contacts or other
// contacts; (e) the account has sent to it before (Gmail `in:sent to:<addr>`, one batch request).
// Inbound mail never makes an address known. Anything that fails a check, a cold contacts cache
// included, is NEW: every doubt resolves toward holding. An address that fails the strict pattern
// below is NEW and is never placed in a query.

import { config } from "../env";
import type { ToolContext } from "../registry/types";
import { CONTACTS, type ContactService } from "../services/contacts";
import { SEND } from "../services/mail-send";
import type { AccountRef } from "../services/types";
import { loadAccountRefs } from "./accounts";
import { all, nowSeconds } from "./db";

/**
 * A conservative RFC 5321 subset: a local part of letters, digits and `._+-` starting with a
 * letter or digit, an `@`, and a domain of at least two dot-separated labels (letters, digits and
 * inner hyphens) ending in letters. No space, quote, parenthesis, brace, colon or any other
 * character Gmail search treats as an operator.
 */
const ADDRESS =
  /^(?=.{3,254}$)[a-z0-9](?!.*\.\.)[a-z0-9._+-]{0,63}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** True for an address that is safe to put in a query (lowercase only: normalize first). */
export const isQueryableAddress = (address: string): boolean => ADDRESS.test(address);

const MAX_SHOWN = 100;

/**
 * The addresses of recipient entries (`a@x.com`, `Name <a@x.com>`): lowercase, trimmed, display
 * names stripped, deduplicated, in first-seen order. An entry that is not exactly an address or
 * `Name <address>` stays as its trimmed lowercase text (clipped), which fails the strict pattern and so
 * counts as NEW.
 */
export function normalizeRecipients(entries: readonly string[]): string[] {
  const out = new Set<string>();
  for (const entry of entries) {
    out.add(
      addressOf(entry) ?? entry.replace(/\s+/g, " ").trim().toLowerCase().slice(0, MAX_SHOWN),
    );
  }
  out.delete("");
  return [...out];
}

/** `a@x.com` or `Name <a@x.com>` (quoted or plain name) and nothing else, lowercase; else null. */
function addressOf(entry: string): string | null {
  const t = entry.trim();
  const named = /^(?:"(?:[^"\\]|\\.)*"|[^<>"@]*)\s*<([^<>\s]+)>$/.exec(t)?.[1];
  const one = named ?? (/^[^\s<>",;]+$/.test(t) ? t : null);
  return one ? one.toLowerCase() : null;
}

const CHUNK = 80;

/** Bounds on the network checks, so 20 recipients stay well under the 50-subrequest cap. */
export const LOOKUP_LIMITS = {
  /** Addresses sent in the one Gmail batch request (Gmail allows 100 calls per batch). */
  sentBatch: 100,
  /** Addresses looked up in contacts: 2 People API calls each (contacts, other contacts). */
  contacts: 6,
} as const;

/** Remembers addresses for the account; an address already there keeps its first source and time. */
export async function recordKnownRecipients(
  db: D1Database,
  accountId: string,
  addresses: readonly string[],
  source: "sent" | "contacts" | "history",
): Promise<void> {
  const valid = [...new Set(addresses.filter(isQueryableAddress))];
  if (valid.length === 0) return;
  const at = nowSeconds();
  for (let i = 0; i < valid.length; i += CHUNK) {
    await db.batch(
      valid
        .slice(i, i + CHUNK)
        .map((address) =>
          db
            .prepare(
              "INSERT OR IGNORE INTO known_recipients (account_id, address, source, first_seen) VALUES (?, ?, ?, ?)",
            )
            .bind(accountId, address, source, at),
        ),
    );
  }
}

/** Best effort: a failing cache write never changes the answer of a send that already happened. */
export async function rememberSent(
  ctx: ToolContext,
  a: AccountRef,
  entries: readonly string[],
): Promise<void> {
  try {
    await recordKnownRecipients(ctx.env.DB, a.accountId, normalizeRecipients(entries), "sent");
  } catch {
    console.error("known recipients: the cache could not be written");
  }
}

/** The owner's own addresses plus this account's verified send-as addresses. */
async function ownAddresses(ctx: ToolContext, a: AccountRef): Promise<Set<string>> {
  const c = config(ctx.env);
  const own = new Set<string>([...c.ownerEmails, ...c.linkableEmails]);
  for (const x of await loadAccountRefs(ctx.env.DB, ctx.ownerId)) own.add(x.address.toLowerCase());
  for (const x of await ctx.sendAs.list(a)) own.add(x.email.toLowerCase());
  return own;
}

/** Of `addresses`, those the account's Gmail `Sent` shows a message to (one batch request). */
async function sentHistory(
  ctx: ToolContext,
  a: AccountRef,
  addresses: readonly string[],
): Promise<string[]> {
  if (addresses.length === 0) return [];
  try {
    return await ctx.use(SEND, a).sentTo(a, addresses.slice(0, LOOKUP_LIMITS.sentBatch));
  } catch {
    return [];
  }
}

/** Of `addresses`, those in the account's contacts or other contacts (bounded lookups). */
async function contactHits(
  ctx: ToolContext,
  a: AccountRef,
  addresses: readonly string[],
): Promise<string[]> {
  if (addresses.length === 0) return [];
  let contacts: ContactService;
  try {
    contacts = ctx.use(CONTACTS, a);
  } catch {
    return [];
  }
  const look = async (address: string): Promise<string | null> => {
    try {
      const found = await contacts.search(a, address, 10);
      return found.some((p) => p.emails.some((e) => e.trim().toLowerCase() === address))
        ? address
        : null;
    } catch {
      return null;
    }
  };
  // The first lookup alone: it pays the one-time cache warm-up of each source, which the rest
  // (run together) then skip, so a cold account costs 4 calls for the first and 2 for each more.
  const [head, ...tail] = addresses.slice(0, LOOKUP_LIMITS.contacts);
  const hits = [await look(head as string), ...(await Promise.all(tail.map(look)))];
  return hits.filter((x): x is string => x !== null);
}

async function cached(
  db: D1Database,
  accountId: string,
  addresses: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < addresses.length; i += CHUNK) {
    const chunk = addresses.slice(i, i + CHUNK);
    const rows = await all<{ address: string }>(
      db,
      `SELECT address FROM known_recipients WHERE account_id = ? AND address IN (${chunk.map(() => "?").join(",")})`,
      accountId,
      ...chunk,
    );
    for (const r of rows) found.add(r.address);
  }
  return found;
}

/**
 * The recipients (from to, cc and bcc, in any form) that are new to the account, as normalized
 * addresses. Empty means every recipient is known and the send may go straight out.
 */
export async function findNewRecipients(
  ctx: ToolContext,
  a: AccountRef,
  entries: readonly string[],
): Promise<string[]> {
  const db = ctx.env.DB;
  const given = normalizeRecipients(entries);
  // Anything that is not a plain address is new and goes no further.
  const invalid = given.filter((x) => !isQueryableAddress(x));
  let rest = given.filter(isQueryableAddress);

  // (a) the owner's own addresses
  if (rest.length > 0) {
    const own = await ownAddresses(ctx, a);
    rest = rest.filter((x) => !own.has(x));
  }
  // (b) the allow list: an address, or the exact domain
  if (rest.length > 0) {
    const rows = await all<{ kind: string; value: string }>(
      db,
      "SELECT kind, value FROM send_allow WHERE account_id = ?",
      a.accountId,
    );
    const addresses = new Set(rows.filter((r) => r.kind === "address").map((r) => r.value));
    const domains = new Set(rows.filter((r) => r.kind === "domain").map((r) => r.value));
    rest = rest.filter((x) => !addresses.has(x) && !domains.has(x.slice(x.lastIndexOf("@") + 1)));
  }
  // (c) the known-recipients cache
  if (rest.length > 0) {
    const hit = await cached(db, a.accountId, rest);
    rest = rest.filter((x) => !hit.has(x));
  }
  // (e) Gmail Sent, one batch request for all that are left; then (d) contacts for what remains.
  const confirmed: { address: string; source: "history" | "contacts" }[] = [];
  const sent = new Set(await sentHistory(ctx, a, rest));
  for (const x of rest) if (sent.has(x)) confirmed.push({ address: x, source: "history" });
  rest = rest.filter((x) => !sent.has(x));
  const met = new Set(await contactHits(ctx, a, rest));
  for (const x of rest) if (met.has(x)) confirmed.push({ address: x, source: "contacts" });
  rest = rest.filter((x) => !met.has(x));

  if (confirmed.length > 0) {
    try {
      for (const source of ["history", "contacts"] as const) {
        await recordKnownRecipients(
          db,
          a.accountId,
          confirmed.filter((c) => c.source === source).map((c) => c.address),
          source,
        );
      }
    } catch {
      console.error("known recipients: the cache could not be written");
    }
  }
  return [...invalid, ...rest];
}

/** The note a held send carries: which recipients are new. */
export const heldBecause = (newOnes: readonly string[]): string =>
  `Held for the owner's approval: ${newOnes.length === 1 ? "this recipient is" : "these recipients are"} new to the account: ${newOnes.join(", ")}.`;
