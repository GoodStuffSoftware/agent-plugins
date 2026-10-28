// JSON-RPC calls to the MCP endpoints through the Worker (ARCHITECTURE s.6, "MCP calls").
//
// Pinned request headers for the stateless handler (2025-era lane, which claude.ai uses):
//   Authorization: Bearer <token>
//   Host: <issuer host>                                  (else 403 "Missing Host header"; a
//                                                        browser or edge request always has one)
//   Content-Type: application/json                       (else 415)
//   Accept: application/json, text/event-stream          (both, else 406)
// The answer is an SSE body: `event: message` then one `data: <JSON-RPC response>` line.

import { exports } from "cloudflare:workers";
import { type Kind, PATH } from "../../src/auth/endpoints";

export const ISSUER = "https://mcp.example.com";

export const MCP_HEADERS: Readonly<Record<string, string>> = {
  Host: new URL(ISSUER).host,
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

let nextId = 1;

/** The Request `mcpCall` sends; `headers` overrides or drops (`null`) pinned headers. */
export function mcpRequest(
  token: string | undefined,
  kind: Kind,
  method: string,
  params?: Record<string, unknown>,
  headers: Record<string, string | null> = {},
): Request {
  const h = new Headers(MCP_HEADERS);
  if (token) h.set("Authorization", `Bearer ${token}`);
  for (const [k, v] of Object.entries(headers)) {
    if (v === null) h.delete(k);
    else h.set(k, v);
  }
  const body: Record<string, unknown> = { jsonrpc: "2.0", id: nextId++, method };
  if (params !== undefined) body.params = params;
  return new Request(ISSUER + PATH[kind], {
    method: "POST",
    headers: h,
    body: JSON.stringify(body),
  });
}

/** A JSON-RPC response: `result` or `error`. */
export interface RpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

/** Reads a JSON or SSE response body into the JSON-RPC response it carries. */
export async function parseMcp(res: Response): Promise<RpcResponse> {
  const text = await res.text();
  if ((res.headers.get("Content-Type") ?? "").includes("text/event-stream")) {
    const data = text.split("\n").find((l) => l.startsWith("data: "));
    if (!data) throw new Error(`no data line in SSE body: ${text}`);
    return JSON.parse(data.slice("data: ".length)) as RpcResponse;
  }
  return JSON.parse(text) as RpcResponse;
}

/** Posts one JSON-RPC request to `PATH[kind]` through `exports.default.fetch`. */
export function mcpCall(
  token: string | undefined,
  kind: Kind,
  method: string,
  params?: Record<string, unknown>,
): Promise<Response> {
  return exports.default.fetch(mcpRequest(token, kind, method, params));
}

/** `mcpCall` plus `parseMcp`, for calls expected to answer 200. */
export async function mcpRpc(
  token: string,
  kind: Kind,
  method: string,
  params?: Record<string, unknown>,
): Promise<RpcResponse> {
  const res = await mcpCall(token, kind, method, params);
  if (res.status !== 200) throw new Error(`${method} answered ${res.status}: ${await res.text()}`);
  return parseMcp(res);
}

/** The parsed JSON of a tool result's single text block. */
export function toolJson(result: Record<string, unknown> | undefined): unknown {
  const content = result?.content as { type: string; text: string }[] | undefined;
  if (!content || content.length !== 1 || content[0]?.type !== "text") {
    throw new Error(`expected one text block, got ${JSON.stringify(result)}`);
  }
  return JSON.parse(content[0].text);
}
