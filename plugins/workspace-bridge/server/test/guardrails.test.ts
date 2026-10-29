// M14: send guardrails (ARCHITECTURE s.2, s.3.2, s.4; plan s.10): sendAs, send limits, recipient
// cap, kill switch, the approval gate and `/approvals/:id`, the audit log, the daily cleanup and
// the `/mcp/ro` surface. Google is the route-table fake; the OAuth library runs for real.

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type Kind, resourceUrl, SCOPES } from "../src/auth/endpoints";
import { mcpHandler } from "../src/auth/mcp-factory";
import { emailHash } from "../src/auth/owners";
import { createSession, SESSION_COOKIE } from "../src/auth/session";
import { randomId } from "../src/core/crypto";
import { type AuditLogRow, all, first, type PendingActionRow } from "../src/core/db";
import { ToolError } from "../src/core/errors";
import { createRateLimiter } from "../src/core/ratelimit";
import { config, type Env } from "../src/env";
import { cleanup } from "../src/index";
import { compileRegistry } from "../src/registry/compile";
import { grantIdOf, toolContext } from "../src/registry/context";
import { defineTool, type Family, type ToolContext, type ToolDef } from "../src/registry/types";
import type { AccountRef } from "../src/services/types";
import { FAMILIES } from "../src/tools";
import { guardrailsRoutes } from "../src/web/guardrails";
import {
  googleJson,
  installFakeGoogle,
  installGoogleRoutes,
  linkGoogleAccount,
  newOwner,
} from "./helpers/google";
import { ISSUER, mcpRequest, mcpRpc, parseMcp, toolJson } from "./helpers/mcp";
import { Browser, mcpClient } from "./helpers/session";
import { mintToken } from "./helpers/tokens";

const SEND_AS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs";
const OWNER_EMAIL = "owner@example.com";
const BODY_TEXT = "SECRET-BODY-TEXT-do-not-store";

// A test-only send tool behind the approval gate, built the way M15 builds send tools.
const runs: { args: unknown; account: string }[] = [];
const guardedSend = defineTool({
  name: "test_guarded_send",
  description: "Sends a test message.",
  component: null,
  scopes: [],
  endpoints: ["full"],
  annotations: { openWorldHint: true },
  input: z.object({ account: z.string().optional(), to: z.string(), body: z.string() }),
  approval: {
    when: (_args, ctx) => config(ctx.env).sendApprovalMode === "all",
    async preview(args, ctx) {
      const [a] = await ctx.accounts.resolve(args.account);
      return { account: a?.label, to: args.to };
    },
  },
  async handler(args, ctx) {
    const [a] = await ctx.accounts.resolve(args.account);
    if (!a) throw new Error("no account");
    runs.push({ args, account: a.label });
    await ctx.audit.write({ tool: "test_guarded_send", account: a, to: [args.to], result: "ok" });
    return { sent: true, account: a.label };
  },
});
const testFamily: Family = {
  id: "test_m14",
  tools: [guardedSend as unknown as ToolDef],
  bindings: {},
  parityPending: [],
};
const registry = compileRegistry([...FAMILIES, testFamily]);

afterEach(() => {
  vi.restoreAllMocks();
});

/** `env` with overrides; `config()` parses each new object once. */
// These suites test the guardrails of a send, not the new-recipient rule (test/send-approval.test.ts):
// approval is off unless a test asks for SEND_REQUIRES_CONFIRM, which with the mode unset means `all`.
const withEnv = (overrides: Partial<Env>): Env =>
  ({
    ...env,
    SEND_APPROVAL_MODE: "SEND_REQUIRES_CONFIRM" in overrides ? undefined : "off",
    ...overrides,
  }) as Env;

function ctxFor(ownerId: string, e: Env = env): ToolContext {
  return toolContext(
    {
      kind: "full",
      ownerId,
      grant: { clientId: "client_test", grantId: "g_test", scopes: [] },
      env: e,
      exec: createExecutionContext(),
    },
    registry.providers,
  );
}

/** An owner with one linked account, and the account as `ctx.accounts` resolves it. */
async function setup(e: Env = env): Promise<{ ownerId: string; ctx: ToolContext; a: AccountRef }> {
  const ownerId = await newOwner();
  await linkGoogleAccount(ownerId);
  const ctx = ctxFor(ownerId, e);
  const [a] = await ctx.accounts.resolve();
  if (!a) throw new Error("no account");
  return { ownerId, ctx, a };
}

/** The ToolError `fn` throws. */
async function toolError(fn: () => Promise<unknown>): Promise<ToolError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ToolError) return e;
    throw e;
  }
  throw new Error("expected a ToolError");
}

/** A tools/call through the real MCP handler with the test registry. */
async function callTool(
  ownerId: string,
  kind: Kind,
  name: string,
  args: Record<string, unknown>,
  { e = env, token = `${ownerId}:g_test:secret` }: { e?: Env; token?: string } = {},
): Promise<{ isError: boolean; json: Record<string, unknown> }> {
  const exec = Object.assign(createExecutionContext(), {
    props: { ownerId },
    auth: {
      token,
      audience: resourceUrl(kind, ISSUER),
      scope: [...SCOPES[kind]],
      clientId: "client_test",
      userId: ownerId,
    },
  });
  const req = mcpRequest(undefined, kind, "tools/call", { name, arguments: args });
  const res = await mcpHandler(kind, ISSUER, registry)(req, e, exec);
  await waitOnExecutionContext(exec);
  expect(res.status).toBe(200);
  const rpc = await parseMcp(res);
  return { isError: rpc.result?.isError === true, json: toolJson(rpc.result) as never };
}

interface PageInit {
  method?: string;
  cookie?: string;
  form?: Record<string, string>;
  bearer?: string;
}

/** The guardrail pages with the test registry. */
function pages(e: Env): (path: string, init?: PageInit) => Promise<Response> {
  const app = new Hono<{ Bindings: Env }>().route("/", guardrailsRoutes(registry));
  return async (path, init = {}) => {
    const headers = new Headers();
    if (init.cookie) headers.set("Cookie", init.cookie);
    if (init.bearer) headers.set("Authorization", `Bearer ${init.bearer}`);
    const exec = createExecutionContext();
    const res = await app.fetch(
      new Request(ISSUER + path, {
        method: init.method ?? "GET",
        headers,
        body: init.form ? new URLSearchParams(init.form) : undefined,
      }),
      e,
      exec,
    );
    await waitOnExecutionContext(exec);
    return res;
  };
}

/** The owner's session cookie, as `Cookie` header text. */
async function ownerCookie(e: Env, ownerId: string): Promise<string> {
  const { setCookie } = await createSession(e, ownerId, OWNER_EMAIL);
  const pair = setCookie.split(";")[0] ?? "";
  expect(pair.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
  return pair;
}

const csrfIn = (html: string): string => html.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";

const pendingRow = (id: string) =>
  first<PendingActionRow>(env.DB, "SELECT * FROM pending_actions WHERE id = ?", id);

/** Holds one `test_guarded_send` for approval on a real grant; returns its id and the token. */
async function holdOne(
  e: Env,
  ownerId: string,
  args: Record<string, unknown> = { to: "x@example.com", body: "b" },
): Promise<{ id: string; token: string }> {
  const token = await mintToken({ kind: "full", scopes: SCOPES.full, ownerId });
  const held = await callTool(ownerId, "full", "test_guarded_send", args, { e, token });
  const id = held.json.pendingActionId;
  if (typeof id !== "string") throw new Error(`not held: ${JSON.stringify(held.json)}`);
  return { id, token };
}

describe("sendAs", () => {
  it("accepts the primary address, verified aliases in any case, and the default when omitted", async () => {
    const calls = installGoogleRoutes([
      {
        url: SEND_AS_URL,
        reply: () =>
          googleJson(200, {
            sendAs: [
              { sendAsEmail: "work@example.com", isPrimary: true },
              {
                sendAsEmail: "Alias@Example.com",
                displayName: "Alias",
                isDefault: true,
                verificationStatus: "accepted",
              },
              { sendAsEmail: "pending@example.com", verificationStatus: "pending" },
            ],
          }),
      },
    ]);
    const { ctx, a } = await setup();
    expect((await ctx.sendAs.assertFrom(a, "ALIAS@example.com")).email).toBe("alias@example.com");
    expect((await ctx.sendAs.assertFrom(a, "work@example.com")).isPrimary).toBe(true);
    expect((await ctx.sendAs.assertFrom(a)).email).toBe("alias@example.com");
    // One refresh, then the stored rows are used within the 24 h TTL.
    expect(calls.filter((c) => c.url.startsWith(SEND_AS_URL))).toHaveLength(1);
    expect(calls[0]?.url).toContain("fields=");
  });

  it("refuses an unverified alias and an address that is not on the list", async () => {
    installGoogleRoutes([
      {
        url: SEND_AS_URL,
        reply: () =>
          googleJson(200, {
            sendAs: [
              { sendAsEmail: "work@example.com", isPrimary: true, isDefault: true },
              { sendAsEmail: "pending@example.com", verificationStatus: "pending" },
            ],
          }),
      },
    ]);
    const { ctx, a } = await setup();
    for (const from of ["pending@example.com", "someone@example.org"]) {
      const err = await toolError(() => ctx.sendAs.assertFrom(a, from));
      expect(err.code).toBe("sender_not_allowed");
      expect(err.message).not.toContain(from);
    }
  });
});

describe("send limits", () => {
  // 10 minutes into an hour, 3 h 10 min into a UTC day.
  const DAY = 1_800_000_000 - (1_800_000_000 % 86400);
  const T = DAY + 3 * 3600 + 600;
  const clock = () => T * 1000;

  it("trips the hourly limit with retryAfterSeconds to the end of the hour", async () => {
    const e = withEnv({ SEND_ENABLED: "true", SEND_PER_HOUR: "2", SEND_PER_DAY: "100" });
    const { ctx, a } = await setup(e);
    const limits = createRateLimiter({ env: e, grant: ctx.grant, now: clock });
    await limits.checkSend(a, ["x@example.com"]);
    await limits.checkSend(a, ["x@example.com"]);
    const err = await toolError(() => limits.checkSend(a, ["x@example.com"]));
    expect(err.code).toBe("rate_limited");
    expect(err.details).toEqual({ retryAfterSeconds: 3000 });
  });

  it("trips the daily limit with retryAfterSeconds to the end of the day", async () => {
    const e = withEnv({ SEND_ENABLED: "true", SEND_PER_HOUR: "100", SEND_PER_DAY: "3" });
    const { ctx, a } = await setup(e);
    const limits = createRateLimiter({ env: e, grant: ctx.grant, now: clock });
    for (let i = 0; i < 3; i++) await limits.checkSend(a, ["x@example.com"]);
    const err = await toolError(() => limits.checkSend(a, ["x@example.com"]));
    expect(err.code).toBe("rate_limited");
    expect(err.details).toEqual({ retryAfterSeconds: 86400 - (3 * 3600 + 600) });
  });

  it("caps distinct recipients across to, cc and bcc", async () => {
    const e = withEnv({ SEND_ENABLED: "true", MAX_RECIPIENTS: "3" });
    const { ctx, a } = await setup(e);
    // Four entries, three distinct addresses once case and spaces are ignored.
    await ctx.limits.checkSend(a, [
      "a@example.com",
      "B@example.com",
      " b@example.com",
      "c@example.com",
    ]);
    const err = await toolError(() =>
      ctx.limits.checkSend(a, ["a@example.com", "b@example.com", "c@example.com", "d@example.com"]),
    );
    expect(err.code).toBe("too_many_recipients");
    expect(err.details).toEqual({ maxRecipients: 3 });
  });
});

describe("kill switch", () => {
  it("SEND_ENABLED=false disables every send", async () => {
    const { ctx, a } = await setup(withEnv({ SEND_ENABLED: "false" }));
    const err = await toolError(() => ctx.limits.checkSend(a, ["x@example.com"]));
    expect(err.code).toBe("send_disabled");
    expect(err.message).toContain("SEND_ENABLED");
  });

  it("the owner switches sending off and on with session and CSRF", async () => {
    const e = withEnv({ SEND_ENABLED: "true" });
    const { ownerId, ctx, a } = await setup(e);
    const fetchPage = pages(e);
    const cookie = await ownerCookie(e, ownerId);
    const audit = await fetchPage("/accounts/audit", { cookie });
    expect(audit.status).toBe(200);
    const csrf = csrfIn(await audit.text());
    expect(csrf).not.toBe("");

    // Without CSRF nothing changes.
    const refused = await fetchPage("/accounts/send-switch", {
      method: "POST",
      cookie,
      form: { sending: "off" },
    });
    expect(refused.status).toBe(403);
    await ctx.limits.checkSend(a, ["x@example.com"]);

    const off = await fetchPage("/accounts/send-switch", {
      method: "POST",
      cookie,
      form: { sending: "off", csrf },
    });
    expect(off.status).toBe(302);
    const err = await toolError(() => ctx.limits.checkSend(a, ["x@example.com"]));
    expect(err.code).toBe("send_disabled");
    expect(err.details).toEqual({ accountsUrl: `${ISSUER}/accounts` });

    const on = await fetchPage("/accounts/send-switch", {
      method: "POST",
      cookie,
      form: { sending: "on", csrf },
    });
    expect(on.status).toBe(302);
    await ctx.limits.checkSend(a, ["x@example.com"]);
    const rows = await all<AuditLogRow>(
      env.DB,
      "SELECT * FROM audit_log WHERE owner_id = ? AND tool = 'send_switch' ORDER BY id",
      ownerId,
    );
    expect(rows.map((r) => r.result)).toEqual(["off", "on"]);
  });
});

describe("approval gate", () => {
  const confirmEnv = withEnv({ SEND_REQUIRES_CONFIRM: "true" });

  it("stores the action bound to its account and returns the pending shape", async () => {
    const { ownerId, a } = await setup(confirmEnv);
    const before = runs.length;
    const res = await callTool(
      ownerId,
      "full",
      "test_guarded_send",
      { to: "x@example.com", body: BODY_TEXT },
      { e: confirmEnv },
    );
    expect(res.isError).toBe(false);
    const id = res.json.pendingActionId as string;
    expect(res.json).toEqual({
      status: "pending_approval",
      pendingActionId: expect.stringMatching(/^pa_[a-z2-7]{16}$/),
      approvalUrl: `${ISSUER}/approvals/${id}`,
      preview: { account: "work", to: "x@example.com" },
      expiresAt: expect.any(Number),
    });
    expect(runs.length).toBe(before);
    const row = await pendingRow(id);
    expect(row).toMatchObject({
      owner_id: ownerId,
      account_id: a.accountId,
      tool: "test_guarded_send",
      status: "pending",
      client_id: "client_test",
      grant_id: "g_test",
    });
    expect(JSON.parse(row?.params ?? "")).toEqual({
      kind: "full",
      args: { to: "x@example.com", body: BODY_TEXT },
    });
    expect((row?.expires_at ?? 0) - (row?.created_at ?? 0)).toBe(7 * 86400);

    const got = await callTool(ownerId, "full", "get_pending_action", { pendingActionId: id });
    expect(got.json).toMatchObject({ pendingActionId: id, status: "pending", result: null });
  });

  it("runs the handler without a pending action when approval is not needed", async () => {
    const { ownerId } = await setup();
    const res = await callTool(ownerId, "full", "test_guarded_send", {
      to: "x@example.com",
      body: "b",
    });
    expect(res.json).toEqual({ sent: true, account: "work" });
  });

  it("escapes an HTML-special label on the approval and audit pages", async () => {
    const ownerId = await newOwner();
    const a = await linkGoogleAccount(ownerId, { label: "<script>x</script> & co" });
    await env.DB.prepare("UPDATE owners SET default_account_id = ? WHERE id = ?")
      .bind(a.row.id, ownerId)
      .run();
    const { id } = await holdOne(confirmEnv, ownerId, { to: "x@example.com", body: BODY_TEXT });
    const fetchPage = pages(confirmEnv);
    const cookie = await ownerCookie(confirmEnv, ownerId);
    for (const path of [`/approvals/${id}`, "/accounts/audit", "/accounts"]) {
      const text = await (await fetchPage(path, { cookie })).text();
      expect(text).not.toContain("<script>x</script>");
    }
    expect(await (await fetchPage(`/approvals/${id}`, { cookie })).text()).toContain(
      "&lt;script&gt;x&lt;/script&gt; &amp; co",
    );
  });

  it("approve on the page with session and CSRF runs the handler once, on the stored account", async () => {
    const ownerId = await newOwner();
    const work = await linkGoogleAccount(ownerId, { label: "work" });
    const home = await linkGoogleAccount(ownerId, { label: "home" });
    const setDefault = (id: string) =>
      env.DB.prepare("UPDATE owners SET default_account_id = ? WHERE id = ?")
        .bind(id, ownerId)
        .run();
    await setDefault(work.row.id);
    const { id, token } = await holdOne(confirmEnv, ownerId, {
      to: "x@example.com",
      body: BODY_TEXT,
    });
    expect((await pendingRow(id))?.grant_id).toBe(grantIdOf(token));
    // The default moves to another mailbox before approval: the action stays on `work`.
    await setDefault(home.row.id);

    const fetchPage = pages(confirmEnv);
    const cookie = await ownerCookie(confirmEnv, ownerId);
    const view = await fetchPage(`/approvals/${id}`, { cookie });
    expect(view.status).toBe(200);
    const html = await view.text();
    expect(html).toContain("test_guarded_send");
    const csrf = csrfIn(html);

    const before = runs.length;
    const approved = await fetchPage(`/approvals/${id}`, {
      method: "POST",
      cookie,
      form: { decision: "approve", csrf },
    });
    expect(approved.status).toBe(200);
    expect(await approved.text()).toContain("The action ran");
    expect(runs.length).toBe(before + 1);
    expect(runs.at(-1)).toEqual({
      args: { to: "x@example.com", body: BODY_TEXT },
      account: "work",
    });

    const again = await fetchPage(`/approvals/${id}`, {
      method: "POST",
      cookie,
      form: { decision: "approve", csrf },
    });
    expect(again.status).toBe(409);
    expect(runs.length).toBe(before + 1);

    const got = await callTool(ownerId, "full", "get_pending_action", { pendingActionId: id });
    expect(got.json).toMatchObject({ status: "executed", result: { sent: true, account: "work" } });

    // Audit rows for the decision and the send, none holding the body.
    const rows = await all<AuditLogRow>(
      env.DB,
      "SELECT * FROM audit_log WHERE owner_id = ? ORDER BY id",
      ownerId,
    );
    expect(rows.map((r) => [r.tool, r.result])).toEqual([
      ["test_guarded_send", "approved"],
      ["test_guarded_send", "ok"],
    ]);
    expect(JSON.stringify(rows)).not.toContain(BODY_TEXT);
  });

  it("refuses approval without a session, with an MCP bearer token, or without CSRF", async () => {
    const ownerId = await newOwner();
    await linkGoogleAccount(ownerId);
    const { id, token } = await holdOne(confirmEnv, ownerId);
    const fetchPage = pages(confirmEnv);
    const cookie = await ownerCookie(confirmEnv, ownerId);
    const csrf = csrfIn(await (await fetchPage(`/approvals/${id}`, { cookie })).text());
    expect(csrf).not.toBe("");
    const before = runs.length;

    const noSession = await fetchPage(`/approvals/${id}`, {
      method: "POST",
      form: { decision: "approve", csrf },
    });
    expect(noSession.status).toBe(403);
    const bearer = await fetchPage(`/approvals/${id}`, {
      method: "POST",
      bearer: token,
      form: { decision: "approve", csrf },
    });
    expect(bearer.status).toBe(403);
    const noCsrf = await fetchPage(`/approvals/${id}`, {
      method: "POST",
      cookie,
      form: { decision: "approve" },
    });
    expect(noCsrf.status).toBe(403);
    // Another owner's session can neither see nor decide it.
    const other = await newOwner();
    const otherCookie = await ownerCookie(confirmEnv, other);
    expect((await fetchPage(`/approvals/${id}`, { cookie: otherCookie })).status).toBe(404);
    const otherCsrf = csrfIn(
      await (await fetchPage("/accounts/audit", { cookie: otherCookie })).text(),
    );
    const foreign = await fetchPage(`/approvals/${id}`, {
      method: "POST",
      cookie: otherCookie,
      form: { decision: "approve", csrf: otherCsrf },
    });
    expect(foreign.status).toBe(404);

    expect(runs.length).toBe(before);
    expect((await pendingRow(id))?.status).toBe("pending");
  });

  it("an expired action cannot run", async () => {
    const ownerId = await newOwner();
    await linkGoogleAccount(ownerId);
    const { id } = await holdOne(confirmEnv, ownerId);
    await env.DB.prepare(
      "UPDATE pending_actions SET created_at = created_at - 700000, expires_at = expires_at - 700000 WHERE id = ?",
    )
      .bind(id)
      .run();
    const fetchPage = pages(confirmEnv);
    const cookie = await ownerCookie(confirmEnv, ownerId);
    const csrf = csrfIn(await (await fetchPage("/accounts/audit", { cookie })).text());
    const before = runs.length;
    const res = await fetchPage(`/approvals/${id}`, {
      method: "POST",
      cookie,
      form: { decision: "approve", csrf },
    });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("expired");
    expect(runs.length).toBe(before);
    const got = await callTool(ownerId, "full", "get_pending_action", { pendingActionId: id });
    expect(got.json).toMatchObject({ status: "expired" });
  });
});

describe("audit log", () => {
  it("stores addresses and subject, clipped, and never a body", async () => {
    const { ownerId, ctx, a } = await setup();
    await ctx.audit.write({
      tool: "send_message",
      account: a,
      from: "work@example.com",
      to: ["x@example.com"],
      cc: ["y@example.com"],
      subject: "s".repeat(500),
      providerRef: "18c0ffee",
      result: "ok",
      // A caller that passes extra fields cannot get them stored.
      ...({ body: BODY_TEXT, text: BODY_TEXT } as object),
    });
    const row = await first<AuditLogRow>(
      env.DB,
      "SELECT * FROM audit_log WHERE owner_id = ? AND tool = 'send_message'",
      ownerId,
    );
    expect(row).toMatchObject({
      account_id: a.accountId,
      from_addr: "work@example.com",
      to_addrs: '["x@example.com"]',
      cc_addrs: '["y@example.com"]',
      bcc_addrs: null,
      provider_ref: "18c0ffee",
      client_id: "client_test",
      grant_id: "g_test",
      result: "ok",
    });
    expect(row?.subject).toHaveLength(300);
    expect(JSON.stringify(row)).not.toContain(BODY_TEXT);
    expect(Object.keys(row ?? {}).some((k) => /body|text/.test(k))).toBe(false);
  });

  it("a refused sign-in writes a row with the hashed address, never the address", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const google = installFakeGoogle();
    const local = `stranger${randomId("")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")}`;
    const email = `${local}@example.com`;
    const res = await new Browser().signin(google, await mcpClient("full"), {
      email,
      sub: "100000000000000000098",
    });
    expect(res.status).toBe(403);
    const hash = await emailHash(env, email);
    const rows = await all<AuditLogRow>(
      env.DB,
      "SELECT * FROM audit_log WHERE owner_id IS NULL AND tool = 'signin' AND detail LIKE ?",
      `%${hash}%`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe("refused");
    expect(JSON.parse(rows[0]?.detail ?? "")).toEqual({
      reason: "not_allowlisted",
      emailHash: hash,
      country: null,
    });
    expect(JSON.stringify(rows)).not.toContain(local);
  });
});

describe("daily cleanup", () => {
  it("expires pending actions and deletes expired flows, old counters and old audit rows", async () => {
    const now = Math.floor(Date.now() / 1000);
    const ownerId = await newOwner();
    const tag = randomId("")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    const hex = (seed: string) =>
      [...new TextEncoder().encode(seed + tag)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
        .padEnd(64, "0")
        .slice(0, 64);
    const flowOld = hex("old");
    const flowNew = hex("new");
    const db = env.DB;
    const flow = db.prepare(
      "INSERT INTO flow_states (id, kind, payload, binding, expires_at) VALUES (?, 'signin', '{}', 'x', ?)",
    );
    const counter = db.prepare(
      "INSERT INTO rate_counters (bucket, window_start, count) VALUES (?, ?, 1)",
    );
    const audit = db.prepare(
      "INSERT INTO audit_log (at, owner_id, tool, result) VALUES (?, ?, ?, 'ok')",
    );
    const pending = db.prepare(
      `INSERT INTO pending_actions (id, owner_id, tool, params, preview, client_id, grant_id,
         status, created_at, expires_at) VALUES (?, ?, 't', '{}', 'null', 'c', 'g', 'pending', ?, ?)`,
    );
    await db.batch([
      flow.bind(flowOld, now - 1),
      flow.bind(flowNew, now + 600),
      counter.bind(`old:${tag}`, now - 3 * 86400),
      counter.bind(`new:${tag}`, now - 3600),
      audit.bind(now - 366 * 86400, ownerId, `old_${tag}`),
      audit.bind(now - 300 * 86400, ownerId, `new_${tag}`),
      pending.bind(`pa_old${tag}`, ownerId, now - 90000, now - 3600),
      pending.bind(`pa_new${tag}`, ownerId, now, now + 3600),
    ]);

    await cleanup(env, now);

    const flows = await all<{ id: string }>(
      db,
      "SELECT id FROM flow_states WHERE id IN (?, ?)",
      flowOld,
      flowNew,
    );
    expect(flows.map((f) => f.id)).toEqual([flowNew]);
    const counters = await all<{ bucket: string }>(
      db,
      "SELECT bucket FROM rate_counters WHERE bucket IN (?, ?)",
      `old:${tag}`,
      `new:${tag}`,
    );
    expect(counters.map((c) => c.bucket)).toEqual([`new:${tag}`]);
    const kept = await all<{ tool: string }>(
      db,
      "SELECT tool FROM audit_log WHERE owner_id = ?",
      ownerId,
    );
    expect(kept.map((r) => r.tool)).toEqual([`new_${tag}`]);
    expect((await pendingRow(`pa_old${tag}`))?.status).toBe("expired");
    expect((await pendingRow(`pa_new${tag}`))?.status).toBe("pending");
  });
});

describe("/mcp/ro surface", () => {
  it("lists no open-world, send, share, filter or trash tool, and refuses a forged send", async () => {
    const token = await mintToken({ kind: "ro", scopes: SCOPES.ro, ownerId: randomId("o_") });
    const list = await mcpRpc(token, "ro", "tools/list");
    const tools = list.result?.tools as { name: string; annotations?: Record<string, unknown> }[];
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.filter((t) => t.annotations?.openWorldHint === true)).toEqual([]);
    const writes = tools
      .map((t) => t.name)
      .filter((n) => !/^(list|get|search)_/.test(n))
      .filter((n) => /send|reply|forward|share|filter|trash|spam/.test(n));
    expect(writes).toEqual([]);

    const forged = await mcpRpc(token, "ro", "tools/call", {
      name: "send_message",
      arguments: { to: ["x@example.com"], subject: "s", body: "b" },
    });
    expect(forged.error).toEqual({ code: -32602, message: "Tool send_message not found" });
  });
});
