// `GET/POST /authorize`: the owner session gate and the consent page (ARCHITECTURE s.1.5;
// plan s.4.2). `src/index.ts` routes the path here by exact match, outside Hono, and adds the
// security headers.
//
// GET parses the MCP client's request (the library validates the client, the redirect URI and the
// resource) and refuses it without PKCE S256, for every client: the library requires PKCE only
// for public clients. Without a valid owner session it starts Google sign-in, whose callback
// returns here. With one it shows the consent page. POST checks the session and its CSRF token,
// then denies, or approves with the scope clamped to the endpoint's and the owner id as `userId`.

import {
  AuthorizationError,
  type AuthRequest,
  authorizationErrorRedirect,
  CimdFetchError,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { base64url, randomBytes, sha256 } from "../core/crypto";
import { config, type Env } from "../env";
import { htmlResponse, page, SECURITY_HEADERS } from "../web/html";
import { consentView, noticeView } from "../web/views";
import {
  ALL_SCOPES,
  endpointScopes,
  KINDS,
  type Kind,
  PATH,
  resourceUrl,
  SCOPES,
  type Scope,
} from "./endpoints";
import { createFlow, type SigninPayload } from "./flow-state";
import { callbackUrl, type GoogleClient, googleClient, signinUrl } from "./google-oidc";
import { getAuth, type Props } from "./server";
import { checkCsrf, cookieSecret, csrfToken, readSession, type Session } from "./session";

const SCOPE_LABELS: Readonly<Record<Scope, string>> = {
  "mail.read": "Read mail",
  "mail.write": "Organize mail and write drafts",
  "mail.send": "Send mail",
  calendar: "Calendar",
  files: "Drive files",
  contacts: "Contacts",
  admin: "Workspace administration",
};

const ENDPOINT_LABELS: Readonly<Record<Kind, string>> = {
  full: "full access",
  ro: "read-only: no sending",
  admin: "administration",
};

/**
 * The Google client when sign-in can run: both Google secrets and a usable `COOKIE_SECRET`.
 * Otherwise `/authorize` and the callback answer 503 and touch neither D1 nor KV.
 */
export function signinClient(env: Env): GoogleClient | undefined {
  return cookieSecret(env) ? googleClient(env) : undefined;
}

/** A small HTML page that is never cached. */
export function notice(status: number, title: string, message: string): Response {
  const res = htmlResponse(page(title, noticeView(title, message)), status);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export const notConfigured = (): Response =>
  notice(
    503,
    "Sign-in not configured",
    "Owner sign-in is not configured on this server yet, so it cannot authorize clients.",
  );

/** A 302 that copies `headers` (cookies included) and is never cached. */
export function redirect(location: string, headers?: Headers): Response {
  const out = new Headers({ "Cache-Control": "no-store" });
  if (headers) {
    for (const [name, value] of headers) {
      if (name.toLowerCase() !== "set-cookie") out.set(name, value);
    }
    for (const cookie of headers.getSetCookie()) out.append("Set-Cookie", cookie);
  }
  out.set("Location", location);
  return new Response(null, { status: 302, headers: out });
}

export async function handleAuthorize(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const client = signinClient(env);
  if (!client) return notConfigured();
  if (req.method === "GET") return authorizeGet(req, env, client);
  if (req.method === "POST") return consentPost(req, env);
  const res = notice(405, "Method not allowed", "Use GET or POST.");
  res.headers.set("Allow", "GET, POST");
  return res;
}

async function authorizeGet(req: Request, env: Env, client: GoogleClient): Promise<Response> {
  const api = getAuth(env).as.getOAuthApi(env);
  let request: AuthRequest;
  try {
    request = await api.parseAuthRequest(req);
  } catch (e) {
    return authorizationFailure(e);
  }
  if (!request.codeChallenge || request.codeChallengeMethod !== "S256") {
    return redirect(
      authorizationErrorRedirect(request, "invalid_request", "PKCE with S256 is required."),
    );
  }
  const session = await readSession(req, env);
  if (!session) {
    const url = new URL(req.url);
    return startSignin(env, client, url.pathname + url.search);
  }
  try {
    return await consentPage(env, api, request, session);
  } catch (e) {
    return authorizationFailure(e);
  }
}

/**
 * Starts Google sign-in: a single-use `signin` flow row bound to this browser, then a redirect to
 * Google. The callback returns the browser to `returnTo`, a same-origin path.
 */
export async function startSignin(
  env: Env,
  client: GoogleClient,
  returnTo: string,
): Promise<Response> {
  const verifier = base64url(randomBytes(32));
  const nonce = base64url(randomBytes(32));
  const payload: SigninPayload = { verifier, nonce, returnTo };
  const { state, setCookie } = await createFlow(env.DB, "signin", payload);
  const location = signinUrl({
    clientId: client.clientId,
    redirectUri: callbackUrl(config(env).issuer),
    state,
    nonce,
    codeChallenge: base64url(await sha256(verifier)),
  });
  return redirect(location, new Headers({ "Set-Cookie": setCookie }));
}

/** The endpoint a parsed request's canonical `resource` names. */
function kindOf(resource: string | undefined, issuer: string): Kind | undefined {
  return KINDS.find((k) => resourceUrl(k, issuer) === resource);
}

async function consentPage(
  env: Env,
  api: OAuthHelpers,
  request: AuthRequest,
  session: Session,
): Promise<Response> {
  const kind = kindOf(request.resource, config(env).issuer);
  if (!kind) return notice(400, "Request refused", "The request names no known endpoint.");
  const about = await api.describeConsent(request);
  const consent = await api.beginConsent(request);
  const csrf = await csrfToken(env, session);
  const body = consentView({
    clientName: about.clientName,
    clientDomain: about.clientDomain,
    redirectHost: about.redirectHost,
    redirectUri: about.redirectUri,
    loopback: about.redirectIsLoopback,
    path: PATH[kind],
    endpointLabel: ENDPOINT_LABELS[kind],
    email: session.email,
    handle: consent.handle,
    csrf,
    choices: SCOPES[kind].map((scope) => ({ scope, label: SCOPE_LABELS[scope] })),
  });
  const res = htmlResponse(page(`Authorize ${about.clientName}`, body));
  for (const [name, value] of consent.headers) {
    if (name.toLowerCase() !== "set-cookie") res.headers.set(name, value);
  }
  for (const cookie of consent.headers.getSetCookie()) res.headers.append("Set-Cookie", cookie);
  // The library sets only `frame-ancestors`; the page gets the full policy.
  res.headers.set("Content-Security-Policy", SECURITY_HEADERS["Content-Security-Policy"] ?? "");
  res.headers.set("Cache-Control", "no-store");
  return res;
}

async function consentPost(req: Request, env: Env): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return notice(400, "Request refused", "The form could not be read.");
  }
  const session = await readSession(req, env);
  if (!session) {
    return notice(
      403,
      "Sign-in required",
      "Your sign-in has expired. Start again from your client.",
    );
  }
  const csrf = form.get("csrf");
  if (!(await checkCsrf(env, session, typeof csrf === "string" ? csrf : null))) {
    return notice(403, "Request refused", "The form token is missing or wrong. Start again.");
  }
  const handle = form.get("handle");
  const decision = form.get("decision");
  if (typeof handle !== "string" || handle === "") {
    return notice(400, "Request refused", "The form is incomplete. Start again.");
  }
  const api = getAuth(env).as.getOAuthApi(env);
  try {
    if (decision === "deny") {
      const denied = await api.denyConsent(req, handle);
      return redirect(denied.redirectTo, denied.headers);
    }
    if (decision !== "approve") return notice(400, "Request refused", "Choose approve or deny.");
    const posted = form.getAll("scope").filter((s): s is string => typeof s === "string");
    if (!posted.some((s) => (ALL_SCOPES as readonly string[]).includes(s))) {
      // The handle is not used up: the owner can go back and select something, or deny.
      return notice(400, "Nothing selected", "Select at least one item, or deny.");
    }
    const approved = await api.approveConsent(req, handle);
    const kind = kindOf(approved.request.resource, config(env).issuer);
    // Whatever was posted, only the endpoint's own scopes are granted: `/mcp/ro` never holds
    // `mail.send`, and `admin` exists only on `/mcp/admin`.
    const granted = kind ? endpointScopes(kind, posted) : [];
    if (granted.length === 0) {
      return redirect(
        authorizationErrorRedirect(approved.request, "invalid_scope", "No scope was granted."),
        approved.headers,
      );
    }
    const props: Props = { ownerId: session.ownerId };
    const { redirectTo } = await api.completeAuthorization({
      request: { ...approved.request, scope: granted },
      userId: session.ownerId,
      metadata: {},
      scope: granted,
      props,
    });
    return redirect(redirectTo, approved.headers);
  } catch (e) {
    return authorizationFailure(e);
  }
}

/** Library refusals: redirect to the client only when the library says it is safe. */
function authorizationFailure(e: unknown): Response {
  if (e instanceof AuthorizationError) {
    if (e.redirectTo) return redirect(e.redirectTo);
    return notice(400, "Request refused", e.description);
  }
  if (e instanceof CimdFetchError) {
    return notice(400, "Request refused", "The client's metadata document could not be loaded.");
  }
  throw e;
}
