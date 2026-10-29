// M16: attachments through the real MCP handler and registry, with Google as the route-table fake
// (no network): a well-formed multipart/mixed on send and forward, the size cap before any Google
// call, the original's files on a forward, `get_attachment` as a blob on both endpoints, and an
// audit row that counts files but never holds them.

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Kind, SCOPES } from "../src/auth/endpoints";
import { mcpHandler } from "../src/auth/mcp-factory";
import { type AuditLogRow, all } from "../src/core/db";
import type { Env } from "../src/env";
import { compileRegistry } from "../src/registry/compile";
import { FAMILIES } from "../src/tools";
import fx from "./fixtures/google/mail-attachments.json";
import {
  type GoogleCall,
  type GoogleRoute,
  googleJson,
  installGoogleRoutes,
  linkGoogleAccount,
  newOwner,
} from "./helpers/google";
import { ISSUER, mcpRequest, parseMcp } from "./helpers/mcp";

const registry = compileRegistry(FAMILIES);

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const UPLOAD = "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send";
const MESSAGE = `${BASE}/messages/${fx.original.id}`;
const ATTACHMENT = `${MESSAGE}/attachments/${fx.original.attachmentId}`;

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- Harness -------------------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: the JSON a tool answered, read loosely by the tests
type Json = any;

const withEnv = (overrides: Partial<Env>): Env => ({ ...env, ...overrides }) as Env;
const ON = (extra: Partial<Env> = {}): Env => withEnv({ SEND_ENABLED: "true", ...extra });

async function setup() {
  const ownerId = await newOwner();
  const linked = await linkGoogleAccount(ownerId, { components: ["mail", "mail.send"] });
  await env.DB.prepare("UPDATE accounts SET send_as_fetched_at = ? WHERE id = ?")
    .bind(Math.floor(Date.now() / 1000), linked.row.id)
    .run();
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

/** The JSON a tool answered; a schema refusal is plain text. */
const parseLoose = (text: string): Json => {
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
};

type Block = { type: string; text?: string; resource?: Json };

async function call(
  e: Env,
  ownerId: string,
  name: string,
  args: Record<string, unknown>,
  kind: Kind = "full",
): Promise<{ isError: boolean; json: Json; blocks: Block[] }> {
  const r = await rpc(e, ownerId, kind, "tools/call", { name, arguments: args });
  const blocks = (r.result?.content ?? []) as Block[];
  const text = blocks.find((b) => b.type === "text")?.text;
  return {
    isError: r.result?.isError === true || r.error !== undefined,
    json: text ? parseLoose(text) : r.error,
    blocks,
  };
}

const b64u = (s: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const query = (c: GoogleCall | undefined) => new URL(c?.url ?? "").searchParams;

const sendRoute = (): GoogleRoute => ({
  method: "POST",
  url: UPLOAD,
  reply: () => googleJson(200, fx.sent),
});

/** A message of the fixture holding one file; `size` is what its part declares. */
const messageRoute = (size: number = fx.file.bytes): GoogleRoute => ({
  url: MESSAGE,
  reply: () =>
    googleJson(200, {
      id: fx.original.id,
      threadId: fx.original.threadId,
      payload: {
        mimeType: "multipart/mixed",
        headers: Object.entries(fx.original.headers).map(([name, value]) => ({ name, value })),
        parts: [
          { mimeType: "text/plain", body: { size: 22, data: b64u(fx.original.text) } },
          {
            mimeType: fx.file.mimeType,
            filename: fx.file.filename,
            body: { attachmentId: fx.original.attachmentId, size },
          },
        ],
      },
    }),
});

const attachmentRoute = (): GoogleRoute => ({
  url: ATTACHMENT,
  reply: () => googleJson(200, { size: fx.file.bytes, data: fx.file.base64url }),
});

const auditRows = (ownerId: string) =>
  all<AuditLogRow>(env.DB, "SELECT * FROM audit_log WHERE owner_id = ? ORDER BY id", ownerId);

/** The bytes of a base64 string, as binary text. */
const fromB64 = (s: string): string => atob(s.replace(/\s+/g, ""));

interface MimePart {
  headers: string;
  body: string;
}

/** The parts of the top-level multipart/mixed of an RFC 822 text. */
function mixedParts(raw: string): { boundary: string; parts: MimePart[]; closed: boolean } {
  const top = raw.split("\r\n\r\n")[0] ?? "";
  const boundary = top.match(/^Content-Type: multipart\/mixed;\s*boundary="([^"]+)"/im)?.[1];
  if (!boundary) throw new Error(`no multipart/mixed boundary in: ${top}`);
  const chunks = raw.split(`--${boundary}`);
  const closed = (chunks.at(-1) ?? "").startsWith("--");
  const parts = chunks.slice(1, closed ? -1 : undefined).map((c) => {
    const [headers = "", ...rest] = c.replace(/^\r\n/, "").split("\r\n\r\n");
    return { headers, body: rest.join("\r\n\r\n").replace(/(?:\r\n)+$/, "") };
  });
  return { boundary, parts, closed };
}

/** The RFC 822 text inside a `multipart/related` upload. */
function rfc822Of(c: GoogleCall | undefined): string {
  const m = c?.body.match(/Content-Type: message\/rfc822\r\n\r\n([\s\S]*?)\r\n--wb_[^\r\n]+--/);
  if (!m?.[1]) throw new Error("no message/rfc822 part");
  return m[1];
}

const own = {
  content: fx.file.base64,
  filename: fx.file.filename,
  mimeType: fx.file.mimeType,
};

const sample = fx.file.base64.slice(0, 40);

// ---- send_message --------------------------------------------------------------------------------

describe("send_message with attachments", () => {
  it("builds a well-formed multipart/mixed: boundary, 76-column base64, the bytes intact", async () => {
    const { ownerId, key } = await setup();
    const calls = installGoogleRoutes([sendRoute()]);
    // Whitespace in the client's base64 is ignored and the lines are wrapped afresh.
    const spaced = fx.file.base64.replace(/(.{50})/g, "$1\n");
    const res = await call(ON(), ownerId, "send_message", {
      to: ["bob@example.com"],
      subject: "Files",
      body: "see attached",
      attachments: [own, { content: spaced, filename: "note.bin" }],
    });
    expect(res.isError).toBe(false);
    expect(res.json.id).toBe(`${key}:m_sent`);
    expect(res.json.attachments).toEqual({ count: 2, bytes: 400 });
    expect(calls).toHaveLength(1);
    expect(query(calls[0]).get("uploadType")).toBe("media");

    const raw = calls[0]?.body ?? "";
    const { boundary, parts, closed } = mixedParts(raw);
    expect(boundary).toMatch(/^=_wb_/);
    expect(closed).toBe(true);
    expect(parts).toHaveLength(3);
    // The text first, then each file in the order given.
    expect(parts[0]?.headers).toContain("Content-Type: text/plain");
    expect(fromB64(parts[0]?.body ?? "")).toBe("see attached");
    expect(parts[1]?.headers).toContain("Content-Type: application/pdf");
    expect(parts[1]?.headers).toContain("Content-Transfer-Encoding: base64");
    expect(parts[1]?.headers).toContain("Content-Disposition: attachment");
    expect(parts[1]?.headers).toContain('filename="plan.pdf"');
    expect(parts[2]?.headers).toContain("Content-Type: application/octet-stream");
    expect(parts[2]?.headers).toContain('filename="note.bin"');
    for (const p of [parts[1], parts[2]]) {
      const lines = (p?.body ?? "").split("\r\n");
      expect(lines.length).toBeGreaterThan(1);
      for (const line of lines.slice(0, -1)) expect(line).toHaveLength(76);
      expect((lines.at(-1) ?? "").length).toBeLessThanOrEqual(76);
      expect(fromB64(p?.body ?? "")).toBe(fromB64(fx.file.base64));
    }
  });

  it("refuses files over the send cap, bad base64, inline and a bad type with no Google call", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([sendRoute()]);
    const base = { to: ["bob@example.com"], subject: "s", body: "b" };
    const cases: [Record<string, unknown>, Env, string][] = [
      [{ ...base, attachments: [own] }, ON({ MAX_SEND_ATTACHMENT_BYTES: "199" }), "too_large"],
      [
        { ...base, attachments: [own, own, own] },
        ON({ MAX_SEND_ATTACHMENT_BYTES: "500" }),
        "too_large",
      ],
      [{ ...base, attachments: [{ content: "***" }] }, ON(), "invalid_argument"],
      [{ ...base, attachments: [{ ...own, inline: true }] }, ON(), "invalid_argument"],
      [{ ...base, attachments: [{ ...own, mimeType: "a/b; x=y" }] }, ON(), "invalid_argument"],
      [
        { ...base, attachments: [{ ...own, filename: "a\r\nBcc: x@example.net" }] },
        ON(),
        "invalid_argument",
      ],
    ];
    for (const [args, e, code] of cases) {
      const res = await call(e, ownerId, "send_message", args);
      expect(res.isError).toBe(true);
      expect(res.json.error.code, JSON.stringify(args.attachments).slice(0, 40)).toBe(code);
    }
    expect(calls).toHaveLength(0);
    // Every refusal is audited, none with content.
    const rows = await auditRows(ownerId);
    expect(rows).toHaveLength(cases.length);
    expect(rows.every((r) => r.result === "refused")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(sample);
  });

  it("refuses more than ten files", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([sendRoute()]);
    const res = await call(ON(), ownerId, "send_message", {
      to: ["bob@example.com"],
      body: "b",
      attachments: Array.from({ length: 11 }, () => ({ content: "aGk=" })),
    });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("audits the count and total size of the files, never their content", async () => {
    const { ownerId } = await setup();
    installGoogleRoutes([sendRoute()]);
    const res = await call(ON(), ownerId, "send_message", {
      to: ["bob@example.com"],
      subject: "Files",
      body: "SECRET-BODY-TEXT",
      attachments: [own, own],
    });
    expect(res.isError).toBe(false);
    const rows = await auditRows(ownerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool: "send_message",
      result: "ok",
      detail: "attachments=2 bytes=400",
    });
    const dump = JSON.stringify(rows[0]);
    expect(dump).not.toContain(sample);
    expect(dump).not.toContain(fx.file.base64url.slice(0, 40));
    expect(dump).not.toContain("SECRET-BODY-TEXT");
  });

  it("holds files for approval and sends nothing", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([sendRoute()]);
    const res = await call(ON({ SEND_REQUIRES_CONFIRM: "true" }), ownerId, "send_message", {
      to: ["bob@example.com"],
      subject: "Held",
      body: "b",
      attachments: [own],
    });
    expect(res.isError).toBe(false);
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(res.json)).not.toContain(sample);
  });
});

// ---- reply ---------------------------------------------------------------------------------------

describe("reply with attachments", () => {
  it("sends the files in the threaded reply", async () => {
    const { ownerId, key } = await setup();
    const calls = installGoogleRoutes([messageRoute(), sendRoute()]);
    const res = await call(ON(), ownerId, "reply", {
      messageId: `${key}:${fx.original.id}`,
      body: "thanks",
      attachments: [own],
    });
    expect(res.isError).toBe(false);
    expect(res.json.attachments).toEqual({ count: 1, bytes: 200 });
    const upload = calls[1];
    expect(query(upload).get("uploadType")).toBe("multipart");
    const { parts } = mixedParts(rfc822Of(upload));
    expect(parts).toHaveLength(2);
    expect(parts[1]?.headers).toContain('filename="plan.pdf"');
  });
});

// ---- forward -------------------------------------------------------------------------------------

describe("forward with attachments", () => {
  it("carries the original's attachments, downloaded after the guardrails pass", async () => {
    const { ownerId, key } = await setup();
    const calls = installGoogleRoutes([messageRoute(), attachmentRoute(), sendRoute()]);
    const res = await call(ON(), ownerId, "forward", {
      messageId: `${key}:${fx.original.id}`,
      to: ["dan@example.com"],
      forwardText: "fyi",
    });
    expect(res.isError).toBe(false);
    expect(res.json.attachments).toEqual({ count: 1, bytes: 200 });
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "POST"]);
    const { parts, closed } = mixedParts(calls[2]?.body ?? "");
    expect(closed).toBe(true);
    expect(parts).toHaveLength(2);
    expect(parts[1]?.headers).toContain('filename="plan.pdf"');
    expect(parts[1]?.headers).toContain("Content-Type: application/pdf");
    // Gmail's base64url became standard base64 without being decoded on the way.
    expect(fromB64(parts[1]?.body ?? "")).toBe(fromB64(fx.file.base64));
    for (const line of (parts[1]?.body ?? "").split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
    const rows = await auditRows(ownerId);
    expect(rows[0]).toMatchObject({
      tool: "forward",
      result: "ok",
      detail: "attachments=1 bytes=200",
    });
    expect(JSON.stringify(rows)).not.toContain(sample);
  });

  it("downloads nothing when sending is refused", async () => {
    const { ownerId, key } = await setup();
    const calls = installGoogleRoutes([messageRoute(), attachmentRoute(), sendRoute()]);
    const res = await call(withEnv({ SEND_ENABLED: "false" }), ownerId, "forward", {
      messageId: `${key}:${fx.original.id}`,
      to: ["dan@example.com"],
    });
    expect(res.isError).toBe(true);
    expect(calls.filter((c) => c.url.includes("/attachments/"))).toHaveLength(0);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("leaves the original's files out when includeAttachments is false", async () => {
    const { ownerId, key } = await setup();
    const calls = installGoogleRoutes([messageRoute(), attachmentRoute(), sendRoute()]);
    const res = await call(ON(), ownerId, "forward", {
      messageId: `${key}:${fx.original.id}`,
      to: ["dan@example.com"],
      includeAttachments: false,
    });
    expect(res.isError).toBe(false);
    expect(res.json.attachments).toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).not.toContain("multipart/mixed");
  });

  it("adds the caller's own files to the original's", async () => {
    const { ownerId, key } = await setup();
    const calls = installGoogleRoutes([messageRoute(), attachmentRoute(), sendRoute()]);
    const res = await call(ON(), ownerId, "forward", {
      messageId: `${key}:${fx.original.id}`,
      to: ["dan@example.com"],
      attachments: [{ content: "aGk=", filename: "extra.txt", mimeType: "text/plain" }],
    });
    expect(res.isError).toBe(false);
    expect(res.json.attachments).toEqual({ count: 2, bytes: 202 });
    const { parts } = mixedParts(calls[2]?.body ?? "");
    expect(parts.map((p) => /filename="([^"]+)"/.exec(p.headers)?.[1])).toEqual([
      undefined,
      "extra.txt",
      "plan.pdf",
    ]);
  });

  it("refuses the whole forward when the original's files exceed the cap, sending nothing", async () => {
    const { ownerId, key } = await setup();
    const calls = installGoogleRoutes([messageRoute(600_000), attachmentRoute(), sendRoute()]);
    const res = await call(ON(), ownerId, "forward", {
      messageId: `${key}:${fx.original.id}`,
      to: ["dan@example.com"],
    });
    expect(res.isError).toBe(true);
    expect(res.json.error.code).toBe("too_large");
    // Only the original was read: no download, no upload.
    expect(calls).toHaveLength(1);
  });

  it("refuses when a file turns out larger than its part said, sending nothing", async () => {
    const { ownerId, key } = await setup();
    const calls = installGoogleRoutes([messageRoute(10), attachmentRoute(), sendRoute()]);
    const res = await call(ON({ MAX_SEND_ATTACHMENT_BYTES: "100" }), ownerId, "forward", {
      messageId: `${key}:${fx.original.id}`,
      to: ["dan@example.com"],
    });
    expect(res.isError).toBe(true);
    expect(res.json.error.code).toBe("too_large");
    expect(calls.filter((c) => c.url.startsWith(UPLOAD))).toHaveLength(0);
  });
});

// ---- get_attachment ------------------------------------------------------------------------------

describe("get_attachment", () => {
  const args = (key: string) => ({
    messageId: `${key}:${fx.original.id}`,
    attachmentId: fx.original.attachmentId,
  });

  it("returns the file as a resource blob with its wrapped name and type", async () => {
    const { ownerId, key } = await setup();
    const calls = installGoogleRoutes([messageRoute(), attachmentRoute()]);
    const res = await call(env, ownerId, "get_attachment", args(key));
    expect(res.isError).toBe(false);
    expect(res.blocks.map((b) => b.type)).toEqual(["text", "resource"]);
    const blob = res.blocks[1]?.resource;
    expect(blob.blob).toBe(fx.file.base64);
    expect(blob.mimeType).toBe("application/pdf");
    expect(res.json).toMatchObject({
      messageId: `${key}:${fx.original.id}`,
      account: key,
      attachmentId: fx.original.attachmentId,
      sizeBytes: 200,
      encoding: "base64",
    });
    expect(res.json.filename).toContain("plan.pdf");
    expect(res.json.filename).toContain("<untrusted-");
    expect(res.json.mimeType).toContain("<untrusted-");
    expect(query(calls[1]).get("fields")).toBe("size,data");
  });

  it("is on /mcp/ro as a read tool and answers there", async () => {
    const { ownerId, key } = await setup();
    const tools = (await rpc(env, ownerId, "ro", "tools/list", {})).result?.tools as {
      name: string;
      annotations?: { readOnlyHint?: boolean };
    }[];
    const t = tools.find((x) => x.name === "get_attachment");
    expect(t?.annotations?.readOnlyHint).toBe(true);
    const full = (await rpc(env, ownerId, "full", "tools/list", {})).result?.tools as {
      name: string;
    }[];
    expect(full.map((x) => x.name)).toContain("get_attachment");

    installGoogleRoutes([messageRoute(), attachmentRoute()]);
    const res = await call(env, ownerId, "get_attachment", args(key), "ro");
    expect(res.isError).toBe(false);
    expect(res.blocks[1]?.resource.blob).toBe(fx.file.base64);
  });

  it("refuses a file known to be over the cap before downloading it", async () => {
    const { ownerId, key } = await setup();
    const calls = installGoogleRoutes([messageRoute(600_000), attachmentRoute()]);
    const res = await call(env, ownerId, "get_attachment", args(key));
    expect(res.isError).toBe(true);
    expect(res.json.error.code).toBe("too_large");
    expect(calls).toHaveLength(1);
  });

  it("refuses a file larger than its part said, and maps a missing one to not_found", async () => {
    const { ownerId, key } = await setup();
    installGoogleRoutes([messageRoute(10), attachmentRoute()]);
    const big = await call(
      withEnv({ MAX_ATTACHMENT_BYTES: "100" }),
      ownerId,
      "get_attachment",
      args(key),
    );
    expect(big.json.error.code).toBe("too_large");
    vi.restoreAllMocks();

    installGoogleRoutes([
      messageRoute(),
      {
        url: ATTACHMENT,
        reply: () => googleJson(404, { error: { code: 404, message: "SECRET-X" } }),
      },
    ]);
    const missing = await call(env, ownerId, "get_attachment", args(key));
    expect(missing.json.error.code).toBe("not_found");
    expect(JSON.stringify(missing.json)).not.toContain("SECRET");
  });
});
