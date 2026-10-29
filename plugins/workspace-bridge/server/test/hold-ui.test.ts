// "Hold sends to new recipients", part 2: the approval page's buttons (approve once, always allow
// an address or a domain, reject), the allow list on `/accounts`, the fast notice email of a held
// action and the 7-day expiry. Every POST needs the owner's session and CSRF token. Google is the
// route-table fake; the notice goes out through the same fake Gmail send.

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCOPES } from "../src/auth/endpoints";
import { mcpHandler } from "../src/auth/mcp-factory";
import { createSession, SESSION_COOKIE } from "../src/auth/session";
import { all, first, incrementCounter, nowSeconds, type PendingActionRow } from "../src/core/db";
import { NOTICE_TOOL, NOTICES_PER_DAY, noticeText } from "../src/core/held-notice";
import { addSendAllow, listSendAllow } from "../src/core/send-allow";
import { config, type Env } from "../src/env";
import { warmupRetry } from "../src/providers/google/contacts";
import { compileRegistry } from "../src/registry/compile";
import { FAMILIES } from "../src/tools";
import { accountsRoutes } from "../src/web/accounts";
import { guardrailsRoutes } from "../src/web/guardrails";
import fx from "./fixtures/google/mail-send.json";
import {
  type GoogleCall,
  type GoogleRoute,
  googleJson,
  installGoogleRoutes,
  linkGoogleAccount,
  newOwner,
} from "./helpers/google";
import { ISSUER, mcpRequest, parseMcp, toolJson } from "./helpers/mcp";
import { mintToken } from "./helpers/tokens";

const registry = compileRegistry(FAMILIES);

const UPLOAD = "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send";
const BATCH = "https://gmail.googleapis.com/batch/gmail/v1";
const SEARCH = "https://people.googleapis.com/v1/people:searchContacts";
const OTHER = "https://people.googleapis.com/v1/otherContacts:search";
const NOTIFY = "me@owner.example";

afterEach(() => {
  vi.restoreAllMocks();
  warmupRetry.ms = 2000;
});

// biome-ignore lint/suspicious/noExplicitAny: the JSON a tool answered, read loosely by the tests
type Json = any;

const withEnv = (overrides: Partial<Env>): Env => ({ ...env, ...overrides }) as Env;
/** Sending on, new recipients held; `notify` is where the held-action email goes ("" for nowhere). */
const E = (notify: string = "", contact = ""): Env =>
  withEnv({
    SEND_ENABLED: "true",
    SEND_APPROVAL_MODE: "new_recipients",
    NOTIFY_EMAIL: notify,
    OWNER_CONTACT: contact,
  });

async function setup(label = "work") {
  warmupRetry.ms = 0;
  const ownerId = await newOwner();
  const linked = await linkGoogleAccount(ownerId, {
    label,
    components: ["mail", "mail.send", "calendar", "contacts"],
  });
  await env.DB.prepare("UPDATE accounts SET send_as_fetched_at = ? WHERE id = ?")
    .bind(nowSeconds(), linked.row.id)
    .run();
  return { ownerId, accountId: linked.row.id, address: linked.row.address };
}

async function call(e: Env, ownerId: string, name: string, args: Record<string, unknown>) {
  const token = await mintToken({ kind: "full", scopes: SCOPES.full, ownerId });
  const exec = Object.assign(createExecutionContext(), {
    props: { ownerId },
    auth: {
      token,
      audience: `${ISSUER}/mcp`,
      scope: [...SCOPES.full],
      clientId: "client_test",
      userId: ownerId,
    },
  });
  const res = await mcpHandler("full", ISSUER, registry)(
    mcpRequest(undefined, "full", "tools/call", { name, arguments: args }),
    e,
    exec,
  );
  await waitOnExecutionContext(exec);
  const { result } = await parseMcp(res);
  return { json: toolJson(result) as Json };
}

const sendRoute = (reply?: () => Response): GoogleRoute => ({
  method: "POST",
  url: UPLOAD,
  reply: reply ?? (() => googleJson(200, fx.sent)),
});

/** Gmail's batch endpoint: no address has ever been sent to. */
const batchRoute = (): GoogleRoute => ({
  method: "POST",
  url: BATCH,
  reply: async (req) => {
    const body = await req.text();
    const parts = [...body.matchAll(/Content-ID: <(s\d+)>\r\n\r\nGET /g)].map(
      (m) =>
        `--resp\r\nContent-Type: application/http\r\nContent-ID: <response-${m[1]}>\r\n\r\n` +
        `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{}\r\n`,
    );
    return new Response(`${parts.join("")}--resp--\r\n`, {
      status: 200,
      headers: { "Content-Type": "multipart/mixed; boundary=resp" },
    });
  },
});

const emptyContacts = (url: string): GoogleRoute => ({
  url,
  reply: () => googleJson(200, { results: [] }),
});

const routes = (send: GoogleRoute = sendRoute()): GoogleRoute[] => [
  batchRoute(),
  emptyContacts(SEARCH),
  emptyContacts(OTHER),
  send,
];

const sendCalls = (calls: GoogleCall[]) => calls.filter((c) => c.url.startsWith(UPLOAD));

const args = (to: string[], extra: Record<string, unknown> = {}) => ({
  to,
  subject: "Quarterly numbers",
  body: "SECRET-BODY-TEXT",
  ...extra,
});

/** Holds a send for `to` and returns the pending action id. */
async function hold(
  e: Env,
  ownerId: string,
  to: string[],
  extra: Record<string, unknown> = {},
): Promise<string> {
  const res = await call(e, ownerId, "send_message", args(to, extra));
  expect(res.json.status).toBe("pending_approval");
  return res.json.pendingActionId as string;
}

const pending = (id: string) =>
  first<PendingActionRow>(env.DB, "SELECT * FROM pending_actions WHERE id = ?", id);

const allowOf = (ownerId: string, accountId: string) =>
  listSendAllow(env.DB, ownerId, accountId).then((rows) =>
    rows.map((r) => `${r.kind}:${r.value}`).sort(),
  );

const noticeRows = (accountId: string) =>
  all<{ tool: string; result: string; to_addrs: string | null; detail: string | null }>(
    env.DB,
    "SELECT tool, result, to_addrs, detail FROM audit_log WHERE account_id = ? AND tool = ?",
    accountId,
    NOTICE_TOOL,
  );

/** The owner's browser: a session cookie and the CSRF token, against the accounts and approvals pages. */
async function owner(e: Env, ownerId: string) {
  const app = new Hono<{ Bindings: Env }>()
    .route("/accounts", accountsRoutes)
    .route("/", guardrailsRoutes(registry));
  const { setCookie } = await createSession(e, ownerId, "owner@example.com");
  const cookie = setCookie.split(";")[0] ?? "";
  expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
  const fetchPath = async (
    path: string,
    init: { form?: Record<string, string>; env?: Env; cookie?: boolean } = {},
  ) => {
    const exec = createExecutionContext();
    const res = await app.fetch(
      new Request(`${ISSUER}${path}`, {
        method: init.form ? "POST" : "GET",
        headers: init.cookie === false ? {} : { Cookie: cookie },
        body: init.form ? new URLSearchParams(init.form) : undefined,
        redirect: "manual",
      }),
      init.env ?? e,
      exec,
    );
    await waitOnExecutionContext(exec);
    return res;
  };
  const csrfOf = async (path: string) =>
    (await (await fetchPath(path)).text()).match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
  return {
    get: async (path: string) => (await fetchPath(path)).text(),
    /** A POST with the page's CSRF token (`csrf` overrides it; "" sends none). */
    post: async (
      path: string,
      form: Record<string, string>,
      opts: { page?: string; csrf?: string; env?: Env } = {},
    ) => {
      const token = opts.csrf ?? (await csrfOf(opts.page ?? path));
      return fetchPath(path, {
        form: token === "" ? form : { ...form, csrf: token },
        env: opts.env,
      });
    },
    postNoSession: (path: string, form: Record<string, string>) =>
      fetchPath(path, { form, cookie: false }),
  };
}

const approvalPath = (id: string) => `/approvals/${id}`;

describe("the approval buttons", () => {
  it("approve once sends, adds no allow-list entry and records the recipients as known", async () => {
    const { ownerId, accountId } = await setup();
    const e = E();
    installGoogleRoutes(routes());
    const id = await hold(e, ownerId, ["fresh@example.org"]);
    const browser = await owner(e, ownerId);
    const calls = installGoogleRoutes(routes());
    const res = await browser.post(approvalPath(id), { decision: "approve" });
    expect(res.status).toBeLessThan(400);
    expect((await pending(id))?.status).toBe("executed");
    expect(sendCalls(calls)).toHaveLength(1);
    expect(await allowOf(ownerId, accountId)).toEqual([]);
    const known = await first(
      env.DB,
      "SELECT address FROM known_recipients WHERE account_id = ? AND address = ?",
      accountId,
      "fresh@example.org",
    );
    expect(known).not.toBeNull();
  });

  it("shows the new recipients and each button for a single address", async () => {
    const { ownerId } = await setup();
    const e = E();
    installGoogleRoutes(routes());
    const id = await hold(e, ownerId, ["fresh@acme-corp.example"]);
    const page = await (await owner(e, ownerId)).get(approvalPath(id));
    expect(page).toContain("fresh@acme-corp.example");
    expect(page).toContain("Approve once");
    expect(page).toContain("Approve and always allow fresh@acme-corp.example");
    expect(page).toContain("Approve and always allow @acme-corp.example");
    expect(page).toContain(">Reject<");
  });

  it("approve and always allow an address writes it to the held send's account only", async () => {
    const a = await setup("alpha");
    const b = await linkGoogleAccount(a.ownerId, {
      label: "beta",
      components: ["mail", "mail.send"],
    });
    const e = E();
    installGoogleRoutes(routes());
    const id = await hold(e, a.ownerId, ["fresh@example.org"], { account: "alpha" });
    const browser = await owner(e, a.ownerId);
    const calls = installGoogleRoutes(routes());
    const res = await browser.post(approvalPath(id), {
      decision: "approve_allow",
      allow: "fresh@example.org",
    });
    expect(res.status).toBeLessThan(400);
    expect((await pending(id))?.status).toBe("executed");
    expect(sendCalls(calls)).toHaveLength(1);
    expect(await allowOf(a.ownerId, a.accountId)).toEqual(["address:fresh@example.org"]);
    expect(await allowOf(a.ownerId, b.row.id)).toEqual([]);
    const audit = await first<{ detail: string }>(
      env.DB,
      "SELECT detail FROM audit_log WHERE account_id = ? AND tool = 'send_allow'",
      a.accountId,
    );
    expect(audit?.detail).toContain("address fresh@example.org");
  });

  it("with several new recipients, always allows only the checked ones", async () => {
    const { ownerId, accountId } = await setup();
    const e = E();
    installGoogleRoutes(routes());
    const id = await hold(e, ownerId, ["one@example.org", "two@example.net"]);
    const browser = await owner(e, ownerId);
    const page = await browser.get(approvalPath(id));
    expect(page).toContain('type="checkbox" name="allow" value="one@example.org"');
    expect(page).toContain("Approve and always allow the checked addresses");
    installGoogleRoutes(routes());
    const res = await browser.post(approvalPath(id), {
      decision: "approve_allow",
      allow: "two@example.net",
    });
    expect(res.status).toBeLessThan(400);
    expect(await allowOf(ownerId, accountId)).toEqual(["address:two@example.net"]);
    expect((await pending(id))?.status).toBe("executed");
  });

  it("refuses to allow an address that is not one of the held send's new recipients", async () => {
    const { ownerId, accountId } = await setup();
    const e = E();
    installGoogleRoutes(routes());
    const id = await hold(e, ownerId, ["fresh@example.org"]);
    const browser = await owner(e, ownerId);
    const calls = installGoogleRoutes(routes());
    for (const form of [
      { decision: "approve_allow", allow: "other@example.org" },
      { decision: "approve_allow" },
      { decision: "approve_domain:elsewhere.example" },
    ] as Record<string, string>[]) {
      const res = await browser.post(approvalPath(id), form, { page: approvalPath(id) });
      expect(res.status).toBe(400);
    }
    expect((await pending(id))?.status).toBe("pending");
    expect(await allowOf(ownerId, accountId)).toEqual([]);
    expect(sendCalls(calls)).toHaveLength(0);
  });

  it("approve and always allow @domain writes the exact domain to the account", async () => {
    const { ownerId, accountId } = await setup();
    const e = E();
    installGoogleRoutes(routes());
    const id = await hold(e, ownerId, ["fresh@acme-corp.example"]);
    const browser = await owner(e, ownerId);
    const calls = installGoogleRoutes(routes());
    const res = await browser.post(approvalPath(id), {
      decision: "approve_domain:acme-corp.example",
    });
    expect(res.status).toBeLessThan(400);
    expect((await pending(id))?.status).toBe("executed");
    expect(sendCalls(calls)).toHaveLength(1);
    expect(await allowOf(ownerId, accountId)).toEqual(["domain:acme-corp.example"]);
  });

  it("offers no domain button for a public mail provider, and the server refuses it too", async () => {
    const { ownerId, accountId } = await setup();
    const e = E();
    installGoogleRoutes(routes());
    const id = await hold(e, ownerId, ["fresh@gmail.com"]);
    const browser = await owner(e, ownerId);
    const page = await browser.get(approvalPath(id));
    expect(page).toContain("Approve and always allow fresh@gmail.com");
    expect(page).not.toContain("always allow @gmail.com");
    expect(page).not.toContain("approve_domain");
    const calls = installGoogleRoutes(routes());
    const res = await browser.post(approvalPath(id), { decision: "approve_domain:gmail.com" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("public mail provider");
    expect((await pending(id))?.status).toBe("pending");
    expect(await allowOf(ownerId, accountId)).toEqual([]);
    expect(sendCalls(calls)).toHaveLength(0);
  });

  it("reject sends nothing and allows nothing", async () => {
    const { ownerId, accountId } = await setup();
    const e = E();
    installGoogleRoutes(routes());
    const id = await hold(e, ownerId, ["fresh@example.org"]);
    const browser = await owner(e, ownerId);
    const calls = installGoogleRoutes(routes());
    const res = await browser.post(approvalPath(id), { decision: "reject" });
    expect(res.status).toBe(200);
    expect((await pending(id))?.status).toBe("rejected");
    expect(sendCalls(calls)).toHaveLength(0);
    expect(await allowOf(ownerId, accountId)).toEqual([]);
  });

  it("repeats every check on approval: sending off after the hold fails the run", async () => {
    const { ownerId } = await setup();
    const e = E();
    installGoogleRoutes(routes());
    const id = await hold(e, ownerId, ["fresh@example.org"]);
    const browser = await owner(e, ownerId);
    const calls = installGoogleRoutes(routes());
    await browser.post(
      approvalPath(id),
      { decision: "approve" },
      { env: withEnv({ SEND_ENABLED: "false", SEND_APPROVAL_MODE: "new_recipients" }) },
    );
    expect((await pending(id))?.status).toBe("failed");
    expect(sendCalls(calls)).toHaveLength(0);
  });

  it("needs the session and a valid CSRF token on every button", async () => {
    const { ownerId, accountId } = await setup();
    const e = E();
    installGoogleRoutes(routes());
    const id = await hold(e, ownerId, ["fresh@acme-corp.example"]);
    const browser = await owner(e, ownerId);
    const calls = installGoogleRoutes(routes());
    for (const form of [
      { decision: "approve" },
      { decision: "approve_allow", allow: "fresh@acme-corp.example" },
      { decision: "approve_domain:acme-corp.example" },
      { decision: "reject" },
    ] as Record<string, string>[]) {
      const none = await browser.post(approvalPath(id), form, { csrf: "", page: approvalPath(id) });
      expect(none.status).toBe(403);
      const wrong = await browser.post(approvalPath(id), form, { csrf: "forged" });
      expect(wrong.status).toBe(403);
      const noSession = await browser.postNoSession(approvalPath(id), form);
      expect(noSession.status).toBe(403);
    }
    expect((await pending(id))?.status).toBe("pending");
    expect(await allowOf(ownerId, accountId)).toEqual([]);
    expect(sendCalls(calls)).toHaveLength(0);
  });

  it("cannot approve an expired item, and the page says expired", async () => {
    const { ownerId, accountId } = await setup();
    const e = E();
    installGoogleRoutes(routes());
    const id = await hold(e, ownerId, ["fresh@acme-corp.example"]);
    // The stored expiry is seven days after the hold.
    const row = await pending(id);
    expect((row?.expires_at ?? 0) - (row?.created_at ?? 0)).toBe(7 * 86400);
    await env.DB.prepare("UPDATE pending_actions SET expires_at = ? WHERE id = ?")
      .bind(nowSeconds() - 1, id)
      .run();
    const browser = await owner(e, ownerId);
    const page = await browser.get(approvalPath(id));
    expect(page).toContain("<dd>expired</dd>");
    expect(page).not.toContain("Approve once");
    const calls = installGoogleRoutes(routes());
    for (const form of [
      { decision: "approve" },
      { decision: "approve_allow", allow: "fresh@acme-corp.example" },
      { decision: "approve_domain:acme-corp.example" },
    ] as Record<string, string>[]) {
      const res = await browser.post(approvalPath(id), form, { page: "/accounts" });
      expect(res.status).toBe(409);
    }
    expect(sendCalls(calls)).toHaveLength(0);
    expect(await allowOf(ownerId, accountId)).toEqual([]);
  });

  it("escapes HTML-special recipients, subject and arguments on the page", async () => {
    const { ownerId } = await setup();
    const e = E();
    installGoogleRoutes(routes());
    const id = await hold(e, ownerId, ["fresh@example.org"]);
    const preview = JSON.stringify({
      subject: "<script>alert(1)</script>",
      newRecipients: ['"><img src=x onerror=alert(1)>@evil.example', "a&b@evil.example"],
    });
    await env.DB.prepare("UPDATE pending_actions SET preview = ? WHERE id = ?")
      .bind(preview, id)
      .run();
    const page = await (await owner(e, ownerId)).get(approvalPath(id));
    expect(page).not.toContain("<script>alert(1)");
    expect(page).not.toContain("<img src=x");
    expect(page).toContain("&lt;img src=x onerror=alert(1)&gt;@evil.example");
    expect(page).toContain("a&amp;b@evil.example");
  });
});

describe("the allow list on /accounts", () => {
  it("lists a mailbox's entries with their added time and a Remove button", async () => {
    const { ownerId, accountId, address } = await setup();
    await addSendAllow(env.DB, ownerId, accountId, "address", "bob@example.org");
    await addSendAllow(env.DB, ownerId, accountId, "domain", "acme-corp.example");
    const page = await (await owner(E(), ownerId)).get("/accounts");
    expect(page).toContain("Allowed recipients");
    expect(page).toContain(address);
    expect(page).toContain("bob@example.org");
    expect(page).toContain("@acme-corp.example");
    expect(page).toMatch(/<td>\d{4}-\d\d-\d\dT[\d:.]+Z<\/td>/);
    expect(page).toContain('action="/accounts/allow/remove"');
    expect(page).toContain(">Remove<");
  });

  it("adds an address or a domain by hand, and Remove deletes it", async () => {
    const { ownerId, accountId } = await setup();
    const browser = await owner(E(), ownerId);
    const add = (kind: string, value: string) =>
      browser.post("/accounts/allow", { account: accountId, kind, value }, { page: "/accounts" });
    expect((await add("address", " Bob@Example.org ")).status).toBe(303);
    expect((await add("domain", "@Acme-Corp.example")).status).toBe(303);
    expect(await allowOf(ownerId, accountId)).toEqual([
      "address:bob@example.org",
      "domain:acme-corp.example",
    ]);
    const removed = await browser.post(
      "/accounts/allow/remove",
      { account: accountId, kind: "address", value: "bob@example.org" },
      { page: "/accounts" },
    );
    expect(removed.status).toBe(303);
    expect(await allowOf(ownerId, accountId)).toEqual(["domain:acme-corp.example"]);
    const audit = await all<{ result: string }>(
      env.DB,
      "SELECT result FROM audit_log WHERE account_id = ? AND tool = 'send_allow' ORDER BY id",
      accountId,
    );
    expect(audit.map((r) => r.result)).toEqual(["added", "added", "removed"]);
  });

  it("refuses a public mail provider's domain and malformed entries", async () => {
    const { ownerId, accountId } = await setup();
    const browser = await owner(E(), ownerId);
    for (const [kind, value] of [
      ["domain", "gmail.com"],
      ["domain", "@Yahoo.co.uk"],
      ["domain", "not a domain"],
      ["address", "a@b.com OR from:boss"],
      ["address", "no-at-sign"],
      ["other", "bob@example.org"],
    ] as const) {
      const res = await browser.post(
        "/accounts/allow",
        { account: accountId, kind, value },
        { page: "/accounts" },
      );
      expect(res.status).toBe(400);
    }
    // A single freemail address is fine: only the whole domain is refused.
    const ok = await browser.post(
      "/accounts/allow",
      { account: accountId, kind: "address", value: "pal@gmail.com" },
      { page: "/accounts" },
    );
    expect(ok.status).toBe(303);
    expect(await allowOf(ownerId, accountId)).toEqual(["address:pal@gmail.com"]);
  });

  it("needs the session and CSRF token to add or remove, and the owner's own account", async () => {
    const { ownerId, accountId } = await setup();
    const other = await setup("other");
    await addSendAllow(env.DB, ownerId, accountId, "address", "bob@example.org");
    const browser = await owner(E(), ownerId);
    const add = { account: accountId, kind: "address", value: "eve@example.org" };
    const remove = { account: accountId, kind: "address", value: "bob@example.org" };
    for (const [path, form] of [
      ["/accounts/allow", add],
      ["/accounts/allow/remove", remove],
    ] as const) {
      expect((await browser.post(path, form, { csrf: "", page: "/accounts" })).status).toBe(403);
      expect((await browser.post(path, form, { csrf: "forged" })).status).toBe(403);
      expect((await browser.postNoSession(path, form)).status).toBe(403);
    }
    expect(await allowOf(ownerId, accountId)).toEqual(["address:bob@example.org"]);
    // Another owner's account is not found, for add and remove.
    const foreign = await browser.post(
      "/accounts/allow",
      { ...add, account: other.accountId },
      { page: "/accounts" },
    );
    expect(foreign.status).toBe(404);
    expect(await allowOf(other.ownerId, other.accountId)).toEqual([]);
  });

  it("escapes the entries it lists", async () => {
    const { ownerId, accountId } = await setup();
    // The store only takes plain values, so a hostile one is planted straight in the table.
    await env.DB.prepare(
      "INSERT INTO send_allow (account_id, kind, value, created_at) VALUES (?, 'address', ?, 1)",
    )
      .bind(accountId, '"><script>alert(1)</script>@evil.example')
      .run();
    const page = await (await owner(E(), ownerId)).get("/accounts");
    expect(page).not.toContain("<script>alert(1)");
    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;@evil.example");
  });
});

describe("the held-action notice", () => {
  const raw = (c: GoogleCall) => c.body;
  const text = (c: GoogleCall) => {
    const part = raw(c).match(
      /Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/,
    )?.[1];
    const bin = atob((part ?? "").replace(/\s+/g, ""));
    return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
  };

  it("sends once, to NOTIFY_EMAIL, with the link and the expiry and never the body", async () => {
    const { ownerId, accountId } = await setup();
    const e = E(NOTIFY);
    const calls = installGoogleRoutes(routes());
    const longSubject = `Contract ${"x".repeat(300)}`;
    const id = await hold(e, ownerId, ["fresh@example.org"], {
      subject: longSubject,
      attachments: [],
    });
    const sent = sendCalls(calls);
    expect(sent).toHaveLength(1);
    const mail = sent[0] as GoogleCall;
    expect(mail.body).toMatch(new RegExp(`^To: ${NOTIFY}\\r?$`, "im"));
    const body = text(mail);
    expect(body).toContain(`${config(e).issuer}/approvals/${id}`);
    expect(body).toContain("fresh@example.org");
    expect(body).toContain("send_message");
    expect(body).toContain("Approving or rejecting needs your own sign-in");
    expect(body).toMatch(/expires on \d{4}-\d\d-\d\dT[\d:.]+Z \(UTC\)/);
    expect(body).not.toContain("SECRET-BODY-TEXT");
    expect(body).not.toContain(longSubject);
    expect(body).toContain("...");
    expect(raw(mail)).not.toContain("SECRET-BODY-TEXT");
    const rows = await noticeRows(accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe("ok");
    expect(rows[0]?.to_addrs).toContain(NOTIFY);
    // Reading the page or deciding does not send it again.
    const browser = await owner(e, ownerId);
    await browser.get(approvalPath(id));
    expect(sendCalls(calls)).toHaveLength(1);
  });

  it("falls back to OWNER_CONTACT when it is an address, and to nothing when neither is set", async () => {
    const { ownerId } = await setup();
    const viaContact = installGoogleRoutes(routes());
    await hold(E("", "owner@contact.example"), ownerId, ["fresh@example.org"]);
    const sent = sendCalls(viaContact);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatch(/^To: owner@contact\.example\r?$/im);

    const none = installGoogleRoutes(routes());
    const id = await hold(E("", ""), ownerId, ["fresh2@example.org"]);
    expect(sendCalls(none)).toHaveLength(0);
    expect((await pending(id))?.status).toBe("pending");

    // A contact that is a web address is not a mailbox: nothing goes out.
    const url = installGoogleRoutes(routes());
    await hold(E("", "https://example.com/contact"), ownerId, ["fresh3@example.org"]);
    expect(sendCalls(url)).toHaveLength(0);
  });

  it("is capped at 20 a day per account; past it the hold still works", async () => {
    const { ownerId, accountId } = await setup();
    const now = nowSeconds();
    const window = now - (now % 86400);
    for (let i = 0; i < NOTICES_PER_DAY - 1; i++) {
      await incrementCounter(env.DB, `notice:d:${accountId}`, window);
    }
    const e = E(NOTIFY);
    const last = installGoogleRoutes(routes());
    await hold(e, ownerId, ["fresh@example.org"]);
    expect(sendCalls(last)).toHaveLength(1);
    const over = installGoogleRoutes(routes());
    const id = await hold(e, ownerId, ["fresh2@example.org"]);
    expect(sendCalls(over)).toHaveLength(0);
    expect((await pending(id))?.status).toBe("pending");
    // Another account has its own cap.
    const other = await setup("second");
    const fresh = installGoogleRoutes(routes());
    await hold(e, other.ownerId, ["fresh@example.org"]);
    expect(sendCalls(fresh)).toHaveLength(1);
  });

  it("does not break the hold when the notice fails, and logs it", async () => {
    const { ownerId, accountId } = await setup();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    installGoogleRoutes(
      routes(
        sendRoute(() => googleJson(400, { error: { code: 400, status: "INVALID_ARGUMENT" } })),
      ),
    );
    const id = await hold(E(NOTIFY), ownerId, ["fresh@example.org"]);
    expect((await pending(id))?.status).toBe("pending");
    expect(errors).toHaveBeenCalled();
    const rows = await noticeRows(accountId);
    expect(rows.map((r) => r.result)).toEqual(["error"]);
    // The owner can still approve it.
    const browser = await owner(E(NOTIFY), ownerId);
    installGoogleRoutes(routes());
    await browser.post(approvalPath(id), { decision: "approve" });
    expect((await pending(id))?.status).toBe("executed");
  });

  it("obeys SEND_ENABLED and the owner's sending switch, for any held action", async () => {
    // A share to anyone is held whatever the sending settings are, so it shows that the notice
    // alone is silenced by them.
    const { ownerId } = await setup();
    const share = (e: Env) =>
      call(e, ownerId, "share_file", { fileId: "1OwnDoc", role: "reader", type: "anyone" });
    const on = withEnv({ ...E(NOTIFY) });
    await env.DB.prepare("UPDATE accounts SET components = ? WHERE owner_id = ?")
      .bind(JSON.stringify(["mail", "mail.send", "files"]), ownerId)
      .run();

    const control = installGoogleRoutes(routes());
    expect((await share(on)).json.status).toBe("pending_approval");
    expect(sendCalls(control)).toHaveLength(1);

    const off = installGoogleRoutes(routes());
    const disabled = withEnv({ ...E(NOTIFY), SEND_ENABLED: "false" });
    expect((await share(disabled)).json.status).toBe("pending_approval");
    expect(sendCalls(off)).toHaveLength(0);

    await env.DB.prepare("UPDATE owners SET send_kill_switch = 1 WHERE id = ?").bind(ownerId).run();
    const switched = installGoogleRoutes(routes());
    expect((await share(on)).json.status).toBe("pending_approval");
    expect(sendCalls(switched)).toHaveLength(0);
  });

  it("writes the notice as plain text on single lines, whatever the subject holds", () => {
    const body = noticeText({
      tool: "send_message",
      account: {
        accountId: "acc",
        ownerId: "o",
        shortId: 1,
        label: "work",
        address: "work@example.com",
        provider: "google",
      },
      preview: {
        subject: "Hi\r\nBcc: evil@example.org <b>x</b>",
        newRecipients: ["a@example.org\nBcc: z@example.org"],
      },
      approvalUrl: "https://mcp.example.com/approvals/pa_x",
      expiresAt: 1_800_000_000,
    });
    expect(body).toContain("Subject: Hi Bcc: evil@example.org <b>x</b>");
    expect(body).toContain("New recipients: a@example.org Bcc: z@example.org");
    expect(body.split("\n").filter((l) => l.startsWith("Bcc:"))).toEqual([]);
  });
});
