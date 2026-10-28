// Which From addresses an account may send as (ARCHITECTURE s.2, s.3.2; plan s.10). M9 stub: only
// the account's own address. M14 fills the bodies from the `send_as` rows (Gmail's sendAs list,
// refreshed after 24 h) without changing these signatures.

import type { Env } from "../env";
import type { AccountRef } from "../services/types";
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
}

export interface SendAsDeps {
  env: Env;
  /** Milliseconds. */
  now: () => number;
}

const primaryOf = (a: AccountRef): SendAsAddress => ({
  email: a.address,
  displayName: null,
  isDefault: true,
  isPrimary: true,
  replyTo: null,
});

/** M9 stub: every account may send as its own address only. */
export function createSendAsCache(_deps: SendAsDeps): SendAsCache {
  return {
    async list(a) {
      return [primaryOf(a)];
    },
    async assertFrom(a, from) {
      const primary = primaryOf(a);
      if (from === undefined || from === null) return primary;
      if (from.trim().toLowerCase() === primary.email) return primary;
      throw new ToolError(
        "sender_not_allowed",
        `Account ${accountKey(a.shortId)} may only send as its own address.`,
      );
    },
  };
}
