import { afterEach, describe, expect, it, vi } from "vitest";
import { SCOPES } from "../src/auth/endpoints";
import { googleJson, installGoogleRoutes, linkGoogleAccount, newOwner } from "./helpers/google";
import { mcpRpc, toolJson } from "./helpers/mcp";
import { mintToken } from "./helpers/tokens";

afterEach(() => vi.restoreAllMocks());

const G = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOOLS = [
  "update_thread_state",
  "update_message_state",
  "mark_message_spam",
  "unmark_message_spam",
  "mark_thread_spam",
  "unmark_thread_spam",
  "trash_message",
  "untrash_message",
  "trash_thread",
  "untrash_thread",
  "apply_sensitive_message_label",
  "apply_sensitive_thread_label",
];

async function call(ownerId: string, name: string, args: Record<string, unknown>) {
  const token = await mintToken({ kind: "full", scopes: SCOPES.full, ownerId });
  const { result } = await mcpRpc(token, "full", "tools/call", { name, arguments: args });
  return {
    isError: (result as { isError?: boolean }).isError === true,
    json: toolJson(result) as Record<string, unknown> & { error?: { code: string } },
  };
}

async function setup() {
  const ownerId = await newOwner();
  await linkGoogleAccount(ownerId, { label: "work" });
  return ownerId;
}

const ok = (id: string) => () => googleJson(200, { id });
const bodies = (calls: { body: string }[]) => calls.map((c) => JSON.parse(c.body || "{}"));

describe("endpoints and annotations", () => {
  it("all tools are on full and absent from ro", async () => {
    const ownerId = await setup();
    for (const [kind, expected] of [
      ["full", true],
      ["ro", false],
    ] as const) {
      const token = await mintToken({ kind, scopes: SCOPES[kind], ownerId });
      const { result } = await mcpRpc(token, kind, "tools/list");
      const tools = (
        result as { tools: { name: string; annotations?: { destructiveHint?: boolean } }[] }
      ).tools;
      const names = tools.map((t) => t.name);
      for (const t of TOOLS) expect(names.includes(t)).toBe(expected);
      if (kind === "full") {
        for (const t of TOOLS.slice(2)) {
          expect(tools.find((x) => x.name === t)?.annotations?.destructiveHint).toBe(true);
        }
      }
    }
  });
});

describe("update_*_state", () => {
  it("archive removes INBOX and unarchive adds it", async () => {
    const ownerId = await setup();
    const calls = installGoogleRoutes([
      { method: "POST", url: `${G}/messages/m1/modify`, reply: ok("m1") },
    ]);
    const a = await call(ownerId, "update_message_state", { messageId: "m1", archived: true });
    await call(ownerId, "update_message_state", { messageId: "m1", archived: false });
    expect(a.isError).toBe(false);
    expect(a.json.messageId).toMatch(/^a\d+:m1$/);
    expect(bodies(calls)).toEqual([{ removeLabelIds: ["INBOX"] }, { addLabelIds: ["INBOX"] }]);
  });

  it("read and unread toggle UNREAD; starred toggles STARRED; combined in one call", async () => {
    const ownerId = await setup();
    const calls = installGoogleRoutes([
      { method: "POST", url: `${G}/threads/t1/modify`, reply: ok("t1") },
    ]);
    await call(ownerId, "update_thread_state", { threadId: "t1", read: true });
    await call(ownerId, "update_thread_state", { threadId: "t1", read: false });
    await call(ownerId, "update_thread_state", {
      threadId: "t1",
      starred: true,
      archived: true,
    });
    expect(bodies(calls)).toEqual([
      { removeLabelIds: ["UNREAD"] },
      { addLabelIds: ["UNREAD"] },
      { addLabelIds: ["STARRED"], removeLabelIds: ["INBOX"] },
    ]);
  });

  it("refuses a call with no flag", async () => {
    const ownerId = await setup();
    installGoogleRoutes([]);
    const res = await call(ownerId, "update_thread_state", { threadId: "t1" });
    expect(res.json.error?.code).toBe("invalid_argument");
  });
});

describe("spam", () => {
  it("thread spam uses the thread modify endpoint; message spam the message one", async () => {
    const ownerId = await setup();
    const calls = installGoogleRoutes([
      { method: "POST", url: `${G}/threads/t1/modify`, reply: ok("t1") },
      { method: "POST", url: `${G}/messages/m1/modify`, reply: ok("m1") },
    ]);
    await call(ownerId, "mark_thread_spam", { threadId: "t1" });
    await call(ownerId, "unmark_thread_spam", { threadId: "t1" });
    await call(ownerId, "mark_message_spam", { messageId: "m1" });
    await call(ownerId, "unmark_message_spam", { messageId: "m1" });
    expect(calls.map((c) => new URL(c.url).pathname.split("/").slice(-3).join("/"))).toEqual([
      "threads/t1/modify",
      "threads/t1/modify",
      "messages/m1/modify",
      "messages/m1/modify",
    ]);
    expect(bodies(calls)).toEqual([
      { addLabelIds: ["SPAM"], removeLabelIds: ["INBOX"] },
      { addLabelIds: ["INBOX"], removeLabelIds: ["SPAM"] },
      { addLabelIds: ["SPAM"], removeLabelIds: ["INBOX"] },
      { addLabelIds: ["INBOX"], removeLabelIds: ["SPAM"] },
    ]);
  });
});

describe("trash", () => {
  it("trash and untrash call the right endpoints", async () => {
    const ownerId = await setup();
    const calls = installGoogleRoutes([
      { method: "POST", url: `${G}/messages/m1/trash`, reply: ok("m1") },
      { method: "POST", url: `${G}/messages/m1/untrash`, reply: ok("m1") },
      { method: "POST", url: `${G}/threads/t1/trash`, reply: ok("t1") },
      { method: "POST", url: `${G}/threads/t1/untrash`, reply: ok("t1") },
    ]);
    await call(ownerId, "trash_message", { messageId: "m1" });
    await call(ownerId, "untrash_message", { messageId: "m1" });
    await call(ownerId, "trash_thread", { threadId: "t1" });
    const last = await call(ownerId, "untrash_thread", { threadId: "t1" });
    expect(last.json.threadId).toMatch(/^a\d+:t1$/);
    expect(calls.map((c) => new URL(c.url).pathname.split("/").slice(-3).join("/"))).toEqual([
      "messages/m1/trash",
      "messages/m1/untrash",
      "threads/t1/trash",
      "threads/t1/untrash",
    ]);
  });

  it.each([
    [404, "not_found"],
    [429, "rate_limited"],
  ])("maps Google %i to %s", async (status, code) => {
    const ownerId = await setup();
    installGoogleRoutes([
      { method: "POST", url: `${G}/messages/m1/trash`, reply: () => googleJson(status, {}) },
    ]);
    const res = await call(ownerId, "trash_message", { messageId: "m1" });
    expect(res.json.error?.code).toBe(code);
  });

  it("maps a 403 permission error without leaking", async () => {
    const ownerId = await setup();
    installGoogleRoutes([
      {
        method: "POST",
        url: `${G}/messages/m1/trash`,
        reply: () =>
          googleJson(403, { error: { errors: [{ reason: "insufficientPermissions" }] } }),
      },
    ]);
    const res = await call(ownerId, "trash_message", { messageId: "m1" });
    expect(["needs_relink", "component_disabled"]).toContain(res.json.error?.code);
  });

  it("answers component_disabled when mail is off", async () => {
    const ownerId = await newOwner();
    await linkGoogleAccount(ownerId, { label: "work", components: ["calendar"] });
    installGoogleRoutes([]);
    const res = await call(ownerId, "trash_thread", { threadId: "t1" });
    expect(res.json.error?.code).toBe("component_disabled");
  });
});

describe("apply_sensitive_*_label", () => {
  it("TRASH trashes and SPAM marks spam", async () => {
    const ownerId = await setup();
    const calls = installGoogleRoutes([
      { method: "POST", url: `${G}/messages/m1/trash`, reply: ok("m1") },
      { method: "POST", url: `${G}/threads/t1/modify`, reply: ok("t1") },
    ]);
    await call(ownerId, "apply_sensitive_message_label", { messageId: "m1", labelOption: "TRASH" });
    const res = await call(ownerId, "apply_sensitive_thread_label", {
      threadId: "t1",
      labelOption: "SPAM",
    });
    expect(res.json.labelOption).toBe("SPAM");
    expect(calls.map((c) => new URL(c.url).pathname.split("/").slice(-3).join("/"))).toEqual([
      "messages/m1/trash",
      "threads/t1/modify",
    ]);
  });

  it("rejects LABEL_OPTION_UNSPECIFIED without calling Google", async () => {
    const ownerId = await setup();
    const calls = installGoogleRoutes([]);
    const res = await call(ownerId, "apply_sensitive_message_label", {
      messageId: "m1",
      labelOption: "LABEL_OPTION_UNSPECIFIED",
    });
    expect(res.json.error?.code).toBe("invalid_argument");
    expect(calls).toHaveLength(0);
  });

  it.each(["INBOX", "DELETE"])("rejects labelOption %s at the schema", async (labelOption) => {
    const ownerId = await setup();
    const calls = installGoogleRoutes([]);
    const token = await mintToken({ kind: "full", scopes: SCOPES.full, ownerId });
    const { result } = await mcpRpc(token, "full", "tools/call", {
      name: "apply_sensitive_thread_label",
      arguments: { threadId: "t1", labelOption },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
