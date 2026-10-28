import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { KINDS, type Kind, resourceUrl, SCOPES, SERVER_NAME } from "../src/auth/endpoints";
import { mcpHandler } from "../src/auth/mcp-factory";
import { randomId } from "../src/core/crypto";
import { INTERNAL_MESSAGE, ToolError } from "../src/core/errors";
import { compileRegistry, REGISTRY } from "../src/registry/compile";
import { grantIdOf } from "../src/registry/context";
import { defineTool, type Family, type ToolDef } from "../src/registry/types";
import { FAMILIES } from "../src/tools";
import { VERSION } from "../src/version";
import { ISSUER, mcpCall, mcpRequest, mcpRpc, parseMcp, toolJson } from "./helpers/mcp";
import { mintToken } from "./helpers/tokens";

const INIT = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "test", version: "0" },
};
const WHOAMI = { name: "whoami", arguments: {} };

describe("request headers", () => {
  it("needs Host, Content-Type, and Accept with both media types", async () => {
    const token = await mintToken({ kind: "full", scopes: ["mail.read"], ownerId: randomId("o_") });
    const send = (headers: Record<string, string | null>) =>
      exports.default.fetch(mcpRequest(token, "full", "tools/list", undefined, headers));
    expect((await send({})).status).toBe(200);
    expect((await send({ Accept: "application/json" })).status).toBe(406);
    expect((await send({ Accept: "text/event-stream" })).status).toBe(406);
    expect((await send({ "Content-Type": null })).status).toBe(415);
    expect((await send({ Host: null })).status).toBe(403);
    expect((await send({ Host: "evil.example.net" })).status).toBe(403);
  });
});

describe.each(KINDS)("%s endpoint", (kind) => {
  it("initializes, lists whoami and runs it", async () => {
    const ownerId = randomId("o_");
    const token = await mintToken({ kind, scopes: SCOPES[kind], ownerId });

    const init = await mcpRpc(token, kind, "initialize", INIT);
    expect(init.result).toMatchObject({
      serverInfo: { name: SERVER_NAME[kind], version: VERSION },
      capabilities: { tools: { listChanged: false } },
    });

    const list = await mcpRpc(token, kind, "tools/list", {});
    const tools = list.result?.tools as { name: string }[];
    expect(tools.map((t) => t.name)).toEqual(["whoami"]);
    expect(tools[0]).toMatchObject({
      name: "whoami",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    });

    const call = await mcpRpc(token, kind, "tools/call", WHOAMI);
    expect(call.result?.isError).toBeUndefined();
    expect(toolJson(call.result)).toEqual({
      ownerId,
      kind,
      scopes: [...SCOPES[kind]],
      clientId: expect.any(String),
      version: VERSION,
    });
  });
});

describe("tool not on the endpoint", () => {
  it("answers InvalidParams on /mcp/ro", async () => {
    const token = await mintToken({ kind: "ro", scopes: SCOPES.ro, ownerId: randomId("o_") });
    const res = await mcpRpc(token, "ro", "tools/call", { name: "send_message", arguments: {} });
    expect(res.error).toEqual({ code: -32602, message: "Tool send_message not found" });
  });
});

// Test-only tools, compiled next to the real families and served by the real handler.
const echo = defineTool({
  name: "test_echo",
  description: "Echoes its arguments.",
  component: null,
  scopes: [],
  endpoints: ["full", "ro"],
  annotations: { readOnlyHint: true },
  input: z.object({ count: z.number().int().min(1), label: z.string() }),
  async handler(args) {
    return args;
  },
});
const tool = (name: string, over: Partial<ToolDef>): ToolDef => ({
  name,
  description: name,
  component: null,
  scopes: [],
  endpoints: ["full"],
  annotations: {},
  input: z.object({}),
  handler: async () => ({ ok: true }),
  ...over,
});
const testFamily: Family = {
  id: "test",
  tools: [
    echo as unknown as ToolDef,
    tool("test_send", { component: "mail", scopes: ["mail.send"] }),
    tool("test_throw", {
      handler: async () => {
        throw new Error("Google said 500: {secret body}");
      },
    }),
    tool("test_tool_error", {
      handler: async () => {
        throw new ToolError("not_found", "No such message.", { messageId: "m1", code: "x" });
      },
    }),
    tool("test_approval", {
      approval: { when: () => true, preview: () => ({}) },
    }),
  ],
  bindings: {},
  parityPending: [],
};
const testRegistry = compileRegistry([...FAMILIES, testFamily]);

/** Calls the handler directly with a grant as the resource server would pass it. */
async function direct(
  kind: Kind,
  scopes: readonly string[],
  method: string,
  params: Record<string, unknown>,
  audience = resourceUrl(kind, ISSUER),
): Promise<Response> {
  const ownerId = randomId("o_");
  const ctx = Object.assign(createExecutionContext(), {
    props: { ownerId },
    auth: {
      token: `${ownerId}:g_test:secret`,
      audience,
      scope: [...scopes],
      clientId: "client_test",
      userId: ownerId,
    },
  });
  const res = await mcpHandler(kind, ISSUER, testRegistry)(
    mcpRequest(undefined, kind, method, params),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function directRpc(
  kind: Kind,
  scopes: readonly string[],
  method: string,
  params: Record<string, unknown>,
) {
  const res = await direct(kind, scopes, method, params);
  expect(res.status).toBe(200);
  return parseMcp(res);
}

const names = (r: { result?: Record<string, unknown> }) =>
  ((r.result?.tools ?? []) as { name: string }[]).map((t) => t.name);

describe("scope filtering", () => {
  it("hides a tool whose scope the grant lacks and answers 403 when it is called", async () => {
    const list = await directRpc("full", ["mail.read"], "tools/list", {});
    expect(names(list)).not.toContain("test_send");
    expect(names(list)).toContain("test_echo");

    const res = await direct("full", ["mail.read"], "tools/call", {
      name: "test_send",
      arguments: {},
    });
    expect(res.status).toBe(403);
    const challenge = res.headers.get("WWW-Authenticate") ?? "";
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="mail.read mail.send"');
  });

  it("lists and runs the tool once the grant holds the scope", async () => {
    const list = await directRpc("full", ["mail.send"], "tools/list", {});
    expect(names(list)).toContain("test_send");
    const call = await directRpc("full", ["mail.send"], "tools/call", {
      name: "test_send",
      arguments: {},
    });
    expect(toolJson(call.result)).toEqual({ ok: true });
  });

  it("answers InvalidParams for a tool registered only on another endpoint", async () => {
    const res = await directRpc("ro", SCOPES.ro, "tools/call", {
      name: "test_send",
      arguments: {},
    });
    expect(res.error).toEqual({ code: -32602, message: "Tool test_send not found" });
  });
});

describe("tool results", () => {
  it("pins the result of a zod validation failure", async () => {
    const res = await directRpc("full", ["mail.read"], "tools/call", {
      name: "test_echo",
      arguments: { count: 0 },
    });
    expect(res.result).toEqual({
      content: [
        {
          type: "text",
          text: "Input validation error: Invalid arguments for tool test_echo: count: Too small: expected number to be >=1, label: Invalid input: expected string, received undefined",
        },
      ],
      isError: true,
    });
  });

  it("returns a valid call as one text block of JSON", async () => {
    const res = await directRpc("full", ["mail.read"], "tools/call", {
      name: "test_echo",
      arguments: { count: 2, label: "x" },
    });
    expect(res.result).toEqual({ content: [{ type: "text", text: '{"count":2,"label":"x"}' }] });
  });

  it("maps a thrown non-ToolError to internal with a generic message", async () => {
    const res = await directRpc("full", ["mail.read"], "tools/call", {
      name: "test_throw",
      arguments: {},
    });
    expect(res.result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: { code: "internal", message: INTERNAL_MESSAGE } }),
        },
      ],
      isError: true,
    });
    expect(JSON.stringify(res)).not.toContain("secret");
  });

  it("returns a ToolError's code, message and details; details never override", async () => {
    const res = await directRpc("full", ["mail.read"], "tools/call", {
      name: "test_tool_error",
      arguments: {},
    });
    expect(res.result?.isError).toBe(true);
    expect(toolJson(res.result)).toEqual({
      error: { code: "not_found", message: "No such message.", messageId: "m1" },
    });
  });

  it("fails closed on a call that needs approval until approvals exist", async () => {
    const res = await directRpc("full", ["mail.read"], "tools/call", {
      name: "test_approval",
      arguments: {},
    });
    expect(res.result?.isError).toBe(true);
    expect(toolJson(res.result)).toMatchObject({ error: { code: "internal" } });
  });
});

describe("audience check", () => {
  it("builds no server for a token whose audience is another endpoint", async () => {
    const res = await direct("full", ["mail.read"], "tools/list", {}, resourceUrl("ro", ISSUER));
    expect(res.status).toBe(500);
    expect((await parseMcp(res)).error).toMatchObject({ code: -32603 });
  });

  it("answers 401 without a token, through the Worker", async () => {
    const res = await mcpCall(undefined, "full", "tools/list", {});
    expect(res.status).toBe(401);
  });
});

describe("registry", () => {
  const family = (tools: ToolDef[], id = "f"): Family => ({
    id,
    tools,
    bindings: {},
    parityPending: [],
  });

  it("refuses bad definitions at load", () => {
    expect(() => compileRegistry([family([tool("a", {}), tool("a", {})])])).toThrow(
      "duplicate tool name a",
    );
    expect(() => compileRegistry([family([]), family([])])).toThrow("duplicate family id f");
    expect(() => compileRegistry([family([tool("Bad-Name", {})])])).toThrow("snake_case");
    expect(() => compileRegistry([family([tool("a", { endpoints: [] })])])).toThrow("no endpoint");
    expect(() =>
      compileRegistry([family([tool("a", { endpoints: ["full", "ro"], scopes: ["mail.send"] })])]),
    ).toThrow("scope mail.send is not allowed on ro");
    expect(() =>
      compileRegistry([family([tool("a", { endpoints: ["full"], scopes: ["admin"] })])]),
    ).toThrow("scope admin is not allowed on full");
  });

  it("precomputes frozen lists and memoises them per kind and scope set", () => {
    const a = REGISTRY.listFor("full", ["mail.read", "files"]);
    expect(REGISTRY.listFor("full", ["files", "mail.read"])).toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a[0]?.inputSchema)).toBe(true);
    const compiled = testRegistry.byKind.full.find((t) => t.def.name === "test_echo");
    expect(compiled?.listed.inputSchema).toMatchObject({
      type: "object",
      required: ["count", "label"],
    });
  });

  it("reads the grant id from the middle of the access token", () => {
    expect(grantIdOf("o_a:g_b:secret")).toBe("g_b");
    for (const bad of ["o_a:g_b", "o_a::secret", "o_a:g_b:s:x", ""]) {
      expect(() => grantIdOf(bad)).toThrow();
    }
  });
});
