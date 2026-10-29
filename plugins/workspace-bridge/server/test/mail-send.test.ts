// M15: send_message, reply and forward through the real MCP handler and registry, with Google as
// the route-table fake (no network). Covers the four guardrails (sending switch and rate limit,
// From check, approval hold, audit row) and Gmail's media upload.

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Kind, SCOPES } from "../src/auth/endpoints";
import { mcpHandler } from "../src/auth/mcp-factory";
import { type AuditLogRow, all } from "../src/core/db";
import type { Env } from "../src/env";
import { compileRegistry } from "../src/registry/compile";
import { FAMILIES } from "../src/tools";
import fx from "./fixtures/google/mail-send.json";
import {
  type GoogleCall,
  type GoogleRoute,
  googleJson,
  installGoogleRoutes,
  linkGoogleAccount,
  newOwner,
  tokenRoute,
} from "./helpers/google";
import { ISSUER, mcpRequest, parseMcp, toolJson } from "./helpers/mcp";

const registry = compileRegistry(FAMILIES);

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const UPLOAD = "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send";
const SEND_AS = `${BASE}/settings/sendAs`;
const MESSAGE = `${BASE}/messages/m_orig`;
const DRAFT = `${BASE}/drafts/d1`;
const DRAFT_SEND = `${BASE}/drafts/send`;

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- Harness -------------------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: the JSON a tool answered, read loosely by the tests
type Json = any;

// These suites test the guardrails of a send, not the new-recipient rule (test/send-approval.test.ts):
// approval is off unless a test asks for SEND_REQUIRES_CONFIRM, which with the mode unset means `all`.
const withEnv = (overrides: Partial<Env>): Env =>
  ({
    ...env,
    SEND_APPROVAL_MODE: "SEND_REQUIRES_CONFIRM" in overrides ? undefined : "off",
    ...overrides,
  }) as Env;
/** Sending on: the example config ships with `SEND_ENABLED=false`. */
const ON = (extra: Partial<Env> = {}): Env => withEnv({ SEND_ENABLED: "true", ...extra });

/** A linked account. `fresh` marks the sendAs cache fresh, so no test counts a sendAs fetch. */
async function setup(opts: { fresh?: boolean } = {}) {
  const ownerId = await newOwner();
  const linked = await linkGoogleAccount(ownerId, { components: ["mail", "mail.send"] });
  if (opts.fresh !== false) {
    await env.DB.prepare("UPDATE accounts SET send_as_fetched_at = ? WHERE id = ?")
      .bind(Math.floor(Date.now() / 1000), linked.row.id)
      .run();
  }
  return { ownerId, key: `a${linked.row.short_id}` };
}

async function rpc(
  e: Env,
  ownerId: string,
  kind: Kind,
  method: string,
  params: Record<string, unknown>,
) {
  const exec = Object.assign(createExecutionContext(), {
    props: { ownerId },
    auth: {
      token: `${ownerId}:g_test:secret`,
      audience: `${ISSUER}${kind === "ro" ? "/mcp/ro" : "/mcp"}`,
      scope: [...SCOPES[kind]],
      clientId: "client_test",
      userId: ownerId,
    },
  });
  const res = await mcpHandler(kind, ISSUER, registry)(
    mcpRequest(undefined, kind, method, params),
    e,
    exec,
  );
  await waitOnExecutionContext(exec);
  expect(res.status).toBe(200);
  return parseMcp(res);
}

async function call(
  e: Env,
  ownerId: string,
  name: string,
  args: Record<string, unknown>,
  kind: Kind = "full",
): Promise<{ isError: boolean; json: Json; text: string }> {
  const r = await rpc(e, ownerId, kind, "tools/call", { name, arguments: args });
  const content = (r.result?.content ?? []) as { text: string }[];
  return {
    isError: r.result?.isError === true || r.error !== undefined,
    json: r.result ? toolJson(r.result) : r.error,
    text: content[0]?.text ?? JSON.stringify(r.error ?? ""),
  };
}

const b64u = (s: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** A header of an RFC 822 text, unfolded. */
const header = (raw: string, name: string): string | undefined =>
  raw
    .split("\r\n\r\n")[0]
    ?.match(new RegExp(`^${name}: (.*(?:\\r\\n[ \\t].*)*)`, "im"))?.[1]
    ?.replace(/\r\n[ \t]/g, " ");

/** The decoded text of each base64 body part. */
function bodies(raw: string): string[] {
  return [...raw.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/g)].map(
    (m) => {
      const bin = atob((m[1] ?? "").replace(/\s+/g, ""));
      return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    },
  );
}

/** The RFC 822 text inside a `multipart/related` upload. */
function rfc822Of(c: GoogleCall): string {
  const m = c.body.match(/Content-Type: message\/rfc822\r\n\r\n([\s\S]*?)\r\n--wb_[^\r\n]+--/);
  if (!m?.[1]) throw new Error("no message/rfc822 part");
  return m[1];
}

const query = (c: GoogleCall | undefined) => new URL(c?.url ?? "").searchParams;

const sentAnswer = () => googleJson(200, fx.sent);

const sendRoute = (reply: GoogleRoute["reply"] = sentAnswer): GoogleRoute => ({
  method: "POST",
  url: UPLOAD,
  reply,
});

/** The original message as Gmail returns it, from the fixture. */
function originalRoute(over: Record<string, string | null> = {}): GoogleRoute {
  const headers = { ...fx.original.headers, ...over } as Record<string, string | null>;
  const list = Object.entries(headers)
    .filter(([, v]) => v !== null)
    .map(([name, value]) => ({ name, value }));
  return {
    url: MESSAGE,
    reply: () =>
      googleJson(200, {
        id: fx.original.id,
        threadId: fx.original.threadId,
        payload: {
          mimeType: "text/plain",
          headers: list,
          body: { size: 10, data: b64u(fx.original.text) },
        },
      }),
  };
}

const auditRows = (ownerId: string) =>
  all<AuditLogRow>(env.DB, "SELECT * FROM audit_log WHERE owner_id = ? ORDER BY id", ownerId);

const sendCalls = (calls: GoogleCall[]) => calls.filter((c) => c.url.startsWith(UPLOAD));

// ---- send_message --------------------------------------------------------------------------------

describe("send_message", () => {
  it("sends by media upload, answers prefixed ids and writes one audit row without the body", async () => {
    const { ownerId, key } = await setup();
    let contentType: string | null = null;
    const calls = installGoogleRoutes([
      sendRoute((req) => {
        contentType = req.headers.get("Content-Type");
        return sentAnswer();
      }),
    ]);
    const res = await call(ON(), ownerId, "send_message", {
      to: ["Bob <bob@example.com>"],
      cc: ["cy@example.com"],
      bcc: ["hidden@example.com"],
      subject: "Status",
      body: "SECRET-BODY-TEXT",
    });
    expect(res.isError).toBe(false);
    expect(res.json).toEqual({
      id: `${key}:m_sent`,
      threadId: `${key}:t_sent`,
      labelIds: [`${key}:SENT`],
      account: key,
    });
    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c?.method).toBe("POST");
    expect(contentType).toBe("message/rfc822");
    expect(query(c).get("uploadType")).toBe("media");
    expect(query(c).get("fields")).toBe("id,threadId,labelIds");
    // The body is the RFC 822 text, not JSON with a base64url `raw`.
    expect(c?.body.startsWith("{")).toBe(false);
    expect(c?.body).not.toContain('"raw"');
    expect(header(c?.body ?? "", "To")).toBe("Bob <bob@example.com>");
    expect(header(c?.body ?? "", "Cc")).toBe("cy@example.com");
    expect(header(c?.body ?? "", "Bcc")).toBe("hidden@example.com");
    expect(header(c?.body ?? "", "Subject")).toBe("Status");
    expect(header(c?.body ?? "", "From")).toBeUndefined();
    expect(bodies(c?.body ?? "")).toEqual(["SECRET-BODY-TEXT"]);

    const rows = await auditRows(ownerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool: "send_message",
      from_addr: "work@example.com",
      subject: "Status",
      provider_ref: "m_sent",
      result: "ok",
    });
    expect(JSON.parse(rows[0]?.to_addrs ?? "[]")).toEqual(["bob@example.com"]);
    expect(JSON.parse(rows[0]?.bcc_addrs ?? "[]")).toEqual(["hidden@example.com"]);
    expect(JSON.stringify(rows[0])).not.toContain("SECRET-BODY-TEXT");
  });

  it("threads under replyThreadId with a multipart upload", async () => {
    const { ownerId, key } = await setup();
    const calls = installGoogleRoutes([sendRoute()]);
    const res = await call(ON(), ownerId, "send_message", {
      to: ["bob@example.com"],
      subject: "Again",
      body: "b",
      replyThreadId: `${key}:t_orig`,
    });
    expect(res.isError).toBe(false);
    expect(query(calls[0]).get("uploadType")).toBe("multipart");
    expect(calls[0]?.body).toContain('{"threadId":"t_orig"}');
  });

  it("threads under replyToMessageId with In-Reply-To and References", async () => {
    const { ownerId, key } = await setup();
    const calls = installGoogleRoutes([originalRoute(), sendRoute()]);
    const res = await call(ON(), ownerId, "send_message", {
      to: ["bob@example.com"],
      body: "b",
      replyToMessageId: `${key}:m_orig`,
    });
    expect(res.isError).toBe(false);
    const raw = rfc822Of(calls[1] as GoogleCall);
    expect(header(raw, "In-Reply-To")).toBe("<orig-1@mail.example.net>");
    expect(header(raw, "References")).toBe("<root-0@mail.example.net> <orig-1@mail.example.net>");
    expect(header(raw, "Subject")).toBe("Re: Quarterly plan");
    expect(calls[1]?.body).toContain('"threadId":"t_orig"');
  });

  it("accepts a verified alias as From and sets the header", async () => {
    const { ownerId } = await setup({ fresh: false });
    const calls = installGoogleRoutes([
      { url: SEND_AS, reply: () => googleJson(200, fx.sendAs) },
      sendRoute(),
    ]);
    const res = await call(ON(), ownerId, "send_message", {
      to: ["bob@example.com"],
      subject: "s",
      body: "b",
      from: "Alias@Example.com",
    });
    expect(res.isError).toBe(false);
    expect(header(sendCalls(calls)[0]?.body ?? "", "From")).toBe("Team Alias <alias@example.com>");
    expect((await auditRows(ownerId))[0]?.from_addr).toBe("alias@example.com");
  });

  it("refuses a From that is not the account's or a verified alias, and audits the refusal", async () => {
    const { ownerId } = await setup({ fresh: false });
    const calls = installGoogleRoutes([
      { url: SEND_AS, reply: () => googleJson(200, fx.sendAs) },
      sendRoute(),
    ]);
    for (const from of ["unverified@example.com", "someone@example.org"]) {
      const res = await call(ON(), ownerId, "send_message", {
        to: ["bob@example.com"],
        subject: "s",
        body: "b",
        from,
      });
      expect(res.json.error.code).toBe("sender_not_allowed");
    }
    expect(sendCalls(calls)).toHaveLength(0);
    const rows = await auditRows(ownerId);
    expect(rows.map((r) => [r.result, r.detail])).toEqual([
      ["refused", "sender_not_allowed"],
      ["refused", "sender_not_allowed"],
    ]);
  });

  it("is refused while sending is switched off, with no Google call", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([sendRoute()]);
    const res = await call(withEnv({ SEND_ENABLED: "false" }), ownerId, "send_message", {
      to: ["bob@example.com"],
      subject: "s",
      body: "b",
    });
    expect(res.json.error.code).toBe("send_disabled");
    expect(calls).toHaveLength(0);
    const rows = await auditRows(ownerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ result: "refused", detail: "send_disabled" });
  });

  it("is refused past the rate limit, and the refused send reaches Google not at all", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([sendRoute()]);
    const e = ON({ SEND_PER_HOUR: "1" });
    const args = { to: ["bob@example.com"], subject: "s", body: "b" };
    expect((await call(e, ownerId, "send_message", args)).isError).toBe(false);
    const second = await call(e, ownerId, "send_message", args);
    expect(second.json.error.code).toBe("rate_limited");
    expect(second.json.error.details?.retryAfterSeconds ?? 1).toBeGreaterThan(0);
    expect(sendCalls(calls)).toHaveLength(1);
    expect((await auditRows(ownerId)).map((r) => r.result)).toEqual(["ok", "refused"]);
  });

  it("caps recipients across to, cc and bcc", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([sendRoute()]);
    const res = await call(ON({ MAX_RECIPIENTS: "2" }), ownerId, "send_message", {
      to: ["a@example.com", "b@example.com"],
      bcc: ["c@example.com"],
      body: "b",
    });
    expect(res.json.error.code).toBe("too_many_recipients");
    expect(calls).toHaveLength(0);
    const rows = await auditRows(ownerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ result: "refused", detail: "too_many_recipients" });
  });

  it("shows a held reply's real recipients and a held draft send's envelope", async () => {
    const { ownerId, key } = await setup();
    installGoogleRoutes([
      originalRoute(),
      { url: DRAFT, reply: () => googleJson(200, fx.draft) },
      sendRoute(),
    ]);
    const e = ON({ SEND_REQUIRES_CONFIRM: "true" });
    await call(e, ownerId, "reply", { messageId: `${key}:m_orig`, body: "SECRET-BODY-TEXT" });
    await call(e, ownerId, "send_message", { draftId: `${key}:d1` });
    const rows = await env.DB.prepare(
      "SELECT tool, preview FROM pending_actions WHERE owner_id = ? ORDER BY rowid",
    )
      .bind(ownerId)
      .all<{ tool: string; preview: string }>();
    const [r, d] = rows.results.map((x) => JSON.parse(x.preview));
    expect(r.to).toEqual(["sam@example.net"]);
    expect(r.subject).toBe("Re: Quarterly plan");
    expect(d.to).toEqual(["dan@example.net"]);
    expect(d.subject).toBe("Draft subject");
    expect(JSON.stringify(rows.results)).not.toContain("SECRET-BODY-TEXT");
  });

  it("holds the send for approval and sends nothing", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([sendRoute()]);
    const res = await call(ON({ SEND_REQUIRES_CONFIRM: "true" }), ownerId, "send_message", {
      to: ["bob@example.com"],
      subject: "Held",
      body: "SECRET-BODY-TEXT",
    });
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({
      status: "pending_approval",
      pendingActionId: expect.stringMatching(/^pa_/),
      approvalUrl: expect.stringContaining("/approvals/"),
    });
    expect(calls).toHaveLength(0);
    expect(await auditRows(ownerId)).toHaveLength(0);
    const row = await env.DB.prepare(
      "SELECT tool, status, preview FROM pending_actions WHERE owner_id = ?",
    )
      .bind(ownerId)
      .first<{ tool: string; status: string; preview: string }>();
    expect(row).toMatchObject({ tool: "send_message", status: "pending" });
    expect(JSON.parse(row?.preview ?? "{}")).toMatchObject({
      account: "work",
      to: ["bob@example.com"],
      subject: "Held",
    });
    expect(row?.preview).not.toContain("SECRET-BODY-TEXT");
  });

  it("refuses at once, queuing nothing, a send that could never go out: no recipient, sending off", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([sendRoute()]);
    const pending = () =>
      env.DB.prepare("SELECT COUNT(*) AS n FROM pending_actions WHERE owner_id = ?")
        .bind(ownerId)
        .first<{ n: number }>();
    const none = await call(ON({ SEND_REQUIRES_CONFIRM: "true" }), ownerId, "send_message", {
      subject: "s",
      body: "b",
    });
    expect(none.json.error.code).toBe("invalid_argument");
    const off = await call(
      withEnv({ SEND_ENABLED: "false", SEND_REQUIRES_CONFIRM: "true" }),
      ownerId,
      "send_message",
      { to: ["bob@example.com"], subject: "s", body: "b" },
    );
    expect(off.json.error.code).toBe("send_disabled");
    expect((await pending())?.n).toBe(0);
    expect(calls).toHaveLength(0);
    expect((await auditRows(ownerId)).map((r) => r.result)).toEqual(["refused", "refused"]);
  });

  it("validates before calling Google: header injection, attachments, no recipient", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([sendRoute()]);
    const cases: [Record<string, unknown>, string][] = [
      [
        { to: ["a@example.com"], subject: "Hi\r\nBcc: evil@example.net", body: "b" },
        "invalid_argument",
      ],
      [{ to: ["a@example.com\r\nBcc: evil@example.net"], body: "b" }, "invalid_argument"],
      [
        {
          to: ["a@example.com"],
          body: "b",
          attachments: [{ content: "aGk=", filename: "a.txt", inline: true }],
        },
        "invalid_argument",
      ],
      [{ subject: "s", body: "b" }, "invalid_argument"],
    ];
    for (const [args, code] of cases) {
      const res = await call(ON(), ownerId, "send_message", args);
      expect(res.json.error.code).toBe(code);
    }
    expect(calls).toHaveLength(0);
  });

  it("sends a draft by id after checking its recipients and From", async () => {
    const { ownerId, key } = await setup();
    let sentBody = "";
    const calls = installGoogleRoutes([
      { url: DRAFT, reply: () => googleJson(200, fx.draft) },
      {
        method: "POST",
        url: DRAFT_SEND,
        reply: async (req) => {
          sentBody = await req.text();
          return sentAnswer();
        },
      },
    ]);
    const res = await call(ON(), ownerId, "send_message", { draftId: `${key}:d1` });
    expect(res.isError).toBe(false);
    expect(res.json.id).toBe(`${key}:m_sent`);
    expect(JSON.parse(sentBody)).toEqual({ id: "d1" });
    expect(query(calls[0]).get("format")).toBe("full");
    const rows = await auditRows(ownerId);
    expect(rows[0]).toMatchObject({
      tool: "send_message",
      from_addr: "work@example.com",
      subject: "Draft subject",
      result: "ok",
    });
    expect(JSON.parse(rows[0]?.to_addrs ?? "[]")).toEqual(["dan@example.net"]);
  });

  it("refuses a draft whose From is not allowed, without sending it", async () => {
    const { ownerId } = await setup();
    const draft = structuredClone(fx.draft);
    draft.message.payload.headers[0] = { name: "From", value: "stranger@example.org" };
    const calls = installGoogleRoutes([
      { url: DRAFT, reply: () => googleJson(200, draft) },
      { method: "POST", url: DRAFT_SEND, reply: sentAnswer },
    ]);
    const res = await call(ON(), ownerId, "send_message", { draftId: "d1" });
    expect(res.json.error.code).toBe("sender_not_allowed");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});

// ---- reply ---------------------------------------------------------------------------------------

describe("reply", () => {
  it("threads: thread id, In-Reply-To, References, one Re:, quote and sender as recipient", async () => {
    const { ownerId, key } = await setup();
    const calls = installGoogleRoutes([originalRoute(), sendRoute()]);
    const res = await call(ON(), ownerId, "reply", {
      messageId: `${key}:m_orig`,
      body: "Thanks, agreed.",
    });
    expect(res.isError).toBe(false);
    expect(res.json.id).toBe(`${key}:m_sent`);
    const send = calls[1] as GoogleCall;
    expect(query(send).get("uploadType")).toBe("multipart");
    expect(send.body).toContain('{"threadId":"t_orig"}');
    const raw = rfc822Of(send);
    expect(header(raw, "To")).toBe("sam@example.net");
    expect(header(raw, "Cc")).toBeUndefined();
    expect(header(raw, "Subject")).toBe("Re: Quarterly plan");
    expect(header(raw, "In-Reply-To")).toBe("<orig-1@mail.example.net>");
    expect(header(raw, "References")).toBe("<root-0@mail.example.net> <orig-1@mail.example.net>");
    const [text] = bodies(raw);
    expect(text).toContain("Thanks, agreed.");
    expect(text).toContain(
      "On Mon, 26 Oct 2026 09:00:00 +0000, Sam Sender <sam@example.net> wrote:",
    );
    expect(text).toContain("> Here is the plan for next quarter.");
    // What comes back from the original is third-party text: wrapped.
    expect(JSON.stringify(res.json.subject)).toContain("untrusted");
    expect(JSON.stringify(res.json.to)).toContain("sam@example.net");
    const rows = await auditRows(ownerId);
    expect(rows[0]).toMatchObject({ tool: "reply", subject: "Re: Quarterly plan", result: "ok" });
    expect(JSON.stringify(rows[0])).not.toContain("Thanks, agreed.");
  });

  it("does not double Re: on an answer to an answer", async () => {
    const { ownerId, key } = await setup();
    const calls = installGoogleRoutes([
      originalRoute({ Subject: "RE: Quarterly plan" }),
      sendRoute(),
    ]);
    await call(ON(), ownerId, "reply", { messageId: `${key}:m_orig`, body: "x" });
    expect(header(rfc822Of(calls[1] as GoogleCall), "Subject")).toBe("RE: Quarterly plan");
  });

  it("replyAll adds the other recipients and leaves out the account's own addresses", async () => {
    const { ownerId, key } = await setup();
    const calls = installGoogleRoutes([originalRoute(), sendRoute()]);
    await call(ON(), ownerId, "reply", {
      messageId: `${key}:m_orig`,
      body: "x",
      replyAll: true,
    });
    const raw = rfc822Of(calls[1] as GoogleCall);
    expect(header(raw, "To")).toBe("sam@example.net");
    // pat and kim, not work@example.com (the account); alias@example.com is not in the cache here.
    expect(header(raw, "Cc")).toBe("pat@example.net, kim@example.net, alias@example.com");
  });

  it("uses Reply-To, and lets to and cc replace the defaults", async () => {
    const { ownerId, key } = await setup();
    const calls = installGoogleRoutes([
      originalRoute({ "Reply-To": "lists@example.net" }),
      originalRoute(),
      sendRoute(),
    ]);
    await call(ON(), ownerId, "reply", { messageId: `${key}:m_orig`, body: "x" });
    // The route table answers the first matching route, so the second original is unused.
    expect(header(rfc822Of(calls[1] as GoogleCall), "To")).toBe("lists@example.net");
    vi.restoreAllMocks();
    const calls2 = installGoogleRoutes([originalRoute(), sendRoute()]);
    await call(ON(), ownerId, "reply", {
      messageId: `${key}:m_orig`,
      body: "x",
      replyAll: true,
      to: ["override@example.com"],
      cc: ["only@example.com"],
    });
    const raw = rfc822Of(calls2[1] as GoogleCall);
    expect(header(raw, "To")).toBe("override@example.com");
    expect(header(raw, "Cc")).toBe("only@example.com");
  });

  it("needs a body, refuses inline attachments, and maps a missing original to not_found", async () => {
    const { ownerId, key } = await setup();
    installGoogleRoutes([
      { url: MESSAGE, reply: () => googleJson(404, { error: { code: 404, message: "SECRET-X" } }) },
    ]);
    const none = await call(ON(), ownerId, "reply", { messageId: `${key}:m_orig` });
    expect(none.json.error.code).toBe("invalid_argument");
    const withFile = await call(ON(), ownerId, "reply", {
      messageId: `${key}:m_orig`,
      body: "x",
      attachments: [{ content: "aGk=", inline: true }],
    });
    expect(withFile.json.error.code).toBe("invalid_argument");
    const missing = await call(ON(), ownerId, "reply", { messageId: `${key}:m_orig`, body: "x" });
    expect(missing.json.error.code).toBe("not_found");
    expect(missing.text).not.toContain("SECRET");
  });

  it("is held for approval when SEND_REQUIRES_CONFIRM is on", async () => {
    const { ownerId, key } = await setup();
    const calls = installGoogleRoutes([originalRoute(), sendRoute()]);
    const res = await call(ON({ SEND_REQUIRES_CONFIRM: "true" }), ownerId, "reply", {
      messageId: `${key}:m_orig`,
      body: "x",
    });
    expect(res.json.status).toBe("pending_approval");
    // Only the read of the original, for the approval summary; nothing is sent.
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(sendCalls(calls)).toHaveLength(0);
  });
});

// ---- forward -------------------------------------------------------------------------------------

describe("forward", () => {
  it("quotes the original under a forwarded-message block and wraps what it returns", async () => {
    const { ownerId, key } = await setup();
    const calls = installGoogleRoutes([originalRoute(), sendRoute()]);
    const res = await call(ON(), ownerId, "forward", {
      messageId: `${key}:m_orig`,
      to: ["dan@example.com"],
      forwardText: "FYI",
    });
    expect(res.isError).toBe(false);
    const send = calls[1] as GoogleCall;
    expect(query(send).get("uploadType")).toBe("media");
    const raw = send.body;
    expect(header(raw, "To")).toBe("dan@example.com");
    expect(header(raw, "Subject")).toBe("Fwd: Quarterly plan");
    expect(header(raw, "In-Reply-To")).toBeUndefined();
    const [text] = bodies(raw);
    expect(text?.startsWith("FYI")).toBe(true);
    expect(text).toContain("---------- Forwarded message ---------");
    expect(text).toContain("From: Sam Sender <sam@example.net>");
    expect(text).toContain("Subject: Quarterly plan");
    expect(text).toContain("Here is the plan for next quarter.");
    expect(JSON.stringify(res.json.subject)).toContain("untrusted");
    expect(res.json.omittedAttachments).toBeUndefined();
    expect((await auditRows(ownerId))[0]).toMatchObject({ tool: "forward", result: "ok" });
  });

  it("does not double Fwd: and builds an HTML alternative when given HTML", async () => {
    const { ownerId, key } = await setup();
    const calls = installGoogleRoutes([originalRoute({ Subject: "Fwd: Plan" }), sendRoute()]);
    await call(ON(), ownerId, "forward", {
      messageId: `${key}:m_orig`,
      to: ["dan@example.com"],
      htmlBody: "<p>see below</p>",
    });
    const raw = (calls[1] as GoogleCall).body;
    expect(header(raw, "Subject")).toBe("Fwd: Plan");
    expect(raw).toContain("multipart/alternative");
    expect(bodies(raw)[1]).toContain("<p>see below</p>");
    expect(bodies(raw)[1]).toContain("Forwarded message");
  });

  it("needs a recipient and refuses inline attachments", async () => {
    const { ownerId, key } = await setup();
    const calls = installGoogleRoutes([originalRoute(), sendRoute()]);
    const none = await call(ON(), ownerId, "forward", { messageId: `${key}:m_orig` });
    expect(none.json.error.code).toBe("invalid_argument");
    const file = await call(ON(), ownerId, "forward", {
      messageId: `${key}:m_orig`,
      to: ["dan@example.com"],
      attachments: [{ content: "aGk=", inline: true }],
    });
    expect(file.json.error.code).toBe("invalid_argument");
    expect(calls).toHaveLength(0);
  });

  it("is refused when sending is off and when the From is not allowed", async () => {
    const { ownerId, key } = await setup();
    const calls = installGoogleRoutes([originalRoute(), sendRoute()]);
    const off = await call(withEnv({ SEND_ENABLED: "false" }), ownerId, "forward", {
      messageId: `${key}:m_orig`,
      to: ["dan@example.com"],
    });
    expect(off.json.error.code).toBe("send_disabled");
    const bad = await call(ON(), ownerId, "forward", {
      messageId: `${key}:m_orig`,
      to: ["dan@example.com"],
      from: "stranger@example.org",
    });
    expect(bad.json.error.code).toBe("sender_not_allowed");
    expect(sendCalls(calls)).toHaveLength(0);
  });
});

// ---- Errors --------------------------------------------------------------------------------------

describe("Google errors on send", () => {
  const secret = { error: { code: 400, message: "SECRET-BODY Payroll" } };

  it("maps 403 rate limit, 429, 404 and 400 without leaking, and audits an error", async () => {
    const { ownerId } = await setup();
    const rate = { error: { code: 403, errors: [{ reason: "userRateLimitExceeded" }] } };
    const cases: [number, unknown, string][] = [
      [403, rate, "rate_limited"],
      [429, secret, "rate_limited"],
      [404, secret, "not_found"],
      [400, secret, "invalid_argument"],
    ];
    for (const [status, body, code] of cases) {
      installGoogleRoutes([sendRoute(() => googleJson(status, body))]);
      const res = await call(ON(), ownerId, "send_message", {
        to: ["a@example.com"],
        subject: "Confidential-subject",
        body: "Confidential-body",
      });
      expect(res.json.error.code).toBe(code);
      expect(res.text).not.toMatch(/SECRET|Payroll|Confidential/);
      vi.restoreAllMocks();
    }
    const rows = await auditRows(ownerId);
    expect(rows.map((r) => r.result)).toEqual(["error", "error", "error", "error"]);
    expect(rows.map((r) => r.detail)).toEqual([
      "rate_limited",
      "rate_limited",
      "not_found",
      "invalid_argument",
    ]);
  });

  it("answers needs_relink after a second 401 and does not send twice", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([
      sendRoute(() => googleJson(401, secret)),
      tokenRoute("ya29.fresh"),
    ]);
    const res = await call(ON(), ownerId, "send_message", { to: ["a@example.com"], body: "b" });
    expect(res.json.error.code).toBe("needs_relink");
    expect(res.text).not.toMatch(/SECRET|ya29/);
    // One refresh and one retry: two attempts, the 401 never being a delivered send.
    expect(sendCalls(calls)).toHaveLength(2);
  });

  it("does not retry a 5xx on send", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([sendRoute(() => googleJson(503, secret))]);
    const res = await call(ON(), ownerId, "send_message", { to: ["a@example.com"], body: "b" });
    expect(res.json.error.code).toBe("upstream_error");
    expect(sendCalls(calls)).toHaveLength(1);
  });
});

// ---- Endpoints -----------------------------------------------------------------------------------

describe("endpoints", () => {
  it("registers the send tools on /mcp only, with openWorldHint", async () => {
    const { ownerId } = await setup();
    const full = (await rpc(env, ownerId, "full", "tools/list", {})).result?.tools as {
      name: string;
      annotations?: { openWorldHint?: boolean; readOnlyHint?: boolean };
    }[];
    const ro = (await rpc(env, ownerId, "ro", "tools/list", {})).result?.tools as {
      name: string;
    }[];
    for (const name of ["send_message", "reply", "forward"]) {
      const t = full.find((x) => x.name === name);
      expect(t?.annotations?.openWorldHint, name).toBe(true);
      expect(t?.annotations?.readOnlyHint, name).toBe(false);
      expect(
        ro.map((x) => x.name),
        name,
      ).not.toContain(name);
    }
  });

  it("refuses a forged send call on /mcp/ro and calls Google not at all", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([sendRoute()]);
    const res = await call(
      ON(),
      ownerId,
      "send_message",
      { to: ["a@example.com"], body: "b" },
      "ro",
    );
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
    expect(await auditRows(ownerId)).toHaveLength(0);
  });
});
