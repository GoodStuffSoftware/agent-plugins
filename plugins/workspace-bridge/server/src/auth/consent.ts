// SEAM, replaced in M4b. `GET/POST /authorize`: parse the request, owner session gate, consent
// page, approve, clamp scope with `endpointScopes`, `completeAuthorization` (ARCHITECTURE s.1.5).
// `src/index.ts` already routes `/authorize` here by exact path, outside Hono, and adds the
// security headers; M4b replaces this body and keeps the signature. M4b also refuses requests
// without PKCE S256 for every client: the library requires it only for public clients.

import type { Env } from "../env";

export function handleAuthorize(
  _req: Request,
  _env: Env,
  _ctx: ExecutionContext,
): Response | Promise<Response> {
  return new Response("sign-in not configured", {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
