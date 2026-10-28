// SEAM, replaced in M4b. `GET /oauth/google/callback`: consume the single-use flow state, then
// dispatch on its kind: `signin` (M4b) or `link` (one dispatch line, filled by M7).
// `src/index.ts` already routes the path here by exact match, outside Hono, and adds the security
// headers; M4b replaces this body and keeps the signature.

import type { Env } from "../env";

export function handleCallback(
  _req: Request,
  _env: Env,
  _ctx: ExecutionContext,
): Response | Promise<Response> {
  return new Response("sign-in not configured", {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
