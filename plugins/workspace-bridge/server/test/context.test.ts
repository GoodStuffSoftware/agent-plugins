// M9b: the tool context (`ctx.use`), the Google HTTP client, the account tools and the
// internal-error log line (ARCHITECTURE s.3.2, s.3.3, s.3.6). Google is the route-table fake.

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type Kind, resourceUrl, SCOPES } from "../src/auth/endpoints";
import { mcpHandler } from "../src/auth/mcp-factory";
import { insertAccount } from "../src/core/db";
import { INTERNAL_MESSAGE, internalErrorLine, ToolError, toToolResult } from "../src/core/errors";
import { GOOGLE_SCOPES } from "../src/providers/google/base";
import { gfetch, gjson } from "../src/providers/google/http";
import { compileRegistry } from "../src/registry/compile";
import { toolContext } from "../src/registry/context";
import { defineTool, type Family, type ToolContext, type ToolDef } from "../src/registry/types";
import { capability, provide } from "../src/services/capability";
import type { AccountRef } from "../src/services/types";
import { FAMILIES } from "../src/tools";
import {
  googleJson,
  installGoogleRoutes,
  linkGoogleAccount,
  newOwner,
  tokenRoute,
} from "./helpers/google";
import { ISSUER, mcpRequest, parseMcp, toolJson } from "./helpers/mcp";

const ACCOUNTS_URL = `${ISSUER}/accounts`;
const LABELS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/labels";
const MAIL_SCOPES = `${GOOGLE_SCOPES.gmailModify} ${GOOGLE_SCOPES.gmailSettingsBasic}`;

// A test-only family: a capability, its Google binding through gjson, and tools that use it.
interface Labels {
  list(a: AccountRef): Promise<string[]>;
}
const LABELS = capability<Labels>("test.labels", "mail");
const SEND = capability<{ send(): void }>("mail.send", "mail");
const testFamily: Family = {
  id: "test_m9b",
  tools: [
    defineTool({
      name: "test_labels",
      description: "Lists label names.",
      component: "mail",
      scopes: [],
      endpoints: ["full"],
      annotations: { readOnlyHint: true },
      input: z.object({ account: z.string().optional() }),
      async handler(args, ctx) {
        const [a] = await ctx.accounts.resolve(args.account);
        if (!a) throw new Error("no account");
        return ctx.use(LABELS, a).list(a);
      },
    }) as unknown as ToolDef,
    defineTool({
      name: "test_boom",
      description: "Fails with its argument in the message.",
      component: null,
      scopes: [],
      endpoints: ["full"],
      annotations: {},
      input: z.object({ secret: z.string() }),
      async handler(args) {
        throw new Error(
          `Google said 500 for ${args.secret}: {"error":"body text"} ya29.abcdefghijklmnop`,
        );
      },
    }) as unknown as ToolDef,
  ],
  bindings: {
    google: [
      provide(LABELS, {
        async list(a) {
          const r = await gjson<{ labels: { name: string }[] }>(
            a,
            LABELS_URL,
            {},
            { fields: "labels(name)" },
          );
          return r.labels.map((l) => l.name);
        },
      }),
    ],
  },
  parityPending: [],
};
const registry = compileRegistry([...FAMILIES, testFamily]);

afterEach(() => {
  vi.restoreAllMocks();
});

function ctxFor(ownerId: string): ToolContext {
  return toolContext(
    {
      kind: "full",
      ownerId,
      grant: { clientId: "client_test", grantId: "g_test", scopes: [] },
      env,
      exec: createExecutionContext(),
    },
    registry.providers,
  );
}

/** An owner, one account and a context; `a` comes from `ctx.accounts` as handlers get it. */
async function setup(
  opts: {
    components?: readonly string[];
    grantedScopes?: string;
    provider?: "google" | "msgraph";
  } = {},
) {
  const ownerId = await newOwner();
  let accessToken = "";
  if (opts.provider === "msgraph") {
    await insertAccount(env.DB, {
      ownerId,
      label: "graph",
      address: "graph@example.com",
      provider: "msgraph",
      components: opts.components ?? ["mail"],
    });
  } else {
    accessToken = (await linkGoogleAccount(ownerId, opts)).accessToken;
  }
  const ctx = ctxFor(ownerId);
  const [a] = await ctx.accounts.resolve();
  if (!a) throw new Error("no account");
  return { ownerId, ctx, a, accessToken };
}

/** What `fn` threw, as the client would read it. */
async function failure(
  fn: () => unknown,
): Promise<{ e: unknown; text: string; error: Record<string, unknown> }> {
  try {
    await fn();
  } catch (e) {
    const text = (toToolResult(e).content[0] as { text: string }).text;
    return { e, text, error: (JSON.parse(text) as { error: Record<string, unknown> }).error };
  }
  throw new Error("expected a failure");
}

/** A tools/call through the real MCP handler with the test registry. */
async function callTool(ownerId: string, kind: Kind, name: string, args: Record<string, unknown>) {
  const exec = Object.assign(createExecutionContext(), {
    props: { ownerId },
    auth: {
      token: `${ownerId}:g_test:secret`,
      audience: resourceUrl(kind, ISSUER),
      scope: [...SCOPES[kind]],
      clientId: "client_test",
      userId: ownerId,
    },
  });
  const req = mcpRequest(undefined, kind, "tools/call", { name, arguments: args });
  const res = await mcpHandler(kind, ISSUER, registry)(req, env, exec);
  await waitOnExecutionContext(exec);
  expect(res.status).toBe(200);
  const rpc = await parseMcp(res);
  const content = rpc.result?.content as { text: string }[];
  return {
    isError: rpc.result?.isError === true,
    json: toolJson(rpc.result) as never,
    text: content[0]?.text ?? "",
  };
}

describe("ctx.use", () => {
  it("refuses a component that is off, with the accounts URL", async () => {
    const { ctx, a } = await setup({ components: ["calendar"] });
    const { e, error } = await failure(() => ctx.use(LABELS, a));
    expect(e).toBeInstanceOf(ToolError);
    expect(error).toMatchObject({
      code: "component_disabled",
      component: "mail",
      accountsUrl: ACCOUNTS_URL,
    });
  });

  it("checks mail.send on its own", async () => {
    const { ctx, a } = await setup({ components: ["mail"] });
    const { error } = await failure(() => ctx.use(SEND, a));
    expect(error).toMatchObject({ code: "component_disabled", component: "mail.send" });
  });

  it("refuses a provider without a binding", async () => {
    const { ctx, a } = await setup({ provider: "msgraph", components: ["mail"] });
    const { error } = await failure(() => ctx.use(LABELS, a));
    expect(error).toMatchObject({
      code: "not_supported_by_provider",
      capability: "test.labels",
      provider: "msgraph",
    });
  });

  it("checks the component before the binding", async () => {
    const { ctx, a } = await setup({ provider: "msgraph", components: [] });
    const { error } = await failure(() => ctx.use(LABELS, a));
    expect(error.code).toBe("component_disabled");
  });

  it("refuses an account that did not come from ctx.accounts", async () => {
    const { ctx, a } = await setup();
    const { e, error } = await failure(() => ctx.use(LABELS, { ...a }));
    expect(e).not.toBeInstanceOf(ToolError);
    expect(error).toEqual({ code: "internal", message: INTERNAL_MESSAGE });
  });

  it("resolves a test-only family binding through the provider registry", async () => {
    const { ownerId, accessToken } = await setup({ components: ["mail"] });
    const calls = installGoogleRoutes([
      {
        url: LABELS_URL,
        reply: () => googleJson(200, { labels: [{ name: "INBOX" }, { name: "Work" }] }),
      },
    ]);
    const res = await callTool(ownerId, "full", "test_labels", {});
    expect(res.isError).toBe(false);
    expect(res.json).toEqual(["INBOX", "Work"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBe(`Bearer ${accessToken}`);
    expect(new URL(calls[0]?.url ?? "").searchParams.get("fields")).toBe("labels(name)");
  });

  it("answers component_disabled through the tool when the component is off", async () => {
    const { ownerId } = await setup({ components: ["calendar"] });
    installGoogleRoutes([]);
    const res = await callTool(ownerId, "full", "test_labels", {});
    expect(res.isError).toBe(true);
    expect((res.json as { error: { code: string } }).error.code).toBe("component_disabled");
  });
});

describe("gfetch", () => {
  it("refreshes once on 401 and succeeds", async () => {
    const { a, accessToken } = await setup();
    const calls = installGoogleRoutes([
      {
        url: LABELS_URL,
        reply: (_req, n) =>
          n === 0 ? googleJson(401, { error: { code: 401 } }) : googleJson(200, { ok: 1 }),
      },
      tokenRoute("ya29.fresh"),
    ]);
    expect(await gjson(a, LABELS_URL)).toEqual({ ok: 1 });
    expect(calls.map((c) => c.authorization)).toEqual([
      `Bearer ${accessToken}`,
      null,
      "Bearer ya29.fresh",
    ]);
  });

  it("answers needs_relink after a second 401", async () => {
    const { a } = await setup();
    const calls = installGoogleRoutes([
      { url: LABELS_URL, reply: () => googleJson(401, { error: { code: 401 } }) },
      tokenRoute("ya29.fresh"),
    ]);
    const { error } = await failure(() => gfetch(a, LABELS_URL));
    expect(error).toMatchObject({ code: "needs_relink", linkUrl: ACCOUNTS_URL });
    expect(calls.filter((c) => c.url.startsWith(LABELS_URL))).toHaveLength(2);
  });

  const scopeError = { error: { code: 403, errors: [{ reason: "insufficientPermissions" }] } };

  it("maps 403 insufficient permissions to component_disabled when never granted", async () => {
    const { a } = await setup({ components: ["mail"], grantedScopes: "" });
    installGoogleRoutes([{ url: LABELS_URL, reply: () => googleJson(403, scopeError) }]);
    const { error } = await failure(() => gfetch(a, LABELS_URL));
    expect(error).toMatchObject({
      code: "component_disabled",
      component: "mail",
      accountsUrl: ACCOUNTS_URL,
    });
  });

  it("maps 403 insufficient permissions to needs_relink when granted", async () => {
    const { a } = await setup({ components: ["mail"], grantedScopes: MAIL_SCOPES });
    installGoogleRoutes([{ url: LABELS_URL, reply: () => googleJson(403, scopeError) }]);
    const { error } = await failure(() => gfetch(a, LABELS_URL));
    expect(error).toMatchObject({ code: "needs_relink", linkUrl: ACCOUNTS_URL });
  });

  it("maps a 403 rate limit and a 429 to rate_limited", async () => {
    const { a } = await setup();
    installGoogleRoutes([
      {
        url: LABELS_URL,
        reply: () =>
          googleJson(403, { error: { code: 403, errors: [{ reason: "userRateLimitExceeded" }] } }),
      },
      {
        url: `${LABELS_URL}/x`,
        reply: () => googleJson(429, { error: { code: 429 } }, { "Retry-After": "7" }),
      },
    ]);
    expect((await failure(() => gfetch(a, LABELS_URL))).error).toMatchObject({
      code: "rate_limited",
      retryAfterSeconds: 30,
    });
    expect((await failure(() => gfetch(a, `${LABELS_URL}/x`))).error).toMatchObject({
      code: "rate_limited",
      retryAfterSeconds: 7,
    });
  });

  it("maps 404 to not_found", async () => {
    const { a } = await setup();
    installGoogleRoutes([
      { url: LABELS_URL, reply: () => googleJson(404, { error: { code: 404 } }) },
    ]);
    expect((await failure(() => gfetch(a, LABELS_URL))).error.code).toBe("not_found");
  });

  it("retries a 5xx once on GET, then answers upstream_error", async () => {
    const { a } = await setup();
    const calls = installGoogleRoutes([
      {
        url: LABELS_URL,
        reply: (_r, n) => (n === 0 ? googleJson(500, {}) : googleJson(200, { ok: 1 })),
      },
      { url: `${LABELS_URL}/down`, reply: () => googleJson(503, {}) },
    ]);
    expect(await gjson(a, LABELS_URL)).toEqual({ ok: 1 });
    expect(calls).toHaveLength(2);
    const { error } = await failure(() => gfetch(a, `${LABELS_URL}/down`));
    expect(error).toMatchObject({ code: "upstream_error", status: 503 });
    expect(calls).toHaveLength(4);
  });

  it("does not retry a 5xx on POST", async () => {
    const { a } = await setup();
    const calls = installGoogleRoutes([
      { method: "POST", url: LABELS_URL, reply: () => googleJson(502, {}) },
    ]);
    const { error } = await failure(() => gfetch(a, LABELS_URL, { method: "POST", json: {} }));
    expect(error).toMatchObject({ code: "upstream_error", status: 502 });
    expect(calls).toHaveLength(1);
  });

  it("never puts Google body text in an error", async () => {
    const secret = {
      error: {
        code: 0,
        message: "SECRET-BODY subject: Payroll from boss@example.com",
        errors: [{ reason: "SECRET-BODY", message: "SECRET-BODY" }],
      },
    };
    for (const status of [400, 401, 403, 404, 409, 429, 500]) {
      const { a } = await setup();
      installGoogleRoutes([
        { url: LABELS_URL, reply: () => googleJson(status, { ...secret, code: status }) },
        tokenRoute("ya29.fresh"),
      ]);
      const { e, text } = await failure(() => gfetch(a, LABELS_URL));
      expect(e).toBeInstanceOf(ToolError);
      expect(text).not.toMatch(/SECRET|Payroll|boss@|ya29/);
      vi.restoreAllMocks();
    }
  });

  it("refuses a URL that is not a Google API before sending anything", async () => {
    const { a } = await setup();
    const calls = installGoogleRoutes([]);
    const { e } = await failure(() => gfetch(a, "https://evil.example.com/gmail/v1/users/me"));
    expect(e).not.toBeInstanceOf(ToolError);
    expect(calls).toHaveLength(0);
  });
});

describe("account tools", () => {
  it("list_accounts shows both accounts, the default and no token fields", async () => {
    const ownerId = await newOwner();
    const work = await linkGoogleAccount(ownerId, {
      label: "work",
      components: ["mail"],
      grantedScopes: MAIL_SCOPES,
    });
    const home = await linkGoogleAccount(ownerId, {
      label: "home",
      components: ["calendar", "contacts"],
    });
    await env.DB.prepare("UPDATE owners SET default_account_id = ? WHERE id = ?")
      .bind(home.row.id, ownerId)
      .run();

    const res = await callTool(ownerId, "full", "list_accounts", {});
    expect(res.isError).toBe(false);
    const { accounts, accountsUrl } = res.json as {
      accounts: Record<string, unknown>[];
      accountsUrl: string;
    };
    expect(accountsUrl).toBe(ACCOUNTS_URL);
    expect(accounts).toEqual([
      {
        account: `a${work.row.short_id}`,
        label: "work",
        address: "work@example.com",
        provider: "google",
        components: ["mail"],
        grantedScopes: MAIL_SCOPES.split(" "),
        status: "ok",
        default: false,
      },
      {
        account: `a${home.row.short_id}`,
        label: "home",
        address: "home@example.com",
        provider: "google",
        components: ["calendar", "contacts"],
        grantedScopes: [],
        status: "ok",
        default: true,
      },
    ]);
    for (const secret of [
      work.accessToken,
      work.refreshToken,
      home.accessToken,
      home.refreshToken,
    ]) {
      expect(res.text).not.toContain(secret);
    }
    expect(res.text).not.toMatch(/token|sealed|ciphertext/i);
  });

  it("link_account_url answers on /mcp/ro with the accounts URL", async () => {
    const ownerId = await newOwner();
    const res = await callTool(ownerId, "ro", "link_account_url", {
      label: " Work ",
      components: ["mail", "calendar", "mail"],
    });
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({
      url: ACCOUNTS_URL,
      label: "work",
      components: ["mail", "calendar"],
    });

    const bad = await callTool(ownerId, "ro", "link_account_url", { label: "all" });
    expect(bad.isError).toBe(true);
    expect((bad.json as { error: { code: string } }).error.code).toBe("invalid_argument");
  });
});

describe("internal error log", () => {
  it("logs one line with the tool and error class, and no argument values", async () => {
    const ownerId = await newOwner();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await callTool(ownerId, "full", "test_boom", { secret: "hunter2-private" });
    expect(res.isError).toBe(true);
    expect(res.json).toEqual({ error: { code: "internal", message: INTERNAL_MESSAGE } });
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      event: "tool_internal_error",
      tool: "test_boom",
      errorClass: "Error",
    });
    expect(line).not.toMatch(/hunter2|body text|ya29/);
  });

  it("redacts emails, tokens, quoted text and long messages", () => {
    const line = internalErrorLine(
      "t",
      new TypeError(`bad 'quoted' bob@example.com 1//0abcdefghijklmnopqrstuv ${"x ".repeat(300)}`),
    );
    const parsed = JSON.parse(line) as { errorClass: string; message: string };
    expect(parsed.errorClass).toBe("TypeError");
    expect(parsed.message).not.toMatch(/quoted|bob@|abcdefghij/);
    expect(parsed.message.length).toBeLessThanOrEqual(203);
  });
});

describe("review fixes", () => {
  it("gfetch refuses an account whose component is off, before calling Google", async () => {
    const { a } = await setup({ components: ["calendar"] });
    const calls = installGoogleRoutes([]);
    const { error } = await failure(() => gfetch(a, LABELS_URL));
    expect(error).toMatchObject({
      code: "component_disabled",
      component: "mail",
      accountsUrl: ACCOUNTS_URL,
    });
    expect(calls).toHaveLength(0);
  });

  it("a huge argument neither breaks the answer nor reaches the log", async () => {
    const ownerId = await newOwner();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await callTool(ownerId, "full", "test_boom", { secret: "q".repeat(1_000_000) });
    expect(res.json).toEqual({ error: { code: "internal", message: INTERNAL_MESSAGE } });
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line.length).toBeLessThan(500);
    expect(line).not.toContain("qqqqqqqqqqqqqqqq");
  });

  it("refuses a duplicate or empty provider binding at load", () => {
    const fam = (id: string, impl: unknown): Family => ({
      id,
      tools: [],
      bindings: { google: [{ cap: LABELS, impl }] },
      parityPending: [],
    });
    expect(() => compileRegistry([fam("x", {}), fam("y", {})])).toThrow(/already binds/);
    expect(() => compileRegistry([fam("x", undefined)])).toThrow(/to nothing/);
  });
});
