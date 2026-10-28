// One authorization server and three audience-bound resource servers (ARCHITECTURE s.1.1).

import {
  insufficientScope,
  OAuthAuthorizationServer,
  type OAuthResourceAuth,
  type OAuthResourceContext,
  OAuthResourceServer,
} from "@cloudflare/workers-oauth-provider";
import { config, type Env } from "../env";
import {
  ALL_SCOPES,
  endpointScopes,
  KINDS,
  type Kind,
  resourceUrl,
  SCOPES,
  SERVER_NAME,
} from "./endpoints";
import { mcpHandler } from "./mcp-factory";

/** What a grant carries into the MCP layer as `ctx.props`. */
export interface Props {
  ownerId: string;
}

export const ACCESS_TOKEN_TTL = 4 * 3600;
export const REFRESH_TOKEN_TTL = 30 * 86400;
export const REGISTER_PATH = "/oauth/register";

export interface Auth {
  issuer: string;
  as: OAuthAuthorizationServer<Env>;
  rs: Readonly<Record<Kind, OAuthResourceServer<Env, Props>>>;
}

let memo: Auth | undefined;

/** The AS and RS objects, built once per isolate (rebuilt only if `PUBLIC_URL` changes). */
export function getAuth(env: Env): Auth {
  const { issuer } = config(env);
  if (memo?.issuer !== issuer) memo = build(issuer);
  return memo;
}

function build(issuer: string): Auth {
  const as = new OAuthAuthorizationServer<Env>({
    issuer,
    resources: KINDS.map((k) => resourceUrl(k, issuer)),
    defaultResource: resourceUrl("full", issuer),
    scopesSupported: [...ALL_SCOPES],
    clientRegistrationEndpoint: REGISTER_PATH,
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: ACCESS_TOKEN_TTL,
    refreshTokenTTL: REFRESH_TOKEN_TTL,
    refreshTokenIdleTTL: REFRESH_TOKEN_TTL,
  });
  const rs = {} as Record<Kind, OAuthResourceServer<Env, Props>>;
  for (const k of KINDS) rs[k] = resourceServer(k, issuer, as);
  return { issuer, as, rs };
}

function resourceServer(
  kind: Kind,
  issuer: string,
  as: OAuthAuthorizationServer<Env>,
): OAuthResourceServer<Env, Props> {
  const mcp = mcpHandler(kind, issuer);
  const required = [...SCOPES[kind]];
  return new OAuthResourceServer<Env, Props>({
    resourceMetadata: {
      resource: resourceUrl(kind, issuer),
      authorization_servers: [issuer],
      resource_name: SERVER_NAME[kind],
    },
    requiredScopes: required,
    validateToken: (env) => (resource, token) => as.validateToken<Props>(resource, token, env),
    handler: {
      fetch(req: Request, env: Env, ctx: OAuthResourceContext<Props>) {
        // Only this endpoint's scopes reach the MCP layer; none left is a 403 step-up.
        const kept = endpointScopes(kind, ctx.auth.scope);
        if (kept.length === 0) return insufficientScope(ctx.auth, required);
        (ctx as { auth: OAuthResourceAuth }).auth = { ...ctx.auth, scope: kept };
        return mcp(req, env, ctx);
      },
    },
  });
}
