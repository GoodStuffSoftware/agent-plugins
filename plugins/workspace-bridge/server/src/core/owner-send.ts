// "The owner told me to send this" (ARCHITECTURE s.2 "Owner-directed sends"): an exemption from
// the recipient-based hold, and only from that. A send tool may carry `ownerInstruction`, the
// owner's own words from the chat that direct this send. When the send would be held ONLY because
// some recipients are new to the account, it goes out unheld if each of those recipients passes
// one of two checks:
//
//   thread  the send is a reply, and the bridge itself read that thread from Google and the address
//           is a sender or recipient (From, To, Cc) of a message in it. Drafts do not count, and the
//           thread id the caller names is never trusted alone: the read decides.
//   quote   the address appears in `ownerInstruction` as a whole address (case-insensitive, with
//           nothing address-like touching either end).
//
// The bridge cannot tell whether the quote really came from the owner (a claude.ai connector has
// no elicitation), so the protection is these two checks, a daily cap on sends that relied on the
// quote check, and the audit trail. Every other hold or refusal (the mode `all`, the sending
// switches, the rate limits, the draft lock) is untouched: this module is only asked about
// recipients, and only in the mode `new_recipients`.

import { all as allRows, first } from "./db";
import { isQueryableAddress, normalizeRecipients } from "./recipients";

/** The longest `ownerInstruction`. The audit row keeps all of it. */
export const OWNER_INSTRUCTION_MAX = 500;

/** Sends per UTC day, across all accounts, that relied on the quote check for a recipient. */
export const OWNER_QUOTE_SENDS_PER_DAY = 5;

const DAY = 86_400;
const BUCKET = "owner_send_quote:d";

export type CheckVia = "thread" | "quote";

/** How one recipient was covered. */
export type Covered = { address: string; via: CheckVia };

/** A recipient that passed neither check. */
export type Uncovered = { address: string; threadChecked: boolean; threadFailed?: string };

/** The audited facts of a send that went out under the exemption. */
export type OwnerSendGrant = {
  instruction: string;
  covered: Covered[];
};

export type OwnerSendDecision =
  | { granted: true; grant: OwnerSendGrant }
  | { granted: false; reason: string };

// What may stand directly before or after an address in the quote. Anything else (a letter, digit,
// `.`, `@`, `-`, `_`, `+`, any non-ASCII character) means the match is part of something longer.
const EDGE = /[\s<>()[\]{}"'`,;:!?]/;

/** True when `address` (lowercase) appears in `text` as a whole address, ignoring case. */
export function addressInQuote(address: string, text: string): boolean {
  if (!isQueryableAddress(address)) return false;
  const hay = text.toLowerCase();
  let from = 0;
  for (;;) {
    const at = hay.indexOf(address, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : (hay[at - 1] as string);
    const end = at + address.length;
    const after = end >= hay.length ? "" : (hay[end] as string);
    // A full stop right after is the end of a sentence only when nothing address-like follows it.
    const next = hay[end + 1];
    const stop = after === "." && (next === undefined || EDGE.test(next));
    if ((before === "" || EDGE.test(before)) && (after === "" || EDGE.test(after) || stop)) {
      return true;
    }
    from = at + 1;
  }
}

/**
 * Takes one slot of today's allowance for quote-based sends: true when there was one. One
 * statement, so concurrent sends never take more than the cap.
 */
export async function takeQuoteSlot(
  db: D1Database,
  nowSeconds: number,
  cap = OWNER_QUOTE_SENDS_PER_DAY,
): Promise<boolean> {
  const day = nowSeconds - (nowSeconds % DAY);
  const row = await first<{ count: number }>(
    db,
    `INSERT INTO rate_counters (bucket, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1 WHERE count < ?
     RETURNING count`,
    BUCKET,
    day,
    cap,
  );
  return row !== null && row !== undefined;
}

/** How many quote-based sends have taken a slot today (for tests and the docs). */
export async function quoteSlotsUsed(db: D1Database, nowSeconds: number): Promise<number> {
  const day = nowSeconds - (nowSeconds % DAY);
  const rows = await allRows<{ count: number }>(
    db,
    "SELECT count FROM rate_counters WHERE bucket = ? AND window_start = ?",
    BUCKET,
    day,
  );
  return rows[0]?.count ?? 0;
}

/**
 * Decides the exemption for the recipients that made a send held (`newOnes`, as returned by
 * `findNewRecipients`). `thread` reads the participants of the reply's thread (undefined for a
 * send that is not a reply; a rejected promise means the thread could not be read, which fails the
 * thread check). Nothing is written unless the answer is granted, and then one slot is taken only
 * when the quote check was needed.
 */
export async function decideOwnerSend(
  db: D1Database,
  nowSeconds: number,
  input: {
    instruction: string;
    newOnes: readonly string[];
    thread: (() => Promise<readonly string[]>) | undefined;
  },
): Promise<OwnerSendDecision> {
  const instruction = input.instruction;
  let onThread: Set<string> | undefined;
  let threadError = false;
  if (input.thread) {
    try {
      onThread = new Set(normalizeRecipients(await input.thread()));
    } catch {
      threadError = true;
    }
  }
  const covered: Covered[] = [];
  const failed: Uncovered[] = [];
  for (const address of normalizeRecipients(input.newOnes)) {
    if (isQueryableAddress(address) && onThread?.has(address)) {
      covered.push({ address, via: "thread" });
    } else if (addressInQuote(address, instruction)) {
      covered.push({ address, via: "quote" });
    } else {
      failed.push({
        address,
        threadChecked: onThread !== undefined,
        ...(threadError ? { threadFailed: "the thread could not be read" } : {}),
      });
    }
  }
  if (failed.length > 0) return { granted: false, reason: failureReason(failed, !!input.thread) };
  if (covered.some((c) => c.via === "quote") && !(await takeQuoteSlot(db, nowSeconds))) {
    return {
      granted: false,
      reason: `The daily cap of ${OWNER_QUOTE_SENDS_PER_DAY} sends that rely on the owner's instruction naming the address was reached (UTC day), so this send is held.`,
    };
  }
  return { granted: true, grant: { instruction, covered } };
}

function failureReason(failed: readonly Uncovered[], isReply: boolean): string {
  const each = failed.map((f) => {
    const thread = !isReply
      ? "not a reply, so no thread check"
      : f.threadFailed
        ? `thread check failed (${f.threadFailed})`
        : "not on the thread";
    return `${f.address} failed the reply check (${thread}) and the given-address check (not named in the owner's instruction)`;
  });
  return `An owner instruction was given but not accepted: ${each.join("; ")}.`;
}

/** The audit detail of a send that went out under the exemption: the quote and each check. */
export function grantDetail(g: OwnerSendGrant): string {
  const checks = g.covered
    .map((c) => `${c.address} via ${c.via === "thread" ? "reply thread" : "named in instruction"}`)
    .join(", ");
  // The checks come first: the longest field (the quote) is last, so a clip can only cut the quote.
  return `owner-directed send; ${checks}; instruction ${JSON.stringify(g.instruction)}`;
}

/** What the tool answer says about a send that went out under the exemption. */
export function grantAnswer(g: OwnerSendGrant): Record<string, unknown> {
  return {
    sent: true,
    ownerInstruction: {
      applied: true,
      note: "Sent without the owner's approval because the owner's instruction was given and every new recipient passed a check. This is recorded in the audit log.",
      recipientChecks: g.covered.map((c) => ({
        address: c.address,
        check: c.via === "thread" ? "reply_thread" : "named_in_instruction",
      })),
    },
  };
}
