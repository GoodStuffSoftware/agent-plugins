// Real MCP tokens for tests (ARCHITECTURE s.6). Runs the library's own flow: createClient,
// parseAuthRequest, completeAuthorization, then the code exchange with PKCE S256 at
// /oauth/token through the Worker. Nothing in the OAuth library is stubbed.

import { env, exports } from "cloudflare:workers";
import { type Kind, resourceUrl } from "../../src/auth/endpoints";
import { getAuth } from "../../src/auth/server";
import { base64url, randomBytes, sha256 } from "../../src/core/crypto";
import { config } from "../../src/env";

export const REDIRECT_URI = "https://client.example.com/callback";

export interface MintOptions {
  kind: Kind;
  /** Scopes written into the grant, as `completeAuthorization` receives them. */
  scopes: readonly string[];
  /** The grant's `userId` and `props.ownerId`; must not contain `:`. */
  ownerId: string;
}

export interface AuthorizedCode {
  code: string;
  verifier: string;
  clientId: string;
  resource: string;
}

/** Everything up to the authorization code: a new public client, PKCE S256, `resource`. */
export async function authorizeCode({
  kind,
  scopes,
  ownerId,
}: MintOptions): Promise<AuthorizedCode> {
  const { issuer } = config(env);
  const api = getAuth(env).as.getOAuthApi(env);
  const client = await api.createClient({
    redirectUris: [REDIRECT_URI],
    tokenEndpointAuthMethod: "none",
    clientName: "test client",
  });
  const verifier = base64url(randomBytes(32));
  const resource = resourceUrl(kind, issuer);
  const url = new URL("/authorize", issuer);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: REDIRECT_URI,
    scope: scopes.join(" "),
    state: "test-state",
    code_challenge: base64url(await sha256(verifier)),
    code_challenge_method: "S256",
    resource,
  }).toString();
  const request = await api.parseAuthRequest(new Request(url));
  const { redirectTo } = await api.completeAuthorization({
    request,
    userId: ownerId,
    metadata: {},
    scope: [...scopes],
    props: { ownerId },
  });
  const code = new URL(redirectTo).searchParams.get("code");
  if (!code) throw new Error(`no code in ${redirectTo}`);
  return { code, verifier, clientId: client.clientId, resource };
}

/** POSTs the code to /oauth/token. `verifier: null` omits `code_verifier`. */
export function exchangeCode(
  auth: AuthorizedCode,
  { verifier = auth.verifier }: { verifier?: string | null } = {},
): Promise<Response> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: auth.code,
    client_id: auth.clientId,
    redirect_uri: REDIRECT_URI,
    resource: auth.resource,
  });
  if (verifier !== null) body.set("code_verifier", verifier);
  return exports.default.fetch(
    new Request(new URL("/oauth/token", config(env).issuer), { method: "POST", body }),
  );
}

/** An access token for `kind` holding exactly `scopes`. */
export async function mintToken(options: MintOptions): Promise<string> {
  const res = await exchangeCode(await authorizeCode(options));
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  const { access_token } = await res.json<{ access_token: string }>();
  return access_token;
}
