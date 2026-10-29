// "Hold sends to new recipients" (core/recipients.ts, core/send-allow.ts): the modes of
// SEND_APPROVAL_MODE, what counts as a known recipient, the injection guard on the sent-history
// query, drafts, replies, calendar notifications, the approved run and the subrequest budget.
// Google is the route-table fake.

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCOPES } from "../src/auth/endpoints";
import { mcpHandler } from "../src/auth/mcp-factory";
import { createSession, SESSION_COOKIE } from "../src/auth/session";
import { all, first, type PendingActionRow } from "../src/core/db";
import { normalizeRecipients, recordKnownRecipients } from "../src/core/recipients";
import {
  addSendAllow,
  isFreemailDomain,
  listSendAllow,
  removeSendAllow,
} from "../src/core/send-allow";
import { config, type Env } from "../src/env";
import { warmupRetry } from "../src/providers/google/contacts";
import { compileRegistry } from "../src/registry/compile";
import { FAMILIES } from "../src/tools";
import { guardrailsRoutes } from "../src/web/guardrails";
import calendarFx from "./fixtures/google/calendar.json";
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
import { mintToken } from "./helpers/tokens";

const registry = compileRegistry(FAMILIES);

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const UPLOAD = "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send";
const BATCH = "https://gmail.googleapis.com/batch/gmail/v1";
const DRAFT = `${GMAIL}/drafts/d1`;
const MESSAGE = `${GMAIL}/messages/m_orig`;
const SEARCH = "https://people.googleapis.com/v1/people:searchContacts";
const OTHER = "https://people.googleapis.com/v1/otherContacts:search";
const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

afterEach(() => {
  vi.restoreAllMocks();
  warmupRetry.ms = 2000;
});

// biome-ignore lint/suspicious/noExplicitAny: the JSON a tool answered, read loosely by the tests
type Json = any;

const withEnv = (overrides: Partial<Env>): Env => ({ ...env, ...overrides }) as Env;
const MODE = (mode: string | undefined): Env =>
  withEnv({ SEND_ENABLED: "true", SEND_APPROVAL_MODE: mode });

async function setup() {
  warmupRetry.ms = 0;
  const ownerId = await newOwner();
  const linked = await linkGoogleAccount(ownerId, {
    components: ["mail", "mail.send", "calendar", "contacts"],
  });
  await env.DB.prepare("UPDATE accounts SET send_as_fetched_at = ? WHERE id = ?")
    .bind(Math.floor(Date.now() / 1000), linked.row.id)
    .run();
  return { ownerId, accountId: linked.row.id, key: `a${linked.row.short_id}` };
}

async function call(
  e: Env,
  ownerId: string,
  name: string,
  args: Record<string, unknown>,
  token?: string,
) {
  const exec = Object.assign(createExecutionContext(), {
    props: { ownerId },
    auth: {
      token: token ?? `${ownerId}:g_test:secret`,
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
  return { isError: result?.isError === true, json: toolJson(result) as Json };
}

const sentAnswer = () => googleJson(200, fx.sent);
const sendRoute = (): GoogleRoute => ({ method: "POST", url: UPLOAD, reply: sentAnswer });
/** The delete of a draft once it has been sent. */
const draftDeleteRoute = (): GoogleRoute => ({
  method: "DELETE",
  url: DRAFT,
  reply: () => new Response(null, { status: 204 }),
});

/** The `in:sent to:` queries a batch request carried, in order. */
const sentQueries = (calls: GoogleCall[]): string[] =>
  calls
    .filter((c) => c.url === BATCH)
    .flatMap((c) =>
      [...c.body.matchAll(/GET (\S+)/g)].map(
        (m) => new URL(`https://x${m[1]}`).searchParams.get("q") ?? "",
      ),
    );

/** Gmail's batch endpoint: an `in:sent to:<addr>` search finds one message for each address in `sent`. */
function batchRoute(sent: readonly string[] = []): GoogleRoute {
  return {
    method: "POST",
    url: BATCH,
    reply: async (req) => {
      const body = await req.text();
      const parts = [...body.matchAll(/Content-ID: <(s\d+)>\r\n\r\nGET (\S+)/g)].map((m) => {
        const q = new URL(`https://x${m[2]}`).searchParams.get("q") ?? "";
        const hit = sent.some((a) => q === `in:sent to:${a}`);
        return (
          `--resp\r\nContent-Type: application/http\r\nContent-ID: <response-${m[1]}>\r\n\r\n` +
          `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(hit ? { messages: [{ id: "x" }] } : {})}\r\n`
        );
      });
      return new Response(`${parts.join("")}--resp--\r\n`, {
        status: 200,
        headers: { "Content-Type": "multipart/mixed; boundary=resp" },
      });
    },
  };
}

/** People API: `people` are the contacts, `other` the other contacts (each an email). */
function peopleRoutes(
  people: readonly string[] = [],
  other: readonly string[] = [],
): GoogleRoute[] {
  const route = (url: string, emails: readonly string[]): GoogleRoute => ({
    url,
    reply: (req) => {
      const q = new URL(req.url).searchParams.get("query") ?? "";
      const results = emails
        .filter((e) => q !== "" && q === e)
        .map((e) => ({
          person: {
            resourceName: `people/c_${e}`,
            names: [{ displayName: e }],
            emailAddresses: [{ value: e }],
          },
        }));
      return googleJson(200, { results });
    },
  });
  return [route(SEARCH, people), route(OTHER, other)];
}

const sendCalls = (calls: GoogleCall[]) => calls.filter((c) => c.url.startsWith(UPLOAD));
const bareArgs = (to: string[], extra: Record<string, unknown> = {}) => ({
  to,
  subject: "s",
  body: "b",
  ...extra,
});

describe("send_message in mode new_recipients", () => {
  it("refuses a display name that holds an address", async () => {
    const { ownerId } = await setup();
    installGoogleRoutes([batchRoute(), ...peopleRoutes(), sendRoute()]);
    const res = await call(
      MODE("new_recipients"),
      ownerId,
      "send_message",
      bareArgs(['"new@evil.com" <bob@example.com>']),
    );
    expect(res.json.error?.code).toBe("invalid_argument");
  });

  it("sends straight out when every recipient is known", async () => {
    const { ownerId, accountId } = await setup();
    await recordKnownRecipients(env.DB, accountId, ["bob@example.com", "cy@example.com"], "sent");
    const calls = installGoogleRoutes([sendRoute()]);
    const res = await call(
      MODE("new_recipients"),
      ownerId,
      "send_message",
      bareArgs(["Bob <BOB@example.com>"], { cc: ["cy@example.com"] }),
    );
    expect(res.json.status).toBeUndefined();
    expect(sendCalls(calls)).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("holds when one recipient is new among known ones and names only the new one", async () => {
    const { ownerId, accountId } = await setup();
    await recordKnownRecipients(env.DB, accountId, ["bob@example.com"], "sent");
    const calls = installGoogleRoutes([batchRoute(), ...peopleRoutes(), sendRoute()]);
    const res = await call(
      MODE("new_recipients"),
      ownerId,
      "send_message",
      bareArgs(["bob@example.com"], { bcc: ["Stranger@Example.org"] }),
    );
    expect(res.json.status).toBe("pending_approval");
    expect(res.json.pendingActionId).toMatch(/^pa_/);
    expect(res.json.preview.newRecipients).toEqual(["stranger@example.org"]);
    expect(res.json.preview.heldBecause).toContain("stranger@example.org");
    expect(res.json.preview.heldBecause).not.toContain("bob@example.com");
    expect(sendCalls(calls)).toHaveLength(0);
  });

  it("knows the owner's own address and the account's verified aliases", async () => {
    const { ownerId } = await setup();
    // The sendAs cache is fresh and empty: the alias comes from the stored rows.
    await env.DB.prepare("UPDATE accounts SET send_as_fetched_at = 0 WHERE owner_id = ?")
      .bind(ownerId)
      .run();
    const calls = installGoogleRoutes([
      { url: `${GMAIL}/settings/sendAs`, reply: () => googleJson(200, fx.sendAs) },
      sendRoute(),
    ]);
    const res = await call(
      MODE("new_recipients"),
      ownerId,
      "send_message",
      bareArgs(["work@example.com", "Alias@Example.com"]),
    );
    expect(res.json.status).toBeUndefined();
    expect(sendCalls(calls)).toHaveLength(1);
    // OWNER_EMAILS and LINKABLE_EMAILS addresses are the owner's too.
    const calls2 = installGoogleRoutes([sendRoute()]);
    const res2 = await call(
      MODE("new_recipients"),
      ownerId,
      "send_message",
      bareArgs(["owner@example.com"]),
    );
    expect(res2.json.status).toBeUndefined();
    expect(sendCalls(calls2)).toHaveLength(1);
  });

  it("knows an allow-listed address and an allow-listed domain", async () => {
    const { ownerId, accountId } = await setup();
    expect(await addSendAllow(env.DB, ownerId, accountId, "address", " Pal@Example.org ")).toBe(
      true,
    );
    expect(await addSendAllow(env.DB, ownerId, accountId, "domain", "@Corp.Example.com")).toBe(
      true,
    );
    expect(await addSendAllow(env.DB, ownerId, accountId, "domain", "corp.example.com")).toBe(
      false,
    );
    const calls = installGoogleRoutes([sendRoute()]);
    const res = await call(
      MODE("new_recipients"),
      ownerId,
      "send_message",
      bareArgs(["pal@example.org", "anyone@corp.example.com"]),
    );
    expect(res.json.status).toBeUndefined();
    expect(calls).toHaveLength(1);
    // The domain is exact: a subdomain is not on the list.
    installGoogleRoutes([batchRoute(), ...peopleRoutes(), sendRoute()]);
    const sub = await call(
      MODE("new_recipients"),
      ownerId,
      "send_message",
      bareArgs(["x@sub.corp.example.com"]),
    );
    expect(sub.json.status).toBe("pending_approval");
    const list = await listSendAllow(env.DB, ownerId, accountId);
    expect(list.map((e) => [e.kind, e.value])).toEqual([
      ["domain", "corp.example.com"],
      ["address", "pal@example.org"],
    ]);
    expect(await removeSendAllow(env.DB, ownerId, accountId, "domain", "corp.example.com")).toBe(
      true,
    );
    expect(await removeSendAllow(env.DB, ownerId, accountId, "domain", "corp.example.com")).toBe(
      false,
    );
  });

  it("refuses a freemail domain for kind domain, and bad entries, and another owner's account", async () => {
    const { ownerId, accountId } = await setup();
    for (const d of [
      "gmail.com",
      "Googlemail.com",
      "yahoo.co.uk",
      "outlook.com",
      "hotmail.fr",
      "gmx.de",
      "proton.me",
      "icloud.com",
      "yandex.ru",
      "mail.com",
    ]) {
      await expect(addSendAllow(env.DB, ownerId, accountId, "domain", d)).rejects.toMatchObject({
        code: "invalid_argument",
      });
    }
    expect(isFreemailDomain("example.com")).toBe(false);
    // A single freemail address is fine.
    expect(await addSendAllow(env.DB, ownerId, accountId, "address", "me@gmail.com")).toBe(true);
    for (const bad of ["x@y.com OR from:boss", "a b@c.com", "nodomain"]) {
      await expect(addSendAllow(env.DB, ownerId, accountId, "address", bad)).rejects.toMatchObject({
        code: "invalid_argument",
      });
    }
    await expect(
      addSendAllow(env.DB, "o_other", accountId, "address", "a@b.com"),
    ).rejects.toMatchObject({
      code: "account_not_found",
    });
  });

  it("makes no network call for a cache hit", async () => {
    const { ownerId, accountId } = await setup();
    await recordKnownRecipients(env.DB, accountId, ["cached@example.org"], "history");
    const calls = installGoogleRoutes([sendRoute()]);
    const res = await call(
      MODE("new_recipients"),
      ownerId,
      "send_message",
      bareArgs(["cached@example.org"]),
    );
    expect(res.json.status).toBeUndefined();
    expect(calls.map((c) => c.url)).toEqual([expect.stringContaining(UPLOAD)]);
  });

  it("knows a contact, and caches it so the next send makes no lookup", async () => {
    const { ownerId, accountId } = await setup();
    const calls = installGoogleRoutes([
      batchRoute(),
      ...peopleRoutes(["ada@example.org"]),
      sendRoute(),
    ]);
    const res = await call(
      MODE("new_recipients"),
      ownerId,
      "send_message",
      bareArgs(["ada@example.org"]),
    );
    expect(res.json.status).toBeUndefined();
    expect(sendCalls(calls)).toHaveLength(1);
    const row = await first<{ source: string }>(
      env.DB,
      "SELECT source FROM known_recipients WHERE account_id = ? AND address = ?",
      accountId,
      "ada@example.org",
    );
    expect(row?.source).toBe("contacts");
    const again = installGoogleRoutes([sendRoute()]);
    await call(MODE("new_recipients"), ownerId, "send_message", bareArgs(["ada@example.org"]));
    expect(again).toHaveLength(1);
  });

  it("knows an address other contacts holds", async () => {
    const { ownerId } = await setup();
    installGoogleRoutes([batchRoute(), ...peopleRoutes([], ["oc@example.org"]), sendRoute()]);
    const res = await call(
      MODE("new_recipients"),
      ownerId,
      "send_message",
      bareArgs(["oc@example.org"]),
    );
    expect(res.json.status).toBeUndefined();
  });

  it("knows an address the account has sent to, asking Gmail exactly `in:sent to:<addr>`", async () => {
    const { ownerId, accountId } = await setup();
    const calls = installGoogleRoutes([batchRoute(["old@example.org"]), sendRoute()]);
    const res = await call(
      MODE("new_recipients"),
      ownerId,
      "send_message",
      bareArgs(["Old@Example.org"]),
    );
    expect(res.json.status).toBeUndefined();
    expect(sentQueries(calls)).toEqual(["in:sent to:old@example.org"]);
    const batch = calls.find((c) => c.url === BATCH);
    expect(batch?.body).toContain("maxResults=1");
    expect(batch?.body).toContain("fields=messages%2Fid");
    expect(sendCalls(calls)).toHaveLength(1);
    const row = await first<{ source: string }>(
      env.DB,
      "SELECT source FROM known_recipients WHERE account_id = ? AND address = ?",
      accountId,
      "old@example.org",
    );
    expect(row?.source).toBe("history");
  });

  it("holds an address that is not a plain address and never puts it in a query", async () => {
    const { ownerId } = await setup();
    for (const evil of [
      "x@y.com OR from:boss",
      "a@b.com in:inbox",
      "a@b.com) OR (to:c@d.com",
      '"x"@y.com',
      "a@b.com,c@d.com",
    ]) {
      const calls = installGoogleRoutes([batchRoute(["a@b.com"]), ...peopleRoutes(), sendRoute()]);
      const res = await call(MODE("new_recipients"), ownerId, "send_message", bareArgs([evil]));
      // Held, or refused as malformed: never sent, never in a query.
      expect(sendCalls(calls)).toHaveLength(0);
      for (const q of sentQueries(calls)) {
        expect(q).toMatch(/^in:sent to:[a-z0-9._+-]+@[a-z0-9.-]+$/);
      }
      expect(calls.some((c) => c.url.includes("OR") && c.url.startsWith("https://people"))).toBe(
        false,
      );
      expect(res.json.status === "pending_approval" || res.json.error !== undefined).toBe(true);
    }
    // The normalizer keeps them as text that fails the pattern.
    expect(normalizeRecipients(["x@y.com OR from:boss", "a@b.com in:inbox"])).toEqual([
      "x@y.com or from:boss",
      "a@b.com in:inbox",
    ]);
  });
});

describe("reply, forward and draft sends", () => {
  it("holds a reply to an inbound stranger", async () => {
    const { ownerId, key } = await setup();
    const calls = installGoogleRoutes([
      {
        url: MESSAGE,
        reply: () =>
          googleJson(200, {
            id: fx.original.id,
            threadId: fx.original.threadId,
            payload: {
              mimeType: "text/plain",
              headers: Object.entries(fx.original.headers).map(([name, value]) => ({
                name,
                value,
              })),
              body: { size: 1, data: "aGk" },
            },
          }),
      },
      batchRoute(),
      ...peopleRoutes(),
      sendRoute(),
    ]);
    const res = await call(MODE("new_recipients"), ownerId, "reply", {
      messageId: `${key}:m_orig`,
      body: "x",
    });
    expect(res.json.status).toBe("pending_approval");
    expect(res.json.preview.newRecipients).toEqual(["sam@example.net"]);
    expect(sendCalls(calls)).toHaveLength(0);
    // The inbound sender never became known.
    expect(sentQueries(calls)).toEqual(["in:sent to:sam@example.net"]);
  });

  it("holds a forward to a new address and sends one to a known address", async () => {
    const { ownerId, accountId, key } = await setup();
    await recordKnownRecipients(env.DB, accountId, ["kin@example.org"], "sent");
    const msg: GoogleRoute = {
      url: MESSAGE,
      reply: () =>
        googleJson(200, {
          id: fx.original.id,
          threadId: fx.original.threadId,
          payload: {
            mimeType: "text/plain",
            headers: Object.entries(fx.original.headers).map(([name, value]) => ({ name, value })),
            body: { size: 1, data: "aGk" },
          },
        }),
    };
    installGoogleRoutes([msg, batchRoute(), ...peopleRoutes(), sendRoute()]);
    const held = await call(MODE("new_recipients"), ownerId, "forward", {
      messageId: `${key}:m_orig`,
      to: ["new@example.org"],
    });
    expect(held.json.status).toBe("pending_approval");
    expect(held.json.preview.newRecipients).toEqual(["new@example.org"]);
    const calls = installGoogleRoutes([msg, sendRoute()]);
    const sent = await call(MODE("new_recipients"), ownerId, "forward", {
      messageId: `${key}:m_orig`,
      to: ["kin@example.org"],
    });
    expect(sent.json.status).toBeUndefined();
    expect(sendCalls(calls)).toHaveLength(1);
  });

  it("checks a draft's real recipients, not the call's", async () => {
    const { ownerId, accountId, key } = await setup();
    // dan@example.net is the draft's To (the fixture); the call names nobody.
    const held = installGoogleRoutes([
      { url: DRAFT, reply: () => googleJson(200, rawDraft()) },
      batchRoute(),
      ...peopleRoutes(),
      sendRoute(),
      draftDeleteRoute(),
    ]);
    const res = await call(MODE("new_recipients"), ownerId, "send_message", {
      draftId: `${key}:d1`,
    });
    expect(res.json.status).toBe("pending_approval");
    expect(res.json.preview.newRecipients).toEqual(["dan@example.net"]);
    expect(held.some((c) => c.url.startsWith(UPLOAD))).toBe(false);

    await recordKnownRecipients(env.DB, accountId, ["dan@example.net"], "sent");
    const calls = installGoogleRoutes([
      { url: DRAFT, reply: () => googleJson(200, rawDraft()) },
      sendRoute(),
      draftDeleteRoute(),
    ]);
    const sent = await call(MODE("new_recipients"), ownerId, "send_message", {
      draftId: `${key}:d1`,
    });
    expect(JSON.stringify(sent.json)).not.toContain("error");
    expect(sendCalls(calls)).toHaveLength(1);
  });
});

describe("calendar notifications", () => {
  const create = {
    summary: "Planning",
    startTime: "2030-01-07T10:00:00+01:00",
    endTime: "2030-01-07T11:00:00+01:00",
    attendeeEmails: ["Outsider@Example.net"],
    notificationLevel: "ALL",
  };
  const createRoute = (): GoogleRoute => ({
    method: "POST",
    url: EVENTS,
    reply: () => googleJson(200, calendarFx.event),
  });

  it("holds an invitation to a new outsider, and not one to a known address", async () => {
    const { ownerId, accountId } = await setup();
    const held = installGoogleRoutes([batchRoute(), ...peopleRoutes(), createRoute()]);
    const res = await call(MODE("new_recipients"), ownerId, "create_event", create);
    expect(res.json.status).toBe("pending_approval");
    expect(res.json.preview.newRecipients).toEqual(["outsider@example.net"]);
    expect(held.some((c) => c.url.startsWith(EVENTS))).toBe(false);

    await recordKnownRecipients(env.DB, accountId, ["outsider@example.net"], "sent");
    const calls = installGoogleRoutes([createRoute()]);
    const ok = await call(MODE("new_recipients"), ownerId, "create_event", create);
    expect(ok.json.status).toBeUndefined();
    expect(calls.some((c) => c.url.startsWith(EVENTS))).toBe(true);
  });

  describe("an update, delete or response checked against the guests it would email", () => {
    const EVENT = `${EVENTS}/evt1`;
    const tagged = { ...calendarFx.event, etag: '"e1"' };
    /** The same event with one more guest: an outsider added after the hold. */
    const withOutsider = {
      ...tagged,
      etag: '"e2"',
      attendees: [
        ...calendarFx.event.attendees,
        { email: "late@attacker.test", responseStatus: "needsAction" },
      ],
    };
    const known = ["boss@example.com", "guest@example.com"];
    const patchRoute = (): GoogleRoute => ({
      method: "PATCH",
      url: EVENT,
      reply: () => googleJson(200, tagged),
    });
    const update = { eventId: "evt1", summary: "Renamed", notificationLevel: "ALL" };

    it("refuses a held update, once approved, whose event gained a guest", async () => {
      const { ownerId } = await setup();
      const e = MODE("all");
      installGoogleRoutes([
        { url: EVENT, reply: () => googleJson(200, tagged) },
        batchRoute(),
        ...peopleRoutes(),
        patchRoute(),
      ]);
      const id = await heldWithGrant(e, ownerId, "update_event", update);
      const row = await first<PendingActionRow>(
        env.DB,
        "SELECT * FROM pending_actions WHERE id = ?",
        id,
      );
      expect(JSON.parse(row?.params ?? "{}").args.checkedRecipients).toEqual(known);
      const page = await approvals(e, ownerId, id);
      const calls = installGoogleRoutes([
        { url: EVENT, reply: () => googleJson(200, withOutsider) },
        patchRoute(),
      ]);
      await page.approve();
      expect((await page.row())?.status).toBe("failed");
      expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
    });

    it("sends a held update whose guests are the ones that were checked, if-match the event", async () => {
      const { ownerId } = await setup();
      const e = MODE("all");
      installGoogleRoutes([
        { url: EVENT, reply: () => googleJson(200, tagged) },
        batchRoute(),
        ...peopleRoutes(),
      ]);
      const id = await heldWithGrant(e, ownerId, "update_event", update);
      const page = await approvals(e, ownerId, id);
      let ifMatch: string | null = null;
      const calls = installGoogleRoutes([
        { url: EVENT, reply: () => googleJson(200, tagged) },
        {
          method: "PATCH",
          url: EVENT,
          reply: (req) => {
            ifMatch = req.headers.get("If-Match");
            return googleJson(200, tagged);
          },
        },
      ]);
      await page.approve();
      expect((await page.row())?.status).toBe("executed");
      const patch = calls.find((c) => c.method === "PATCH");
      expect(new URL(patch?.url ?? "").searchParams.get("sendUpdates")).toBe("all");
      expect(ifMatch).toBe('"e1"');
    });

    for (const [tool, args] of [
      ["update_event", update],
      ["delete_event", { eventId: "evt1", notificationLevel: "ALL" }],
      [
        "respond_to_event",
        { eventId: "evt1", responseStatus: "accepted", notificationLevel: "ALL" },
      ],
    ] as const) {
      it(`${tool}: refuses on the direct path when the fresh plan has a guest nobody checked`, async () => {
        const { ownerId, accountId } = await setup();
        await recordKnownRecipients(env.DB, accountId, known, "sent");
        await recordKnownRecipients(env.DB, accountId, ["late@attacker.test"], "sent");
        // Every address is known, so nothing is held; the guest list differs only by the time the
        // handler reads it. Known-ness cannot be what refuses it: the checked set is.
        let reads = 0;
        const calls = installGoogleRoutes([
          {
            url: EVENT,
            // A response mails only the organizer, so for it the organizer is the one that changes.
            reply: () =>
              googleJson(
                200,
                reads++ === 0
                  ? tagged
                  : tool === "respond_to_event"
                    ? { ...withOutsider, organizer: { email: "late@attacker.test" } }
                    : withOutsider,
              ),
          },
          patchRoute(),
          { method: "DELETE", url: EVENT, reply: () => new Response(null, { status: 204 }) },
        ]);
        const res = await call(MODE("new_recipients"), ownerId, tool, args);
        expect(res.json.status).toBeUndefined();
        expect(res.json.error?.message ?? "").toContain("not the ones that were checked");
        expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
      });
    }

    it("sends the etag the plan was made from, so a changed event is refused by Google", async () => {
      const { ownerId, accountId } = await setup();
      await recordKnownRecipients(env.DB, accountId, known, "sent");
      let ifMatch: string | null = null;
      installGoogleRoutes([
        { url: EVENT, reply: () => googleJson(200, tagged) },
        {
          method: "PATCH",
          url: EVENT,
          reply: (req) => {
            ifMatch = req.headers.get("If-Match");
            return googleJson(412, { error: { code: 412, message: "Precondition Failed" } });
          },
        },
      ]);
      const res = await call(MODE("new_recipients"), ownerId, "update_event", update);
      expect(ifMatch).toBe('"e1"');
      expect(res.json.error.message).toContain("changed while this change was being sent");
    });

    it("delete_event sends the etag it planned on, and refuses a notifying delete without one", async () => {
      const { ownerId, accountId } = await setup();
      await recordKnownRecipients(env.DB, accountId, known, "sent");
      let ifMatch: string | null = null;
      installGoogleRoutes([
        { url: EVENT, reply: () => googleJson(200, tagged) },
        {
          method: "DELETE",
          url: EVENT,
          reply: (req) => {
            ifMatch = req.headers.get("If-Match");
            return new Response(null, { status: 204 });
          },
        },
      ]);
      const args = { eventId: "evt1", notificationLevel: "ALL" };
      const ok = await call(MODE("new_recipients"), ownerId, "delete_event", args);
      expect(ok.isError).toBe(false);
      expect(ifMatch).toBe('"e1"');

      // No etag in the answer: a delete that would email guests is not made unprotected.
      const { etag: _etag, ...untagged } = tagged;
      const calls = installGoogleRoutes([
        { url: EVENT, reply: () => googleJson(200, untagged) },
        { method: "DELETE", url: EVENT, reply: () => new Response(null, { status: 204 }) },
      ]);
      const refused = await call(MODE("new_recipients"), ownerId, "delete_event", args);
      expect(refused.isError).toBe(true);
      expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    });

    it("sets no precondition when nobody is notified", async () => {
      const { ownerId } = await setup();
      let ifMatch: string | null = "unset";
      installGoogleRoutes([
        {
          method: "PATCH",
          url: EVENT,
          reply: (req) => {
            ifMatch = req.headers.get("If-Match");
            return googleJson(200, tagged);
          },
        },
      ]);
      const res = await call(MODE("new_recipients"), ownerId, "update_event", {
        eventId: "evt1",
        summary: "Renamed",
      });
      expect(res.isError).toBe(false);
      expect(ifMatch).toBeNull();
    });
  });

  it("records the invitees as known once the invitation went out", async () => {
    const { ownerId, accountId } = await setup();
    installGoogleRoutes([createRoute()]);
    await call(MODE("off"), ownerId, "create_event", create);
    const rows = await all<{ address: string }>(
      env.DB,
      "SELECT address FROM known_recipients WHERE account_id = ?",
      accountId,
    );
    expect(rows.map((r) => r.address)).toEqual(["outsider@example.net"]);
  });
});

describe("the modes", () => {
  it("all holds everything, even a known recipient", async () => {
    const { ownerId, accountId } = await setup();
    await recordKnownRecipients(env.DB, accountId, ["bob@example.com"], "sent");
    const calls = installGoogleRoutes([sendRoute()]);
    const res = await call(MODE("all"), ownerId, "send_message", bareArgs(["bob@example.com"]));
    expect(res.json.status).toBe("pending_approval");
    expect(sendCalls(calls)).toHaveLength(0);
  });

  it("off holds nothing, even a stranger", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([sendRoute()]);
    const res = await call(
      MODE("off"),
      ownerId,
      "send_message",
      bareArgs(["stranger@example.org"]),
    );
    expect(res.json.status).toBeUndefined();
    expect(sendCalls(calls)).toHaveLength(1);
  });

  it("with the mode unset, SEND_REQUIRES_CONFIRM=true behaves as all, and unset alone as new_recipients", async () => {
    const { ownerId, accountId } = await setup();
    await recordKnownRecipients(env.DB, accountId, ["bob@example.com"], "sent");
    installGoogleRoutes([sendRoute()]);
    const held = await call(
      withEnv({
        SEND_ENABLED: "true",
        SEND_APPROVAL_MODE: undefined,
        SEND_REQUIRES_CONFIRM: "true",
      }),
      ownerId,
      "send_message",
      bareArgs(["bob@example.com"]),
    );
    expect(held.json.status).toBe("pending_approval");
    expect(
      config(withEnv({ SEND_APPROVAL_MODE: undefined, SEND_REQUIRES_CONFIRM: "true" }))
        .sendApprovalMode,
    ).toBe("all");
    expect(
      config(withEnv({ SEND_APPROVAL_MODE: undefined, SEND_REQUIRES_CONFIRM: undefined }))
        .sendApprovalMode,
    ).toBe("new_recipients");
    expect(
      config(withEnv({ SEND_APPROVAL_MODE: "off", SEND_REQUIRES_CONFIRM: "true" }))
        .sendApprovalMode,
    ).toBe("off");
    expect(() => config(withEnv({ SEND_APPROVAL_MODE: "sometimes" }))).toThrow();
  });

  it("keeps the caps and the sending switch in every mode", async () => {
    const { ownerId } = await setup();
    const many = Array.from({ length: 4 }, (_, i) => `r${i}@example.org`);
    for (const mode of ["new_recipients", "all", "off"]) {
      installGoogleRoutes([batchRoute(), ...peopleRoutes(), sendRoute()]);
      const over = await call(
        withEnv({ SEND_ENABLED: "true", SEND_APPROVAL_MODE: mode, MAX_RECIPIENTS: "3" }),
        ownerId,
        "send_message",
        bareArgs(many),
      );
      expect(over.json.error?.code).toBe("too_many_recipients");
      const off = await call(
        withEnv({ SEND_ENABLED: "false", SEND_APPROVAL_MODE: mode }),
        ownerId,
        "send_message",
        bareArgs(["bob@example.com"]),
      );
      expect(off.json.error?.code).toBe("send_disabled");
    }
  });
});

/** The owner's approvals page for one pending action, as the owner's browser would use it. */
async function approvals(e: Env, ownerId: string, id: string) {
  const app = new Hono<{ Bindings: Env }>().route("/", guardrailsRoutes(registry));
  const { setCookie } = await createSession(e, ownerId, "owner@example.com");
  const cookie = setCookie.split(";")[0] ?? "";
  expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
  const fetchPage = async (env2: Env, init: { method?: string; form?: Record<string, string> }) => {
    const exec = createExecutionContext();
    const res = await app.fetch(
      new Request(`${ISSUER}/approvals/${id}`, {
        method: init.method ?? "GET",
        headers: { Cookie: cookie },
        body: init.form ? new URLSearchParams(init.form) : undefined,
      }),
      env2,
      exec,
    );
    await waitOnExecutionContext(exec);
    return res;
  };
  const csrf =
    (await (await fetchPage(e, {})).text()).match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
  return {
    approve: (env2: Env = e) =>
      fetchPage(env2, { method: "POST", form: { decision: "approve", csrf } }),
    row: () => first<PendingActionRow>(env.DB, "SELECT * FROM pending_actions WHERE id = ?", id),
  };
}

const heldWithGrant = async (
  e: Env,
  ownerId: string,
  name: string,
  args: Record<string, unknown>,
) => {
  const token = await mintToken({ kind: "full", scopes: SCOPES.full, ownerId });
  const held = await call(e, ownerId, name, args, token);
  const id = held.json.pendingActionId as string;
  expect(id).toMatch(/^pa_/);
  return id;
};

describe("the approved send", () => {
  const knownRow = (accountId: string, address: string) =>
    first<{ address: string }>(
      env.DB,
      "SELECT address FROM known_recipients WHERE account_id = ? AND address = ?",
      accountId,
      address,
    );

  it("goes out once on approval and records its recipients as known", async () => {
    const { ownerId, accountId } = await setup();
    const e = MODE("new_recipients");
    installGoogleRoutes([batchRoute(), ...peopleRoutes(), sendRoute()]);
    const id = await heldWithGrant(e, ownerId, "send_message", bareArgs(["fresh@example.org"]));
    expect(await knownRow(accountId, "fresh@example.org")).toBeNull();

    const page = await approvals(e, ownerId, id);
    const calls = installGoogleRoutes([sendRoute()]);
    expect((await page.approve()).status).toBeLessThan(500);
    expect((await page.row())?.status).toBe("executed");
    expect(sendCalls(calls)).toHaveLength(1);
    expect(await knownRow(accountId, "fresh@example.org")).not.toBeNull();
  });

  it("still refuses when sending was switched off after the hold", async () => {
    const { ownerId, accountId } = await setup();
    const e = MODE("new_recipients");
    installGoogleRoutes([batchRoute(), ...peopleRoutes(), sendRoute()]);
    const id = await heldWithGrant(e, ownerId, "send_message", bareArgs(["fresh@example.org"]));
    const page = await approvals(e, ownerId, id);
    const calls = installGoogleRoutes([sendRoute()]);
    await page.approve(withEnv({ SEND_ENABLED: "false", SEND_APPROVAL_MODE: "new_recipients" }));
    expect((await page.row())?.status).toBe("failed");
    expect(sendCalls(calls)).toHaveLength(0);
    expect(await knownRow(accountId, "fresh@example.org")).toBeNull();
  });

  it("sends a held draft that is unchanged", async () => {
    const { ownerId, accountId, key } = await setup();
    const e = MODE("new_recipients");
    installGoogleRoutes([
      { url: DRAFT, reply: () => googleJson(200, rawDraft()) },
      batchRoute(),
      ...peopleRoutes(),
    ]);
    const id = await heldWithGrant(e, ownerId, "send_message", { draftId: `${key}:d1` });
    const page = await approvals(e, ownerId, id);
    const calls = installGoogleRoutes([
      { url: DRAFT, reply: () => googleJson(200, rawDraft()) },
      sendRoute(),
      draftDeleteRoute(),
    ]);
    await page.approve();
    expect((await page.row())?.status).toBe("executed");
    expect(sendCalls(calls)).toHaveLength(1);
    expect(await knownRow(accountId, "dan@example.net")).not.toBeNull();
  });

  for (const mode of ["new_recipients", "all"]) {
    it(`refuses a held draft that gained a recipient after the hold (mode ${mode})`, async () => {
      const { ownerId, key } = await setup();
      const e = MODE(mode);
      installGoogleRoutes([
        { url: DRAFT, reply: () => googleJson(200, rawDraft()) },
        batchRoute(),
        ...peopleRoutes(),
      ]);
      const id = await heldWithGrant(e, ownerId, "send_message", { draftId: `${key}:d1` });
      const page = await approvals(e, ownerId, id);
      // The draft is edited after the owner's preview: an outsider is added.
      const edited = rawDraft({ to: "dan@example.net, evil@attacker.test" });
      const calls = installGoogleRoutes([
        { url: DRAFT, reply: () => googleJson(200, edited) },
        sendRoute(),
        draftDeleteRoute(),
      ]);
      await page.approve();
      expect((await page.row())?.status).toBe("failed");
      expect(sendCalls(calls)).toHaveLength(0);
    });
  }

  it("ignores a checkedRecipients value the caller supplies", async () => {
    const { ownerId, key } = await setup();
    const e = MODE("new_recipients");
    installGoogleRoutes([
      { url: DRAFT, reply: () => googleJson(200, rawDraft()) },
      batchRoute(),
      ...peopleRoutes(),
    ]);
    const id = await heldWithGrant(e, ownerId, "send_message", {
      draftId: `${key}:d1`,
      checkedRecipients: ["dan@example.net", "evil@attacker.test"],
    });
    const row = await first<PendingActionRow>(
      env.DB,
      "SELECT * FROM pending_actions WHERE id = ?",
      id,
    );
    expect(JSON.parse(row?.params ?? "{}").args.checkedRecipients).toEqual(["dan@example.net"]);
  });

  for (const [mode, readsBeforeSend] of [
    ["off", 1],
    ["new_recipients", 2],
  ] as const) {
    it(`sends only the checked bytes when the draft is edited after the read (mode ${mode})`, async () => {
      const { ownerId, accountId, key } = await setup();
      await recordKnownRecipients(env.DB, accountId, ["dan@example.net"], "sent");
      const checked = rawDraft();
      const edited = rawDraft({ to: "dan@example.net, evil@attacker.test" });
      // The draft as Gmail holds it: a concurrent update_draft lands right after the last read
      // this call makes before it sends, so anything that read the draft again would see `edited`.
      let live = checked;
      let reads = 0;
      let sentBody = "";
      const calls = installGoogleRoutes([
        {
          url: DRAFT,
          reply: () => {
            const answer = googleJson(200, live);
            reads += 1;
            if (reads === readsBeforeSend) live = edited;
            return answer;
          },
        },
        {
          method: "POST",
          url: UPLOAD,
          reply: async (req) => {
            sentBody = await req.text();
            return sentAnswer();
          },
        },
        draftDeleteRoute(),
      ]);
      const res = await call(MODE(mode), ownerId, "send_message", { draftId: `${key}:d1` });
      expect(res.isError).toBe(false);
      expect(res.json.status).toBeUndefined();
      expect(reads).toBe(readsBeforeSend);
      expect(sentBody).toBe(atob(checked.message.raw.replace(/-/g, "+").replace(/_/g, "/")));
      expect(sentBody).toContain("dan@example.net");
      expect(sentBody).not.toContain("evil@attacker.test");
      // The draft is deleted after it was sent, as `drafts.send` would have.
      const methods = calls.map((c) => c.method);
      expect(methods.at(-2)).toBe("POST");
      expect(methods.at(-1)).toBe("DELETE");
    });
  }

  it("records the recipients of a send that was not held", async () => {
    const { ownerId, accountId } = await setup();
    installGoogleRoutes([sendRoute()]);
    await call(
      MODE("off"),
      ownerId,
      "send_message",
      bareArgs(["Bob <Bob@Example.com>"], { cc: ["cy@example.com"] }),
    );
    const rows = await all<{ address: string; source: string }>(
      env.DB,
      "SELECT address, source FROM known_recipients WHERE account_id = ? ORDER BY address",
      accountId,
    );
    expect(rows).toEqual([
      { address: "bob@example.com", source: "sent" },
      { address: "cy@example.com", source: "sent" },
    ]);
  });
});

describe("the subrequest budget", () => {
  /** The Free plan allows 50 subrequests per request. */
  const MAX_CHECK_CALLS = 15;

  it("holds 20 new recipients in at most 15 calls", async () => {
    const { ownerId } = await setup();
    const to = Array.from({ length: 20 }, (_, i) => `n${i}@example.org`);
    const calls = installGoogleRoutes([batchRoute(), ...peopleRoutes(), sendRoute()]);
    const res = await call(MODE("new_recipients"), ownerId, "send_message", bareArgs(to));
    expect(res.json.status).toBe("pending_approval");
    expect(res.json.preview.newRecipients).toHaveLength(20);
    expect(calls.length).toBeLessThanOrEqual(MAX_CHECK_CALLS);
    expect(sentQueries(calls)).toHaveLength(20);
    expect(calls.filter((c) => c.url === BATCH)).toHaveLength(1);
  });

  it("sends 20 recipients the account has written to in 2 calls (one batch, one send)", async () => {
    const { ownerId } = await setup();
    const to = Array.from({ length: 20 }, (_, i) => `h${i}@example.org`);
    const calls = installGoogleRoutes([batchRoute(to), ...peopleRoutes(), sendRoute()]);
    const res = await call(MODE("new_recipients"), ownerId, "send_message", bareArgs(to));
    expect(res.json.status).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it("sends 20 cached recipients in 1 call", async () => {
    const { ownerId, accountId } = await setup();
    const to = Array.from({ length: 20 }, (_, i) => `c${i}@example.org`);
    await recordKnownRecipients(env.DB, accountId, to, "sent");
    const calls = installGoogleRoutes([sendRoute()]);
    const res = await call(MODE("new_recipients"), ownerId, "send_message", bareArgs(to));
    expect(res.json.status).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});
