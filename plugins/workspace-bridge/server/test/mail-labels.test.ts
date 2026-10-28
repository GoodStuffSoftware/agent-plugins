import { afterEach, describe, expect, it, vi } from "vitest";
import { SCOPES } from "../src/auth/endpoints";
import { googleJson, installGoogleRoutes, linkGoogleAccount, newOwner } from "./helpers/google";
import { mcpRpc, toolJson } from "./helpers/mcp";
import { mintToken } from "./helpers/tokens";

afterEach(() => vi.restoreAllMocks());

const G = "https://gmail.googleapis.com/gmail/v1/users/me";
const WRITE_TOOLS = [
  "create_label",
  "update_label",
  "delete_label",
  "label_message",
  "unlabel_message",
  "label_thread",
  "unlabel_thread",
  "update_message_labels",
];

async function call(
  ownerId: string,
  name: string,
  args: Record<string, unknown>,
  kind: "full" | "ro" = "full",
) {
  const token = await mintToken({ kind, scopes: SCOPES[kind], ownerId });
  const { result } = await mcpRpc(token, kind, "tools/call", { name, arguments: args });
  return {
    isError: (result as { isError?: boolean }).isError === true,
    json: toolJson(result) as Record<string, unknown> & { error?: { code: string } },
  };
}

async function setup(opts: Parameters<typeof linkGoogleAccount>[1] = {}) {
  const ownerId = await newOwner();
  const acct = await linkGoogleAccount(ownerId, { label: "work", ...opts });
  return { ownerId, ...acct };
}

describe("endpoints", () => {
  it("list_labels is on ro; write tools are full only", async () => {
    const { ownerId } = await setup();
    for (const [kind, expectWrite] of [
      ["full", true],
      ["ro", false],
    ] as const) {
      const token = await mintToken({ kind, scopes: SCOPES[kind], ownerId });
      const { result } = await mcpRpc(token, kind, "tools/list");
      const names = (result as { tools: { name: string }[] }).tools.map((t) => t.name);
      expect(names).toContain("list_labels");
      for (const w of WRITE_TOOLS) expect(names.includes(w)).toBe(expectWrite);
    }
  });
});

describe("list_labels", () => {
  it("returns prefixed ids, system ids included, and sends fields=", async () => {
    const { ownerId, accessToken } = await setup();
    const calls = installGoogleRoutes([
      {
        url: `${G}/labels`,
        reply: () =>
          googleJson(200, {
            labels: [
              { id: "INBOX", name: "INBOX", type: "system" },
              { id: "Label_1", name: "Receipts", type: "user", labelListVisibility: "labelShow" },
            ],
          }),
      },
    ]);
    const { json } = await call(ownerId, "list_labels", {}, "ro");
    const labels = json.labels as { id: string; type: string }[];
    expect(labels.map((l) => l.id)).toEqual([
      expect.stringMatching(/^a\d+:INBOX$/),
      expect.stringMatching(/^a\d+:Label_1$/),
    ]);
    expect(labels[0]?.type).toBe("system");
    expect(calls[0]?.authorization).toBe(`Bearer ${accessToken}`);
    expect(new URL(calls[0]?.url ?? "").searchParams.get("fields")).toContain("labels(id,name");
  });

  it("answers component_disabled when mail is off", async () => {
    const { ownerId } = await setup({ components: ["calendar"] });
    installGoogleRoutes([]);
    const res = await call(ownerId, "list_labels", {});
    expect(res.isError).toBe(true);
    expect(res.json.error?.code).toBe("component_disabled");
  });

  it.each([
    [404, "not_found"],
    [429, "rate_limited"],
  ])("maps Google %i to %s", async (status, code) => {
    const { ownerId } = await setup();
    installGoogleRoutes([{ url: `${G}/labels`, reply: () => googleJson(status, { error: {} }) }]);
    const res = await call(ownerId, "list_labels", {});
    expect(res.json.error?.code).toBe(code);
  });

  it("maps a 403 insufficient scope to needs_relink or component_disabled, not a leak", async () => {
    const { ownerId } = await setup();
    installGoogleRoutes([
      {
        url: `${G}/labels`,
        reply: () =>
          googleJson(403, { error: { errors: [{ reason: "insufficientPermissions" }] } }),
      },
    ]);
    const res = await call(ownerId, "list_labels", {});
    expect(res.isError).toBe(true);
    expect(["needs_relink", "component_disabled"]).toContain(res.json.error?.code);
  });
});

describe("create_label", () => {
  it("posts the label with a color preset and returns a prefixed id", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([
      {
        method: "POST",
        url: `${G}/labels`,
        reply: () =>
          googleJson(200, {
            id: "Label_9",
            name: "Projects/Alpha",
            type: "user",
            color: { backgroundColor: "#4a86e8", textColor: "#ffffff" },
          }),
      },
    ]);
    const res = await call(ownerId, "create_label", {
      displayName: "Projects/Alpha",
      colorPreset: "LABEL_COLOR_PRESET_BLUE",
      labelListVisibility: "LABEL_SHOW",
    });
    expect(res.isError).toBe(false);
    expect((res.json.label as { id: string }).id).toMatch(/^a\d+:Label_9$/);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      name: "Projects/Alpha",
      labelListVisibility: "LABEL_SHOW",
      color: { backgroundColor: "#4a86e8", textColor: "#ffffff" },
    });
  });

  it("maps Google's 409 for an existing label to invalid_argument", async () => {
    const { ownerId } = await setup();
    installGoogleRoutes([
      {
        method: "POST",
        url: `${G}/labels`,
        reply: () => googleJson(409, { error: { code: 409, message: "Label name exists" } }),
      },
    ]);
    const res = await call(ownerId, "create_label", { displayName: "Receipts" });
    expect(res.isError).toBe(true);
    expect(res.json.error?.code).toBe("invalid_argument");
    expect(JSON.stringify(res.json)).toContain("already exists");
  });

  it("is refused on /mcp/ro", async () => {
    const { ownerId } = await setup();
    const token = await mintToken({ kind: "ro", scopes: SCOPES.ro, ownerId });
    const { result, error } = await mcpRpc(token, "ro", "tools/call", {
      name: "create_label",
      arguments: { displayName: "x" },
    });
    const refused =
      error !== undefined || (result as { isError?: boolean } | undefined)?.isError === true;
    expect(refused).toBe(true);
  });
});

describe("update_label and delete_label", () => {
  it("patches only the given fields, with the bare provider id in the URL", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([
      {
        method: "PATCH",
        url: `${G}/labels/Label_1`,
        reply: () => googleJson(200, { id: "Label_1", name: "Bills", type: "user" }),
      },
    ]);
    const res = await call(ownerId, "update_label", { labelId: "Label_1", displayName: "Bills" });
    expect(res.isError).toBe(false);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ name: "Bills" });
  });

  it("update_label with nothing to change is invalid_argument", async () => {
    const { ownerId } = await setup();
    installGoogleRoutes([]);
    const res = await call(ownerId, "update_label", { labelId: "Label_1" });
    expect(res.json.error?.code).toBe("invalid_argument");
  });

  it("update_label maps 409 to invalid_argument", async () => {
    const { ownerId } = await setup();
    installGoogleRoutes([
      { method: "PATCH", url: `${G}/labels/Label_1`, reply: () => googleJson(409, {}) },
    ]);
    const res = await call(ownerId, "update_label", { labelId: "Label_1", displayName: "Dup" });
    expect(res.json.error?.code).toBe("invalid_argument");
  });

  it("delete_label accepts a prefixed id and maps 404", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([
      {
        method: "DELETE",
        url: `${G}/labels/Label_1`,
        reply: (_r, n) => (n === 0 ? new Response(null, { status: 204 }) : googleJson(404, {})),
      },
    ]);
    const labels = await call(ownerId, "delete_label", { labelId: "Label_1" });
    expect(labels.isError).toBe(false);
    const again = await call(ownerId, "delete_label", { labelId: "Label_1" });
    expect(again.json.error?.code).toBe("not_found");
    expect(calls).toHaveLength(2);
  });

  it("rejects a label id of another account", async () => {
    const { ownerId } = await setup();
    installGoogleRoutes([]);
    const res = await call(ownerId, "delete_label", { labelId: "a99:Label_1", account: "work" });
    expect(res.isError).toBe(true);
  });
});

describe("label changes", () => {
  it("label_message adds system and user labels, prefixed or bare", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([
      {
        method: "POST",
        url: `${G}/messages/m1/modify`,
        reply: () => googleJson(200, { id: "m1" }),
      },
    ]);
    const res = await call(ownerId, "label_message", {
      messageId: "m1",
      labelIds: ["STARRED", "UNREAD", "Label_1"],
    });
    expect(res.isError).toBe(false);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      addLabelIds: ["STARRED", "UNREAD", "Label_1"],
    });
    expect((res.json.added as string[])[0]).toMatch(/^a\d+:STARRED$/);
    expect(res.json.messageId).toMatch(/^a\d+:m1$/);
  });

  it("system label ids pass through when given prefixed", async () => {
    const { ownerId } = await setup();
    const msg = await call(ownerId, "list_accounts", {});
    const key = (msg.json.accounts as { account: string }[])[0]?.account ?? "a1";
    const calls = installGoogleRoutes([
      {
        method: "POST",
        url: `${G}/messages/m1/modify`,
        reply: () => googleJson(200, { id: "m1" }),
      },
    ]);
    await call(ownerId, "unlabel_message", {
      messageId: `${key}:m1`,
      labelIds: [`${key}:INBOX`, "UNREAD"],
    });
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ removeLabelIds: ["INBOX", "UNREAD"] });
  });

  it("label_thread and unlabel_thread use the thread modify endpoint", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([
      { method: "POST", url: `${G}/threads/t1/modify`, reply: () => googleJson(200, { id: "t1" }) },
    ]);
    await call(ownerId, "label_thread", { threadId: "t1", labelIds: ["Label_1"] });
    await call(ownerId, "unlabel_thread", { threadId: "t1", labelIds: ["INBOX"] });
    expect(calls.map((c) => JSON.parse(c.body ?? "{}"))).toEqual([
      { addLabelIds: ["Label_1"] },
      { removeLabelIds: ["INBOX"] },
    ]);
  });

  it("update_message_labels adds and removes in one call", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([
      {
        method: "POST",
        url: `${G}/messages/m1/modify`,
        reply: () => googleJson(200, { id: "m1" }),
      },
    ]);
    const res = await call(ownerId, "update_message_labels", {
      messageId: "m1",
      addLabelIds: ["Label_1", "STARRED"],
      removeLabelIds: ["INBOX"],
    });
    expect(res.isError).toBe(false);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      addLabelIds: ["Label_1", "STARRED"],
      removeLabelIds: ["INBOX"],
    });
    expect((res.json.removed as string[])[0]).toMatch(/^a\d+:INBOX$/);
  });

  it("update_message_labels without add or remove is invalid_argument", async () => {
    const { ownerId } = await setup();
    installGoogleRoutes([]);
    const res = await call(ownerId, "update_message_labels", { messageId: "m1" });
    expect(res.json.error?.code).toBe("invalid_argument");
  });

  it("maps 404 and 403 rate limits on a modify", async () => {
    const { ownerId } = await setup();
    installGoogleRoutes([
      { method: "POST", url: `${G}/messages/gone/modify`, reply: () => googleJson(404, {}) },
      {
        method: "POST",
        url: `${G}/messages/busy/modify`,
        reply: () => googleJson(403, { error: { errors: [{ reason: "userRateLimitExceeded" }] } }),
      },
    ]);
    const a = await call(ownerId, "label_message", { messageId: "gone", labelIds: ["X"] });
    expect(a.json.error?.code).toBe("not_found");
    const b = await call(ownerId, "label_message", { messageId: "busy", labelIds: ["X"] });
    expect(b.json.error?.code).toBe("rate_limited");
  });

  it("refuses a prefixed message id with a selector naming another account", async () => {
    const { ownerId } = await setup();
    await linkGoogleAccount(ownerId, { label: "home" });
    installGoogleRoutes([]);
    const res = await call(ownerId, "label_message", {
      messageId: "a1:m1",
      labelIds: ["STARRED"],
      account: "home",
    });
    expect(res.isError).toBe(true);
    expect(res.json.error?.code).toBe("invalid_argument");
  });
});
