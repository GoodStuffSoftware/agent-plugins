// Link a Google mailbox to the owner (plan s.4.3, ARCHITECTURE s.1.5 "Link leg"). `/accounts`
// starts it with `startLink`; the shared callback consumes the single-use `link` flow and calls
// `finishLink`.
//
// The flow row holds the owner id, label and components and is bound to this browser's flow
// cookie. The callback then requires the current owner session to be the same owner, and the
// address Google returns to be on `LINKABLE_EMAILS`, before anything is stored. Tokens are sealed
// (s.4) and never logged, rendered or put in a URL. Every refusal answers with a page, sets no
// cookie and writes no row.

import { base64url, randomBytes, randomId, seal, sha256, type TokenKind } from "../core/crypto";
import { type AccountRow, first, getAccount, nowSeconds } from "../core/db";
import { config, type Env } from "../env";
import {
  type AccountComponent,
  GOOGLE_SCOPES,
  grantedComponents,
  isAccountComponent,
  LINK_IDENTITY_SCOPES,
  parseScopes,
  revokeToken,
  scopesFor,
} from "../providers/google/base";
import { html, htmlResponse, page } from "../web/html";
import { redirect } from "./consent";
import { createFlow, FLOW_COOKIE } from "./flow-state";
import {
  callbackUrl,
  checkIdToken,
  exchangeCode,
  GOOGLE_AUTHORIZE_URL,
  type GoogleClient,
} from "./google-oidc";
import { emailHash } from "./owners";
import { clearCookie, readSession } from "./session";

/** `kind: "link"` flow payload. */
export interface LinkPayload {
  /** The owner whose session started the link; the callback requires the same owner. */
  ownerId: string;
  label: string;
  /** The components the account should have afterwards (only those Google grants are kept). */
  components: AccountComponent[];
  /**
   * Set when the flow is for an existing account (toggle, relink): the callback then requires
   * Google to return that account's address.
   */
  accountId?: string;
  /** PKCE verifier for the Google code exchange. */
  verifier: string;
  /** Must come back as the ID token's `nonce`. */
  nonce: string;
}

/** Lowercase letters, digits, `.`, `_` and `-`, starting with a letter or digit, at most 32. */
export const LABEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/** `all` selects every account in multi-account tools (plan s.6), so it cannot be a label. */
const RESERVED_LABELS: ReadonlySet<string> = new Set(["all"]);

/** The label as stored (trimmed, lowercased), or undefined if it breaks the label rules. */
export function normalizeLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = value.trim().toLowerCase();
  return LABEL_PATTERN.test(label) && !RESERVED_LABELS.has(label) ? label : undefined;
}

const GMAIL_SEND_AS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs";

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields, at: new Date().toISOString() }));
}

/** A no-store page with a link back to `/accounts`. */
function linkNotice(status: number, title: string, message: string): Response {
  const res = htmlResponse(
    page(
      title,
      html`<h1>${title}</h1><p>${message}</p><p><a href="/accounts">Back to accounts</a></p>`,
    ),
    status,
  );
  res.headers.set("Cache-Control", "no-store");
  return res;
}

/**
 * Whether tokens can be sealed now. The callback seals after the code exchange, so check this
 * before anything starts: a missing or malformed key must never leave a grant at Google whose
 * tokens were thrown away.
 */
export async function sealingReady(env: Env, ownerId: string): Promise<boolean> {
  try {
    await seal("probe", { ownerId, accountId: "probe", kind: "access" }, env);
    return true;
  } catch {
    log("link_failed", { reason: "token_key", owner_id: ownerId });
    return false;
  }
}

/** The page for `sealingReady` false. */
export const sealingNotReady = (): Response =>
  linkNotice(
    503,
    "Not configured",
    "Token encryption is not configured on this server. Nothing was started.",
  );

/**
 * Starts the link leg: stores a single-use `link` flow bound to this browser, then redirects to
 * Google for offline access. It asks for the scopes of `components`, or only for `scopes` when
 * given (incremental consent: with `include_granted_scopes` Google adds what it already granted).
 * `accountId` pins the flow to an existing account.
 */
export async function startLink(
  env: Env,
  client: GoogleClient,
  o: {
    ownerId: string;
    label: string;
    components: AccountComponent[];
    accountId?: string;
    scopes?: string[];
    loginHint?: string;
  },
): Promise<Response> {
  if (!(await sealingReady(env, o.ownerId))) return sealingNotReady();
  const verifier = base64url(randomBytes(32));
  const nonce = base64url(randomBytes(32));
  const payload: LinkPayload = {
    ownerId: o.ownerId,
    label: o.label,
    components: o.components,
    ...(o.accountId ? { accountId: o.accountId } : {}),
    verifier,
    nonce,
  };
  const { state, setCookie } = await createFlow(env.DB, "link", payload);
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: callbackUrl(config(env).issuer),
    response_type: "code",
    scope: [...LINK_IDENTITY_SCOPES, ...(o.scopes ?? scopesFor(o.components))].join(" "),
    state,
    nonce,
    code_challenge: base64url(await sha256(verifier)),
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  });
  if (o.loginHint) params.set("login_hint", o.loginHint);
  return redirect(`${GOOGLE_AUTHORIZE_URL}?${params}`, new Headers({ "Set-Cookie": setCookie }));
}

/** Narrows a consumed `link` payload; anything malformed is treated as no flow. */
export function linkPayload(payload: unknown): LinkPayload | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  if (
    typeof p.ownerId !== "string" ||
    p.ownerId === "" ||
    typeof p.label !== "string" ||
    normalizeLabel(p.label) !== p.label ||
    !Array.isArray(p.components) ||
    !p.components.every(isAccountComponent) ||
    (p.accountId !== undefined && (typeof p.accountId !== "string" || p.accountId === "")) ||
    typeof p.verifier !== "string" ||
    typeof p.nonce !== "string"
  ) {
    return undefined;
  }
  return {
    ownerId: p.ownerId,
    label: p.label,
    components: p.components,
    ...(typeof p.accountId === "string" ? { accountId: p.accountId } : {}),
    verifier: p.verifier,
    nonce: p.nonce,
  };
}

/** The `link` branch of `GET /oauth/google/callback`, after the flow row was consumed. */
export async function finishLink(
  req: Request,
  env: Env,
  client: GoogleClient,
  url: URL,
  flowPayload: unknown,
): Promise<Response> {
  const payload = linkPayload(flowPayload);
  if (!payload) {
    return linkNotice(400, "Link failed", "The link state is damaged. Start again.");
  }

  // The flow cookie proves this browser started the flow; the session proves it is still the
  // owner who started it. Checked before the code is exchanged.
  const session = await readSession(req, env);
  if (!session) {
    log("link_refused", { reason: "no_session" });
    return linkNotice(
      403,
      "Sign-in expired",
      "Your sign-in expired before Google answered. Nothing was stored. Open accounts and start again.",
    );
  }
  if (session.ownerId !== payload.ownerId) {
    log("link_refused", { reason: "owner_mismatch" });
    return linkNotice(
      403,
      "Link refused",
      "This link was not started by the owner signed in here. Sign in and start again.",
    );
  }

  if (url.searchParams.has("error")) {
    log("link_failed", { reason: "google_error", owner_id: session.ownerId });
    return linkNotice(400, "Link cancelled", "Google did not link the mailbox. Nothing changed.");
  }
  const code = url.searchParams.get("code");
  if (!code) return linkNotice(400, "Link failed", "Google returned no authorization code.");

  const { issuer, linkableEmails } = config(env);
  let tokens: Awaited<ReturnType<typeof exchangeCode>>;
  try {
    tokens = await exchangeCode(client, {
      code,
      verifier: payload.verifier,
      redirectUri: callbackUrl(issuer),
    });
  } catch (e) {
    log("link_failed", { reason: "token_exchange", status: (e as { status?: number }).status });
    return linkNotice(502, "Link failed", "Google did not complete the link. Try again.");
  }

  const identity = checkIdToken(tokens.id_token, {
    clientId: client.clientId,
    nonce: payload.nonce,
  });
  if (!identity.ok) {
    log("link_failed", { reason: `id_token_${identity.reason}` });
    return linkNotice(400, "Link failed", "Google's answer could not be verified. Try again.");
  }
  const hash = await emailHash(env, identity.email);
  // A refusal below drops the new grant at Google, unless an account already holds that address:
  // a revoke ends the whole grant, which a linked mailbox may be using.
  const refused = async (reason: string, status: number, title: string, message: string) => {
    log("link_refused", { reason, email_hash: hash, owner_id: session.ownerId });
    await discardGrant(env, tokens.refresh_token ?? tokens.access_token, identity.email, hash);
    return linkNotice(status, title, message);
  };
  if (!linkableEmails.includes(identity.email)) {
    return refused(
      "not_linkable",
      403,
      "Not allowed",
      "This Google account is not on the list of mailboxes that can be linked. Nothing was stored.",
    );
  }
  if (typeof tokens.refresh_token !== "string" || typeof tokens.access_token !== "string") {
    log("link_failed", { reason: "no_refresh_token", email_hash: hash });
    return linkNotice(502, "Link failed", "Google returned no offline access. Try again.");
  }

  const existing = await first<AccountRow>(
    env.DB,
    "SELECT * FROM accounts WHERE owner_id = ? AND address = ?",
    session.ownerId,
    identity.email,
  );
  if (payload.accountId) {
    // A toggle or relink of one account: Google must have returned that account's address.
    const target = await getAccount(env.DB, session.ownerId, payload.accountId);
    if (!target) {
      return refused("account_gone", 404, "Not found", "That mailbox is no longer linked.");
    }
    if (target.id !== existing?.id) {
      return refused(
        "address_mismatch",
        409,
        "Wrong Google account",
        `Google signed in a different account than ${target.address}. Nothing was changed. Start again and pick ${target.address}.`,
      );
    }
  }
  const clash = await first<{ id: string }>(
    env.DB,
    "SELECT id FROM accounts WHERE owner_id = ? AND label = ? AND address <> ?",
    session.ownerId,
    payload.label,
    identity.email,
  );
  if (clash) {
    return refused(
      "label_in_use",
      409,
      "Label in use",
      `Another mailbox already has the label "${payload.label}". Pick another label.`,
    );
  }
  if (existing?.provider_sub && existing.provider_sub !== identity.sub) {
    // Same address, new Google user id: a deleted and recreated Workspace user. Verified by
    // the address check above and started by the owner, so it proceeds, on the record.
    log("sub_changed", { account_id: existing.id, owner_id: session.ownerId, email_hash: hash });
  }

  const granted = parseScopes(tokens.scope);
  const components = grantedComponents(payload.components, granted);
  if (components.length === 0) {
    // Google's granular consent lets the owner untick every box; an account with no component
    // would only look linked.
    return refused(
      "nothing_granted",
      400,
      "Nothing granted",
      "Google granted none of the requested access, so nothing was stored. Start again and leave the boxes ticked.",
    );
  }
  const now = nowSeconds();
  const sendAs =
    components.includes("mail") && granted.includes(GOOGLE_SCOPES.gmailSettingsBasic)
      ? await fetchSendAs(tokens.access_token)
      : undefined;
  // A relink that turns mail off drops the old sendAs cache with it.
  const dropSendAs = Boolean(existing) && !components.includes("mail");

  const accountId = existing?.id ?? randomId("ac_");
  const aad = (kind: TokenKind) => ({ ownerId: session.ownerId, accountId, kind });
  const refresh = await seal(tokens.refresh_token, aad("refresh"), env);
  const access = await seal(tokens.access_token, aad("access"), env);
  const accessExpiry = typeof tokens.expires_in === "number" ? now + tokens.expires_in : null;

  const db = env.DB;
  const statements: D1PreparedStatement[] = existing
    ? [
        db
          .prepare(
            `UPDATE accounts SET label = ?, provider_sub = ?, components = ?, granted_scopes = ?,
               status = 'ok', send_as_fetched_at = IIF(? = 1, NULL, COALESCE(?, send_as_fetched_at)),
               updated_at = ?
             WHERE id = ? AND owner_id = ?`,
          )
          .bind(
            payload.label,
            identity.sub,
            JSON.stringify(components),
            granted.join(" "),
            dropSendAs ? 1 : 0,
            sendAs ? now : null,
            now,
            accountId,
            session.ownerId,
          ),
      ]
    : [
        // As `insertAccount` (core/db.ts), in the same batch as the tokens: the short id comes
        // from the owner row and a failed batch stores nothing and uses no short id.
        db
          .prepare(
            `INSERT INTO accounts (id, owner_id, short_id, label, address, provider, provider_sub,
               components, granted_scopes, send_as_fetched_at, created_at, updated_at)
             SELECT ?1, id, next_short_id, ?2, ?3, 'google', ?4, ?5, ?6, ?7, ?8, ?8
             FROM owners WHERE id = ?9`,
          )
          .bind(
            accountId,
            payload.label,
            identity.email,
            identity.sub,
            JSON.stringify(components),
            granted.join(" "),
            sendAs ? now : null,
            now,
            session.ownerId,
          ),
        db
          .prepare("UPDATE owners SET next_short_id = next_short_id + 1 WHERE id = ?")
          .bind(session.ownerId),
      ];
  statements.push(
    tokenStatement(db, accountId, "refresh", refresh, null, now),
    tokenStatement(db, accountId, "access", access, accessExpiry, now),
  );
  if (sendAs || dropSendAs) {
    statements.push(db.prepare("DELETE FROM send_as WHERE account_id = ?").bind(accountId));
  }
  if (sendAs) {
    for (const s of sendAs) {
      statements.push(
        db
          .prepare(
            `INSERT INTO send_as (account_id, email, display_name, is_default, is_primary,
               verification_status, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            accountId,
            s.email,
            s.displayName,
            s.isDefault ? 1 : 0,
            s.isPrimary ? 1 : 0,
            s.verificationStatus,
            s.replyTo,
          ),
      );
    }
  }

  try {
    await db.batch(statements);
  } catch (e) {
    // A concurrent link took the label or address between the checks and the batch.
    if (!String((e as Error).message ?? e).includes("UNIQUE")) throw e;
    log("link_refused", { reason: "conflict", email_hash: hash });
    return linkNotice(409, "Not linked", "The label or mailbox is already in use. Start again.");
  }

  log("account_linked", {
    owner_id: session.ownerId,
    account_id: accountId,
    email_hash: hash,
    relinked: Boolean(existing),
    components,
  });
  const headers = new Headers({ "Set-Cookie": clearCookie(FLOW_COOKIE) });
  // Components Google did not grant are named on the page, so a partial grant is not silent.
  const missing = payload.components.filter((c) => !components.includes(c));
  const back = new URL("/accounts", issuer);
  if (missing.length > 0) back.searchParams.set("partial", missing.join(","));
  return redirect(back.toString(), headers);
}

/**
 * Best-effort revoke of a grant the link flow refused to keep, only when no account holds the
 * address (any owner): a revoke drops the whole grant, which a linked mailbox may be using.
 */
async function discardGrant(
  env: Env,
  token: string | undefined,
  address: string,
  hash: string,
): Promise<void> {
  if (!token) return;
  const held = await first<{ id: string }>(
    env.DB,
    "SELECT id FROM accounts WHERE address = ?",
    address,
  );
  if (held) return;
  log("link_grant_discarded", { email_hash: hash, revoked: await revokeToken(token) });
}

function tokenStatement(
  db: D1Database,
  accountId: string,
  kind: TokenKind,
  sealed: Awaited<ReturnType<typeof seal>>,
  expiresAt: number | null,
  now: number,
): D1PreparedStatement {
  // Same statement as `upsertToken` (core/db.ts), prepared for the link batch.
  return db
    .prepare(
      `INSERT INTO account_tokens (account_id, kind, ciphertext, iv, key_version, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_id, kind) DO UPDATE SET
         ciphertext = excluded.ciphertext, iv = excluded.iv, key_version = excluded.key_version,
         expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
    )
    .bind(accountId, kind, sealed.ciphertext, sealed.iv, sealed.key_version, expiresAt, now);
}

interface SendAsEntry {
  email: string;
  displayName: string | null;
  replyTo: string | null;
  isPrimary: boolean;
  isDefault: boolean;
  verificationStatus: string | null;
}

/**
 * The account's sendAs list from Gmail, or undefined when Gmail does not answer with one. A
 * failure does not stop the link: the cache stays empty and M14 refreshes it later.
 */
async function fetchSendAs(accessToken: string): Promise<SendAsEntry[] | undefined> {
  let body: unknown;
  try {
    const res = await fetch(GMAIL_SEND_AS_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (!res.ok) {
      await res.body?.cancel();
      log("link_send_as_failed", { status: res.status });
      return undefined;
    }
    body = await res.json();
  } catch {
    log("link_send_as_failed", { status: null });
    return undefined;
  }
  const list = (body as { sendAs?: unknown } | null)?.sendAs;
  if (!Array.isArray(list)) return undefined;
  const out = new Map<string, SendAsEntry>();
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const s = item as Record<string, unknown>;
    if (typeof s.sendAsEmail !== "string") continue;
    const email = s.sendAsEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(email) || out.has(email)) continue;
    out.set(email, {
      email,
      displayName: typeof s.displayName === "string" ? s.displayName : null,
      replyTo: typeof s.replyToAddress === "string" ? s.replyToAddress : null,
      isPrimary: s.isPrimary === true,
      isDefault: s.isDefault === true,
      verificationStatus: typeof s.verificationStatus === "string" ? s.verificationStatus : null,
    });
  }
  return [...out.values()];
}
