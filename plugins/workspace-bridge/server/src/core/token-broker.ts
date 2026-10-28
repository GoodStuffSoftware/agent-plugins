// Google token broker (ARCHITECTURE s.3.6; plan s.3.3, s.4.3 item 6). The only code that opens a
// sealed refresh token or calls Google's token endpoint. Refresh and access tokens never appear in
// a log, an error or any return value other than accessToken()'s own result.

import { GOOGLE_TOKEN_URL } from "../auth/google-oidc";
import { config, type Env } from "../env";
import { currentKeyVersion, open, type SealAad, seal, type TokenKind } from "./crypto";
import { getAccount, getToken, nowSeconds } from "./db";

// Until M5's src/core/errors.ts lands: the same constructor and fields as its ToolError.
type BrokerErrorCode = "account_not_found" | "needs_relink" | "upstream_error" | "internal";
class ToolError extends Error {
  readonly code: BrokerErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  constructor(code: BrokerErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.details = details;
  }
}

/** An access token this close to its expiry (seconds) counts as expired. */
export const EXPIRY_MARGIN_SECONDS = 300;

/** The account fields the broker reads; `AccountRef` (s.3.6) satisfies it. */
export interface BrokerAccount {
  readonly ownerId: string;
  readonly accountId: string;
}

export interface TokenBroker {
  /** A Google access token for the account, valid for at least `EXPIRY_MARGIN_SECONDS`. */
  accessToken(a: BrokerAccount): Promise<string>;
  /** Google refused the last token: drop it, and make the next `accessToken(a)` refresh. */
  invalidate(a: BrokerAccount): void;
}

interface Cached {
  token: string;
  /** Unix seconds. */
  expiresAt: number;
}

// Per isolate, shared by every request and every broker object.
const memory = new Map<string, Cached>();
const inflight = new Map<string, Promise<string>>();
/** Accounts whose D1 access token Google refused (`invalidate`): skip it on the next load. */
const mustRefresh = new Set<string>();

const keyOf = (a: BrokerAccount): string => `${a.ownerId}|${a.accountId}`;

const aad = (a: BrokerAccount, kind: TokenKind): SealAad => ({
  ownerId: a.ownerId,
  accountId: a.accountId,
  kind,
});

const usable = (expiresAt: number | null, now: number): expiresAt is number =>
  expiresAt !== null && expiresAt - now > EXPIRY_MARGIN_SECONDS;

/** Cheap to build: no I/O, and all state lives at module scope. Reads Google secrets lazily. */
export function createTokenBroker(env: Env): TokenBroker {
  return {
    async accessToken(a) {
      const key = keyOf(a);
      const hit = memory.get(key);
      if (hit && usable(hit.expiresAt, nowSeconds())) return hit.token;
      let pending = inflight.get(key);
      if (!pending) {
        pending = load(env, a, key).finally(() => inflight.delete(key));
        inflight.set(key, pending);
      }
      return pending;
    },
    invalidate(a) {
      const key = keyOf(a);
      memory.delete(key);
      mustRefresh.add(key);
    },
  };
}

/** D1 access token if it is not expiring, else a refresh. Runs once per account at a time. */
async function load(env: Env, a: BrokerAccount, key: string): Promise<string> {
  if (!mustRefresh.has(key)) {
    const row = await getToken(env.DB, a.accountId, "access");
    if (row && usable(row.expires_at, nowSeconds())) {
      try {
        const token = await open(row, aad(a, "access"), env);
        memory.set(key, { token, expiresAt: row.expires_at });
        return token;
      } catch {
        // The access row is a cache: one that does not open is a miss, and the refresh
        // below either replaces it or reports the real problem.
      }
    }
  }
  return refresh(env, a, key);
}

async function refresh(env: Env, a: BrokerAccount, key: string): Promise<string> {
  const client = googleClient(env);
  const accountsUrl = `${config(env).issuer}/accounts`;
  const [account, stored] = await Promise.all([
    getAccount(env.DB, a.ownerId, a.accountId),
    getToken(env.DB, a.accountId, "refresh"),
  ]);
  if (!account) {
    memory.delete(key);
    throw new ToolError("account_not_found", "The account is no longer linked.", { accountsUrl });
  }
  if (account.status === "needs_relink") {
    memory.delete(key);
    throw relinkError(accountsUrl);
  }
  if (!stored) {
    await markNeedsRelink(env, a, key, null);
    throw relinkError(accountsUrl);
  }

  const refreshToken = await open(stored, aad(a, "refresh"), env);
  const result = await requestToken(client, refreshToken);
  if (result === "invalid_grant") {
    // Revoked, password change or six months idle. Mark only if the refresh row is still the
    // one just used: a relink that landed meanwhile must not be taken offline.
    if (await markNeedsRelink(env, a, key, stored.iv)) throw relinkError(accountsUrl);
    throw new ToolError(
      "upstream_error",
      "The account's Google tokens changed during the refresh; try again.",
    );
  }

  // One D1 write per refresh: the access token, plus the refresh token when Google rotated it or
  // its row is under an older key version, all sealed under CURRENT_KEY_VERSION.
  const now = nowSeconds();
  const expiresAt = now + result.expiresIn;
  const statements: D1PreparedStatement[] = [];
  const rotated = result.refreshToken !== undefined && result.refreshToken !== refreshToken;
  if (rotated || stored.key_version !== currentKeyVersion(env)) {
    const sealed = await seal(result.refreshToken ?? refreshToken, aad(a, "refresh"), env);
    statements.push(
      env.DB.prepare(
        `UPDATE account_tokens SET ciphertext = ?1, iv = ?2, key_version = ?3, updated_at = ?4
         WHERE account_id = ?5 AND kind = 'refresh' AND iv = ?6`,
      ).bind(sealed.ciphertext, sealed.iv, sealed.key_version, now, a.accountId, stored.iv),
    );
  }
  const sealed = await seal(result.accessToken, aad(a, "access"), env);
  statements.push(
    // The statement of upsertToken (core/db.ts), here so it joins the batch.
    env.DB.prepare(
      `INSERT INTO account_tokens (account_id, kind, ciphertext, iv, key_version, expires_at, updated_at)
       VALUES (?, 'access', ?, ?, ?, ?, ?)
       ON CONFLICT (account_id, kind) DO UPDATE SET
         ciphertext = excluded.ciphertext, iv = excluded.iv, key_version = excluded.key_version,
         expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
    ).bind(a.accountId, sealed.ciphertext, sealed.iv, sealed.key_version, expiresAt, now),
  );
  await env.DB.batch(statements);

  memory.set(key, { token: result.accessToken, expiresAt });
  mustRefresh.delete(key);
  return result.accessToken;
}

function googleClient(env: Env): { id: string; secret: string } {
  const id = env.GOOGLE_CLIENT_ID?.trim() ?? "";
  const secret = env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
  if (id === "" || secret === "") {
    const missing = [id === "" && "GOOGLE_CLIENT_ID", secret === "" && "GOOGLE_CLIENT_SECRET"]
      .filter(Boolean)
      .join(" and ");
    throw new ToolError(
      "internal",
      `Google OAuth is not configured: set the ${missing} secret on the Worker.`,
    );
  }
  return { id, secret };
}

const relinkError = (linkUrl: string): ToolError =>
  new ToolError(
    "needs_relink",
    "Google no longer accepts this account's access (revoked, password changed or unused for " +
      `six months). Link it again at ${linkUrl}; other accounts are not affected.`,
    { linkUrl },
  );

/**
 * Sets `status = 'needs_relink'` and deletes the D1 access token, in one batch, and drops the
 * memory entry. `usedIv` is the IV of the refresh row that Google refused (null: there was none);
 * nothing changes unless the refresh row is still that one. Returns whether the account was marked.
 */
async function markNeedsRelink(
  env: Env,
  a: BrokerAccount,
  key: string,
  usedIv: Uint8Array | null,
): Promise<boolean> {
  memory.delete(key);
  mustRefresh.delete(key);
  // ?1 account id, ?2 the refresh row's IV (only when there was one).
  const guard =
    usedIv === null
      ? "NOT EXISTS (SELECT 1 FROM account_tokens WHERE account_id = ?1 AND kind = 'refresh')"
      : "EXISTS (SELECT 1 FROM account_tokens WHERE account_id = ?1 AND kind = 'refresh' AND iv = ?2)";
  const ids: unknown[] = usedIv === null ? [a.accountId] : [a.accountId, usedIv];
  const [marked] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE accounts SET status = 'needs_relink', updated_at = ?3
       WHERE id = ?1 AND owner_id = ?4 AND ${guard}`,
    ).bind(a.accountId, usedIv, nowSeconds(), a.ownerId),
    env.DB.prepare(
      `DELETE FROM account_tokens WHERE account_id = ?1 AND kind = 'access' AND ${guard}`,
    ).bind(...ids),
  ]);
  return (marked?.meta.changes ?? 0) > 0;
}

interface Grant {
  accessToken: string;
  /** Seconds. */
  expiresIn: number;
  /** Present when Google rotated the refresh token. */
  refreshToken?: string;
}

/**
 * POSTs `grant_type=refresh_token`. Returns the new tokens or "invalid_grant"; throws
 * `upstream_error` (network, 5xx, unexpected reply) or `internal` (Google refused the client).
 * Google's response body never reaches an error.
 */
async function requestToken(
  client: { id: string; secret: string },
  refreshToken: string,
): Promise<Grant | "invalid_grant"> {
  let res: Response;
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: client.id,
        client_secret: client.secret,
      }),
      redirect: "manual",
    });
  } catch {
    throw new ToolError("upstream_error", "Google's token endpoint could not be reached.");
  }
  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch {
    body = undefined;
  }
  const status = res.status;
  if (status === 200) {
    const grant = parseGrant(body);
    if (grant) return grant;
    throw new ToolError(
      "upstream_error",
      "Google's token endpoint returned an unexpected response.",
      { status },
    );
  }
  const error = isRecord(body) && typeof body.error === "string" ? body.error : "";
  // RFC 6749 s.5.2: a refused grant is a 400. Anything else never marks the account.
  if (status === 400 && error === "invalid_grant") return "invalid_grant";
  if (error === "invalid_client" || error === "unauthorized_client") {
    throw new ToolError(
      "internal",
      "Google refused the OAuth client: check the GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET secrets.",
    );
  }
  throw new ToolError("upstream_error", "Google's token endpoint failed.", { status });
}

function parseGrant(body: unknown): Grant | null {
  if (!isRecord(body)) return null;
  const { access_token, expires_in, refresh_token } = body;
  if (typeof access_token !== "string" || access_token === "") return null;
  if (typeof expires_in !== "number" || !Number.isFinite(expires_in) || expires_in <= 0) {
    return null;
  }
  const grant: Grant = { accessToken: access_token, expiresIn: Math.floor(expires_in) };
  if (typeof refresh_token === "string" && refresh_token !== "") grant.refreshToken = refresh_token;
  return grant;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
