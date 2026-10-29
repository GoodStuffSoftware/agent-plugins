// Fixed-window limits (ARCHITECTURE s.2, s.4 `rate_counters`; plan s.10.3): tool calls per grant
// per minute (the `CALL_LIMIT` ratelimits binding when bound, else D1) and sends per account per
// hour and day (D1). `checkSend` is the one gate every send path calls before the provider.

import { config, type Env } from "../env";
import type { Grant } from "../registry/types";
import type { AccountRef } from "../services/types";
import { first, incrementCounter } from "./db";
import { ToolError } from "./errors";
import { accountKey } from "./ids";

/** Tool calls per grant per minute. The `CALL_LIMIT` binding in wrangler.example.jsonc matches. */
export const CALLS_PER_MINUTE = 120;

/** What `ctx.limits` is (s.3.2). Each throws `rate_limited` with `retryAfterSeconds` when over. */
export interface RateLimiter {
  /** One tool call on the call's grant (bucket `calls:m:<grantId>`). `register.ts` calls it. */
  call(tool: string): Promise<void>;
  /** One message sent from the account (`send:h:<accountId>`, `send:d:<accountId>`). */
  send(a: AccountRef): Promise<void>;
  /**
   * Every check a send makes before it calls the provider, in this order: `SEND_ENABLED`
   * (`send_disabled`), the owner's kill switch (`send_disabled`), at most `MAX_RECIPIENTS`
   * distinct addresses across to, cc and bcc (`too_many_recipients`), then one hit on the hourly
   * and daily counters (`rate_limited`). A refused attempt that reached the counters still counts.
   */
  checkSend(a: AccountRef, recipients: readonly string[]): Promise<void>;
  /** Only the two switches `checkSend` starts with (`send_disabled`); counts nothing. */
  assertSendEnabled(a: AccountRef): Promise<void>;
}

export interface RateLimiterDeps {
  env: Env;
  grant: Grant;
  /** Milliseconds. */
  now: () => number;
}

const limited = (message: string, retryAfterSeconds: number): ToolError =>
  new ToolError("rate_limited", message, {
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)),
  });

/** Counts one hit; the seconds until the window ends when the count is over `limit`. */
async function hit(
  db: D1Database,
  bucket: string,
  now: number,
  window: number,
  limit: number,
): Promise<number | undefined> {
  const start = now - (now % window);
  const count = await incrementCounter(db, bucket, start);
  return count > limit ? start + window - now : undefined;
}

export function createRateLimiter(deps: RateLimiterDeps): RateLimiter {
  const { env, grant } = deps;
  const nowS = (): number => Math.floor(deps.now() / 1000);

  async function send(a: AccountRef): Promise<void> {
    const c = config(env);
    const t = nowS();
    const key = accountKey(a.shortId);
    const hour = await hit(env.DB, `send:h:${a.accountId}`, t, 3600, c.sendPerHour);
    if (hour !== undefined) {
      throw limited(
        `Account ${key} has reached its limit of ${c.sendPerHour} sends per hour.`,
        hour,
      );
    }
    const day = await hit(env.DB, `send:d:${a.accountId}`, t, 86400, c.sendPerDay);
    if (day !== undefined) {
      throw limited(`Account ${key} has reached its limit of ${c.sendPerDay} sends per day.`, day);
    }
  }

  async function assertSendEnabled(a: AccountRef): Promise<void> {
    const c = config(env);
    const accountsUrl = `${c.issuer}/accounts`;
    if (!c.sendEnabled) {
      throw new ToolError(
        "send_disabled",
        "Sending is disabled on this server: the SEND_ENABLED setting is not true.",
      );
    }
    const owner = await first<{ send_kill_switch: number }>(
      env.DB,
      "SELECT send_kill_switch FROM owners WHERE id = ?",
      a.ownerId,
    );
    if (owner?.send_kill_switch !== 0) {
      throw new ToolError(
        "send_disabled",
        `Sending is switched off. The owner can switch it back on at ${accountsUrl}.`,
        { accountsUrl },
      );
    }
  }

  return {
    async call() {
      const message = `Too many tool calls on this connection: the limit is ${CALLS_PER_MINUTE} a minute.`;
      if (env.CALL_LIMIT) {
        const { success } = await env.CALL_LIMIT.limit({ key: `calls:${grant.grantId}` });
        if (!success) throw limited(message, 60);
        return;
      }
      const after = await hit(env.DB, `calls:m:${grant.grantId}`, nowS(), 60, CALLS_PER_MINUTE);
      if (after !== undefined) throw limited(message, after);
    },
    send,
    assertSendEnabled,
    async checkSend(a, recipients) {
      const c = config(env);
      await assertSendEnabled(a);
      const distinct = new Set(recipients.map((r) => r.trim().toLowerCase()).filter((r) => r));
      if (distinct.size > c.maxRecipients) {
        throw new ToolError(
          "too_many_recipients",
          `A message may have at most ${c.maxRecipients} recipients across to, cc and bcc; this one has ${distinct.size}.`,
          { maxRecipients: c.maxRecipients },
        );
      }
      await send(a);
    },
  };
}
