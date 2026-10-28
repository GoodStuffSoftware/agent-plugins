// SEAM, replaced in M5. The MCP handler behind each resource server (ARCHITECTURE s.1.3).
//
// M5 replaces the body of `mcpHandler` with
//   createMcpHandler((c) => buildServer(kind, c), { route: PATH[kind],
//     allowedHostnames: [new URL(issuer).hostname] })
// from "agents/mcp/server", and adds `buildServer`. Keep the signature: `auth/server.ts` calls
// `mcpHandler(kind, issuer)` once per kind and passes requests that already hold a valid token
// for this endpoint, with `ctx.auth.scope` reduced to the endpoint's scopes.

import type { OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../env";
import type { Kind } from "./endpoints";
import type { Props } from "./server";

export type McpFetch = (
  req: Request,
  env: Env,
  ctx: OAuthResourceContext<Props>,
) => Response | Promise<Response>;

export function mcpHandler(kind: Kind, _issuer: string): McpFetch {
  // `scope` lets M4a tests see the RS narrowing; M5 drops this body.
  return (_req, _env, ctx) =>
    Response.json({ kind, ownerId: ctx.props.ownerId, scope: ctx.auth.scope });
}
