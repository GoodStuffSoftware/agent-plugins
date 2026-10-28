// `/accounts`, the owner's page for linked mailboxes (plan s.4.3, ARCHITECTURE s.2). M7a: the
// list, the link form and unlink. M7b adds component toggles with incremental consent, the default
// account, "re-link minimal" and "re-encrypt all" as more sections and POST routes here.
//
// Every route needs the owner session; every POST also needs the session's CSRF token. Pages are
// never cached and never show a token.

import { Hono } from "hono";
import { notConfigured, signinClient, startSignin } from "../auth/consent";
import { normalizeLabel, startLink } from "../auth/link";
import { checkCsrf, csrfToken, readSession, type Session } from "../auth/session";
import { open, type TokenKind } from "../core/crypto";
import { type AccountRow, first, getAccount, getToken, listAccounts } from "../core/db";
import type { Env } from "../env";
import {
  ACCOUNT_COMPONENTS,
  type AccountComponent,
  isAccountComponent,
  revokeToken,
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

function components(account: AccountRow): AccountComponent[] {
  try {
    const parsed: unknown = JSON.parse(account.components);
    return Array.isArray(parsed) ? parsed.filter(isAccountComponent) : [];
  } catch {
    return [];
  }
}

function accountRow(account: AccountRow, isDefault: boolean, csrf: string): SafeHtml {
  const on = components(account);
  return html`<tr>
<td>${account.label}</td>
<td>${account.address}</td>
<td>${account.provider}</td>
<td>${on.length > 0 ? on.map((c) => COMPONENT_LABELS[c]).join(", ") : "none"}</td>
<td>${account.status === "ok" ? "ok" : "needs re-link"}</td>
<td>${isDefault ? "default" : ""}</td>
<td><form method="post" action="/accounts/unlink">
<input type="hidden" name="csrf" value="${csrf}">
<input type="hidden" name="account" value="${account.id}">
<button type="submit">Unlink</button>
</form></td>
</tr>`;
}

function accountsTable(accounts: AccountRow[], defaultId: string | null, csrf: string): SafeHtml {
  if (accounts.length === 0) return html`<p>No mailbox is linked yet.</p>`;
  return html`<table>
<thead><tr><th>Label</th><th>Address</th><th>Provider</th><th>Components</th><th>Status</th><th>Default</th><th></th></tr></thead>
<tbody>${accounts.map((a) => accountRow(a, a.id === defaultId, csrf))}</tbody>
</table>`;
}

function linkForm(csrf: string): SafeHtml {
  return html`<h2>Link a mailbox</h2>
<form method="post" action="/accounts/link">
<input type="hidden" name="csrf" value="${csrf}">
<p><label>Label <input name="label" required maxlength="32" pattern="[a-z0-9][a-z0-9._\\-]{0,31}" placeholder="personal"></label></p>
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
  const body = html`<h1>Linked mailboxes</h1>
<p>Signed in as ${session.email}.</p>
${accountsTable(accounts, owner?.default_account_id ?? null, csrf)}
${linkForm(csrf)}`;
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
      'Use up to 32 lowercase letters, digits, ".", "_" or "-", starting with a letter or digit. "all" is reserved.',
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
  // M14: write the `unlink` audit row here (plan s.4.3 step 5, s.10.2).
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
