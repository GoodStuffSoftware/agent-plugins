// The stateless MCP handler behind each resource server (ARCHITECTURE s.1.3). A new McpServer per
// HTTP request; per-request work is constructing it and registering the endpoint's tools.
// `auth/server.ts` calls `mcpHandler(kind, issuer)` once per kind and passes only requests that
// hold a valid token for this endpoint, with `ctx.auth.scope` reduced to the endpoint's scopes.

import type { OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { McpServer, preloadSchemas } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import type { Env } from "../env";
import { REGISTRY, type Registry } from "../registry/compile";
import { requestScope } from "../registry/context";
import { registerAll } from "../registry/register";
import { VERSION } from "../version";
import { type Kind, PATH, resourceUrl, SERVER_NAME } from "./endpoints";
import type { Props } from "./server";

export type McpFetch = (
  req: Request,
  env: Env,
  ctx: OAuthResourceContext<Props>,
) => Response | Promise<Response>;

// Module scope: the SDK's protocol schemas are built during isolate warm-up (s.8).
preloadSchemas();

/**
 * Hands the Worker's `env` and execution context to the server factory, keyed on the Request
 * object the factory receives as `requestInfo` (the same object in both protocol lanes).
 */
const worker = new WeakMap<Request, { env: Env; exec: ExecutionContext }>();

/** `registry` is for tests; production uses the module-scope `REGISTRY`. */
export function mcpHandler(kind: Kind, issuer: string, registry: Registry = REGISTRY): McpFetch {
  const audience = resourceUrl(kind, issuer);
  const handler = createMcpHandler(
    ({ authInfo, requestInfo }) => {
      const w = requestInfo && worker.get(requestInfo);
      // Fail closed: no validated token, or a token for another resource, never gets a server.
      if (!w || !authInfo || authInfo.resource?.href !== new URL(audience).href) {
        throw new Error("MCP request without a token for this endpoint");
      }
      const server = new McpServer(
        { name: SERVER_NAME[kind], version: VERSION },
        { capabilities: { tools: { listChanged: false } } },
      );
      registerAll(server, registry, requestScope(kind, authInfo, w.env, w.exec));
      return server;
    },
    { route: PATH[kind], allowedHostnames: [new URL(issuer).hostname] },
  );
  return (req, env, ctx) => {
    worker.set(req, { env, exec: ctx });
    return handler(req, env, ctx);
  };
}
