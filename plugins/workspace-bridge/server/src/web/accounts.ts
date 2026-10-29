// `/accounts`, the owner's page for linked mailboxes (plan s.4.3, ARCHITECTURE s.2): the list,
// the link form and unlink (M7a); component toggles with incremental consent, the default
// account, relink, "re-link minimal" and "re-encrypt all" (M7b).
//
// Every route needs the owner session; every POST also needs the session's CSRF token. Pages are
// never cached and never show a token. A POST that changes D1 only (toggle, default) answers 303
// back to the page; the ones that go to Google answer 302 to Google.

import { Hono } from "hono";
import { notConfigured, signinClient, startSignin } from "../auth/consent";
import {
  LABEL_MAX,
  LABEL_RULE,
  labelClash,
  normalizeLabel,
  sealingNotReady,
  sealingReady,
  startLink,
} from "../auth/link";
import { checkCsrf, csrfToken, readSession, type Session } from "../auth/session";
import { writeAudit } from "../core/audit";
import { currentKeyVersion, open, seal, type TokenKind } from "../core/crypto";
import {
  type AccountRow,
  first,
  getAccount,
  getToken,
  listAccounts,
  listOwnerTokens,
  nowSeconds,
} from "../core/db";
import { config, type Env } from "../env";
import {
  ACCOUNT_COMPONENTS,
  type AccountComponent,
  excessScopes,
  grantedComponents,
  isAccountComponent,
  parseScopes,
  revokeToken,
  scopesFor,
} from "../providers/google/base";
import { html, htmlResponse, page, type SafeHtml } from "./html";

export const accountsRoutes = new Hono<{ Bindings: Env }>();

const COMPONENT_LABELS: Readonly<Record<AccountComponent, string>> = {
  mail: "Mail: read, organize, drafts, filters",
  "mail.send": "Mail: send",
  calendar: "Calendar",
  files: "Drive files",
  contacts: "Contacts",
};

const ADDRESS = /^[^\s@]+@[^\s@]+$/;

/** An HTML page that is never cached. */
function noStore(res: Response): Response {
  res.headers.set("Cache-Control", "no-store");
  return res;
}

function result(status: number, title: string, message: string): Response {
  return noStore(
    htmlResponse(
      page(
        title,
        html`<h1>${title}</h1><p>${message}</p><p><a href="/accounts">Back to accounts</a></p>`,
      ),
      status,
    ),
  );
}

/** 303 back to the page, so a reload does not repeat the POST. */
function backToAccounts(env: Env): Response {
  return new Response(null, {
    status: 303,
    headers: {
      Location: new URL("/accounts", config(env).issuer).toString(),
      "Cache-Control": "no-store",
    },
  });
}

function components(account: AccountRow): AccountComponent[] {
  try {
    const parsed: unknown = JSON.parse(account.components);
    return Array.isArray(parsed) ? parsed.filter(isAccountComponent) : [];
  } catch {
    return [];
  }
}

function postForm(action: string, csrf: string, fields: [string, string][], button: string) {
  return html`<form method="post" action="${action}" style="display:inline">
<input type="hidden" name="csrf" value="${csrf}">
${fields.map(([name, value]) => html`<input type="hidden" name="${name}" value="${value}">`)}
<button type="submit">${button}</button>
</form>`;
}

function accountRow(account: AccountRow, isDefault: boolean, csrf: string): SafeHtml {
  const on = components(account);
  const id: [string, string] = ["account", account.id];
  const excess = excessScopes(on, parseScopes(account.granted_scopes));
  return html`<tr>
<td>${account.label}
<form method="post" action="/accounts/rename" style="display:inline">
<input type="hidden" name="csrf" value="${csrf}">
<input type="hidden" name="account" value="${account.id}">
<input name="label" required maxlength="${LABEL_MAX}" value="${account.label}" title="${LABEL_RULE}" aria-label="New label for ${account.address}">
<button type="submit">Rename</button>
</form></td>
<td>${account.address}</td>
<td>${account.provider}</td>
<td><ul>${ACCOUNT_COMPONENTS.map((c) => {
    const isOn = on.includes(c);
    return html`<li>${COMPONENT_LABELS[c]}: ${isOn ? "on" : "off"} ${postForm(
      "/accounts/component",
      csrf,
      [id, ["component", c], ["on", isOn ? "0" : "1"]],
      isOn ? "Turn off" : "Turn on",
    )}</li>`;
  })}</ul></td>
<td>${account.status === "ok" ? "ok" : "needs re-link"}</td>
<td>${isDefault ? "default" : ""}</td>
<td>${postForm("/accounts/unlink", csrf, [id], "Unlink")}
${account.status === "ok" ? "" : postForm("/accounts/relink", csrf, [id], "Re-link")}
${excess.length > 0 ? postForm("/accounts/relink-minimal", csrf, [id], "Re-link minimal") : ""}</td>
</tr>`;
}

function accountsTable(accounts: AccountRow[], defaultId: string | null, csrf: string): SafeHtml {
  if (accounts.length === 0) return html`<p>No mailbox is linked yet.</p>`;
  return html`<table>
<thead><tr><th>Label</th><th>Address</th><th>Provider</th><th>Components</th><th>Status</th><th>Default</th><th></th></tr></thead>
<tbody>${accounts.map((a) => accountRow(a, a.id === defaultId, csrf))}</tbody>
</table>
<p>A component switched off stops working at once. Google keeps the old access until you press "Re-link minimal", which revokes it and asks again for only the components that are on.</p>`;
}

function defaultForm(accounts: AccountRow[], defaultId: string | null, csrf: string): SafeHtml {
  if (accounts.length === 0) return html``;
  return html`<h2>Default mailbox</h2>
<form method="post" action="/accounts/default">
<input type="hidden" name="csrf" value="${csrf}">
<p><label>Used when a tool names no mailbox
<select name="account">
<option value=""${defaultId === null ? " selected" : ""}>none</option>
${accounts.map(
  (a) =>
    html`<option value="${a.id}"${a.id === defaultId ? " selected" : ""}>${a.label} (${a.address})</option>`,
)}
</select></label>
<button type="submit">Save</button></p>
</form>`;
}

async function encryptionForm(env: Env, ownerId: string, csrf: string): Promise<SafeHtml> {
  let version: number;
  try {
    version = currentKeyVersion(env);
  } catch {
    return html``;
  }
  const old = await first<{ n: number }>(
    env.DB,
    `SELECT count(*) AS n FROM account_tokens t JOIN accounts a ON a.id = t.account_id
     WHERE a.owner_id = ? AND t.key_version <> ?`,
    ownerId,
    version,
  );
  return html`<h2>Token encryption</h2>
<p>New tokens are sealed under key version ${version}. ${old?.n ?? 0} stored token(s) use another version; they move on their next refresh, or all at once here.</p>
${postForm("/accounts/reencrypt", csrf, [], "Re-encrypt all tokens")}`;
}

function linkForm(csrf: string): SafeHtml {
  return html`<h2>Link a mailbox</h2>
<form method="post" action="/accounts/link">
<input type="hidden" name="csrf" value="${csrf}">
<p><label>Label <input name="label" required maxlength="${LABEL_MAX}" title="${LABEL_RULE}" placeholder="Personal" aria-describedby="label-help"></label><br>
<small id="label-help">${LABEL_RULE} Capitals and spaces are fine; two mailboxes cannot differ only by case.</small></p>
<p><label>Google address (optional) <input type="email" name="login_hint" maxlength="254"></label></p>
<fieldset><legend>Components</legend>
<ul>${ACCOUNT_COMPONENTS.map(
    (c) =>
      html`<li><label><input type="checkbox" name="components" value="${c}" checked> ${COMPONENT_LABELS[c]}</label></li>`,
  )}</ul>
</fieldset>
<button type="submit">Link with Google</button>
</form>`;
}

accountsRoutes.get("/", async (c) => {
  const env = c.env;
  const session = await readSession(c.req.raw, env);
  if (!session) {
    const client = signinClient(env);
    if (!client) return notConfigured();
    return startSignin(env, client, "/accounts");
  }
  const [accounts, owner, csrf] = await Promise.all([
    listAccounts(env.DB, session.ownerId),
    first<{ default_account_id: string | null }>(
      env.DB,
      "SELECT default_account_id FROM owners WHERE id = ?",
      session.ownerId,
    ),
    csrfToken(env, session),
  ]);
  const defaultId = owner?.default_account_id ?? null;
  const partial = (new URL(c.req.url).searchParams.get("partial") ?? "")
    .split(",")
    .filter(isAccountComponent);
  const relinked = new URL(c.req.url).searchParams.get("relinked");
  const body = html`<h1>Linked mailboxes</h1>
${relinked ? html`<p><strong>Re-linked ${relinked}.</strong> A linked mailbox keeps its label; use Rename to change its name.</p>` : ""}
<p>Signed in as ${session.email}. <a href="/accounts/audit">Sending switch and audit log</a></p>
${
  partial.length > 0
    ? html`<p><strong>Google did not grant everything asked for.</strong> These stay off: ${partial.map((p) => COMPONENT_LABELS[p]).join(", ")}.</p>`
    : ""
}
${accountsTable(accounts, defaultId, csrf)}
${defaultForm(accounts, defaultId, csrf)}
${linkForm(csrf)}
${accounts.length > 0 ? await encryptionForm(env, session.ownerId, csrf) : ""}`;
  return noStore(htmlResponse(page("Linked mailboxes", body)));
});

/** The session and form of a POST, or the refusal page: no session, or a missing or wrong CSRF. */
async function authorizePost(
  req: Request,
  env: Env,
): Promise<{ session: Session; form: FormData } | Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return result(400, "Request refused", "The form could not be read.");
  }
  const session = await readSession(req, env);
  if (!session) {
    return result(403, "Sign-in required", "Your sign-in has expired. Open this page again.");
  }
  const csrf = form.get("csrf");
  if (!(await checkCsrf(env, session, typeof csrf === "string" ? csrf : null))) {
    return result(
      403,
      "Request refused",
      "The form token is missing or wrong. Open this page again.",
    );
  }
  return { session, form };
}

/** Same as `authorizePost`, plus the owner's account the form names (404 page if none). */
async function authorizeAccountPost(
  req: Request,
  env: Env,
): Promise<{ session: Session; form: FormData; account: AccountRow } | Response> {
  const posted = await authorizePost(req, env);
  if (posted instanceof Response) return posted;
  const id = posted.form.get("account");
  const account =
    typeof id === "string" && id !== ""
      ? await getAccount(env.DB, posted.session.ownerId, id)
      : null;
  if (!account) return result(404, "Not found", "That mailbox is not linked.");
  return { ...posted, account };
}

accountsRoutes.post("/link", async (c) => {
  const env = c.env;
  const posted = await authorizePost(c.req.raw, env);
  if (posted instanceof Response) return posted;
  const { session, form } = posted;

  const label = normalizeLabel(form.get("label"));
  if (!label) {
    return result(
      400,
      "Label not valid",
      `${LABEL_RULE} The label cannot be empty or "all" in any case.`,
    );
  }
  const chosen = ACCOUNT_COMPONENTS.filter((k) => form.getAll("components").includes(k));
  if (chosen.length === 0) return result(400, "Nothing selected", "Select at least one component.");
  const hint = form.get("login_hint");
  const loginHint = typeof hint === "string" ? hint.trim().toLowerCase() : "";
  if (loginHint !== "" && (loginHint.length > 254 || !ADDRESS.test(loginHint))) {
    return result(400, "Address not valid", "Enter a Google address, or leave it empty.");
  }

  const client = signinClient(env);
  if (!client) return notConfigured();
  return startLink(env, client, {
    ownerId: session.ownerId,
    label,
    components: chosen,
    ...(loginHint !== "" ? { loginHint } : {}),
  });
});

/**
 * Renames a mailbox. Only the display label changes: the account id, tokens, short id and the
 * default-mailbox choice are untouched. Same rules as linking, and no other mailbox of the owner
 * may have the label, ignoring case.
 */
accountsRoutes.post("/rename", async (c) => {
  const env = c.env;
  const posted = await authorizeAccountPost(c.req.raw, env);
  if (posted instanceof Response) return posted;
  const { session, form, account } = posted;

  const label = normalizeLabel(form.get("label"));
  if (!label) {
    return result(
      400,
      "Label not valid",
      `${LABEL_RULE} The label cannot be empty or "all" in any case.`,
    );
  }
  const clash = await labelClash(env.DB, session.ownerId, label, account.id);
  if (clash) return result(409, "Label in use", `${clash} Pick another label.`);
  try {
    await env.DB.prepare(
      "UPDATE accounts SET label = ?, updated_at = ? WHERE id = ? AND owner_id = ?",
    )
      .bind(label, nowSeconds(), account.id, session.ownerId)
      .run();
  } catch {
    return result(
      409,
      "Label in use",
      "Another mailbox already has that label. Pick another label.",
    );
  }
  return result(200, "Mailbox renamed", `${account.address} is now labelled "${label}".`);
});

/**
 * Switches one component of an account. Off: D1 only, at once (tools read `accounts.components`
 * and refuse with `component_disabled`). On: at once when Google already granted its scopes;
 * otherwise incremental consent for only the missing scopes, and the callback stores what
 * Google returns.
 */
accountsRoutes.post("/component", async (c) => {
  const env = c.env;
  const posted = await authorizeAccountPost(c.req.raw, env);
  if (posted instanceof Response) return posted;
  const { session, form, account } = posted;

  const component = form.get("component");
  const turnOn = form.get("on") === "1";
  if (!isAccountComponent(component) || (!turnOn && form.get("on") !== "0")) {
    return result(400, "Request refused", "Pick a component and on or off.");
  }
  const current = components(account);
  if (current.includes(component) === turnOn) return backToAccounts(env);

  const wanted = ACCOUNT_COMPONENTS.filter((k) =>
    turnOn ? k === component || current.includes(k) : k !== component && current.includes(k),
  );
  const granted = parseScopes(account.granted_scopes);
  if (turnOn && !grantedComponents([component], granted).includes(component)) {
    const client = signinClient(env);
    if (!client) return notConfigured();
    return startLink(env, client, {
      ownerId: session.ownerId,
      label: account.label,
      components: wanted,
      accountId: account.id,
      added: [component],
      // A needs_relink account has no live grant to add to: ask for everything that is on.
      ...(account.status === "ok"
        ? { scopes: scopesFor([component]).filter((s) => !granted.includes(s)) }
        : {}),
      loginHint: account.address,
    });
  }

  // Compare-and-set on the old value, so two toggles at once cannot undo each other.
  const changed = await env.DB.prepare(
    "UPDATE accounts SET components = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND components = ?",
  )
    .bind(JSON.stringify(wanted), nowSeconds(), account.id, session.ownerId, account.components)
    .run();
  if (changed.meta.changes === 0) {
    return result(
      409,
      "Changed meanwhile",
      "The mailbox changed while you were looking. Open the page again.",
    );
  }
  console.log(
    JSON.stringify({
      event: "account_component",
      owner_id: session.ownerId,
      account_id: account.id,
      component,
      on: turnOn,
      at: new Date().toISOString(),
    }),
  );
  return backToAccounts(env);
});

/** Runs the link leg again for an account's address (status `needs_relink`, or any time). */
accountsRoutes.post("/relink", async (c) => {
  const env = c.env;
  const posted = await authorizeAccountPost(c.req.raw, env);
  if (posted instanceof Response) return posted;
  const { session, account } = posted;
  const on = components(account);
  if (on.length === 0) {
    return result(
      400,
      "Nothing to re-link",
      "Turn a component on first; a link needs at least one.",
    );
  }
  const client = signinClient(env);
  if (!client) return notConfigured();
  return startLink(env, client, {
    ownerId: session.ownerId,
    label: account.label,
    components: on,
    accountId: account.id,
    loginHint: account.address,
  });
});

/**
 * Google has no "drop one scope" call: revoke the grant, then ask again for only the components
 * that are on. The stored tokens are dead after the revoke, so the account is `needs_relink`
 * until the callback stores the new ones.
 */
accountsRoutes.post("/relink-minimal", async (c) => {
  const env = c.env;
  const posted = await authorizeAccountPost(c.req.raw, env);
  if (posted instanceof Response) return posted;
  const { session, account } = posted;
  const on = components(account);
  if (on.length === 0) {
    return result(400, "Nothing to keep", "No component is on. Unlink the mailbox instead.");
  }
  const client = signinClient(env);
  if (!client) return notConfigured();
  // Nothing may fail after the revoke except Google itself.
  if (!(await sealingReady(env, session.ownerId))) return sealingNotReady();

  // No stored token (an earlier re-link minimal was abandoned at Google): nothing left to revoke.
  const stored = await first<{ n: number }>(
    env.DB,
    "SELECT count(*) AS n FROM account_tokens WHERE account_id = ?",
    account.id,
  );
  if ((stored?.n ?? 0) > 0 && !(await revokeStored(env, account))) {
    return result(
      502,
      "Not revoked",
      "Google did not confirm the revocation, so nothing was changed. Try again.",
    );
  }
  const db = env.DB;
  await db.batch([
    db
      .prepare(
        "UPDATE accounts SET status = 'needs_relink', updated_at = ? WHERE id = ? AND owner_id = ?",
      )
      .bind(nowSeconds(), account.id, session.ownerId),
    db.prepare("DELETE FROM account_tokens WHERE account_id = ?").bind(account.id),
  ]);
  console.log(
    JSON.stringify({
      event: "account_grant_revoked",
      owner_id: session.ownerId,
      account_id: account.id,
      at: new Date().toISOString(),
    }),
  );
  return startLink(env, client, {
    ownerId: session.ownerId,
    label: account.label,
    components: on,
    accountId: account.id,
    loginHint: account.address,
  });
});

/** Sets the owner's default mailbox, or clears it (empty `account`). */
accountsRoutes.post("/default", async (c) => {
  const env = c.env;
  const posted = await authorizePost(c.req.raw, env);
  if (posted instanceof Response) return posted;
  const { session, form } = posted;
  const id = form.get("account");
  if (typeof id !== "string") return result(400, "Request refused", "Pick a mailbox or none.");
  if (id === "") {
    await env.DB.prepare("UPDATE owners SET default_account_id = NULL WHERE id = ?")
      .bind(session.ownerId)
      .run();
    return backToAccounts(env);
  }
  // One statement: only an account of this owner can be the default.
  const set = await env.DB.prepare(
    `UPDATE owners SET default_account_id = ?1
     WHERE id = ?2 AND EXISTS (SELECT 1 FROM accounts WHERE id = ?1 AND owner_id = ?2)`,
  )
    .bind(id, session.ownerId)
    .run();
  if (set.meta.changes === 0) return result(404, "Not found", "That mailbox is not linked.");
  return backToAccounts(env);
});

/**
 * Re-seals every token of the owner's accounts that is under another key version than
 * `CURRENT_KEY_VERSION` (ARCHITECTURE s.4). Each update applies only while the row still has the
 * IV that was opened, so a refresh that lands meanwhile is never overwritten. The page reports
 * counts, never token material.
 */
accountsRoutes.post("/reencrypt", async (c) => {
  const env = c.env;
  const posted = await authorizePost(c.req.raw, env);
  if (posted instanceof Response) return posted;
  const { session } = posted;
  if (!(await sealingReady(env, session.ownerId))) return sealingNotReady();

  const version = currentKeyVersion(env);
  const now = nowSeconds();
  const db = env.DB;
  const rows = await listOwnerTokens(db, session.ownerId);
  const statements: D1PreparedStatement[] = [];
  let current = 0;
  let failed = 0;
  for (const row of rows) {
    if (row.key_version === version) {
      current++;
      continue;
    }
    const aad = { ownerId: session.ownerId, accountId: row.account_id, kind: row.kind };
    try {
      const sealed = await seal(await open(row, aad, env), aad, env);
      statements.push(
        db
          .prepare(
            `UPDATE account_tokens SET ciphertext = ?, iv = ?, key_version = ?, updated_at = ?
             WHERE account_id = ? AND kind = ? AND iv = ?`,
          )
          .bind(
            sealed.ciphertext,
            sealed.iv,
            sealed.key_version,
            now,
            row.account_id,
            row.kind,
            row.iv,
          ),
      );
    } catch {
      failed++;
    }
  }
  let moved = 0;
  for (let i = 0; i < statements.length; i += 50) {
    for (const r of await db.batch(statements.slice(i, i + 50))) moved += r.meta.changes;
  }
  const skipped = statements.length - moved;
  console.log(
    JSON.stringify({
      event: "tokens_reencrypted",
      owner_id: session.ownerId,
      key_version: version,
      moved,
      current,
      skipped,
      failed,
      at: new Date().toISOString(),
    }),
  );
  return result(
    200,
    "Tokens re-encrypted",
    `${moved} token(s) moved to key version ${version}; ${current} already used it` +
      (skipped > 0 ? `; ${skipped} changed while running and were left as they are` : "") +
      (failed > 0 ? `; ${failed} could not be opened and were left as they are` : "") +
      ".",
  );
});

accountsRoutes.post("/unlink", async (c) => {
  const env = c.env;
  const posted = await authorizePost(c.req.raw, env);
  if (posted instanceof Response) return posted;
  const { session, form } = posted;

  const accountId = form.get("account");
  const account =
    typeof accountId === "string" && accountId !== ""
      ? await getAccount(env.DB, session.ownerId, accountId)
      : null;
  if (!account) return result(404, "Not found", "That mailbox is not linked.");

  // Revoke first: a Google refresh token revokes the whole grant. The rows go even if Google does
  // not confirm, so the owner is never stuck with a mailbox they cannot remove.
  const revoked = await revokeStored(env, account);
  const db = env.DB;
  await db.batch([
    db
      .prepare(
        "UPDATE owners SET default_account_id = NULL WHERE id = ? AND default_account_id = ?",
      )
      .bind(session.ownerId, account.id),
    db.prepare("DELETE FROM account_tokens WHERE account_id = ?").bind(account.id),
    db.prepare("DELETE FROM send_as WHERE account_id = ?").bind(account.id),
    // Cascades to anything else that references the account (pending actions).
    db
      .prepare("DELETE FROM accounts WHERE id = ? AND owner_id = ?")
      .bind(account.id, session.ownerId),
  ]);
  await writeAudit(db, {
    at: nowSeconds(),
    ownerId: session.ownerId,
    accountId: account.id,
    tool: "unlink",
    result: "ok",
    detail: revoked ? "provider grant revoked" : "provider grant not revoked",
  });
  console.log(
    JSON.stringify({
      event: "account_unlinked",
      owner_id: session.ownerId,
      account_id: account.id,
      revoked,
      at: new Date().toISOString(),
    }),
  );

  const what = `${account.label} (${account.address})`;
  return revoked
    ? result(200, "Mailbox unlinked", `${what} is unlinked and its Google access is revoked.`)
    : result(
        200,
        "Mailbox unlinked",
        `${what} is unlinked, but Google did not confirm the revocation. Remove workspace-bridge under "Third-party apps and services" in that Google account.`,
      );
});

/**
 * Revokes the account's stored grant at Google: the refresh token, else the access token. False
 * when there is no token to revoke, it cannot be opened, or Google does not confirm.
 */
async function revokeStored(env: Env, account: AccountRow): Promise<boolean> {
  for (const kind of ["refresh", "access"] as const satisfies readonly TokenKind[]) {
    const row = await getToken(env.DB, account.id, kind);
    if (!row) continue;
    let token: string;
    try {
      token = await open(row, { ownerId: account.owner_id, accountId: account.id, kind }, env);
    } catch {
      continue;
    }
    return revokeToken(token);
  }
  return false;
}
