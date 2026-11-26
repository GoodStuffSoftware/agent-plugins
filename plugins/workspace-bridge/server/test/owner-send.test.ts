// "The owner told me to send this" (core/owner-send.ts): the exemption from the new-recipient hold,
// its two checks (the reply thread read from Google, the address written out in the quote), the daily
// cap on quote-based sends, what stays held, and the audit row. Google is the route-table fake.

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCOPES } from "../src/auth/endpoints";
import { mcpHandler } from "../src/auth/mcp-factory";
import { all, first } from "../src/core/db";
import {
  addressInQuote,
  OWNER_QUOTE_SENDS_PER_DAY,
  quoteSlotsUsed,
  takeQuoteSlot,
} from "../src/core/owner-send";
import { recordKnownRecipients } from "../src/core/recipients";
import type { Env } from "../src/env";
import { warmupRetry } from "../src/providers/google/contacts";
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
  rawDraft,
} from "./helpers/google";
import { ISSUER, mcpRequest, parseMcp, toolJson } from "./helpers/mcp";

const registry = compileRegistry(FAMILIES);

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const UPLOAD = "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send";
const BATCH = "https://gmail.googleapis.com/batch/gmail/v1";
const DRAFT = `${GMAIL}/drafts/d1`;
const MESSAGE = `${GMAIL}/messages/m_orig`;
const THREAD = `${GMAIL}/threads/t_orig`;
const SEARCH = "https://people.googleapis.com/v1/people:searchContacts";
const OTHER = "https://people.googleapis.com/v1/otherContacts:search";
const BUCKET = "owner_send_quote:d";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM rate_counters WHERE bucket = ?").bind(BUCKET).run();
});

afterEach(() => {
  vi.restoreAllMocks();
  warmupRetry.ms = 2000;
});

// biome-ignore lint/suspicious/noExplicitAny: the JSON a tool answered, read loosely by the tests
type Json = any;

const withEnv = (overrides: Partial<Env>): Env => ({ ...env, ...overrides }) as Env;
const MODE = (mode: string): Env => withEnv({ SEND_ENABLED: "true", SEND_APPROVAL_MODE: mode });
const NEW = MODE("new_recipients");

async function setup() {
  warmupRetry.ms = 0;
  const ownerId = await newOwner();
  const linked = await linkGoogleAccount(ownerId, {
    components: ["mail", "mail.send", "calendar", "contacts"],
  });
  await env.DB.prepare(
    "UPDATE accounts SET send_as_fetched_at = ?, signature_default = 0 WHERE id = ?",
  )
    .bind(Math.floor(Date.now() / 1000), linked.row.id)
    .run();
  return { ownerId, accountId: linked.row.id, key: `a${linked.row.short_id}` };
}

async function call(e: Env, ownerId: string, name: string, args: Record<string, unknown>) {
  const exec = Object.assign(createExecutionContext(), {
    props: { ownerId },
    auth: {
      token: `${ownerId}:g_test:secret`,
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
  const isError = result?.isError === true;
  // An input-validation refusal is plain text, not JSON.
  if (isError) {
    const text = (result?.content as { text?: string }[] | undefined)?.[0]?.text ?? "";
    try {
      return { isError, json: JSON.parse(text) as Json, text };
    } catch {
      return { isError, json: undefined as Json, text };
    }
  }
  return { isError, json: toolJson(result) as Json, text: "" };
}

const sendRoute = (): GoogleRoute => ({
  method: "POST",
  url: UPLOAD,
  reply: () => googleJson(200, fx.sent),
});
const sendCalls = (calls: GoogleCall[]) => calls.filter((c) => c.url.startsWith(UPLOAD));

const headersOf = (h: Record<string, string>) =>
  Object.entries(h).map(([name, value]) => ({ name, value }));

/** The original message (its thread is t_orig) as the reply tool reads it, and the thread itself. */
function threadRoutes(
  extra: { labelIds?: string[]; headers: Record<string, string> }[] = [],
): GoogleRoute[] {
  return [
    {
      url: MESSAGE,
      reply: (req) =>
        new URL(req.url).searchParams.get("format") === "minimal"
          ? googleJson(200, { id: "m_orig", threadId: "t_orig" })
          : googleJson(200, {
              id: fx.original.id,
              threadId: fx.original.threadId,
              payload: {
                mimeType: "text/plain",
                headers: headersOf(fx.original.headers),
                body: { size: 1, data: "aGk" },
              },
            }),
    },
    {
      url: THREAD,
      reply: () =>
        googleJson(200, {
          messages: [
            { labelIds: ["INBOX"], payload: { headers: headersOf(fx.original.headers) } },
            ...extra.map((m) => ({
              labelIds: m.labelIds ?? ["SENT"],
              payload: { headers: headersOf(m.headers) },
            })),
          ],
        }),
    },
  ];
}

/** Gmail's batch endpoint and People API: nobody has been written to, nobody is a contact. */
const unknownRoutes = (): GoogleRoute[] => [
  {
    method: "POST",
    url: BATCH,
    reply: async (req) => {
      const body = await req.text();
      const parts = [...body.matchAll(/Content-ID: <(s\d+)>/g)].map(
        (m) =>
          `--resp\r\nContent-Type: application/http\r\nContent-ID: <response-${m[1]}>\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{}\r\n`,
      );
      return new Response(`${parts.join("")}--resp--\r\n`, {
        status: 200,
        headers: { "Content-Type": "multipart/mixed; boundary=resp" },
      });
    },
  },
  { url: SEARCH, reply: () => googleJson(200, { results: [] }) },
  { url: OTHER, reply: () => googleJson(200, { results: [] }) },
];

const sendArgs = (to: string[], extra: Record<string, unknown> = {}) => ({
  to,
  subject: "s",
  body: "b",
  ...extra,
});

async function lastAudit(accountId: string, tool: string) {
  const rows = await all<{ result: string; detail: string | null; to_addrs: string | null }>(
    env.DB,
    "SELECT result, detail, to_addrs FROM audit_log WHERE account_id = ? AND tool = ? ORDER BY id DESC LIMIT 1",
    accountId,
    tool,
  );
  return rows[0];
}

describe("addressInQuote", () => {
  const ok = (a: string, q: string) => expect(addressInQuote(a, q)).toBe(true);
  const no = (a: string, q: string) => expect(addressInQuote(a, q)).toBe(false);

  it("matches the whole address, ignoring case, with sentence punctuation around it", () => {
    ok("bob@example.com", "Yes, send it to Bob@Example.COM.");
    ok("bob@example.com", "send it to <bob@example.com>, thanks");
    ok("bob@example.com", "bob@example.com");
    ok("bob@example.com", "to bob@example.com\nand cy@example.com");
  });

  it("does not match a substring of a longer or look-alike address", () => {
    no("bob@example.com", "send it to xbob@example.com");
    no("bob@example.com", "send it to bob@example.com.au");
    no("bob@example.com", "send it to bob@example.com.evil.org");
    no("bob@example.com", "send it to bob@example.comx");
    no("bob@example.com", "send it to bob+tag@example.com");
    no("bob@example.com", "send it to alice.bob@example.com");
    no("bob@example.com", "send it to bob@mail.example.com");
    no("bob@example.com", "send it to бbob@example.com");
    no("bob@example.com", "send it to bob@example.comа");
    no("bob@example.com", "send it to b0b@example.com");
    no("bob@example.com", "no address here");
    no("not an address", "not an address");
  });
});

describe("the daily cap", () => {
  it("hands out five slots a UTC day and no more, across calls", async () => {
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < OWNER_QUOTE_SENDS_PER_DAY; i++) {
      expect(await takeQuoteSlot(env.DB, now)).toBe(true);
    }
    expect(await takeQuoteSlot(env.DB, now)).toBe(false);
    expect(await quoteSlotsUsed(env.DB, now)).toBe(OWNER_QUOTE_SENDS_PER_DAY);
    // The next UTC day starts fresh.
    expect(await takeQuoteSlot(env.DB, now - (now % 86400) + 86400)).toBe(true);
  });
});

describe("send_message with ownerInstruction", () => {
  it("without the field behaves as before: a new recipient is held", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([...unknownRoutes(), sendRoute()]);
    const res = await call(NEW, ownerId, "send_message", sendArgs(["bob@example.com"]));
    expect(res.json.status).toBe("pending_approval");
    expect(res.json.preview.ownerInstruction).toBeUndefined();
    expect(sendCalls(calls)).toHaveLength(0);
    expect(await quoteSlotsUsed(env.DB, Math.floor(Date.now() / 1000))).toBe(0);
  });

  it("sends when every new address is written out in the quote, counts it and audits the quote", async () => {
    const { ownerId, accountId } = await setup();
    const calls = installGoogleRoutes([...unknownRoutes(), sendRoute()]);
    const said = "Yes please send it to Bob@Example.com and cc cy@example.org.";
    const res = await call(
      NEW,
      ownerId,
      "send_message",
      sendArgs(["bob@example.com"], { cc: ["cy@example.org"], ownerInstruction: said }),
    );
    expect(res.json.status).toBeUndefined();
    expect(res.json.sent).toBe(true);
    expect(res.json.ownerInstruction.applied).toBe(true);
    expect(res.json.ownerInstruction.recipientChecks).toEqual([
      { address: "bob@example.com", check: "named_in_instruction" },
      { address: "cy@example.org", check: "named_in_instruction" },
    ]);
    expect(sendCalls(calls)).toHaveLength(1);
    expect(await quoteSlotsUsed(env.DB, Math.floor(Date.now() / 1000))).toBe(1);
    const row = await lastAudit(accountId, "send_message");
    expect(row?.result).toBe("ok");
    expect(row?.detail).toContain(JSON.stringify(said));
    expect(row?.detail).toContain("bob@example.com via named in instruction");
    expect(JSON.parse(row?.to_addrs ?? "[]")).toEqual(["bob@example.com"]);
  });

  it("holds when one address is only a substring of a longer one in the quote, and names it", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([...unknownRoutes(), sendRoute()]);
    const res = await call(
      NEW,
      ownerId,
      "send_message",
      sendArgs(["bob@example.com"], { ownerInstruction: "send it to xbob@example.com.au" }),
    );
    expect(res.json.status).toBe("pending_approval");
    expect(res.json.preview.heldBecause).toContain("bob@example.com failed the reply check");
    expect(res.json.preview.heldBecause).toContain("given-address check");
    expect(res.json.preview.ownerInstruction).toBe("send it to xbob@example.com.au");
    expect(sendCalls(calls)).toHaveLength(0);
    expect(await quoteSlotsUsed(env.DB, Math.floor(Date.now() / 1000))).toBe(0);
  });

  it("holds when only one of two new addresses is in the quote", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([...unknownRoutes(), sendRoute()]);
    const res = await call(
      NEW,
      ownerId,
      "send_message",
      sendArgs(["bob@example.com"], {
        bcc: ["eve@example.org"],
        ownerInstruction: "send it to bob@example.com",
      }),
    );
    expect(res.json.status).toBe("pending_approval");
    expect(res.json.preview.heldBecause).toContain("eve@example.org failed");
    expect(res.json.preview.heldBecause).not.toContain("bob@example.com failed");
    expect(sendCalls(calls)).toHaveLength(0);
  });

  it("holds the sixth quote-based send of a UTC day with a reason that names the cap", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([...unknownRoutes(), sendRoute()]);
    for (let i = 0; i < OWNER_QUOTE_SENDS_PER_DAY; i++) {
      const to = `p${i}@example.com`;
      const res = await call(
        NEW,
        ownerId,
        "send_message",
        sendArgs([to], { ownerInstruction: `send it to ${to}` }),
      );
      expect(res.json.sent).toBe(true);
    }
    const sixth = await call(
      NEW,
      ownerId,
      "send_message",
      sendArgs(["p9@example.com"], { ownerInstruction: "send it to p9@example.com" }),
    );
    expect(sixth.json.status).toBe("pending_approval");
    expect(sixth.json.preview.heldBecause).toContain("daily cap of 5");
    expect(sendCalls(calls)).toHaveLength(OWNER_QUOTE_SENDS_PER_DAY);
  });

  it("does not lift sending being off: the send is refused and no slot is used", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([...unknownRoutes(), sendRoute()]);
    const res = await call(
      withEnv({ SEND_ENABLED: "false", SEND_APPROVAL_MODE: "new_recipients" }),
      ownerId,
      "send_message",
      sendArgs(["bob@example.com"], { ownerInstruction: "send it to bob@example.com" }),
    );
    expect(res.json.error?.code).toBe("send_disabled");
    expect(sendCalls(calls)).toHaveLength(0);
    expect(await quoteSlotsUsed(env.DB, Math.floor(Date.now() / 1000))).toBe(0);
  });

  it("does not lift the mode `all`", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([...unknownRoutes(), sendRoute()]);
    const res = await call(
      MODE("all"),
      ownerId,
      "send_message",
      sendArgs(["bob@example.com"], { ownerInstruction: "send it to bob@example.com" }),
    );
    expect(res.json.status).toBe("pending_approval");
    expect(sendCalls(calls)).toHaveLength(0);
  });

  it("does not lift the recipient limit", async () => {
    const { ownerId } = await setup();
    installGoogleRoutes([...unknownRoutes(), sendRoute()]);
    const res = await call(
      withEnv({ SEND_ENABLED: "true", SEND_APPROVAL_MODE: "new_recipients", MAX_RECIPIENTS: "1" }),
      ownerId,
      "send_message",
      sendArgs(["a@example.com", "b@example.com"], {
        ownerInstruction: "send it to a@example.com and b@example.com",
      }),
    );
    expect(res.json.error?.code).toBe("too_many_recipients");
  });

  it("rejects an empty or over-long instruction", async () => {
    const { ownerId } = await setup();
    installGoogleRoutes([...unknownRoutes(), sendRoute()]);
    for (const bad of ["", "   ", "x".repeat(501)]) {
      const res = await call(
        NEW,
        ownerId,
        "send_message",
        sendArgs(["bob@example.com"], { ownerInstruction: bad }),
      );
      expect(res.isError).toBe(true);
    }
  });

  it("a known recipient needs no instruction and uses no slot", async () => {
    const { ownerId, accountId } = await setup();
    await recordKnownRecipients(env.DB, accountId, ["bob@example.com"], "sent");
    installGoogleRoutes([sendRoute()]);
    const res = await call(
      NEW,
      ownerId,
      "send_message",
      sendArgs(["bob@example.com"], { ownerInstruction: "go ahead" }),
    );
    expect(res.json.status).toBeUndefined();
    expect(res.json.ownerInstruction).toBeUndefined();
    expect(await quoteSlotsUsed(env.DB, Math.floor(Date.now() / 1000))).toBe(0);
  });

  it("a thread id the caller names is checked by reading the thread: a thread that is not there fails", async () => {
    const { ownerId, key } = await setup();
    const calls = installGoogleRoutes([
      { url: `${GMAIL}/threads/t_nope`, reply: () => googleJson(404, { error: { code: 404 } }) },
      ...unknownRoutes(),
      sendRoute(),
    ]);
    const res = await call(
      NEW,
      ownerId,
      "send_message",
      sendArgs(["sam@example.net"], {
        replyThreadId: `${key}:t_nope`,
        ownerInstruction: "go ahead and send that",
      }),
    );
    expect(res.json.status).toBe("pending_approval");
    expect(res.json.preview.heldBecause).toContain("sam@example.net failed the reply check");
    expect(sendCalls(calls)).toHaveLength(0);
  });
});

describe("reply with ownerInstruction", () => {
  it("sends when every new recipient is on the thread, uses no slot and says which check passed", async () => {
    const { ownerId, accountId, key } = await setup();
    const calls = installGoogleRoutes([...threadRoutes(), ...unknownRoutes(), sendRoute()]);
    const res = await call(NEW, ownerId, "reply", {
      messageId: `${key}:m_orig`,
      replyAll: true,
      body: "x",
      ownerInstruction: "reply to everyone, send it",
    });
    expect(res.json.sent).toBe(true);
    const checks = res.json.ownerInstruction.recipientChecks.map((c: Json) => c.check);
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((c: string) => c === "reply_thread")).toBe(true);
    expect(sendCalls(calls)).toHaveLength(1);
    expect(await quoteSlotsUsed(env.DB, Math.floor(Date.now() / 1000))).toBe(0);
    const row = await lastAudit(accountId, "reply");
    expect(row?.detail).toContain("reply thread");
    expect(row?.detail).toContain("reply to everyone, send it");
  });

  it("holds when one recipient is not on the thread and not in the quote, and names it", async () => {
    const { ownerId, key } = await setup();
    const calls = installGoogleRoutes([...threadRoutes(), ...unknownRoutes(), sendRoute()]);
    const res = await call(NEW, ownerId, "reply", {
      messageId: `${key}:m_orig`,
      body: "x",
      cc: ["newbie@example.org"],
      ownerInstruction: "reply to him, send it",
    });
    expect(res.json.status).toBe("pending_approval");
    expect(res.json.preview.heldBecause).toContain("newbie@example.org failed the reply check");
    expect(res.json.preview.heldBecause).not.toContain("sam@example.net failed");
    expect(sendCalls(calls)).toHaveLength(0);
  });

  it("sends and counts when the extra recipient is only in the quote", async () => {
    const { ownerId, key } = await setup();
    const calls = installGoogleRoutes([...threadRoutes(), ...unknownRoutes(), sendRoute()]);
    const res = await call(NEW, ownerId, "reply", {
      messageId: `${key}:m_orig`,
      body: "x",
      cc: ["newbie@example.org"],
      ownerInstruction: "reply and cc newbie@example.org, send it",
    });
    expect(res.json.sent).toBe(true);
    expect(res.json.ownerInstruction.recipientChecks).toEqual([
      { address: "sam@example.net", check: "reply_thread" },
      { address: "newbie@example.org", check: "named_in_instruction" },
    ]);
    expect(sendCalls(calls)).toHaveLength(1);
    expect(await quoteSlotsUsed(env.DB, Math.floor(Date.now() / 1000))).toBe(1);
  });

  it("does not count an address that only a draft on the thread names", async () => {
    const { ownerId, key } = await setup();
    const calls = installGoogleRoutes([
      ...threadRoutes([
        { labelIds: ["DRAFT"], headers: { From: "work@example.com", To: "newbie@example.org" } },
      ]),
      ...unknownRoutes(),
      sendRoute(),
    ]);
    const res = await call(NEW, ownerId, "reply", {
      messageId: `${key}:m_orig`,
      body: "x",
      cc: ["newbie@example.org"],
      ownerInstruction: "reply, send it",
    });
    expect(res.json.status).toBe("pending_approval");
    expect(res.json.preview.heldBecause).toContain("newbie@example.org failed the reply check");
    expect(sendCalls(calls)).toHaveLength(0);
  });

  it("counts an address that a sent message on the thread names", async () => {
    const { ownerId, key } = await setup();
    const calls = installGoogleRoutes([
      ...threadRoutes([
        { labelIds: ["SENT"], headers: { From: "work@example.com", To: "newbie@example.org" } },
      ]),
      ...unknownRoutes(),
      sendRoute(),
    ]);
    const res = await call(NEW, ownerId, "reply", {
      messageId: `${key}:m_orig`,
      body: "x",
      cc: ["newbie@example.org"],
      ownerInstruction: "reply, send it",
    });
    expect(res.json.sent).toBe(true);
    expect(sendCalls(calls)).toHaveLength(1);
  });
});

describe("forward and draft sends with ownerInstruction", () => {
  it("a forward has no thread check: only the quote can cover a new address", async () => {
    const { ownerId, key } = await setup();
    const calls = installGoogleRoutes([...threadRoutes(), ...unknownRoutes(), sendRoute()]);
    const held = await call(NEW, ownerId, "forward", {
      messageId: `${key}:m_orig`,
      to: ["sam@example.net"],
      ownerInstruction: "forward it, send it",
    });
    expect(held.json.status).toBe("pending_approval");
    expect(held.json.preview.heldBecause).toContain("not a reply");
    const sent = await call(NEW, ownerId, "forward", {
      messageId: `${key}:m_orig`,
      to: ["sam@example.net"],
      ownerInstruction: "forward it to sam@example.net",
    });
    expect(sent.json.sent).toBe(true);
    expect(sendCalls(calls)).toHaveLength(1);
  });

  it("a draft send is covered by the quote, and a held draft is still locked", async () => {
    const { ownerId, key } = await setup();
    // dan@example.net is the draft's To (the fixture).
    const calls = installGoogleRoutes([
      { url: DRAFT, reply: () => googleJson(200, rawDraft()) },
      ...unknownRoutes(),
      sendRoute(),
      { method: "DELETE", url: DRAFT, reply: () => new Response(null, { status: 204 }) },
    ]);
    const held = await call(NEW, ownerId, "send_message", {
      draftId: `${key}:d1`,
      ownerInstruction: "send the draft",
    });
    expect(held.json.status).toBe("pending_approval");
    const stored = await first<{ params: string }>(
      env.DB,
      "SELECT params FROM pending_actions WHERE id = ?",
      held.json.pendingActionId,
    );
    expect(JSON.parse(stored?.params ?? "{}").args.draftLock).toMatch(/^sha256:/);
    expect(sendCalls(calls)).toHaveLength(0);

    const sent = await call(NEW, ownerId, "send_message", {
      draftId: `${key}:d1`,
      ownerInstruction: "send the draft to dan@example.net",
    });
    expect(sent.json.sent).toBe(true);
    expect(sendCalls(calls)).toHaveLength(1);
  });
});
