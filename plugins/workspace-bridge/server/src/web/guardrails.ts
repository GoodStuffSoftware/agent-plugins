// Owner pages for the guardrails (ARCHITECTURE s.2, s.3.1; plan s.10.5, s.10.7): `/approvals/:id`
// (approve or reject a pending action), the send kill switch and the audit log at
// `/accounts/audit`. Every decision needs the owner's session cookie and CSRF token; an MCP bearer
// token carries neither, so a client can never approve its own request.

import { Hono } from "hono";
import { notConfigured, notice, redirect, signinClient, startSignin } from "../auth/consent";
import { endpointScopes } from "../auth/endpoints";
import { getAuth } from "../auth/server";
import { checkCsrf, csrfToken, readSession, type Session } from "../auth/session";
import { createAccountResolver, loadAccountsWithState } from "../core/accounts";
import { readAudit, writeAudit } from "../core/audit";
import {
  first,
  getAccount,
  listAccounts,
  nowSeconds,
  type PendingActionRow,
  run,
} from "../core/db";
import { type ErrorCode, INTERNAL_MESSAGE, internalErrorLine, ToolError } from "../core/errors";
import {
  decidePending,
  finishPending,
  loadPending,
  parseStoredCall,
  pendingInfo,
} from "../core/pending";
import { isQueryableAddress } from "../core/recipients";
import { type AllowKind, addSendAllow, isFreemailDomain, normalizeAllow } from "../core/send-allow";
import { config, type Env } from "../env";
import { REGISTRY, type Registry } from "../registry/compile";
import { type RequestScope, toolContext } from "../registry/context";
import type { ToolContext } from "../registry/types";
import { htmlResponse, page, type SafeHtml } from "./html";
import { approvalView, auditView } from "./views";

const PENDING_ID = /^pa_[a-z2-7]{16}$/;

function noStore(res: Response): Response {
  res.headers.set("Cache-Control", "no-store");
  return res;
}

const message = (status: number, title: string, text: string): Response =>
  noStore(notice(status, title, text));

const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();

async function signIn(env: Env, returnTo: string): Promise<Response> {
  const client = signinClient(env);
  if (!client) return notConfigured();
  return startSignin(env, client, returnTo);
}

/** The form, the owner session and a valid CSRF token, or the refusal page. */
async function authorize(
  req: Request,
  env: Env,
): Promise<{ session: Session; form: FormData } | Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return message(400, "Request refused", "The form could not be read.");
  }
  const session = await readSession(req, env);
  if (!session) {
    return message(403, "Sign-in required", "Your sign-in has expired. Open this page again.");
  }
  const csrf = form.get("csrf");
  if (!(await checkCsrf(env, session, typeof csrf === "string" ? csrf : null))) {
    return message(403, "Request refused", "The form has expired. Reload the page and try again.");
  }
  return { session, form };
}

/** The grant behind a pending action, if the owner has not revoked it and it has not expired. */
async function findGrant(env: Env, ownerId: string, grantId: string) {
  const api = getAuth(env).as.getOAuthApi(env);
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const page = await api.listUserGrants(ownerId, { limit: 1000, cursor });
    const grant = page.items.find((g) => g.id === grantId);
    if (grant) {
      return grant.expiresAt !== undefined && grant.expiresAt <= nowSeconds() ? undefined : grant;
    }
    if (!page.cursor) return undefined;
    cursor = page.cursor;
  }
  return undefined;
}

type Outcome = { ok: true } | { ok: false; message: string };

/**
 * Runs an approved action: the same handler, with a context rebuilt from the stored endpoint and
 * grant (still present, still holding the tool's scopes) and accounts narrowed to the stored one,
 * so no selector or default change can move it to another mailbox. No rate check or approval gate
 * runs again; the handler's own checks (kill switch, send limits, sendAs) do.
 */
async function runApproved(
  env: Env,
  exec: ExecutionContext,
  registry: Registry,
  row: PendingActionRow,
): Promise<Outcome> {
  const fail = async (
    code: ErrorCode,
    text: string,
    details?: Readonly<Record<string, unknown>>,
  ): Promise<Outcome> => {
    await finishPending(env.DB, row.id, "failed", {
      error: { ...details, code, message: text },
    });
    return { ok: false, message: text };
  };
  const call = parseStoredCall(row.params);
  if (!call) return fail("internal", "The stored action could not be read.");
  const tool = registry.byKind[call.kind].find((t) => t.def.name === row.tool);
  if (!tool) return fail("not_found", "This tool is no longer available on that endpoint.");
  const grant = await findGrant(env, row.owner_id, row.grant_id);
  if (!grant) {
    return fail("not_found", "The connection that asked for this action is revoked or expired.");
  }
  const scopes = endpointScopes(call.kind, grant.scope);
  if (!tool.def.scopes.every((s) => scopes.includes(s))) {
    return fail("invalid_argument", "The connection no longer holds the scopes this tool needs.");
  }
  const scope: RequestScope = {
    kind: call.kind,
    ownerId: row.owner_id,
    grant: Object.freeze({
      clientId: row.client_id,
      grantId: row.grant_id,
      scopes: Object.freeze(scopes),
    }),
    env,
    exec,
  };
  const base = toolContext(scope, registry.providers);
  const accountId = row.account_id;
  // Always narrowed: a row without an account (never written by the gate) sees no account at all.
  const ctx: ToolContext = {
    ...base,
    accounts: createAccountResolver({
      db: env.DB,
      ownerId: row.owner_id,
      publicUrl: base.publicUrl,
      load: async () =>
        accountId === null
          ? []
          : (await loadAccountsWithState(env, row.owner_id)).filter(
              (a) => a.accountId === accountId,
            ),
    }),
  };
  try {
    const value = await tool.def.handler(call.args as never, ctx);
    await finishPending(env.DB, row.id, "executed", value);
    return { ok: true };
  } catch (e) {
    if (!(e instanceof ToolError)) {
      try {
        console.error(internalErrorLine(row.tool, e, call.args));
      } catch {
        // Logging must never change the outcome.
      }
    }
    const err = e instanceof ToolError ? e : new ToolError("internal", INTERNAL_MESSAGE);
    return fail(err.code, err.message, err.details);
  }
}

/** The new recipients a held send's stored preview names (normalized addresses), or none. */
function newRecipientsOf(preview: string): string[] {
  try {
    const found = (JSON.parse(preview) as { newRecipients?: unknown } | null)?.newRecipients;
    return Array.isArray(found)
      ? found.filter((x): x is string => typeof x === "string" && x !== "")
      : [];
  } catch {
    return [];
  }
}

const domainOf = (address: string): string => address.slice(address.lastIndexOf("@") + 1);

/** What an approval writes to the allow list of the held send's account; refused as a whole. */
type AllowRequest = { entries: { kind: AllowKind; value: string }[] } | { refusal: string };

/**
 * The allow-list entries a decision asks for, checked before the action is decided: only the held
 * send's own new recipients (or their domains) can be allowed, and a public mail provider's
 * domain is refused here as it is in the store.
 */
function allowRequest(decision: string, form: FormData, fresh: readonly string[]): AllowRequest {
  const known = new Set(fresh);
  try {
    if (decision === "approve_allow") {
      const picked = [...new Set(form.getAll("allow").map((v) => String(v).trim().toLowerCase()))];
      if (picked.length === 0) return { refusal: "Check at least one address to allow." };
      if (picked.some((a) => !known.has(a))) {
        return { refusal: "Only the new recipients of this send can be allowed here." };
      }
      return {
        entries: picked.map((a) => ({
          kind: "address" as const,
          value: normalizeAllow("address", a),
        })),
      };
    }
    const domain = decision.slice("approve_domain:".length).trim().toLowerCase();
    if (![...known].some((a) => isQueryableAddress(a) && domainOf(a) === domain)) {
      return { refusal: "That domain is not one of this send's new recipients." };
    }
    return { entries: [{ kind: "domain", value: normalizeAllow("domain", domain) }] };
  } catch (e) {
    if (e instanceof ToolError) return { refusal: e.message };
    throw e;
  }
}

async function approvalBody(env: Env, row: PendingActionRow, csrf: string): Promise<SafeHtml> {
  const info = pendingInfo(row, nowSeconds());
  const account = row.account_id ? await getAccount(env.DB, row.owner_id, row.account_id) : null;
  const fresh = newRecipientsOf(row.preview);
  const mailbox = account?.address ?? "this mailbox";
  const plain = fresh.filter(isQueryableAddress);
  return approvalView({
    id: row.id,
    csrf,
    tool: row.tool,
    status: info.status,
    clientId: row.client_id,
    requested: iso(row.created_at),
    expires: iso(row.expires_at),
    account: account ? { label: account.label, address: account.address } : null,
    preview: info.preview,
    previewJson: JSON.stringify(info.preview, null, 2) ?? "null",
    args: storedArgs(row.params),
    resultJson: info.result === null ? null : JSON.stringify(info.result, null, 2),
    held:
      fresh.length > 0 && row.account_id !== null
        ? {
            fresh: fresh.map((address) => ({ address, queryable: isQueryableAddress(address) })),
            mailbox,
            domains: [...new Set(plain.map(domainOf))].filter((d) => !isFreemailDomain(d)),
          }
        : null,
  });
}

const MAX_ARGS_SHOWN = 20_000;
/** The stored call's arguments as the handler will get them, clipped for the page. */
const storedArgs = (params: string): string => {
  const call = parseStoredCall(params);
  const text = call ? (JSON.stringify(call.args, null, 2) ?? "null") : "(unreadable)";
  return text.length > MAX_ARGS_SHOWN ? `${text.slice(0, MAX_ARGS_SHOWN)}\n(clipped)` : text;
};

const addresses = (json: string | null): string => {
  if (json === null) return "";
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").join(", ") : "";
  } catch {
    return "";
  }
};

export function guardrailsRoutes(registry: Registry = REGISTRY): Hono<{ Bindings: Env }> {
  const routes = new Hono<{ Bindings: Env }>();

  routes.get("/approvals/:id", async (c) => {
    const env = c.env;
    const id = c.req.param("id");
    const session = await readSession(c.req.raw, env);
    if (!session) return signIn(env, `/approvals/${encodeURIComponent(id)}`);
    const row = PENDING_ID.test(id) ? await loadPending(env.DB, session.ownerId, id) : null;
    if (!row) return message(404, "Not found", "No pending action has that id.");
    const csrf = await csrfToken(env, session);
    return noStore(
      htmlResponse(page("Approve an action", await approvalBody(env, row, csrf), { nav: "other" })),
    );
  });

  routes.post("/approvals/:id", async (c) => {
    const env = c.env;
    const id = c.req.param("id");
    const auth = await authorize(c.req.raw, env);
    if (auth instanceof Response) return auth;
    const { session, form } = auth;
    const choice = form.get("decision");
    const isAllow =
      typeof choice === "string" &&
      (choice === "approve_allow" || choice.startsWith("approve_domain:"));
    if (choice !== "approve" && choice !== "reject" && !isAllow) {
      return message(400, "Request refused", "Choose Approve or Reject.");
    }
    // An allow-list approval is checked in full before anything is decided, so a refusal (a public
    // mail provider's domain, an address that is not one of the new recipients) leaves the action
    // waiting, and nothing is written for an action that is expired or already decided.
    let allow: { kind: AllowKind; value: string }[] = [];
    if (isAllow) {
      const held = PENDING_ID.test(id) ? await loadPending(env.DB, session.ownerId, id) : null;
      if (!held) return message(404, "Not found", "No pending action has that id.");
      if (held.account_id === null || newRecipientsOf(held.preview).length === 0) {
        return message(400, "Request refused", "This action has no new recipients to allow.");
      }
      const wanted = allowRequest(choice, form, newRecipientsOf(held.preview));
      if ("refusal" in wanted) return message(400, "Not allowed", wanted.refusal);
      allow = wanted.entries;
    }
    const now = nowSeconds();
    const status = choice === "reject" ? "rejected" : "approved";
    const row = PENDING_ID.test(id)
      ? await decidePending(env.DB, session.ownerId, id, status, now)
      : null;
    if (!row) {
      const existing = PENDING_ID.test(id) ? await loadPending(env.DB, session.ownerId, id) : null;
      if (!existing) return message(404, "Not found", "No pending action has that id.");
      return message(
        409,
        "Already decided",
        `This action is ${pendingInfo(existing, now).status} and can no longer be approved or rejected.`,
      );
    }
    // The decision is recorded; from here every path settles the row, so an approved action
    // never stays `approved` without a result.
    try {
      await writeAudit(env.DB, {
        at: now,
        ownerId: session.ownerId,
        accountId: row.account_id,
        tool: row.tool,
        clientId: row.client_id,
        grantId: row.grant_id,
        result: status,
        detail: `pending action ${row.id}`,
      });
    } catch (e) {
      console.error(internalErrorLine("approval audit", e, {}));
    }
    if (status === "rejected") {
      return message(200, "Rejected", "The action was rejected and will not run.");
    }
    // The allow list of the held send's own account, before the approved run, which repeats every
    // check on its own.
    if (allow.length > 0 && row.account_id !== null) {
      try {
        for (const entry of allow) {
          await addSendAllow(env.DB, session.ownerId, row.account_id, entry.kind, entry.value);
          await writeAudit(env.DB, {
            at: now,
            ownerId: session.ownerId,
            accountId: row.account_id,
            tool: "send_allow",
            clientId: row.client_id,
            grantId: row.grant_id,
            result: "added",
            detail: `${entry.kind} ${entry.value}; from approving pending action ${row.id}`,
          });
        }
      } catch (e) {
        console.error(internalErrorLine("approval allow list", e, {}));
        await finishPending(env.DB, row.id, "failed", {
          error: { code: "internal", message: INTERNAL_MESSAGE },
        });
        return message(
          200,
          "Approved, but it failed",
          "The allow list could not be updated, so the action did not run.",
        );
      }
    }
    let outcome: Outcome;
    try {
      outcome = await runApproved(
        env,
        c.executionCtx as unknown as ExecutionContext,
        registry,
        row,
      );
    } catch (e) {
      console.error(internalErrorLine(row.tool, e, {}));
      await finishPending(env.DB, row.id, "failed", {
        error: { code: "internal", message: INTERNAL_MESSAGE },
      });
      outcome = { ok: false, message: INTERNAL_MESSAGE };
    }
    return outcome.ok
      ? message(
          200,
          "Approved",
          "The action ran. The client can read its result with get_pending_action.",
        )
      : message(200, "Approved, but it failed", `The action did not complete: ${outcome.message}`);
  });

  routes.post("/accounts/send-switch", async (c) => {
    const env = c.env;
    const auth = await authorize(c.req.raw, env);
    if (auth instanceof Response) return auth;
    const sending = auth.form.get("sending");
    if (sending !== "on" && sending !== "off") {
      return message(400, "Request refused", "Choose on or off.");
    }
    await run(
      env.DB,
      "UPDATE owners SET send_kill_switch = ? WHERE id = ?",
      sending === "off" ? 1 : 0,
      auth.session.ownerId,
    );
    await writeAudit(env.DB, {
      at: nowSeconds(),
      ownerId: auth.session.ownerId,
      tool: "send_switch",
      result: sending,
    });
    return redirect(`${config(env).issuer}/accounts/audit`);
  });

  routes.get("/accounts/audit", async (c) => {
    const env = c.env;
    const session = await readSession(c.req.raw, env);
    if (!session) return signIn(env, "/accounts/audit");
    const raw = c.req.query("before")?.match(/^(\d{1,12})-(\d{1,15})$/);
    const before = raw ? { at: Number(raw[1]), id: Number(raw[2]) } : undefined;
    const rows = await readAudit(env.DB, session.ownerId, { limit: 100, before });
    const labels = new Map(
      (await listAccounts(env.DB, session.ownerId)).map((a) => [a.id, a.label]),
    );
    const owner = await first<{ send_kill_switch: number }>(
      env.DB,
      "SELECT send_kill_switch FROM owners WHERE id = ?",
      session.ownerId,
    );
    const switchedOff = owner?.send_kill_switch !== 0;
    const enabled = config(env).sendEnabled;
    const csrf = await csrfToken(env, session);
    const last = rows.at(-1);
    const body = auditView({
      csrf,
      sendEnabled: enabled,
      switchedOff,
      rows: rows.map((r) => ({
        at: iso(r.at),
        account: r.account_id ? (labels.get(r.account_id) ?? r.account_id) : "",
        tool: r.tool,
        result: r.result,
        from: r.from_addr ?? "",
        recipients: [addresses(r.to_addrs), addresses(r.cc_addrs), addresses(r.bcc_addrs)]
          .filter((x) => x)
          .join("; "),
        subject: r.subject ?? "",
        detail: r.detail ?? "",
        client: r.client_id ?? "",
      })),
      older: rows.length === 100 && last ? `${last.at}-${last.id}` : null,
    });
    return noStore(htmlResponse(page("Sending and audit log", body, { nav: "audit" })));
  });

  return routes;
}
