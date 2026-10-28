// Google token broker (ARCHITECTURE s.3.6; plan s.3.3, s.4.3 item 6). The only code that opens a
// sealed refresh token or calls Google's token endpoint. Refresh and access tokens never appear in
// a log, an error or any return value other than accessToken()'s own result.

import { GOOGLE_TOKEN_URL, type GoogleClient, googleClient } from "../auth/google-oidc";
import { config, type Env } from "../env";
import { currentKeyVersion, open, type SealAad, seal, type TokenKind } from "./crypto";
import { getAccount, getToken, nowSeconds } from "./db";
import { ToolError } from "./errors";

/** An access token this close to its expiry (seconds) counts as expired. */
export const EXPIRY_MARGIN_SECONDS = 300;

/** The token request is abandoned after this many milliseconds. */
export const TOKEN_TIMEOUT_MS = 10_000;

/**
 * Callers wait at most this long (ms) for a shared refresh, and a refresh this old is not joined.
 * A Worker request that is cancelled can leave its pending promise unsettled for good.
 */
export const REFRESH_WAIT_MS = 15_000;

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

interface Inflight {
  promise: Promise<string>;
  /** `Date.now()` when the refresh started. */
  startedAt: number;
}

// Per isolate, shared by every request and every broker object.
const memory = new Map<string, Cached>();
const inflight = new Map<string, Inflight>();
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
      const now = Date.now();
      let entry = inflight.get(key);
      if (!entry || now - entry.startedAt >= REFRESH_WAIT_MS) {
        const started: Inflight = {
          startedAt: now,
          promise: load(env, a, key).finally(() => {
            if (inflight.get(key) === started) inflight.delete(key);
          }),
        };
        inflight.set(key, started);
        entry = started;
      }
      return withDeadline(entry.promise, entry.startedAt + REFRESH_WAIT_MS - now);
    },
    invalidate(a) {
      const key = keyOf(a);
      memory.delete(key);
      mustRefresh.add(key);
    },
  };
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new ToolError("upstream_error", "Google's token endpoint did not answer in time.")),
      ms,
    );
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** D1 access token if it is not expiring, else a refresh. Runs once per account at a time. */
async function load(env: Env, a: BrokerAccount, key: string): Promise<string> {
  if (!mustRefresh.has(key)) {
    const token = await fromD1(env, a, key);
    if (token !== null) return token;
  }
  return refresh(env, a, key);
}

/** The D1 access token, cached in memory, or null if there is none that opens and is not expiring. */
async function fromD1(env: Env, a: BrokerAccount, key: string): Promise<string | null> {
  const row = await getToken(env.DB, a.accountId, "access");
  if (!row || !usable(row.expires_at, nowSeconds())) return null;
  try {
    const token = await open(row, aad(a, "access"), env);
    memory.set(key, { token, expiresAt: row.expires_at });
    return token;
  } catch {
    // The access row is a cache: one that does not open is a miss, and a refresh either
    // replaces it or reports the real problem.
    return null;
  }
}

async function refresh(env: Env, a: BrokerAccount, key: string): Promise<string> {
  const client = configuredClient(env);
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
    if (await markNeedsRelink(env, a, key, null)) throw relinkError(accountsUrl);
    throw changedError();
  }

  const refreshToken = await open(stored, aad(a, "refresh"), env);
  const result = await requestToken(client, refreshToken);
  if (result === "invalid_grant") {
    // Revoked, password change or six months idle. Mark only if the refresh row is still the
    // one just used: a relink that landed meanwhile must not be taken offline.
    if (await markNeedsRelink(env, a, key, stored.iv)) throw relinkError(accountsUrl);
    throw changedError();
  }

  // One D1 batch per refresh: the access token, plus the refresh token when Google rotated it or
  // its row is under an older key version, all sealed under CURRENT_KEY_VERSION. Both writes
  // apply only while the refresh row is still the one just used (?1 account id, ?7 its IV), so
  // the old grant never overwrites a relink; the access write runs first, before the IV changes.
  // If the batch fails after Google rotated the refresh token, the rotated one is lost and the
  // old one keeps working until Google retires it; D1's error surfaces as `internal`.
  const now = nowSeconds();
  const expiresAt = now + result.expiresIn;
  const access = await seal(result.accessToken, aad(a, "access"), env);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO account_tokens (account_id, kind, ciphertext, iv, key_version, expires_at, updated_at)
       SELECT ?1, 'access', ?2, ?3, ?4, ?5, ?6
       WHERE EXISTS (SELECT 1 FROM account_tokens WHERE account_id = ?1 AND kind = 'refresh' AND iv = ?7)
       ON CONFLICT (account_id, kind) DO UPDATE SET
         ciphertext = excluded.ciphertext, iv = excluded.iv, key_version = excluded.key_version,
         expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
    ).bind(
      a.accountId,
      access.ciphertext,
      access.iv,
      access.key_version,
      expiresAt,
      now,
      stored.iv,
    ),
  ];
  const rotated = result.refreshToken !== undefined && result.refreshToken !== refreshToken;
  if (rotated || stored.key_version !== currentKeyVersion(env)) {
    const sealed = await seal(result.refreshToken ?? refreshToken, aad(a, "refresh"), env);
    statements.push(
      env.DB.prepare(
        `UPDATE account_tokens SET ciphertext = ?2, iv = ?3, key_version = ?4, updated_at = ?5
         WHERE account_id = ?1 AND kind = 'refresh' AND iv = ?6`,
      ).bind(a.accountId, sealed.ciphertext, sealed.iv, sealed.key_version, now, stored.iv),
    );
  }
  const [written] = await env.DB.batch(statements);
  mustRefresh.delete(key);
  if ((written?.meta.changes ?? 0) === 0) {
    // A relink replaced the refresh token while Google answered, and nothing was written: serve
    // the relink's access token if it is usable, else this one, uncached.
    return (await fromD1(env, a, key)) ?? result.accessToken;
  }
  memory.set(key, { token: result.accessToken, expiresAt });
  return result.accessToken;
}

/** The Google OAuth client (`auth/google-oidc.ts`), or `internal` naming the missing secrets. */
function configuredClient(env: Env): GoogleClient {
  const client = googleClient(env);
  if (client) return client;
  const missing = (["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const).filter(
    (name) => (env[name] ?? "").trim() === "",
  );
  throw new ToolError(
    "internal",
    `Google OAuth is not configured: set the ${missing.join(" and ")} ` +
      `${missing.length > 1 ? "secrets" : "secret"} on the Worker.`,
  );
}

const relinkError = (linkUrl: string): ToolError =>
  new ToolError(
    "needs_relink",
    "Google no longer accepts this account's access (revoked, password changed or unused for " +
      `six months). Link it again at ${linkUrl}; other accounts are not affected.`,
    { linkUrl },
  );

const changedError = (): ToolError =>
  new ToolError(
    "upstream_error",
    "The account's Google tokens changed during the refresh; try again.",
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
 * `upstream_error` (network, timeout, 5xx, unexpected reply) or `internal` (Google refused the
 * client). Google's response body never reaches an error.
 */
async function requestToken(
  client: GoogleClient,
  refreshToken: string,
): Promise<Grant | "invalid_grant"> {
  const signal = AbortSignal.timeout(TOKEN_TIMEOUT_MS);
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
        client_id: client.clientId,
        client_secret: client.clientSecret,
      }),
      redirect: "manual",
      signal,
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
