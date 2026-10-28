// Top-level router: exact paths first (ARCHITECTURE s.1.2). `/mcp/ro` and `/mcp/admin` are
// descendants of `/mcp`, so each path goes to its own resource server, whose exact audience
// check refuses a token minted for another endpoint. OAuth and MCP stay out of Hono.

import { handleCallback } from "./auth/callback";
import { handleAuthorize } from "./auth/consent";
import { KINDS, type Kind, PATH } from "./auth/endpoints";
import { getAuth, REGISTER_PATH } from "./auth/server";
import { nowSeconds } from "./core/db";
import { PENDING_KEEP_SECONDS } from "./core/pending";
import { config, type Env } from "./env";
import { app } from "./web/app";
import { withSecurityHeaders } from "./web/html";

const RS_ROUTES = new Map<string, Kind>(
  KINDS.flatMap(
    (k) =>
      [
        [PATH[k], k],
        [`/.well-known/oauth-protected-resource${PATH[k]}`, k],
      ] as const,
  ),
);

const AS_PATHS = new Set([
  "/.well-known/oauth-authorization-server",
  "/oauth/token",
  REGISTER_PATH,
]);

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const { pathname } = new URL(req.url);
  const kind = RS_ROUTES.get(pathname);
  if (kind) return getAuth(env).rs[kind].fetch(req, env, ctx);
  if (AS_PATHS.has(pathname)) {
    if (pathname === REGISTER_PATH) {
      const limited = await registrationLimited(req, env);
      if (limited) return limited;
    }
    return getAuth(env).as.fetch(req, env, ctx);
  }
  if (pathname === "/authorize") return withSecurityHeaders(await handleAuthorize(req, env, ctx));
  if (pathname === "/oauth/google/callback") {
    return withSecurityHeaders(await handleCallback(req, env, ctx));
  }
  return app.fetch(req, env, ctx);
}

/** Dynamic Client Registration limit (plan s.4.1): 429 when the `DCR_LIMIT` binding trips. */
async function registrationLimited(req: Request, env: Env): Promise<Response | undefined> {
  if (!env.DCR_LIMIT || req.method === "OPTIONS") return undefined;
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.DCR_LIMIT.limit({ key: `dcr:${ip}` });
  if (success) return undefined;
  return Response.json(
    {
      error: "temporarily_unavailable",
      error_description: "Too many client registrations. Retry later.",
    },
    { status: 429, headers: { "Retry-After": "60", "Cache-Control": "no-store" } },
  );
}

/** Rate counter windows are at most a day long; older rows only take space. */
const COUNTER_KEEP_SECONDS = 2 * 86400;
/** OAuth purge rounds per run, 50 grants and 50 tokens each. */
const PURGE_ROUNDS = 5;

/**
 * The daily cleanup (cron in wrangler.example.jsonc): pending actions past their expiry become
 * `expired`, settled actions a week past expiry are deleted, and expired flow states, old rate
 * counters and audit rows older than
 * `AUDIT_RETENTION_DAYS` are deleted, in one batch; then expired OAuth grants and tokens are purged.
 */
export async function cleanup(env: Env, now = nowSeconds()): Promise<void> {
  const db = env.DB;
  const auditBefore = now - config(env).auditRetentionDays * 86400;
  await db.batch([
    db
      .prepare(
        "UPDATE pending_actions SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?",
      )
      .bind(now),
    db
      .prepare("DELETE FROM pending_actions WHERE status != 'pending' AND expires_at < ?")
      .bind(now - PENDING_KEEP_SECONDS),
    db.prepare("DELETE FROM flow_states WHERE expires_at <= ?").bind(now),
    db.prepare("DELETE FROM rate_counters WHERE window_start < ?").bind(now - COUNTER_KEEP_SECONDS),
    db.prepare("DELETE FROM audit_log WHERE at < ?").bind(auditBefore),
  ]);
  const as = getAuth(env).as;
  let cursor: string | undefined;
  for (let i = 0; i < PURGE_ROUNDS; i++) {
    const res = await as.purgeExpiredData(env, { batchSize: 50, cursor });
    if (res.done || !res.cursor) break;
    cursor = res.cursor;
  }
}

export default {
  fetch: route,
  scheduled: (_controller, env, ctx) => ctx.waitUntil(cleanup(env)),
} satisfies ExportedHandler<Env>;
