// `GET /oauth/google/callback` (ARCHITECTURE s.1.5): consume the single-use flow state, then
// dispatch on its kind. `signin` (M4b) checks the ID token, resolves the owner and sets the owner
// session; `link` (M7) is `finishLink` in `link.ts`. `src/index.ts` routes the path here by exact
// match, outside Hono, and adds the security headers.
//
// Every failure answers with a page and sets no cookie. A refused identity also gets a log line
// with a keyed hash of the address, never the address.

import { authorizationErrorRedirect } from "@cloudflare/workers-oauth-provider";
import { config, type Env } from "../env";
import { notConfigured, notice, redirect, signinClient } from "./consent";
import { consumeFlow, FLOW_COOKIE, signinPayload } from "./flow-state";
import { callbackUrl, checkIdToken, exchangeCode, type GoogleClient } from "./google-oidc";
import { finishLink } from "./link";
import { emailHash, resolveOwner } from "./owners";
import { getAuth } from "./server";
import { clearCookie, createSession } from "./session";

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields, at: new Date().toISOString() }));
}

export async function handleCallback(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const client = signinClient(env);
  if (!client) return notConfigured();
  if (req.method !== "GET") {
    const res = notice(405, "Method not allowed", "Use GET.");
    res.headers.set("Allow", "GET");
    return res;
  }
  const url = new URL(req.url);
  const flow = await consumeFlow(env.DB, req, url.searchParams.get("state"));
  if (!flow.ok) {
    log("signin_flow_refused", { reason: flow.reason });
    return notice(
      400,
      "Sign-in link not valid",
      "This sign-in link has expired, was already used or belongs to another browser. Start again from your client.",
    );
  }
  switch (flow.kind) {
    case "signin":
      return finishSignin(req, env, client, url, flow.payload);
    case "link":
      return finishLink(req, env, client, url, flow.payload);
  }
}

async function finishSignin(
  req: Request,
  env: Env,
  client: GoogleClient,
  url: URL,
  flowPayload: unknown,
): Promise<Response> {
  const payload = signinPayload(flowPayload);
  if (!payload) return notice(400, "Sign-in failed", "The sign-in state is damaged. Start again.");
  const { issuer } = config(env);

  if (url.searchParams.has("error")) {
    // Cancelled or refused at Google: tell the MCP client, if its request still parses.
    log("signin_failed", { reason: "google_error" });
    try {
      const original = await getAuth(env)
        .as.getOAuthApi(env)
        .parseAuthRequest(new Request(issuer + payload.returnTo));
      return redirect(
        authorizationErrorRedirect(original, "access_denied", "Owner sign-in was cancelled."),
      );
    } catch {
      return notice(400, "Sign-in cancelled", "Google sign-in did not complete.");
    }
  }

  const code = url.searchParams.get("code");
  if (!code) return notice(400, "Sign-in failed", "Google returned no authorization code.");
  let idToken: unknown;
  try {
    const tokens = await exchangeCode(client, {
      code,
      verifier: payload.verifier,
      redirectUri: callbackUrl(issuer),
    });
    idToken = tokens.id_token;
  } catch (e) {
    log("signin_failed", { reason: "token_exchange", status: (e as { status?: number }).status });
    return notice(502, "Sign-in failed", "Google did not complete the sign-in. Try again.");
  }

  const identity = checkIdToken(idToken, { clientId: client.clientId, nonce: payload.nonce });
  if (!identity.ok) {
    log("signin_failed", { reason: `id_token_${identity.reason}` });
    return notice(400, "Sign-in failed", "Google's answer could not be verified. Try again.");
  }

  const owner = await resolveOwner(env, identity.email, identity.sub);
  if (!owner.ok) {
    log("signin_refused", {
      reason: owner.reason,
      email_hash: await emailHash(env, identity.email),
      country: req.cf?.country ?? null,
    });
    return notice(403, "Not allowed", "This Google account cannot sign in to this server.");
  }

  const { setCookie } = await createSession(env, owner.ownerId, identity.email);
  log("signin", {
    owner_id: owner.ownerId,
    email_hash: await emailHash(env, identity.email),
    pinned: owner.pinned,
  });
  const headers = new Headers();
  headers.append("Set-Cookie", setCookie);
  headers.append("Set-Cookie", clearCookie(FLOW_COOKIE));
  return redirect(new URL(sameOriginPath(payload.returnTo), issuer).toString(), headers);
}

/** `returnTo` if it is a plain same-origin path, else `/`. */
function sameOriginPath(returnTo: string): string {
  return returnTo.startsWith("/") && !returnTo.startsWith("//") && !returnTo.includes("\\")
    ? returnTo
    : "/";
}
