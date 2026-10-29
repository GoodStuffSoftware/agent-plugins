// M17: the filter tools through the real MCP handler and registry, with Google as the route-table
// fake (no network). The shapes in fixtures/google/mail-filters.json follow Gmail's
// users.settings.filters. A filter that forwards is held for owner approval and creates nothing
// until the owner approves it on the approval page.

import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCOPES } from "../src/auth/endpoints";
import { createSession, SESSION_COOKIE } from "../src/auth/session";
import { type AuditLogRow, all, first, type PendingActionRow } from "../src/core/db";
import { createRateLimiter } from "../src/core/ratelimit";
import type { Env } from "../src/env";
import type { AccountRef } from "../src/services/types";
import fixture from "./fixtures/google/mail-filters.json";
import {
  type GoogleCall,
  googleJson,
  installGoogleRoutes,
  linkGoogleAccount,
  newOwner,
  tokenRoute,
} from "./helpers/google";
import { ISSUER, mcpRpc, toolJson } from "./helpers/mcp";
import { mintToken } from "./helpers/tokens";

afterEach(() => vi.restoreAllMocks());

const FWD_ADDRESSES = "https://gmail.googleapis.com/gmail/v1/users/me/settings/forwardingAddresses";
const switchOff = (ownerId: string) =>
  env.DB.prepare("UPDATE owners SET send_kill_switch = 1 WHERE id = ?").bind(ownerId).run();
/** The forwarding addresses Gmail lists for the account. */
const fwdRoute = (status = "accepted", email = "archive@example.net") => ({
  url: FWD_ADDRESSES,
  reply: () =>
    googleJson(200, {
      forwardingAddresses: [{ forwardingEmail: email, verificationStatus: status }],
    }),
});

const FILTERS = "https://gmail.googleapis.com/gmail/v1/users/me/settings/filters";
const TOOLS = ["list_filters", "create_filter", "delete_filter"];

// biome-ignore lint/suspicious/noExplicitAny: the JSON a tool answered, read loosely by the tests
type Json = any;

async function setup(opts: { components?: readonly string[] } = {}) {
  const ownerId = await newOwner();
  const linked = await linkGoogleAccount(ownerId, { label: "work", ...opts });
  return { ownerId, key: `a${linked.row.short_id}`, accessToken: linked.accessToken };
}

/** The tool's JSON answer; a protocol-level refusal (bad input) is plain text and reads as `{}`. */
function parse(result: Parameters<typeof toolJson>[0]) {
  try {
    return toolJson(result);
  } catch {
    return {};
  }
}

async function call(ownerId: string, name: string, args: Record<string, unknown>) {
  const token = await mintToken({ kind: "full", scopes: SCOPES.full, ownerId });
  const { result } = await mcpRpc(token, "full", "tools/call", { name, arguments: args });
  return {
    isError: (result as { isError?: boolean }).isError === true,
    json: parse(result) as Json,
  };
}

const bodyOf = (c: GoogleCall | undefined) => JSON.parse(c?.body || "{}");
const auditRows = (ownerId: string) =>
  all<AuditLogRow>(env.DB, "SELECT * FROM audit_log WHERE owner_id = ? ORDER BY id", ownerId);
const pendingRows = (ownerId: string) =>
  all<PendingActionRow>(
    env.DB,
    "SELECT * FROM pending_actions WHERE owner_id = ? ORDER BY created_at",
    ownerId,
  );

/** GET (or POST a form to) a page of the real worker with the owner's session cookie. */
function pageFetch(cookie: string, path: string, form?: Record<string, string>) {
  return exports.default.fetch(
    new Request(ISSUER + path, {
      method: form ? "POST" : "GET",
      headers: { Cookie: cookie },
      body: form ? new URLSearchParams(form) : undefined,
    }),
  );
}

/** Approves a pending action on its approval page, as the owner (one session for page and form). */
async function approve(ownerId: string, id: string): Promise<Response> {
  const { setCookie } = await createSession(env, ownerId, "owner@example.com");
  const cookie = setCookie.split(";")[0] ?? "";
  expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
  const html = await (await pageFetch(cookie, `/approvals/${id}`)).text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
  expect(csrf).not.toBe("");
  return pageFetch(cookie, `/approvals/${id}`, { decision: "approve", csrf });
}

describe("endpoints and annotations", () => {
  it("the filter tools are on full only, never on ro or admin", async () => {
    const { ownerId } = await setup();
    for (const kind of ["full", "ro", "admin"] as const) {
      const token = await mintToken({ kind, scopes: SCOPES[kind], ownerId });
      const { result } = await mcpRpc(token, kind, "tools/list");
      const tools = (
        result as {
          tools: {
            name: string;
            annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean };
          }[];
        }
      ).tools;
      const names = tools.map((t) => t.name);
      for (const t of TOOLS) expect(names.includes(t)).toBe(kind === "full");
      if (kind === "full") {
        const by = (n: string) => tools.find((t) => t.name === n)?.annotations;
        expect(by("create_filter")?.destructiveHint).toBe(true);
        expect(by("delete_filter")?.destructiveHint).toBe(true);
        expect(by("list_filters")?.readOnlyHint).toBe(true);
      }
    }
  });

  it("a forged create_filter on ro is refused and reaches no Google route", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([]);
    const token = await mintToken({ kind: "ro", scopes: SCOPES.ro, ownerId });
    const { result, error } = await mcpRpc(token, "ro", "tools/call", {
      name: "create_filter",
      arguments: { criteria: { from: "a@example.com" }, action: { addLabelIds: ["Label_1"] } },
    });
    expect(error !== undefined || (result as { isError?: boolean }).isError === true).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("list_filters", () => {
  it("returns prefixed ids, sends fields= and wraps criteria text as untrusted", async () => {
    const { ownerId, key, accessToken } = await setup();
    const calls = installGoogleRoutes([
      { url: FILTERS, reply: () => googleJson(200, fixture.list) },
    ]);
    const { isError, json } = await call(ownerId, "list_filters", {});
    expect(isError).toBe(false);
    expect(calls[0]?.authorization).toBe(`Bearer ${accessToken}`);
    expect(new URL(calls[0]?.url ?? "").searchParams.get("fields")).toBe(
      "filter(id,criteria,action)",
    );
    const [one, two] = json.filters as Json[];
    expect(one.id).toBe(`${key}:ANe1BmgExample1`);
    expect(one.action.addLabelIds).toEqual([`${key}:Label_12`]);
    expect(one.action.removeLabelIds).toEqual([`${key}:INBOX`, `${key}:UNREAD`]);
    expect(one.criteria.hasAttachment).toBe(true);
    // Criteria text is wrapped, and an injected closing tag stays inert inside the block.
    expect(one.criteria.from).toMatch(/^<untrusted-[0-9a-f]+ source="email" account="a\d+"/);
    expect(one.criteria.subject).toContain("&lt;/untrusted>");
    expect(one.criteria.subject.match(/<\/untrusted-/g)).toHaveLength(1);
    expect(two.criteria.query).toContain("list:news.example.com");
    expect(two.criteria.query).toContain("<untrusted-");
    expect(two.criteria.negatedQuery).toContain("<untrusted-");
    expect(two.criteria.size).toBe(5000000);
    expect(two.criteria.sizeComparison).toBe("larger");
    // The forwarding address is an address, not mail text.
    expect(two.action.forward).toBe("archive@example.net");
  });

  it("answers an empty list when Gmail has no filter", async () => {
    const { ownerId } = await setup();
    installGoogleRoutes([{ url: FILTERS, reply: () => googleJson(200, {}) }]);
    const { isError, json } = await call(ownerId, "list_filters", {});
    expect(isError).toBe(false);
    expect(json.filters).toEqual([]);
  });

  it("maps 403 rate limit, 429 and 404, and refreshes once on a 401", async () => {
    const { ownerId } = await setup();
    const reply =
      (status: number, body: unknown = {}) =>
      () =>
        googleJson(status, body);
    installGoogleRoutes([{ url: FILTERS, reply: reply(429) }]);
    expect((await call(ownerId, "list_filters", {})).json.error.code).toBe("rate_limited");
    vi.restoreAllMocks();
    installGoogleRoutes([
      {
        url: FILTERS,
        reply: reply(403, {
          error: {
            code: 403,
            errors: [{ reason: "rateLimitExceeded" }],
            status: "RESOURCE_EXHAUSTED",
          },
        }),
      },
    ]);
    expect((await call(ownerId, "list_filters", {})).json.error.code).toBe("rate_limited");
    vi.restoreAllMocks();
    installGoogleRoutes([{ url: FILTERS, reply: reply(404) }]);
    expect((await call(ownerId, "list_filters", {})).json.error.code).toBe("not_found");
    vi.restoreAllMocks();
    installGoogleRoutes([
      { url: FILTERS, reply: (_r, n) => (n === 0 ? googleJson(401, {}) : googleJson(200, {})) },
      tokenRoute("ya29.fresh"),
    ]);
    expect((await call(ownerId, "list_filters", {})).isError).toBe(false);
  });

  it("answers component_disabled when mail is off", async () => {
    const { ownerId } = await setup({ components: ["calendar"] });
    const calls = installGoogleRoutes([]);
    const { isError, json } = await call(ownerId, "list_filters", {});
    expect(isError).toBe(true);
    expect(json.error.code).toBe("component_disabled");
    expect(calls).toHaveLength(0);
  });
});

describe("create_filter without forwarding", () => {
  it("creates a label-only filter directly, with bare label ids to Google and prefixed ones back", async () => {
    const { ownerId, key } = await setup();
    const calls = installGoogleRoutes([
      { method: "POST", url: FILTERS, reply: () => googleJson(200, fixture.createdLabelOnly) },
    ]);
    const { isError, json } = await call(ownerId, "create_filter", {
      criteria: { from: "news@example.com" },
      action: { addLabelIds: [`${key}:Label_7`], removeLabelIds: ["INBOX"] },
    });
    expect(isError).toBe(false);
    // Created at once: no pending action.
    expect(json.status).toBeUndefined();
    expect(await pendingRows(ownerId)).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0])).toEqual({
      criteria: { from: "news@example.com" },
      action: { addLabelIds: ["Label_7"], removeLabelIds: ["INBOX"] },
    });
    expect(new URL(calls[0]?.url ?? "").searchParams.get("fields")).toBe("id,criteria,action");
    expect(json.id).toBe(`${key}:ANe1BmgCreated1`);
    expect(json.action.addLabelIds).toEqual([`${key}:Label_7`]);
    expect(json.action.removeLabelIds).toEqual([`${key}:INBOX`]);
    expect(json.criteria.from).toContain("<untrusted-");

    const rows = await auditRows(ownerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool: "create_filter",
      result: "ok",
      provider_ref: "ANe1BmgCreated1",
      to_addrs: null,
    });
  });

  it("refuses label ids from another account and incomplete filters before calling Google", async () => {
    const { ownerId, key } = await setup();
    const calls = installGoogleRoutes([]);
    const other = await call(ownerId, "create_filter", {
      criteria: { from: "a@example.com" },
      action: { addLabelIds: [`${key}:Label_1`, "a999:Label_2"] },
    });
    expect(other.json.error.code).toBe("invalid_argument");
    const noCriteria = await call(ownerId, "create_filter", {
      criteria: {},
      action: { addLabelIds: ["Label_1"] },
    });
    expect(noCriteria.json.error.code).toBe("invalid_argument");
    const noAction = await call(ownerId, "create_filter", {
      criteria: { from: "a@example.com" },
      action: {},
    });
    expect(noAction.json.error.code).toBe("invalid_argument");
    const lonelySize = await call(ownerId, "create_filter", {
      criteria: { size: 100 },
      action: { addLabelIds: ["Label_1"] },
    });
    expect(lonelySize.json.error.code).toBe("invalid_argument");
    // hasAttachment: false is not a criterion: it would match all mail.
    const noRealCriterion = await call(ownerId, "create_filter", {
      criteria: { hasAttachment: false },
      action: { removeLabelIds: ["INBOX"] },
    });
    expect(noRealCriterion.json.error.code).toBe("invalid_argument");
    expect(calls).toHaveLength(0);
    expect(await pendingRows(ownerId)).toHaveLength(0);
  });

  it("writes an error audit row and keeps Google's error code when Gmail refuses", async () => {
    const { ownerId } = await setup();
    installGoogleRoutes([
      { method: "POST", url: FILTERS, reply: () => googleJson(400, { error: { code: 400 } }) },
    ]);
    const { isError, json } = await call(ownerId, "create_filter", {
      criteria: { from: "a@example.com" },
      action: { addLabelIds: ["Label_1"] },
    });
    expect(isError).toBe(true);
    expect(json.error.code).toBe("invalid_argument");
    // A label-only filter keeps the generic refusal: no talk of forwarding addresses.
    expect(json.error.message).not.toContain("forwarding");
    const rows = await auditRows(ownerId);
    expect(rows.map((r) => [r.tool, r.result])).toEqual([["create_filter", "error"]]);
    expect(rows[0]?.detail).toContain("invalid_argument");
  });
});

describe("create_filter that forwards", () => {
  const forwardArgs = {
    criteria: { from: "boss@example.com" },
    action: { forward: "archive@example.net" },
  };

  it("is held for owner approval and creates nothing", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([fwdRoute()]);
    const { isError, json } = await call(ownerId, "create_filter", forwardArgs);
    expect(isError).toBe(false);
    expect(json).toMatchObject({
      status: "pending_approval",
      pendingActionId: expect.stringMatching(/^pa_/),
      approvalUrl: expect.stringContaining("/approvals/pa_"),
    });
    expect(json.preview.account).toBe("work@example.com");
    expect(json.preview.summary).toContain("archive@example.net");
    expect(json.preview.action.forward).toBe("archive@example.net");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    const rows = await pendingRows(ownerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: "create_filter", status: "pending" });
    expect(await auditRows(ownerId)).toHaveLength(0);
  });

  it("holds a forward filter that also labels, and previews bare label ids", async () => {
    const { ownerId, key } = await setup();
    const calls = installGoogleRoutes([fwdRoute()]);
    const { json } = await call(ownerId, "create_filter", {
      criteria: { query: "from:boss@example.com" },
      action: { forward: "archive@example.net", addLabelIds: [`${key}:Label_3`] },
    });
    expect(json.status).toBe("pending_approval");
    expect(json.preview.action.addLabelIds).toEqual(["Label_3"]);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("an invalid forwarding address is refused before it is held", async () => {
    const { ownerId } = await setup();
    const res = await call(ownerId, "create_filter", {
      criteria: { from: "boss@example.com" },
      action: { forward: "not an address" },
    });
    expect(res.isError).toBe(true);
    expect(await pendingRows(ownerId)).toHaveLength(0);
  });

  it("creates the filter once the owner approves, and audits the forwarding address", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([
      fwdRoute(),
      { method: "POST", url: FILTERS, reply: () => googleJson(200, fixture.createdForward) },
    ]);
    const held = await call(ownerId, "create_filter", forwardArgs);
    const id = held.json.pendingActionId as string;
    const posts = () => calls.filter((c) => c.method === "POST");
    expect(posts()).toHaveLength(0);

    const res = await approve(ownerId, id);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("The action ran");
    expect(posts()).toHaveLength(1);
    expect(bodyOf(posts()[0])).toEqual({
      criteria: { from: "boss@example.com" },
      action: { forward: "archive@example.net" },
    });

    const got = await call(ownerId, "get_pending_action", { pendingActionId: id });
    expect(got.json).toMatchObject({ status: "executed" });
    expect(got.json.result.action.forward).toBe("archive@example.net");

    const rows = await auditRows(ownerId);
    expect(rows.map((r) => [r.tool, r.result])).toEqual([
      ["create_filter", "approved"],
      ["create_filter", "ok"],
    ]);
    expect(rows[1]?.to_addrs).toBe(JSON.stringify(["archive@example.net"]));
    expect(rows[1]?.provider_ref).toBe("ANe1BmgCreated2");
  });

  it("maps Gmail's refusal of an unverified forwarding address and audits the failure", async () => {
    const { ownerId } = await setup();
    installGoogleRoutes([
      fwdRoute(),
      {
        method: "POST",
        url: FILTERS,
        reply: () => googleJson(400, fixture.invalidForwardingAddress),
      },
    ]);
    const held = await call(ownerId, "create_filter", forwardArgs);
    const id = held.json.pendingActionId as string;
    const res = await approve(ownerId, id);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("verified forwarding address");

    const got = await call(ownerId, "get_pending_action", { pendingActionId: id });
    expect(got.json.status).toBe("failed");
    expect(got.json.result.error.code).toBe("invalid_argument");
    expect(got.json.result.error.message).toContain("verified forwarding address");
    expect(JSON.stringify(got.json)).not.toContain("Invalid forwarding address");

    const rows = await auditRows(ownerId);
    expect(rows.map((r) => [r.tool, r.result])).toEqual([
      ["create_filter", "approved"],
      ["create_filter", "error"],
    ]);
    const stored = await first<PendingActionRow>(
      env.DB,
      "SELECT * FROM pending_actions WHERE id = ?",
      id,
    );
    expect(stored?.status).toBe("failed");
  });
});

describe("filter guards (M17b)", () => {
  const forwardArgs = {
    criteria: { from: "boss@example.com" },
    action: { forward: "archive@example.net" },
  };
  const post = (calls: GoogleCall[]) => calls.filter((c) => c.method === "POST");
  const created = {
    method: "POST",
    url: FILTERS,
    reply: () => googleJson(200, fixture.createdLabelOnly),
  };

  it("holds a filter that adds TRASH or SPAM, or removes INBOX together with one", async () => {
    const { ownerId, key } = await setup();
    const calls = installGoogleRoutes([]);
    for (const action of [
      { addLabelIds: ["TRASH"] },
      { addLabelIds: [`${key}:SPAM`] },
      { removeLabelIds: ["INBOX", "TRASH"] },
    ]) {
      const { json } = await call(ownerId, "create_filter", {
        criteria: { from: "news@example.com" },
        action,
      });
      expect(json.status).toBe("pending_approval");
    }
    expect(calls).toHaveLength(0);
    expect(await pendingRows(ownerId)).toHaveLength(3);
  });

  it("creates a filter that archives or adds a user label directly", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([created]);
    for (const action of [{ removeLabelIds: ["INBOX"] }, { addLabelIds: ["Label_7"] }]) {
      const { json } = await call(ownerId, "create_filter", {
        criteria: { from: "news@example.com" },
        action,
      });
      expect(json.id).toBeDefined();
    }
    expect(post(calls)).toHaveLength(2);
    expect(await pendingRows(ownerId)).toHaveLength(0);
  });

  it("a held trash filter is created once the owner approves it", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([created]);
    const held = await call(ownerId, "create_filter", {
      criteria: { from: "news@example.com" },
      action: { addLabelIds: ["TRASH"] },
    });
    expect(post(calls)).toHaveLength(0);
    await approve(ownerId, held.json.pendingActionId);
    expect(post(calls)).toHaveLength(1);
    expect(bodyOf(post(calls)[0]).action).toEqual({ addLabelIds: ["TRASH"] });
  });

  it("refuses a forward filter while the owner has sending off, as checkSend does, queues nothing", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([fwdRoute()]);
    await switchOff(ownerId);
    const res = await call(ownerId, "create_filter", forwardArgs);
    expect(res.isError).toBe(true);
    expect(res.json.error.code).toBe("send_disabled");
    expect(res.json.error.message).toContain("Sending is switched off");
    expect(res.json.error.message).toContain(`${ISSUER}/accounts`);
    expect(await pendingRows(ownerId)).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("assertSendEnabled refuses with checkSend's message when SEND_ENABLED is not true", async () => {
    const limits = createRateLimiter({
      env: { ...env, SEND_ENABLED: "false" } as Env,
      grant: { clientId: "c", grantId: "g", scopes: [] },
      now: () => 0,
    });
    const err = await limits.assertSendEnabled({} as AccountRef).catch((e) => e);
    expect(err.code).toBe("send_disabled");
    expect(err.message).toContain("SEND_ENABLED");
  });

  it("a label-only filter does not depend on the sending switch", async () => {
    const { ownerId } = await setup();
    installGoogleRoutes([created]);
    const { isError } = await call(ownerId, "create_filter", {
      criteria: { from: "news@example.com" },
      action: { addLabelIds: ["Label_7"] },
    });
    expect(isError).toBe(false);
  });

  it("re-checks the sending switch when the owner approves, refuses and audits it", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([
      fwdRoute(),
      { method: "POST", url: FILTERS, reply: () => googleJson(200, fixture.createdForward) },
    ]);
    const held = await call(ownerId, "create_filter", forwardArgs);
    const id = held.json.pendingActionId as string;
    await switchOff(ownerId);
    const res = await approve(ownerId, id);
    expect(res.status).toBe(200);
    expect(post(calls)).toHaveLength(0);
    const got = await call(ownerId, "get_pending_action", { pendingActionId: id });
    expect(got.json.status).toBe("failed");
    expect(got.json.result.error.code).toBe("send_disabled");
    const rows = await auditRows(ownerId);
    expect(rows.map((r) => [r.tool, r.result])).toEqual([
      ["create_filter", "approved"],
      ["create_filter", "error"],
    ]);
    expect(rows[1]?.detail).toContain("send_disabled");
  });

  it("refuses a forward to an address that is not an accepted forwarding address, queues nothing", async () => {
    const { ownerId } = await setup();
    for (const route of [
      fwdRoute("pending"),
      fwdRoute("accepted", "other@example.net"),
      { url: FWD_ADDRESSES, reply: () => googleJson(200, {}) },
    ]) {
      const calls = installGoogleRoutes([route]);
      const res = await call(ownerId, "create_filter", forwardArgs);
      expect(res.isError).toBe(true);
      expect(res.json.error.code).toBe("invalid_argument");
      expect(res.json.error.message).toContain("verified forwarding address");
      expect(post(calls)).toHaveLength(0);
      expect(calls.some((c) => c.url.startsWith(FWD_ADDRESSES))).toBe(true);
      vi.restoreAllMocks();
    }
    expect(await pendingRows(ownerId)).toHaveLength(0);
  });

  it("holds a forward to an accepted address and never adds a forwarding address", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([fwdRoute("accepted", "Archive@Example.net")]);
    const { json } = await call(ownerId, "create_filter", forwardArgs);
    expect(json.status).toBe("pending_approval");
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });
});

describe("delete_filter", () => {
  it("deletes by prefixed id with the bare id in the URL, and audits it", async () => {
    const { ownerId, key } = await setup();
    const calls = installGoogleRoutes([
      {
        method: "DELETE",
        url: `${FILTERS}/ANe1BmgExample1`,
        reply: () => new Response(null, { status: 204 }),
      },
    ]);
    const { isError, json } = await call(ownerId, "delete_filter", {
      filterId: `${key}:ANe1BmgExample1`,
    });
    expect(isError).toBe(false);
    expect(json).toEqual({ filterId: `${key}:ANe1BmgExample1`, deleted: true });
    expect(calls).toHaveLength(1);
    const rows = await auditRows(ownerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool: "delete_filter",
      result: "ok",
      provider_ref: "ANe1BmgExample1",
    });
  });

  it("accepts a bare id with the default account, and maps 404 to not_found with an error audit row", async () => {
    const { ownerId } = await setup();
    installGoogleRoutes([
      {
        method: "DELETE",
        url: `${FILTERS}/gone`,
        reply: () => googleJson(404, { error: { code: 404 } }),
      },
    ]);
    const { isError, json } = await call(ownerId, "delete_filter", { filterId: "gone" });
    expect(isError).toBe(true);
    expect(json.error.code).toBe("not_found");
    const rows = await auditRows(ownerId);
    expect(rows.map((r) => [r.tool, r.result])).toEqual([["delete_filter", "error"]]);
  });

  it("refuses an id that could reshape the URL", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([]);
    for (const filterId of ["..", ".", "a/b", "x?y"]) {
      expect((await call(ownerId, "delete_filter", { filterId })).isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses an id of one account with a selector naming another", async () => {
    const { ownerId, key } = await setup();
    await linkGoogleAccount(ownerId, { label: "home" });
    const calls = installGoogleRoutes([]);
    const { json } = await call(ownerId, "delete_filter", {
      filterId: `${key}:abc`,
      account: "home",
    });
    expect(json.error.code).toBe("invalid_argument");
    expect(calls).toHaveLength(0);
  });
});
