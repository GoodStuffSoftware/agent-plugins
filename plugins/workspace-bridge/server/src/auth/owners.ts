// Owner identities (ARCHITECTURE s.4 `owners`, `owner_identities`; plan s.4.2).
//
// An address may sign in only if it is on `OWNER_EMAILS` (exact, lowercase; an empty list lets
// nobody in) and its Google `sub` matches the one pinned for it. A `sub` is pinned only while
// `SETUP_MODE=true`; after that an unpinned address or a different `sub` is refused. Every owner
// address belongs to the one owner, whose row is created by the first allowed sign-in.

import { hex, hmacSha256, randomId } from "../core/crypto";
import { first, nowSeconds, type OwnerIdentityRow, run } from "../core/db";
import { config, type Env } from "../env";
import { cookieSecret } from "./session";

export type OwnerRefusal =
  /** The address is not on `OWNER_EMAILS`. */
  | "not_allowlisted"
  /** The address has no pinned `sub` and setup mode is off. */
  | "not_pinned"
  /** The address is pinned to another Google account. */
  | "sub_mismatch"
  /** This Google account is already pinned to another address. */
  | "sub_in_use";

export type OwnerResolution =
  | { ok: true; ownerId: string; pinned: boolean }
  | { ok: false; reason: OwnerRefusal };

const IDENTITY = "SELECT * FROM owner_identities WHERE email = ?";

/** Decides whether a Google identity may sign in, pinning its `sub` in setup mode. */
export async function resolveOwner(env: Env, email: string, sub: string): Promise<OwnerResolution> {
  const address = email.toLowerCase();
  const { ownerEmails, setupMode } = config(env);
  if (!ownerEmails.includes(address)) return { ok: false, reason: "not_allowlisted" };
  if (sub === "") return { ok: false, reason: "sub_mismatch" };

  const now = nowSeconds();
  let row = await first<OwnerIdentityRow>(env.DB, IDENTITY, address);
  let pinned = false;
  if (row?.sub == null) {
    if (!setupMode) return { ok: false, reason: "not_pinned" };
    try {
      await env.DB.batch([
        // The single owner, created once; concurrent first sign-ins serialize in D1.
        env.DB.prepare(
          "INSERT INTO owners (id, created_at) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM owners)",
        ).bind(randomId("o_"), now),
        // Pin only an unpinned identity: a `sub` already written is never replaced.
        env.DB.prepare(
          "INSERT INTO owner_identities (email, owner_id, sub, pinned_at, last_login_at) " +
            "VALUES (?, (SELECT id FROM owners ORDER BY created_at, id LIMIT 1), ?, ?, ?) " +
            "ON CONFLICT (email) DO UPDATE SET sub = excluded.sub, pinned_at = excluded.pinned_at, " +
            "last_login_at = excluded.last_login_at WHERE owner_identities.sub IS NULL",
        ).bind(address, sub, now, now),
      ]);
    } catch (e) {
      if (String(e).includes("owner_identities.sub")) return { ok: false, reason: "sub_in_use" };
      throw e;
    }
    row = await first<OwnerIdentityRow>(env.DB, IDENTITY, address);
    pinned = true;
  }
  if (!row || row.sub !== sub) return { ok: false, reason: "sub_mismatch" };
  if (!pinned) {
    await run(
      env.DB,
      "UPDATE owner_identities SET last_login_at = ? WHERE email = ?",
      now,
      address,
    );
  }
  return { ok: true, ownerId: row.owner_id, pinned };
}

/**
 * A keyed hash of an address for log lines, never the address itself: HMAC with `COOKIE_SECRET`,
 * so it cannot be reversed by hashing guesses. 16 hex characters.
 */
export async function emailHash(env: Env, email: string): Promise<string> {
  const secret = cookieSecret(env);
  if (!secret) return "unavailable";
  return hex(await hmacSha256(secret, `wb-email|${email.toLowerCase()}`)).slice(0, 16);
}
