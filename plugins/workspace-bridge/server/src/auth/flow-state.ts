// Single-use Google flow state (ARCHITECTURE s.1.5, s.4 `flow_states`).
//
// `state` is 256 random bits sent to Google; the row's id is its SHA-256, so D1 never holds a
// usable `state`. The row is bound to the browser that started the flow by `__Host-wb-flow`, whose
// SHA-256 is the row's `binding`. Consuming is `DELETE ... RETURNING`: any attempt, right or wrong,
// uses the row up. Rows live 10 minutes.

import { base64url, randomBytes, sha256Hex, timingSafeEqual } from "../core/crypto";
import { type FlowKind, type FlowStateRow, first, nowSeconds } from "../core/db";
import { hostCookie, readCookie } from "./session";

export const FLOW_COOKIE = "__Host-wb-flow";
export const FLOW_TTL = 10 * 60;

/** `kind: "signin"` payload: what the callback needs to finish the owner sign-in. */
export interface SigninPayload {
  /** PKCE verifier for the Google code exchange. */
  verifier: string;
  /** Must come back as the ID token's `nonce`. */
  nonce: string;
  /** Same-origin path to return to after sign-in, such as the original `/authorize?...`. */
  returnTo: string;
}

export type FlowFailure = "missing" | "unknown" | "mismatch" | "expired";

export type Consumed =
  | { ok: true; kind: FlowKind; payload: unknown }
  | { ok: false; reason: FlowFailure };

/**
 * Stores a new flow and returns the `state` for Google and the `Set-Cookie` that binds it to this
 * browser. Expired rows are swept in the same batch.
 */
export async function createFlow(
  db: D1Database,
  kind: FlowKind,
  payload: unknown,
): Promise<{ state: string; setCookie: string }> {
  const state = base64url(randomBytes(32));
  const cookie = base64url(randomBytes(32));
  const now = nowSeconds();
  await db.batch([
    db.prepare("DELETE FROM flow_states WHERE expires_at <= ?").bind(now),
    db
      .prepare(
        "INSERT INTO flow_states (id, kind, payload, binding, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        await sha256Hex(state),
        kind,
        JSON.stringify(payload),
        await sha256Hex(cookie),
        now + FLOW_TTL,
      ),
  ]);
  return { state, setCookie: hostCookie(FLOW_COOKIE, cookie, FLOW_TTL) };
}

/**
 * Consumes the flow named by `state`. The row is deleted before the cookie is compared, so a
 * replay, a wrong cookie and an expired row all fail and none can be retried.
 */
export async function consumeFlow(
  db: D1Database,
  req: Request,
  state: string | null,
): Promise<Consumed> {
  if (!state) return { ok: false, reason: "missing" };
  const row = await first<FlowStateRow>(
    db,
    "DELETE FROM flow_states WHERE id = ? RETURNING *",
    await sha256Hex(state),
  );
  if (!row) return { ok: false, reason: "unknown" };
  const cookie = readCookie(req, FLOW_COOKIE);
  if (!cookie || !timingSafeEqual(await sha256Hex(cookie), row.binding)) {
    return { ok: false, reason: "mismatch" };
  }
  if (row.expires_at <= nowSeconds()) return { ok: false, reason: "expired" };
  return { ok: true, kind: row.kind, payload: JSON.parse(row.payload) as unknown };
}

/** Narrows a consumed `signin` payload; anything malformed is treated as no flow. */
export function signinPayload(payload: unknown): SigninPayload | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  if (
    typeof p.verifier !== "string" ||
    typeof p.nonce !== "string" ||
    typeof p.returnTo !== "string"
  ) {
    return undefined;
  }
  return { verifier: p.verifier, nonce: p.nonce, returnTo: p.returnTo };
}
