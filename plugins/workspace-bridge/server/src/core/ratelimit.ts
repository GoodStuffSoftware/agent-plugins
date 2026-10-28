// Fixed-window limits (ARCHITECTURE s.2, s.4 `rate_counters`): tool calls per grant per minute and
// sends per account per hour and day. M9 stub: never trips. M14 fills the bodies without changing
// these signatures.

import type { Env } from "../env";
import type { Grant } from "../registry/types";
import type { AccountRef } from "../services/types";

/** What `ctx.limits` is (s.3.2). Both throw `rate_limited` with `retryAfterSeconds` when over. */
export interface RateLimiter {
  /** One tool call on the call's grant (bucket `calls:m:<grantId>`). `register.ts` calls it. */
  call(tool: string): Promise<void>;
  /** One message sent from the account (`send:h:<accountId>`, `send:d:<accountId>`). */
  send(a: AccountRef): Promise<void>;
}

export interface RateLimiterDeps {
  env: Env;
  grant: Grant;
  /** Milliseconds. */
  now: () => number;
}

/** M9 stub: nothing is counted and nothing trips. */
export function createRateLimiter(_deps: RateLimiterDeps): RateLimiter {
  return {
    async call() {},
    async send() {},
  };
}
