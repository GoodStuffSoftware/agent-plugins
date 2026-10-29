# workspace-bridge server: architecture and module contracts

Developer reference for the Cloudflare Worker in `plugins/workspace-bridge/server/`. It fixes the library shapes, the module layout, the TypeScript contracts, the D1 schema and the order in which milestones M4-M21 can be built, so tool families can be written in parallel without editing each other's files. "Plan s.N" points at the maintainers' design plan; what an implementer needs from it is restated here. Hostnames and addresses are placeholders (`mcp.example.com`, `owner@example.com`).

Pinned versions (`package.json`): `@cloudflare/workers-oauth-provider` 1.2.4, `agents` 0.31.0, `@modelcontextprotocol/server` 2.3.1, `zod` 4.6.7, `hono` 4.13.14; dev: `@cloudflare/vitest-plugin` 1.4.9, `vitest` 5.0.5, `wrangler` 4.154.0, `typescript` 7.0.2, `@cloudflare/workers-types` 5.20261028.1, `@biomejs/biome` 2.6.3.

## 1. Library shapes

**How claims are backed.** "Verified (wb-proto:N)" marks an excerpt of a scratch project that installs exactly these versions and passes `tsc --noEmit` with `strict` and `skipLibCheck`; N is its line. A "negative probe" is a line that must fail type-check, with the code tsc reported. "Design" marks code that has not been type-checked. Other claims cite `file:line` under `node_modules/` for these versions; bundled chunk names carry build hashes and change with versions.

| Short      | File under `node_modules/`                                                                 |
| ---------- | ------------------------------------------------------------------------------------------ |
| OP, OPJ    | `@cloudflare/workers-oauth-provider/dist/oauth-provider.d.ts`, `.js`                       |
| OPD        | `@cloudflare/workers-oauth-provider/docs/`                                                 |
| AG, AGJ    | `agents/dist/handler-stateless-C90kD5_R.d.ts`, `agents/dist/handler-stateless-B5hU3dxK.js` |
| AGM        | `agents/dist/mcp/index.d.ts` (the root `agents/mcp` entry)                                 |
| SDK        | `@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts`                        |
| SDKJ, SDKS | `@modelcontextprotocol/server/dist/mcp-DIH4cS6P.mjs`, `src-Cqbh3MYc.mjs`                   |
| VT, VP     | `@cloudflare/vitest-plugin/types/cloudflare-test.d.ts`, `dist/pool/index.d.mts`            |
| WT         | `@cloudflare/workers-types/index.d.ts`                                                     |

### 1.1 One authorization server, three resource servers

The role-based API splits the AS from each protected resource. The AS lists the three resource URLs; scopes and metadata live on each resource server (RS).

```ts
// Verified (wb-proto:60-63)
const as = new OAuthAuthorizationServer<Env>({
  issuer,
  resources: KINDS.map((k) => issuer + PATH[k]),
  defaultResource: issuer + PATH.full,
  scopesSupported: [...new Set(KINDS.flatMap((k) => SCOPES[k]))],
  clientRegistrationEndpoint: "/oauth/register",
  clientIdMetadataDocumentEnabled: true,
  accessTokenTTL: 4 * 3600,
  refreshTokenTTL: 30 * 86400,
  refreshTokenIdleTTL: 30 * 86400,
});
```

- Options: `issuer`, `resources`, `defaultResource` OP:1151-1174 (authorize and token endpoints default to `${issuer}/authorize` and `${issuer}/oauth/token`); `clientRegistrationEndpoint` OP:989; TTLs OP:994, 1003, 1015; `scopesSupported` OP:1030; `clientIdMetadataDocumentEnabled` OP:1120.
- Negative probe N2 (TS2353): `requiredScopes` is not an AS option; the AS options type omits it (OP:1151).

```ts
// Verified (wb-proto:68-73), one per kind
rs[k] = new OAuthResourceServer<Env, Props>({
  resourceMetadata: {
    resource: issuer + PATH[k],
    authorization_servers: [issuer],
    resource_name: `workspace-bridge ${k}`,
  },
  requiredScopes: [...SCOPES[k]],
  validateToken: (e) => (resource, token) => as.validateToken<Props>(resource, token, e),
  handler: {
    fetch: (req: Request, e: Env, ctx: OAuthResourceContext<Props>) =>
      ctx.auth.scope.length === 0 ? insufficientScope(ctx.auth, [...SCOPES[k]]) : mcp(req, e, ctx),
  },
});
```

- `requiredScopes` is "Advertised, not enforced" (OP:563), so the handler enforces scope itself with `insufficientScope()` (OP:597).
- In one Worker, `validateToken` calls the AS directly (OP:574, 585; OPD/resource-servers.md:36-94).
- `ctx.auth` is `{ token, audience, expiresAt?, scope[], userId?, clientId? }` (OP:515-531); `OAuthResourceContext` is `ExecutionContext<Props> & { auth }` (OP:533-535).
- The RS compares audience exactly: the token's audience must equal its resource (OPJ:2053-2055 via `resourceMatches`, OPJ:994-998). Paths are not exact: the RS treats its resource path and every descendant path as its own (OP:565, OPJ:2040-2048). The combined `OAuthProvider` class also accepts descendant audiences (OPJ:5244-5252); we do not use it.

Production RS handler (`src/auth/server.ts`, M4a): bound to its kind, it keeps only the granted scopes that belong to the endpoint (`endpointScopes(kind, ctx.auth.scope)`), returns `insufficientScope(ctx.auth, SCOPES[kind])` when none remain, and otherwise passes the MCP handler a `ctx.auth` whose `scope` holds only the kept scopes. `resource_name` is `SERVER_NAME[kind]` (`workspace-bridge`, `workspace-bridge-readonly`, `workspace-bridge-admin`; plan s.4.1), not the excerpt's `workspace-bridge ${k}`. `resourceUrl(kind, issuer)` takes the issuer as an argument so `endpoints.ts` stays pure data. The factory (s.1.3, M5) is bound to the same kind and throws unless `authInfo?.resource?.href === resourceUrl(kind, issuer)`. wb-proto:35-39 derives the kind from the audience instead; the production code asserts it.

AS metadata as 1.2.4 serves it with these options (pinned by `test/auth.test.ts`): `issuer`, `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, `revocation_endpoint` (the token endpoint), `scopes_supported`, `response_types_supported`, `response_modes_supported` `["query"]`, `grant_types_supported` `["authorization_code", "refresh_token"]`, `token_endpoint_auth_methods_supported` `["client_secret_basic", "client_secret_post", "none", "private_key_jwt"]`, `token_endpoint_auth_signing_alg_values_supported` `["RS256", "ES256"]`, `code_challenge_methods_supported` `["S256"]`, `authorization_response_iss_parameter_supported` and `client_id_metadata_document_supported` (both `true`), and `protected_resources` (the three resource URLs). A code exchange without `code_verifier` gets 400 `invalid_request`; a wrong verifier gets 400 `invalid_grant`.

### 1.2 Top-level router: exact paths first

`/mcp/ro` and `/mcp/admin` are descendants of `/mcp`, so prefix routing would let the `/mcp` RS serve them with a `/mcp` token. The router matches exact paths and hands each to its own RS, whose exact audience check then refuses a token minted for another endpoint with 401.

```ts
// Verified (wb-proto:106-116)
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
  "/oauth/register",
]);
export default {
  fetch(req, env, ctx) {
    const { pathname } = new URL(req.url);
    const kind = RS_ROUTES.get(pathname);
    if (kind) return getBuilt(env).rs[kind].fetch(req, env, ctx);
    if (AS_PATHS.has(pathname)) return getBuilt(env).as.fetch(req, env, ctx);
    return app.fetch(req, env, ctx);
  },
} satisfies ExportedHandler<Env>;
```

- Protected Resource Metadata lives at `/.well-known/oauth-protected-resource/mcp` and the same suffix per resource (OPD/mcp-discovery.md:36-62).
- Negative probe N4 (TS2739): Hono's `c.executionCtx` is not assignable to the `ExecutionContext` that `OAuthResourceServer.fetch` (OP:607-611) and `OAuthAuthorizationServer.fetch` (OP:1927) take; it lacks `mapVirtualHost`, `tracing` and `abort`. So OAuth and MCP routes stay out of Hono, which serves pages only. The Hono example in OPD/resource-servers.md does not type-check with these versions.
- Production (`src/index.ts`, M4a) adds two exact paths before the page app, `/authorize` and `/oauth/google/callback`, each wrapped with the page security headers (bodies from M4b, s.1.5), and runs the `DCR_LIMIT` check before `/oauth/register` reaches the AS (s.3.3).

### 1.3 MCP handler: a new server per HTTP request

```ts
// Verified (wb-proto:66-67)
const mcp: StatelessMcpHandler = createMcpHandler((c) => buildServer(issuer, c), {
  route: PATH[k],
  allowedHostnames: [new URL(issuer).hostname],
});
```

- Import from `agents/mcp/server`, which re-exports `createStatelessMcpHandler` as `createMcpHandler` plus `getMcpAuthContext` (`agents/dist/mcp/server/index.d.ts:1-17`). The root `agents/mcp` entry imports SDK v1 types and keeps a deprecated v1 overload (AGM:50-69, 271-282). Probe N3 compiles only because of `skipLibCheck`, so this rule rests on the citation.
- Options: `route` is an exact pathname, default `/mcp`; also `allowedHostnames`, `allowedOriginHostnames`, `corsOptions`, `authContext` (AG:16-40). The handler is callable as `(req, env, ctx)` (AG:41-48), so it drops into the RS handler.
- The factory receives `McpRequestContext { era, authInfo?, requestInfo? }` and runs once per HTTP request (SDK:3876-3894, 3903).
- `authInfo` is built from `ctx.auth` as `{ token, clientId, scopes, expiresAt, resource: new URL(audience), extra: { props } }`, and is `undefined` when `clientId` is missing or empty or `props` is not a plain object (AGJ:29-52). The factory fails closed on a missing `authInfo`.
- Inside a tool, `getMcpAuthContext()` returns the same props (AG:10-13), and `env` from `cloudflare:workers` is reachable at module scope (both used at wb-proto:3, 48). M5 uses neither: the factory reads owner, client, grant id and endpoint scopes from `authInfo` into a `RequestScope`, and gets the Worker's `env` and execution context from a module-scope `WeakMap` keyed on the Request, which it receives back as `requestInfo`.
- M5's factory throws (HTTP 500, JSON-RPC `-32603`) when `authInfo` is missing or `authInfo.resource` is not this endpoint's resource URL, so no server is built for a token meant elsewhere. The server declares `tools: { listChanged: false }`.

### 1.4 Tools: precomputed schemas, scope challenges, filtered tools/list

```ts
// Verified (wb-proto:22-27): zod validates; the JSON Schema is computed once per isolate and handed over as-is
function precomputed<S extends z.ZodType>(
  schema: S,
  json: Record<string, unknown>,
): StandardSchemaWithJSON<z.input<S>, z.output<S>> {
  return {
    "~standard": {
      version: 1,
      vendor: "workspace-bridge",
      validate: (v) => schema["~standard"].validate(v),
      jsonSchema: { input: () => json, output: () => json },
    },
  };
}
const json = z.toJSONSchema(input, { target: "draft-2020-12", io: "input" }) as Record<
  string,
  unknown
>;
```

```ts
// Verified (wb-proto:30-34, 45-46, 51)
const challenge =
  (required: readonly string[]): ScopeChallengeHandler =>
  ({ authInfo }) => {
    const granted = authInfo?.scopes ?? [];
    if (!authInfo || required.every((s) => granted.includes(s))) return undefined;
    return {
      scopes: [...new Set([...granted, ...required])] as [string, ...string[]],
      errorDescription: "step-up needed",
    };
  };
mcp.registerTool(
  name,
  { description, inputSchema, annotations, scopeChallenge: challenge(scopes) },
  handler,
);
mcp.server.setRequestHandler("tools/list", () => ({ tools: listed })); // only after the first registerTool
```

- `inputSchema` must be a `StandardSchemaWithJSON`; zod v4 schemas implement it (SDK:1376-1383). Negative probe N1 (TS2769): a raw JSON Schema object is rejected. `fromJsonSchema()` exists, but zod stays the single source.
- `registerTool` takes `scopeChallenge` (SDK:3372-3382, 2803-2819). When it returns a challenge, the call becomes HTTP 403 with `WWW-Authenticate: Bearer error="insufficient_scope", scope="..."` (SDKJ:765-795), for registered, enabled tools only (SDKJ:1722-1729).
- The first `registerTool` installs the SDK's tool handlers (SDKJ:2147, 1756-1790); after that `setRequestHandler` overwrites with no check (SDKS:6845-6868). Overriding before any `registerTool` makes the later install throw in `assertCanSetRequestHandler` (SDKS:6901-6903). Order: register everything, then override `tools/list`.
- An unregistered name gets JSON-RPC `InvalidParams` "Tool X not found" (SDKJ:1777). A thrown handler error becomes `createToolError(message)`, an `isError` result carrying the raw message (SDKJ:1785); our wrapper catches first (s.3.3).
- The SDK converts schemas lazily (SDKJ:1679-1690); with `precomputed()` that is a lookup. `preloadSchemas()` is meant to be called at module scope on isolate runtimes (SDK:2786-2799).

### 1.5 OAuth helpers for the sign-in and consent pages

`as.getOAuthApi(env)` (OP:1929) returns the helpers (OP:1201-1346). We use `parseAuthRequest` (1209), `lookupClient` (1216), `beginConsent` (1245), `approveConsent` (1253), `denyConsent`, `completeAuthorization` (1224) and, in tests, `createClient` (1286). `completeAuthorization`'s `userId` must not contain `:`, and `revokeExistingGrants` defaults to `true` (OP:1513-1544); keep the default. Access tokens have the form `{userId}:{grantId}:{secret}` (OP:1686). The consent GET/POST pair and `completeAuthorization` with a clamped scope are verified at wb-proto:79-105. The library's cookies are named `__Host-oauth-consent-*`, `__Host-oauth-upstream-*` and `__Host-oauth-approvals` (OPD/consent-page.md:131), so ours use other names.

Design choice: `beginUpstream` and `finishUpstream` (OP:1271, 1280) type-check (wb-proto:90, 96) but are not used. `beginUpstream` must run after consent (OP:1271), while plan s.4.2 signs the owner in before consent, and the link flow (plan s.4.3) and `/accounts` need the same Google callback plus an owner session that the library's upstream transaction does not provide. We run one Google flow of our own and one callback, `/oauth/google/callback`, that dispatches on the flow's kind (`signin` or `link`). It keeps the properties listed in OPD/upstream-sign-in.md:61-66: `__Host-` cookie binding, single use, 10-minute expiry.

**Deviation from plan (link `state`).** Plan s.4.3 has a random `state` HMAC-bound to the session cookie. Here `state` is random, its SHA-256 keys a single-use D1 `flow_states` row (s.4), the row is bound to a `__Host-` flow cookie, and a link row also stores the owner id that the callback compares with the session. A D1 row gives true single use, which a stateless HMAC cannot.

**Sign-in and consent as built (M4b).**

- Sign-in is configured only with `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and a `COOKIE_SECRET` of at least 32 characters. Otherwise `/authorize` and the callback answer a 503 "Sign-in not configured" page before touching D1 or KV; the rest of the Worker is unaffected.
- `GET /authorize` refuses a request without PKCE S256 from every client, confidential ones too (the library requires PKCE only for public clients), with an `invalid_request` redirect. Without a session it starts the `signin` flow; the callback returns the browser to the original `/authorize` URL (a same-origin path only).
- `resolveOwner(env, email, sub)` (`owners.ts`): exact lowercase match on `OWNER_EMAILS` (empty means nobody). While `SETUP_MODE=true` an unpinned address is pinned to its `sub` and the single owner row is created on the first allowed sign-in; a pinned address is never re-pinned. Afterwards an unpinned address and a different `sub` are refused, and so is a `sub` already pinned to another address. Every address maps to the one owner.
- A refused sign-in sets no cookie and writes no grant. It logs one JSON line, `signin_refused`, with the reason, the country and `email_hash`, an HMAC of the address keyed with `COOKIE_SECRET` (16 hex characters); the address itself is never logged. The `audit_log` row (s.4) is added with `core/audit.ts`.
- The owner session is re-checked against `OWNER_EMAILS` on every request, so removing an address ends its session. Page forms carry a CSRF token derived from the session id.
- The consent page shows the client name (escaped; "not verified" unless the client has a domain), the redirect host and URI, a loopback warning, the endpoint and the signed-in address, and one checkbox per scope of that endpoint, all checked. POST clamps the posted scopes with `endpointScopes` before `completeAuthorization`, so `/mcp/ro` never holds `mail.send` and `admin` exists only on `/mcp/admin`; nothing left gives an `invalid_scope` redirect and no grant. Deny, and a cancel on Google's page, give `access_denied` at the client.

**Link leg as built (M7a).**

- `/accounts` needs the owner session; without one it starts the `signin` flow and the callback returns to `/accounts` (503 "Sign-in not configured" when sign-in is not configured). Every POST (`/accounts/link`, `/accounts/unlink`) needs the session's CSRF token; pages are `no-store` and never show a token.
- `POST /accounts/link` takes a label (free-form text: trimmed, control characters removed, 1 to 64 characters, not `all` in any case; unique per owner ignoring case via migration `0003_label_nocase.sql`), at least one account component (s.3.6) and an optional address for `login_hint`. It checks the sealing key first (503, nothing started), then stores a `link` flow row (owner id, label, components, PKCE verifier, nonce) and redirects to Google with `access_type=offline`, `prompt=consent`, `include_granted_scopes=true`, scope `openid email` plus `scopesFor(components)`, PKCE S256 and a nonce.
- The callback's `link` branch (`finishLink`), in order: the flow cookie (by `consumeFlow`); a session of the owner in the row, checked before the code is exchanged; the code exchange; the ID token (as sign-in); the address on `LINKABLE_EMAILS`; a refresh token present; the label not on another of the owner's mailboxes (409). A refusal answers with a page, sets no cookie, writes no row and logs `link_refused` or `link_failed` (with `email_hash` once the address is known), never the address or a token.
- On success one D1 batch writes the account (a new one takes the owner's next `short_id` with `insertAccount`'s statement; the same address updates the existing row in place and keeps its label; `POST /accounts/rename` changes a label with the same rules, touching no id, token or default), both sealed tokens (`upsertToken`'s statement; the access token with its expiry) and, when `mail` is on and `gmail.settings.basic` was granted, the sendAs list fetched with the new access token. A sendAs failure does not stop the link; a relink without `mail` clears the cache. `granted_scopes` is what Google returned; `components` keeps only the chosen components whose scopes were all granted. A relink never revokes: Google's revoke drops the whole grant, which the new tokens belong to. Only "re-link minimal" and unlink revoke (below).

**Accounts controls as built (M7b).** All on `/accounts`, each POST behind the owner session and CSRF token; the ones that only change D1 answer 303 back to the page.

- **Component toggles** (`POST /accounts/component`, fields `account`, `component`, `on`). Off updates `accounts.components` in D1 at once, as a compare-and-set on the old value (409 if it changed meanwhile), and does not call Google; the tool layer reads that column and refuses with `component_disabled` (s.3.6). On is the same update when `granted_scopes` already cover the component; otherwise it is incremental consent: the link leg again with `include_granted_scopes=true`, `login_hint` set to the account's address, and only the missing scopes asked for. The flow row carries the account id, the component set at click time and the component being added; the callback keeps only the account's components that are still on plus the added one, so a component switched off while the owner is at Google stays off. For a `needs_relink` account (no live grant to add to) the request asks for the scopes of every component that is on. The callback requires Google to return that account's address (else 409 "Wrong Google account", nothing stored), and then stores what Google returned, as for any relink: `granted_scopes`, the components whose scopes were all granted, fresh sealed tokens. A component Google left out is listed on the redirect (`/accounts?partial=...`) and stays off.
- **Relink** (`POST /accounts/relink`) is the link leg for the account's address and current components, pinned to the account, for `needs_relink` (the broker refuses such an account until a refresh token is stored; the callback sets `status` back to `ok`). **Re-link minimal** (`POST /accounts/relink-minimal`, offered when `granted_scopes` hold API scopes the components no longer need) first checks the sealing key, then revokes the stored grant at Google (nothing changes if Google does not confirm), then sets `needs_relink` and deletes the account's token rows in one batch and starts the link leg for only the components that are on. Abandoning it at Google leaves a relink button; a retry skips the revoke when no token is left.
- **Default account** (`POST /accounts/default`). One statement sets `owners.default_account_id` only to an account of that owner (404 otherwise); an empty `account` clears it. Unlink of the default clears it (s.3.4).
- **Re-encrypt all** (`POST /accounts/reencrypt`). Opens each of the owner's token rows under another key version than `CURRENT_KEY_VERSION` and seals it again under the current one, in batches of 50. Each update applies only while the row still has the IV that was opened, so a broker refresh that lands meanwhile is not overwritten; such a row is counted as skipped, a row that cannot be opened as failed, and both are left as they are. The result page shows counts only; the log line `tokens_reencrypted` carries counts and no token material. A broker refresh in flight when the IV changes may drop its own write; the next call refreshes again.
- **Refused links drop the grant.** When the callback refuses a completed Google consent (address not linkable, address mismatch, label in use, nothing granted, account gone) it revokes the new grant at Google, best effort and logged as `link_grant_discarded`, unless an account already holds that address (any owner): a revoke ends the whole grant, which that account may be using. A grant that holds no component scope (identity only) is refused with 400. A changed Google user id for a known address is logged as `sub_changed` and proceeds. The flow-failure page says "sign-in or link request" for both flows.
- `POST /accounts/unlink` revokes the stored refresh token (else the access token) at `https://oauth2.googleapis.com/revoke`, then in one batch clears `owners.default_account_id` if it named the account and deletes its tokens, sendAs rows and the account (pending actions cascade). The rows go even when Google does not confirm, and the page then tells the owner to remove the app in the Google account. The audit row is M14's (a comment marks the call site).

### 1.6 Test harness

Tests run on `@cloudflare/vitest-plugin` 1.4.9 with `vitest` 5.0.5; the old `@cloudflare/vitest-pool-workers` is deprecated and not used. The facts below were also run in a throwaway test project against the committed `wrangler.example.jsonc`.

- **`env` and calling the Worker.** `cloudflare:test` still exports `env` and `SELF`, both marked deprecated (VT:3-13). Use `import { env, exports } from "cloudflare:workers"` and `await exports.default.fetch(url)` (VT:11; `env` and `exports` typed at WT:16680-16681). The main Worker runs in the same isolate as the tests, so global mocks apply to it (VT:7-10). `exports.default` is typed only after a project declaration `declare namespace Cloudflare { interface GlobalProps { mainModule: typeof import("../src/index") } interface Env { DB: D1Database; ... } }` (WT:16380-16406, 16411-16427); `wrangler types` can generate it. `Cloudflare.Env` is an empty interface until then (WT:16387), so add test-only binding names to it by hand.
- **`createExecutionContext`.** `createExecutionContext()` and `waitOnExecutionContext(ctx)` (VT:136-148) drive a handler directly: `worker.fetch(request, env, ctx)`, then `await waitOnExecutionContext(ctx)` to settle `waitUntil` work. `createScheduledController` is at VT:149-159.
- **D1 migrations exist.** `readD1Migrations(pathOrOptions)` runs in Node (the config file) and is exported from the package root (VP:113; options `migrationsDir`, `migrationsPattern` at VP:99-103). `applyD1Migrations(db, migrations, tableName?)` is exported by `cloudflare:test` (VT:200-215), records progress in `d1_migrations` and can be re-run. Wiring: `vitest.config.ts` passes the result in as a binding; a `setupFiles` entry (which runs per test file) calls `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)`. Verified: a migration with a seed row is visible to the test through `env.DB`.
- **Storage is not rolled back between tests.** A row inserted in one test was still there in a later test of the same file, so tests must create their own owner and account ids. `reset()` (VT:80-94) deletes all binding data including the applied tables and `d1_migrations`: after `reset()` a `sqlite_master` query returned no tables. A test that calls `reset()` must re-run `applyD1Migrations` afterwards (do it in `beforeEach` if `afterEach` calls `reset()`). A later test file still got the migrated database with only the seed row.
- **Test-only bindings and vars.** `cloudflareTest()` takes options or a function (sync or async) returning them (VP:87), and `wrangler` (`configPath`, `environment`; VP:16-19) plus a `miniflare` block (VP:33-37) in which `bindings: { NAME: value }` adds JSON-serializable bindings, such as the migrations array. Verified: a `miniflare.bindings` entry overrides a same-named `vars` entry from the wrangler config. Secrets are never in the example config, so they are also added this way. `env.NAME` sees them with no further wiring.
- **Deviation from plan (s.12, `fetchMock`).** `cloudflare:test` 1.4.9 has no `fetchMock` export (VT; the package README and `dist/` have no `fetchMock` either). Google is faked by `vi.spyOn(globalThis, "fetch")` (s.6). Verified: a module imported from `src/` that calls the global `fetch` gets the stub installed by the test.
- **Compatibility date.** The plugin's workerd (miniflare 5.20261023.1-beta) accepts `compatibility_date` 2026-10-28; `wrangler.example.jsonc` uses it.
- **Rate limit binding.** Miniflare emulates the `ratelimits` binding declared in `wrangler.example.jsonc` (`DCR_LIMIT`, 10 per 60 s): ten `limit()` calls with one key return `success: true` and the eleventh `false`, so the HTTP 429 test uses the real binding. Tests use distinct `CF-Connecting-IP` values so their counts do not mix.

## 2. Module layout

Paths are under `plugins/workspace-bridge/server/`. M is the milestone that creates the file; later milestones edit a file only where s.7 says so.

| Path                            | M       | Responsibility                                                                                                                                                                                                                          |
| ------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                  | M4a     | Top-level fetch: exact RS paths, AS paths (DCR rate limit, HTTP 429), `/authorize` and `/oauth/google/callback` with security headers, else the page app. `scheduled` added in M14.                                                     |
| `src/version.ts`                | M0      | `VERSION`, also `serverInfo.version`.                                                                                                                                                                                                   |
| `src/env.ts`                    | M4a     | `Env` bindings, vars, secrets and the `Cloudflare.Env` declaration; `config(env)` validates the issuer and parses numbers, flags and email lists once per `env` object.                                                                 |
| `src/auth/endpoints.ts`         | M4a     | `KINDS`, `PATH`, `Kind`, `Scope`, `SCOPES` per kind, `ALL_SCOPES`, `SERVER_NAME`, `resourceUrl(kind, issuer)`, `endpointScopes(kind, granted)`. Pure data.                                                                              |
| `src/auth/server.ts`            | M4a     | `getAuth(env)`: module-scope memo of the AS and three RS, each with its MCP handler; RS handlers enforce scope (s.1.1). Access tokens 4 h, refresh tokens 30 d.                                                                         |
| `src/auth/mcp-factory.ts`       | M4a, M5 | M4a: placeholder `mcpHandler(kind, issuer)` answering `{ kind, ownerId, scope }`. M5: `mcpHandler(kind, issuer, registry = REGISTRY)`, the third parameter for tests: fail-closed audience check, `registerAll`, `tools/list` override. |
| `src/auth/google-oidc.ts`       | M4b     | Google authorize URL (`openid email`, PKCE S256, nonce, `prompt=select_account`), code exchange, ID token claim checks.                                                                                                                 |
| `src/auth/owners.ts`            | M4b     | Owner identities: `OWNER_EMAILS` allowlist, `sub` pinning only in `SETUP_MODE`, `resolveOwner(env, email, sub)`, `emailHash`.                                                                                                           |
| `src/auth/session.ts`           | M4b     | Owner session cookie `__Host-wb-session` (HMAC with `COOKIE_SECRET`, 30 min) and CSRF tokens for page forms.                                                                                                                            |
| `src/auth/flow-state.ts`        | M4b     | `flow_states` rows: create, consume once, `__Host-wb-flow` cookie binding.                                                                                                                                                              |
| `src/auth/consent.ts`           | M4b     | `GET/POST /authorize`: 503 when sign-in is not configured, parse, PKCE S256 gate, session gate, consent page, approve or deny, clamp scope, `completeAuthorization`.                                                                    |
| `src/auth/callback.ts`          | M4b, M7 | `GET /oauth/google/callback`: consume state, dispatch to sign-in (M4b) or to `finishLink` in `link.ts` (M7).                                                                                                                            |
| `src/auth/link.ts`              | M7      | Link leg: Google URL for chosen components, owner and `LINKABLE_EMAILS` checks, sealed tokens in one batch, first sendAs fetch; M7b: account-pinned flows (toggle, relink), grant discard on refusal.                                   |
| `src/web/app.ts`                | M4a     | Hono app for pages; one `app.route()` line per page module; security headers.                                                                                                                                                           |
| `src/web/html.ts`               | M4a     | Escaping `html` tagged template and page shell.                                                                                                                                                                                         |
| `src/web/public.ts`             | M4a     | `/` and `/privacy` with the contact from var `OWNER_CONTACT`; `/health`.                                                                                                                                                                |
| `src/web/accounts.ts`           | M7      | `/accounts`: list, link, unlink and revoke (M7a); component toggles, default account, relink, re-link minimal, re-encrypt (M7b).                                                                                                        |
| `src/web/guardrails.ts`         | M14     | `/approvals/:id`: approve once, approve and allow addresses or an exact non-freemail domain (written to the held send's account before the approved run), reject; kill switch; audit view. Every POST needs the owner session and CSRF. |
| `src/core/crypto.ts`            | M4a, M6 | M4a: random ids, SHA-256, HMAC, constant-time compare. M6: AES-256-GCM `seal`/`open` (AAD, per-row key version), `currentKeyVersion`.                                                                                                   |
| `src/core/db.ts`                | M4a, M6 | Typed D1 helpers and row types. M6: core rows, `insertAccount`, `getAccount`, `listAccounts`, `upsertToken`, `getToken`, `incrementCounter`; M7b: `listOwnerTokens`.                                                                    |
| `src/core/errors.ts`            | M5      | `ToolError`, codes, `toToolResult`, `okResult` (s.3.3). Google error mapping lives in `providers/google/http.ts` (M9).                                                                                                                  |
| `src/core/accounts.ts`          | M9      | Account repository and resolution: label, address, short id, `all`, default.                                                                                                                                                            |
| `src/core/ids.ts`               | M9      | `a<shortId>:<id>` prefixing (s.3.4).                                                                                                                                                                                                    |
| `src/core/cursor.ts`            | M9      | Multi-account cursor codec (s.3.5).                                                                                                                                                                                                     |
| `src/core/untrusted.ts`         | M9      | Per-response nonce wrapper, escaping, control-character stripping (s.3.7).                                                                                                                                                              |
| `src/core/token-broker.ts`      | M8      | `createTokenBroker(env)`: memory, then D1, then one shared refresh per account; `invalid_grant` sets `needs_relink` (s.3.6).                                                                                                            |
| `src/core/send-as.ts`           | M9, M14 | sendAs cache (24 h) and `assertFrom()`. M9 stub allows the primary address only.                                                                                                                                                        |
| `src/core/audit.ts`             | M9, M14 | Audit writes and reads. M9 stub is a no-op.                                                                                                                                                                                             |
| `src/core/ratelimit.ts`         | M9, M14 | Fixed-window counters and the per-grant call limit. M9 stub never trips.                                                                                                                                                                |
| `src/core/pending.ts`           | M9, M14 | Pending actions: create, get, decide, expire, execute.                                                                                                                                                                                  |
| `src/core/recipients.ts`        | 0004    | Which recipients of a send are new to the account (own addresses, allow list, known-recipients cache, contacts, Gmail Sent); the strict address pattern.                                                                                |
| `src/core/send-allow.ts`        | 0004    | The allow list: list, add (freemail domains refused), remove.                                                                                                                                                                           |
| `src/core/held-notice.ts`       | 0004    | The fast notice email of a held action (`sendHeldNotice`, `noticeText`): system send from the holding mailbox to `NOTIFY_EMAIL` (else `OWNER_CONTACT` if an address).                                                                   |
| `src/core/html-text.ts`         | M10     | Linear HTML-to-text and body truncation.                                                                                                                                                                                                |
| `src/core/mime.ts`              | M13     | Vendored MIME builder (notice in THIRD-PARTY.md); M16 adds attachments.                                                                                                                                                                 |
| `src/services/capability.ts`    | M9      | `capability<T>()`, `provide()`, `Binding` (s.3.6).                                                                                                                                                                                      |
| `src/services/types.ts`         | M9      | `AccountRef`, `Page<T>`, `ProviderId`, shared value types.                                                                                                                                                                              |
| `src/services/<cap>.ts`         | family  | One capability interface and its key per file.                                                                                                                                                                                          |
| `src/providers/registry.ts`     | M9      | Builds providers from the families' bindings; backs `ctx.use()`.                                                                                                                                                                        |
| `src/providers/google/base.ts`  | M7      | `ACCOUNT_COMPONENTS`, Google scopes, `scopesFor(components)`, `grantedComponents`, revoke. Authorize and token URLs are in `auth/google-oidc.ts`.                                                                                       |
| `src/providers/google/http.ts`  | M9      | `gfetch`, `gjson`: component check, bearer, `fields=`, 401 retry, error mapping (s.3.3).                                                                                                                                                |
| `src/providers/google/batch.ts` | M10     | Gmail batch requests (`multipart/mixed`) for metadata.                                                                                                                                                                                  |
| `src/providers/google/<cap>.ts` | family  | One file per capability (`gmail-*`, `calendar`, `drive-*`, `people`).                                                                                                                                                                   |
| `src/registry/types.ts`         | M5      | `ToolDef`, `ToolContext`, `Family`, `Component`; re-exports `Kind` and `Scope` from `auth/endpoints.ts`.                                                                                                                                |
| `src/registry/compile.ts`       | M5      | Module-scope precompute: `precomputed()`, `UNTRUSTED_NOTE`, `compileRegistry()` with load-time checks, frozen `Tool[]` per kind, `listFor` memo, `REGISTRY`.                                                                            |
| `src/registry/register.ts`      | M5      | `registerAll(server, registry, scope)`: `scopeChallenge`, per-grant limit, approval gate, error wrapper, `tools/list` override.                                                                                                         |
| `src/registry/context.ts`       | M5, M9  | `requestScope`, `toolContext` per call, `grantIdOf`, the `checkRate` and `gateApproval` hooks; M9 adds accounts, providers and guardrails.                                                                                              |
| `src/tools/index.ts`            | M5      | `FAMILIES`: one import line per family, all present from M5.                                                                                                                                                                            |
| `src/tools/<family>.ts`         | family  | Exports one `Family`: tools, bindings, parity pending list.                                                                                                                                                                             |
| `migrations/0001_auth.sql`      | M4a     | `owners`, `owner_identities`, `flow_states`.                                                                                                                                                                                            |
| `migrations/0002_core.sql`      | M6      | All other tables in s.4.                                                                                                                                                                                                                |
| `test/helpers/*.ts`             | M4, M5  | `tokens.ts` (M4a: `mintToken`, `authorizeCode`, `exchangeCode`); `google.ts` (fake Google) and `session.ts` (M4b); `mcp.ts` (M5).                                                                                                       |

Families (`src/tools/<family>.ts` plus their `services/` and `providers/google/` files): `meta` (M5: `whoami`), `account` (M9: `list_accounts`, `link_account_url`), `guardrails` (M14: `list_send_as`, `get_pending_action`), `mail-read` (M10), `mail-labels` (M11), `mail-state` (M12), `mail-drafts` (M13), `mail-send` (M15), `mail-attachments` (M16), `mail-filters` (M17), `calendar` (M18), `drive-read` (M19), `drive-write` (M20), `contacts` (M21); `admin-*` later (A1-A3).

Sending is off until `SEND_ENABLED` is `"true"` (default `"false"`); `checkSend` in `core/ratelimit.ts` then also needs the owner's `send_kill_switch` at 0 (a per-owner switch on `/accounts/audit`, not per account) before the recipient cap and the hourly and daily counters apply.

New in `wrangler.example.jsonc` (M4a): vars `PUBLIC_URL` (the issuer, `https://mcp.example.com`, an origin with no trailing slash) and `OWNER_CONTACT` (shown on `/` and `/privacy`; empty hides the line), and the `DCR_LIMIT` `ratelimits` binding (10 per 60 s).

## 3. Contracts

### 3.1 Tool definition and family

```ts
// src/registry/types.ts (Design)
export type Kind = 'full' | 'ro' | 'admin';
export type Scope = 'mail.read' | 'mail.write' | 'mail.send' | 'calendar' | 'files' | 'contacts' | 'admin';
export type Component = 'mail' | 'calendar' | 'files' | 'contacts' | 'admin';

export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string;                      // snake_case; the official name where one exists
  title?: string;
  description: string;               // UNTRUSTED_NOTE is appended when untrusted is true
  component: Component | null;       // null: account and meta tools, no component check
  scopes: readonly Scope[];          // all required; [] = any valid grant
  endpoints: readonly Kind[];        // registered only on these
  annotations: ToolAnnotations;      // readOnlyHint, destructiveHint, idempotentHint, openWorldHint
  input: S;                          // zod v4 object, camelCase keys
  untrusted?: boolean;               // output carries third-party text
  approval?: { when(args: z.output<S>, ctx: ToolContext): boolean | Promise<boolean>;   // also the cheap, Google-free checks: a throw refuses before anything is queued
               preview(args: z.output<S>, ctx: ToolContext): unknown;
               onHeld?(args: z.output<S>, ctx: ToolContext, held: HeldAction): void | Promise<void> };   // after the pending action exists (held audit row)
  handler(args: z.output<S>, ctx: ToolContext): Promise<unknown>;   // JSON-serialisable
}

export interface Family {
  id: string;                                                   // 'mail.labels'
  tools: readonly ToolDef[];
  bindings: Partial<Record<ProviderId, readonly Binding[]>>;    // capability implementations (s.3.6)
  parityPending: readonly string[];                             // official names not built yet (s.5)
}

// src/registry/compile.ts, module scope, once per isolate
export interface CompiledTool { def: ToolDef; schema: StandardSchemaWithJSON; listed: Tool; challenge: ScopeChallengeHandler }
export interface Registry {
  byKind: Readonly<Record<Kind, readonly CompiledTool[]>>;
  providers: ProviderRegistry;                                        // the families' bindings (s.3.6)
  listFor(kind: Kind, granted: readonly string[]): readonly Tool[];  // memo: kind + sorted scopes
}
export function compileRegistry(families: readonly Family[]): Registry;  // tests compile extra families
export const REGISTRY: Registry;                                        // compileRegistry(FAMILIES)
```

`Kind` and `Scope` are defined in `src/auth/endpoints.ts` (M4a), which the auth layer needs before M5; `registry/types.ts` re-exports them. `Family.bindings` is `Partial<Record<ProviderId, readonly Binding[]>>` (s.3.6); the providers are built inside `compileRegistry`, so a test registry carries its test bindings. `defineTool(def)` is an identity helper that types the handler's arguments from `input`.

`compile.ts` runs `z.toJSONSchema(def.input, { target: 'draft-2020-12', io: 'input' })` once per tool, wraps the result with `precomputed()` (s.1.4) and freezes it. At load it also checks that family ids and tool names are unique, names are snake_case, every tool has an endpoint, and `scopes` is a subset of `SCOPES[k]` for every `k` in `endpoints` (which keeps `mail.send` off `ro`). A test imports the module, so a bad definition fails CI rather than production.

Endpoint rule (plan s.10.6): `ro` gets read tools plus `create_draft` and `update_draft`, and no send, reply, forward, share, filter, trash or label-write tool. `admin` gets admin tools. Account and meta tools are on all three. Server names per endpoint: `workspace-bridge`, `workspace-bridge-readonly`, `workspace-bridge-admin` (plan s.4.1).

`register.ts` wraps every handler in this order: per-grant rate check, `approval.when` (if true, store a pending action and return its preview), handler, error mapping. An approved pending action later runs the same handler from `/approvals/:id` with a context built from the stored grant. `checkRate` calls `ctx.limits.call(tool)`; `gateApproval` builds `approval.preview`, calls `ctx.pending.create(...)` and then `approval.onHeld` with the new `pendingActionId` (the place for a held audit row: a failed create leaves none; a failing hook is logged and the hold stands), and returns the pending answer. Until M14 fills the stubs, the limit never trips and `create` throws `internal`, so a call that needs approval fails closed. An exception that is not a `ToolError` is logged as one redacted line before it becomes `internal` (s.3.3).

**New-recipient hold: what it binds and what it leaves.** A held `draftId` send stores the draft's normalized recipients with the call (`checkedRecipients`, set by `approval.when`, never by the caller), and the send, now or once approved, refuses a draft that gained a recipient since. The send itself is bound to what was checked: `readDraft` fetches the draft as `format=raw`, the recipients are read from those bytes (every To, Cc and Bcc line), and `sendDraft` sends exactly those bytes through `messages.send` (keeping the draft's `threadId`) and then deletes the draft, so an `update_draft` landing after the read changes the draft, not the mail (the delete is best effort; an edited draft is deleted unsent; unlike `drafts.send`, which consumed the draft atomically, two parallel sends of one draft can both succeed, so the checked recipients may get two copies, never a new recipient). The read pulls every byte of the message, so a draft larger than `MAX_SEND_ATTACHMENT_BYTES` (as base64) plus 256 KB for its text is refused as `too_large` before it is decoded (the audit count and size of its files come from one linear scan). A draft send costs one subrequest more than `drafts.send` did (read, read, send, delete). For `update_event`, `delete_event` and `respond_to_event`, `approval.when` stores the notified recipients it checked as `checkedRecipients` (a hidden input field, cleared and set by the server), and the handler refuses (the held action then fails; the agent asks for the change again), before any Google write, when its fresh plan would email someone outside that set. `update_event` and `delete_event` also send `If-Match` with the etag the plan was read at whenever notifications are on (an event with guests to email and no etag is refused rather than written unprotected), so Google answers 412 (reported as "the event changed, retry") if the event changed between the plan and the write; that leaves no window beyond Google's own atomic check. Residual risk, accepted: `respond_to_event` has no `If-Match` (the etag moves whenever any guest answers, which would fail most responses to a large event); it mails only the organizer, read in the handler's plan, and only moving the event to another calendar changes that between the plan and the patch. Other limits: contacts are looked up for at most 6 addresses per send (the rest count as new, which over-holds), Gmail Sent is checked before contacts, allow-list domains match exactly (a parent domain does not cover subdomains), and `known_recipients` is never pruned.

**Approval buttons, allow list and notice (part 2).** `/approvals/:id` for a send with `newRecipients` shows the list and four decisions in one form: `approve` (once), `approve_allow` (the posted `allow` addresses, each of which must be one of the held send's own new recipients), `approve_domain:<d>` (`<d>` must be the domain of a new recipient; a public mail provider is refused by `normalizeAllow` as well as not offered) and `reject`. An allow request is validated in full before `decidePending`, so a refusal leaves the action pending; the entries are written (and audited as `send_allow`) after the decision and before `runApproved`, to `row.account_id`, the held send's account, and the approved run repeats every check. An allow entry therefore stays even if the approved run then fails. `/accounts` lists each mailbox's `send_allow` rows and posts `/accounts/allow` and `/accounts/allow/remove` through `authorizeAccountPost` (session, CSRF, the owner's own account). `gateApproval` calls `sendHeldNotice` after `pending.create` and `onHeld`, inside a try/catch that logs and never fails the hold. The notice resolves the account from `ctx.accounts` (so `ctx.use(SEND, account)` is valid), checks `ctx.limits.assertSendEnabled` (no counter), counts `notice:d:<accountId>` per day (cap `NOTICES_PER_DAY` = 20, counted before the send so a failing Gmail cannot be hammered), sends via `SEND.prepare` and `deliver` from the account's primary address and writes an audit row with tool `system_notice`. It carries no body, attachment or token: the link only opens the page, which needs the owner's session. The notice goes out for every held action type (including `share_file` and `create_filter`). `NOTIFY_EMAIL` must be one plain address (the config throws otherwise); `OWNER_CONTACT` is used only when it is a plain address. Pending actions expire 7 days after creation (`decidePending` refuses an expired row, and the page shows its status as `expired`).

**Deviation from plan (parameter names).** Plan s.8 writes params in snake_case; the captured official tools (`test/fixtures/parity/*.json`) use camelCase (`messageId`, `labelIds`, `pageToken`, `startTime`, `fileId`). Plan s.8.7 says captured names win, so tools use the official names and additions follow the same style (`account`, `maxBodyChars`, `messageOffset`). Where the official required set differs from plan s.8, the official one wins: `create_label(displayName)`, `respond_to_event(eventId, responseStatus)`, `suggest_time(attendeeEmails, startTime, endTime)`, `create_file(title)`, `share_file(fileId, role)`, and `update_message_labels(messageId)` with one message, not a list.

**Deviation from plan (sensitive labels).** `apply_sensitive_message_label` and `apply_sensitive_thread_label` take `labelOption` with values `TRASH` or `SPAM` (`gmail.json`), so they belong to the state family (M12), not labels (M11).

**Deviation from plan (filters).** The official Gmail tools have no `create_filter`, so the filter tools (M17) are additions, not parity items.

### 3.2 Tool context

```ts
// Design
export interface ToolContext {
  readonly kind: Kind;
  readonly ownerId: string; // from token props, never from arguments
  readonly grant: { clientId: string; grantId: string; scopes: readonly Scope[] };
  readonly publicUrl: string; // for approvalUrl and link URLs
  readonly env: Env;
  readonly now: () => number; // ms; tests inject a clock
  readonly untrusted: Untrusted; // one nonce per tool call
  accounts: AccountResolver; // resolve(selector?, idPrefix?, { allowAll? }) -> AccountRef[]
  use<T>(cap: Capability<T>, account: AccountRef): T; // throws component_disabled or not_supported_by_provider
  ids: IdCodec;
  cursors: CursorCodec;
  sendAs: SendAsCache;
  audit: AuditLog;
  limits: RateLimiter;
  pending: PendingActions;
  waitUntil(p: Promise<unknown>): void;
}
```

All fields exist since M9 (`registry/types.ts`, `registry/context.ts`, `toolContext(scope, registry.providers)`). `sendAs`, `audit`, `limits` and `pending` are M9 stubs with final signatures (`core/{send-as,audit,ratelimit,pending}.ts`); M14 fills the bodies. `ctx.accounts` loads the owner's accounts with `loadAccountsWithState`, which records each frozen `AccountRef` with its row, components and env in a module `WeakMap` (`accountState`). `ctx.use` and `gfetch` look the account up by object identity, so an `AccountRef` must come from `ctx.accounts` in the same call; any other object (a copy, a hand-built ref) is a programming error and ends as `internal`.

`grantId` is the middle segment of the bearer token (OP:1686), read in one function (`grantIdOf`) with its own test. If the format changes, `unwrapToken()` (OP:1338) is the fallback at the cost of a KV read.

### 3.3 Errors

Handlers throw `ToolError(code, message, details?)`. The wrapper returns `{ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code, message, ...details } }) }] }`. Any other exception becomes `internal` with a generic message, so Google error bodies and stack traces never reach the client (the SDK would pass the raw message through, SDKJ:1785). Success is one text block of compact JSON; no `structuredContent` in v1, since there are no output schemas.

| Code                                                     | Raised by                                                                                 | Client sees                                                   | HTTP |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---- |
| (missing or bad token, wrong audience)                   | RS, before MCP                                                                            | `WWW-Authenticate: Bearer ... resource_metadata=`             | 401  |
| `insufficient_scope`                                     | RS (no scope for this endpoint); `scopeChallenge` (registered tool, scope missing)        | `WWW-Authenticate: Bearer error="insufficient_scope", scope=` | 403  |
| (tool not on this endpoint)                              | SDK                                                                                       | JSON-RPC error `InvalidParams`                                | 200  |
| `invalid_argument`                                       | our checks: cursor mismatch, id and account disagree, bad combination                     | tool error                                                    | 200  |
| `account_not_found`, `ambiguous_account`                 | `AccountResolver`; broker (account unlinked meanwhile)                                    | tool error, `{ accountsUrl }`                                 | 200  |
| `component_disabled`                                     | `ctx.use`: component off for the account                                                  | tool error, `{ component, accountsUrl }`                      | 200  |
| `not_supported_by_provider`                              | `ctx.use`: no binding                                                                     | tool error, `{ capability, provider }`                        | 200  |
| `needs_relink`                                           | broker `invalid_grant`; Google 401 after one refresh; Google 403 insufficient permissions | tool error, `{ linkUrl }`                                     | 200  |
| `rate_limited`                                           | `ctx.limits`; Google 429 or rate-limit 403                                                | tool error, `{ retryAfterSeconds }`                           | 200  |
| `send_disabled`                                          | kill switch or `SEND_ENABLED=false`                                                       | tool error                                                    | 200  |
| `sender_not_allowed`, `too_many_recipients`, `too_large` | sendAs, `MAX_RECIPIENTS`, `MAX_*_BYTES`                                                   | tool error                                                    | 200  |
| `not_found`                                              | Google 404                                                                                | tool error                                                    | 200  |
| `upstream_error`                                         | Google 5xx after one retry; broker: token endpoint 5xx, network failure or bad reply      | tool error, `{ status }` (none on network failure)            | 200  |
| `internal`                                               | broker: Google OAuth client missing or refused; anything else                             | tool error, generic message or the secret to check            | 200  |

An approval is not an error: the tool returns `{ status: 'pending_approval', pendingActionId, approvalUrl, preview, expiresAt }` without `isError`. HTTP 429 appears only on `/oauth/register` (DCR limit per `CF-Connecting-IP`, plan s.4.1), with `Retry-After: 60` and body `{ "error": "temporarily_unavailable", ... }`. The SDK rejects zod failures before the handler runs, with a result that is not our error shape (pinned in `test/mcp.test.ts`): `{ content: [{ type: 'text', text: 'Input validation error: Invalid arguments for tool <name>: <path>: <message>, ...' }], isError: true }`, one `path: message` per zod issue, joined by `, `.

Google answers (`providers/google/http.ts`, M9): `gfetch` first refuses an account whose component for the URL is off (`component_disabled`, nothing sent), so an implementation handed one account cannot reach another past a switched-off component. A 403 "insufficient permissions" is `component_disabled` when the account's stored `granted_scopes` never covered the component (`opts.component`, else taken from the URL), else `needs_relink`; any other 403 is `upstream_error` `{ status: 403 }`; 400 is `invalid_argument` `{ status }`; a timeout (10 s per attempt) or network failure is `upstream_error` without `status`. A 5xx is retried once except on POST, which opts in with `retry: true`, so a send never runs twice. Messages name the account (`a<shortId>`), never Google's body. `googleError` maps one status for batch parts too.

Internal-error log (N3): `register.ts` logs one line per non-`ToolError`, `{"event":"tool_internal_error","tool","errorClass","message"}`, where `redactMessage` cuts every argument value, brace and bracket blocks, quoted text, email addresses and token-like runs (16+ characters), then cuts at 200 characters. No arguments, bodies, tokens or stacks.

**Deviation from plan (s.10.6 test).** A forged `send_message` call on `/mcp/ro` returns `InvalidParams` "Tool not found", not 403: the tool is not registered there (SDKJ:1777), and a 403 would invite a step-up that can never succeed on that endpoint.

### 3.4 Account-scoped ids

Every returned id that belongs to one account is prefixed with the account's short id: `a<shortId>:<providerId>`, matched by `^a([1-9][0-9]{0,8}):(.+)$` and split at the first `:` only (People ids contain `/`, calendar ids `@`). `shortId` is a per-owner integer from `owners.next_short_id`, never reused after unlink and never the label, so renaming `work` cannot send a follow-up call to another mailbox.

A prefixed id selects its account. A bare id needs `account`, else the default account applies. A prefixed id plus a different `account` is `invalid_argument`. Prefixed: thread, message, draft, label, attachment, filter, calendar, event, file, contact. Not prefixed: `pendingActionId` (`pa_` plus random, owner-scoped).

`core/ids.ts`: `encodeId(account | shortId, providerId)`, `decodeId(id)` (null for a bare id) and `parseId(id)`, which also refuses a value shaped like a prefixed id but malformed (`a0:x`, `a1:`, ten digits) with `invalid_argument` instead of taking it for a bare id. `ctx.ids` is the `IdCodec` of these three.

`core/accounts.ts`: `createAccountResolver({ db, ownerId, publicUrl })` gives `AccountResolver.resolve(selector?, idPrefix?, { allowAll? })`. `selector` is tried as an exact label, then a label ignoring case or an address (lowercase), then a short id (`a3` or `3`); two matches at one step is `ambiguous_account` with `candidates` (labels). `"all"` (reserved, any case) returns every account only with `allowAll`, else `invalid_argument`. Omitted selects the owner's `default_account_id`, else the only linked account, else `account_not_found` (none) or `ambiguous_account` (several). `idPrefix` (`a3` or `3`, from `decodeId`) selects its account when `selector` is omitted; a selector that names another account, or `"all"`, is `invalid_argument` (a selector that names no account, or several, keeps `account_not_found` or `ambiguous_account`). Accounts in `needs_relink` resolve (the broker reports the relink). Errors carry `{ accountsUrl: PUBLIC_URL/accounts }`. A resolver reads the owner's accounts once, so make one per tool call.

### 3.5 Cursors

`nextPageToken` is `base64url(JSON.stringify(cursor))`:

```ts
// Design
type Cursor = {
  v: 1;
  t: string; // tool name
  q: string; // 16 hex of sha256(canonical query params)
  p: Record<string, { tok: string | null; skip: number } | null>;
}; // key 'a<shortId>'; null = exhausted
```

A single-account call has one entry. With `account: "all"` each account fetches its page (`tok`), results merge by date, and `skip` counts the items of that page already returned, so nothing is lost when the merged page is cut. A cursor whose `t` or `q` does not match the call is `invalid_argument`. Cursors are not signed: they hold only Google page tokens for the caller's own accounts, resolved through the owner's account table.

`core/cursor.ts` is the one implementation. `queryHash(params)` fingerprints the call's result-shaping parameters (canonical JSON, no `pageToken`); `encodeCursor` and `decodeCursor(token, { tool, query })` (any malformed or mismatched token is `invalid_argument`, fixed message) make up `ctx.cursors` with `queryHash`. A list tool does: `decode` when a `pageToken` came in, `startFromCursor(cursor | null, keys)` for the `{ key, tok, skip }` of every account still active (a cursor for a different account set is `invalid_argument`), one provider page fetch per account with `tok`, then `mergePages(pages, { tool, query, limit, keys, compare })` where each `AccountPage` is `{ key, tok, skip, items, next }` in sort order. `mergePages` drops the first `skip` items of each page, merges by `compare` up to `limit`, and returns `{ items, taken, nextPageToken }`. An account whose page is used up but has a next page stops the merge (its next items are unknown), so a page can be short, and empty if a provider returns an empty page with a next token (the cursor still advances). `keys` lists every account of the call, so exhausted ones stay in the cursor as null; `nextPageToken` is undefined when all are exhausted.

### 3.6 Services and providers (plan s.7)

```ts
// Design. src/services/types.ts
export type ProviderId = "google" | "msgraph" | "imap";
export type AccountRef = {
  ownerId: string;
  accountId: string;
  shortId: number;
  label: string;
  address: string;
  provider: ProviderId;
};
export type Page<T> = { items: T[]; nextPageToken?: string };

// src/services/capability.ts
export interface Capability<T> {
  readonly id: string;
  readonly component: Component | null;
  readonly _t?: T;
}
export const capability = <T>(id: string, component: Component | null): Capability<T> => ({
  id,
  component,
});
export type Binding = { cap: Capability<unknown>; impl: unknown };
export const provide = <T>(cap: Capability<T>, impl: T): Binding => ({ cap, impl });

// src/services/mail-labels.ts (M11), one interface per capability file
export interface LabelService {
  list(a: AccountRef): Promise<Label[]>;
  create(a: AccountRef, l: LabelInput): Promise<Label>;
  update(a: AccountRef, id: string, l: Partial<LabelInput>): Promise<Label>;
  remove(a: AccountRef, id: string): Promise<void>;
  modify(a: AccountRef, t: Target, change: { add?: string[]; remove?: string[] }): Promise<void>;
}
export const LABELS = capability<LabelService>("mail.labels", "mail");

// src/tools/mail-labels.ts (M11)
export const mailLabels: Family = {
  id: "mail.labels",
  tools: [listLabels, createLabel /* ... */],
  bindings: { google: [provide(LABELS, gmailLabels)] },
  parityPending: [],
};
```

| Capability         | Interface and methods                                                                                                                                         | M   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| `mail.read`        | `MailReader`: `search(a, q)`, `getThread(a, id, BodyOpts)`, `getMessage(a, id, BodyOpts)`                                                                     | M10 |
| `mail.labels`      | `LabelService`: above                                                                                                                                         | M11 |
| `mail.state`       | `StateService`: `modify(a, target, { add?, remove? })`, `trash(a, target)`, `untrash(a, target)`                                                              | M12 |
| `mail.drafts`      | `DraftService`: `create`, `get`, `list`, `update`, `remove`                                                                                                   | M13 |
| `mail.sendas`      | `SendAsService`: `list(a)`                                                                                                                                    | M14 |
| `mail.send`        | `SendService`: `prepare(a, input)`, `deliver(a, prepared, { from?, includeSignature, signatureOptional? })`, `readDraft(a, draftId)`, `sendDraft(a, draftId)` | M15 |
| `mail.attachments` | `AttachmentService`: `get(a, messageId, attachmentId, maxBytes)`                                                                                              | M16 |
| `mail.filters`     | `FilterService`: `list`, `create`, `remove`                                                                                                                   | M17 |
| `calendar`         | `CalendarService`: `listCalendars`, `calendarTimeZone`, `listEvents`, `getEvent`, `createEvent`, `updateEvent`, `deleteEvent`, `respond`, `freeBusy`          | M18 |
| `files.read`       | `FileReader`: `search`, `recent`, `metadata`, `readText`, `download`, `permissions`                                                                           | M19 |
| `files.write`      | `FileWriter`: `create`, `update`, `copy`, `share`, `trash`                                                                                                    | M20 |
| `contacts`         | `ContactService`: `search`, `get`                                                                                                                             | M21 |
| `admin.directory`  | `DirectoryAdminService`: users, aliases, groups, members, domains                                                                                             | A1  |

```ts
// Design. src/providers/registry.ts
export interface Provider {
  id: ProviderId;
  scopesFor(c: readonly AccountComponent[]): string[]; // google only; others throw until built
  get<T>(cap: Capability<T>): T | undefined;
}
export interface ProviderRegistry {
  get(id: ProviderId): Provider;
} // every id present
export function createProviderRegistry(families: readonly Family[]): ProviderRegistry; // duplicate binding throws at load
// src/providers/google/http.ts (M9). `a` must come from ctx.accounts; only https://*.googleapis.com.
export function gfetch(
  a: AccountRef,
  url: string | URL,
  init?: GoogleInit,
  opts?: { fields?; query?; component?; retry? },
): Promise<Response>;
export function gjson<T>(
  a: AccountRef,
  url: string | URL,
  init?: GoogleInit,
  opts?: GoogleFetchOptions,
): Promise<T>;
// src/core/token-broker.ts (M8). AccountRef satisfies BrokerAccount { ownerId, accountId }.
export function createTokenBroker(env: Env): TokenBroker; // cheap; state is per isolate
export interface TokenBroker {
  accessToken(a: BrokerAccount): Promise<string>; // refresh tokens never leave it
  invalidate(a: BrokerAccount): void; // Google refused the token: the next call refreshes
}
```

**Token broker (M8).** `accessToken(a)` returns the isolate's cached token, else the sealed D1 access token while more than 5 minutes remain (`EXPIRY_MARGIN_SECONDS`), else a refresh at Google's token endpoint with the sealed refresh token. Concurrent calls for one account share one refresh; the token request times out after 10 s (`TOKEN_TIMEOUT_MS`), and callers stop waiting for a shared refresh after 15 s (`REFRESH_WAIT_MS`), when the next call starts a new one. A refresh writes one D1 batch: the access token, plus the refresh token when Google rotated it or its row is under an older key version, all sealed under `CURRENT_KEY_VERSION` (lazy key rotation). Both writes apply only while the refresh row is still the one used, so a relink that lands meanwhile is never overwritten. A 400 `invalid_grant` marks the account `needs_relink` and deletes its access row, only if the refresh row is still the one Google refused; later calls throw `needs_relink` (`{ linkUrl: PUBLIC_URL/accounts }`) without calling Google, until a relink stores a new refresh token and sets `status` back to `ok`. Network failures, 5xx and malformed replies throw `upstream_error` and change nothing; a missing or refused Google client is `internal`. Google 401 contract: the Google HTTP client calls `invalidate(a)`, then `accessToken(a)`, and retries once; a second 401 is `needs_relink`.

`ctx.use(cap, a)` checks, in order: the capability's component is on for the account (`component_disabled`, `{ component, accountsUrl }`), the account's provider has a binding (`not_supported_by_provider`, `{ capability, provider }`); then it returns the implementation. `componentFor(cap)` (`registry/context.ts`) gives the account component: `mail.send` for the `mail.send` capability, `mail` for the other mail capabilities, the capability's own component otherwise. `admin` is no account component, so admin capabilities are refused until their milestone defines the check (fail closed). The component and the provider come from the stored row, read once per call. With `account: "all"`, a family calls `ctx.use` per account and skips the accounts where it throws `component_disabled` or `not_supported_by_provider`; it fails only when no account is left (the recipe in `progress.md`, M9b).

Account components (`providers/google/base.ts`, M7) are `mail`, `mail.send`, `calendar`, `files` and `contacts`, stored in `accounts.components`. Sending is its own account component so a mailbox can be linked without send: `ctx.use` (M9) checks `mail.send` for the `mail.send` capability and `mail` for the other `mail.*` capabilities. Google's `scopesFor` takes account components: `mail` asks for `gmail.modify` and `gmail.settings.basic`, `mail.send` alone for `gmail.send` (covered by `gmail.modify` otherwise), `calendar` for `calendar`, `files` for `drive`, `contacts` for `contacts.readonly` and `contacts.other.readonly` (plan s.9).

**Deviation from plan (s.7 shape).** Plan s.7 has one `MailService` with nested `drafts` and optional `filters`. Here mail is split into capability interfaces with typed keys, and each family binds its own implementation. Behaviour is unchanged (a missing capability gives `not_supported_by_provider`), but the mail milestones no longer edit one shared interface and one Google class.

### 3.7 Untrusted content

```ts
// Design
export interface Untrusted {
  readonly nonce: string; // 12 hex chars from crypto.getRandomValues, new per tool call
  wrap(
    text: string,
    a: { source: "email" | "calendar" | "file" | "contact"; account: string; from?: string },
  ): string;
}
```

`wrap` strips zero-width and bidi controls (U+200B-U+200F, U+202A-U+202E, U+2060-U+2069, U+FEFF), replaces `/<(\/?)untrusted/gi` with `&lt;$1untrusted`, escapes attribute values, and returns `<untrusted-NONCE source="email" account="a1" from="...">...</untrusted-NONCE>`. Tools with `untrusted: true` get the fixed `UNTRUSTED_NOTE` appended to their description. Required unit test: a body containing `</untrusted>` or a guessed `</untrusted-...>` stays inside one block (`test/untrusted.test.ts`). `stripHiddenControls` also removes U+00AD, U+034F, U+061C, U+180E and the Unicode Tags block U+E0000-U+E007F, which hide text from a reader. `core/untrusted.ts` exports `createUntrusted()` (one per tool call; becomes `ctx.untrusted`), `Untrusted`, `UntrustedAttrs`, `stripHiddenControls`, `neutralizeTags` and `escapeAttr` (which also folds line breaks to spaces). Stripping runs before neutralising, so a tag split by a zero-width character is still caught. `UNTRUSTED_NOTE` stays in `registry/compile.ts`.

## 4. D1 schema outline

`migrations/0001_auth.sql` (M4) and `0002_core.sql` (M6). Times are Unix seconds. Every row is keyed by owner, directly or through `accounts`, except sign-in `flow_states`, `rate_counters` (keyed by bucket) and a refused sign-in in `audit_log`. Foreign keys cascade from `owners` and `accounts`; `audit_log` has none, so it outlives an unlink. All tables are `STRICT`.

| Table              | Columns (key first)                                                                                                                                                                                                                                                                                                                                                       | Notes                                                                                                                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `owners`           | `id` PK (`o_` + 16 base32, no `:`), `default_account_id`, `send_kill_switch`, `next_short_id`, `created_at`                                                                                                                                                                                                                                                               | One row in v1.                                                                                                                                                                                                                                                           |
| `owner_identities` | `email` PK (lowercase), `owner_id`, `sub` (NULL until pinned), `pinned_at`, `last_login_at`; UNIQUE(`sub`)                                                                                                                                                                                                                                                                | `sub` is written only while `SETUP_MODE=true` (`UPDATE ... WHERE sub IS NULL`). After that, a missing or different `sub` is refused.                                                                                                                                     |
| `flow_states`      | `id` PK = sha256(state), `kind` (signin, link), `payload` JSON (PKCE verifier, nonce, returnTo, or owner, label, components), `binding` (hash of the flow cookie), `expires_at`                                                                                                                                                                                           | Consumed with `DELETE ... RETURNING`; 10 min.                                                                                                                                                                                                                            |
| `accounts`         | `id` PK (`ac_` + 16 base32), `owner_id`, `short_id`, `label`, `address` (lowercase), `provider`, `provider_sub`, `components` JSON, `granted_scopes`, `status` (ok, needs_relink), `send_as_fetched_at`, `created_at`, `updated_at`; UNIQUE(`owner_id`, `short_id`), (`owner_id`, `label`), (`owner_id`, `address`), and the index (`owner_id`, `lower(label)`) from 0003 | No token columns. `insertAccount` takes `short_id` from `owners.next_short_id` in one batch, so a failed insert uses none. `provider`, `status` and label rules beyond non-empty are checked in TypeScript. Unlink clears `owners.default_account_id` in the same batch. |
| `account_tokens`   | (`account_id`, `kind`) PK with kind refresh or access, `ciphertext` BLOB (tag included), `iv` BLOB (12 bytes), `key_version`, `expires_at`, `updated_at`                                                                                                                                                                                                                  | AES-256-GCM, AAD `ownerId\|accountId\|kind`, fresh IV per seal; `open()` uses the row's `key_version`; version 1 uses `TOKEN_KEK`, version N uses `TOKEN_KEK_vN`; re-encrypted on the next refresh after `CURRENT_KEY_VERSION` moves.                                    |
| `send_as`          | (`account_id`, `email` lowercase) PK, `display_name`, `is_default`, `is_primary`, `verification_status`, `reply_to`                                                                                                                                                                                                                                                       | Refreshed on link and after 24 h.                                                                                                                                                                                                                                        |
| `audit_log`        | `id` INTEGER PK, `at`, `owner_id` (NULL for a refused sign-in), `account_id`, `tool`, `client_id`, `grant_id`, `from_addr`, `to_addrs`, `cc_addrs`, `bcc_addrs`, `subject`, `provider_ref`, `result`, `detail`; INDEX(`owner_id`, `at`)                                                                                                                                   | No bodies. Also refused sign-ins (email hash, country). 365-day retention.                                                                                                                                                                                               |
| `rate_counters`    | (`bucket`, `window_start`) PK, `count`                                                                                                                                                                                                                                                                                                                                    | One `INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count`; buckets `send:h:<accountId>`, `send:d:<accountId>`, `calls:m:<grantId>`.                                                                                                                   |
| `pending_actions`  | `id` PK (`pa_...`), `owner_id`, `tool`, `account_id`, `params` JSON, `preview` JSON, `client_id`, `grant_id`, `status` (pending, approved, rejected, expired, executed, failed), `created_at`, `expires_at` (+7 days), `decided_at`, `result` JSON; INDEX(`owner_id`, `created_at`), INDEX(`account_id`)                                                                  | Decided only on `/approvals/:id` with an owner session and CSRF token, so an MCP token cannot approve.                                                                                                                                                                   |
| `known_recipients` | (`account_id`, `address` lowercase) PK, `source` (sent, history, contacts), `first_seen`                                                                                                                                                                                                                                                                                  | Migration 0004. Addresses the account has sent to or that a network check confirmed; `SEND_APPROVAL_MODE=new_recipients` sends to them without approval.                                                                                                                 |
| `send_allow`       | (`account_id`, `kind` address or domain, `value`) UNIQUE, `created_at`                                                                                                                                                                                                                                                                                                    | Migration 0004. The owner's allow list, edited only in the browser; a `domain` entry for a public mail provider is refused.                                                                                                                                              |

**Never rebuild `owners` or `accounts`.** D1 keeps `foreign_keys` on, and the implicit DELETE in `DROP TABLE` runs `ON DELETE CASCADE` even under `PRAGMA defer_foreign_keys = on`, so a create-copy-drop-rename rebuild deletes every sealed token, `send_as` row and pending action. Change them with `ALTER TABLE ... ADD COLUMN` or a new index (for example UNIQUE(`owner_id`, `lower(label)`)). A rebuild that cannot be avoided first copies the cascade children to holding tables and restores them in the same migration, with a test.

Plan s.3.2 lists "confirm nonces"; pending actions replace them (plan s.10.5). KV `OAUTH_KV` holds only the OAuth library's data.

## 5. Parity ratchet

`test/parity.test.ts` (M5) reads `test/fixtures/parity/{gmail,calendar,drive}.json` (`[{ name, description, inputSchema }]`, 50 tools) and `FAMILIES`:

```ts
// Design
const implemented = new Map(
  FAMILIES.flatMap((f) => f.tools.map((t) => [t.name, jsonSchemaOf(t.name)])),
);
const pending = new Set(FAMILIES.flatMap((f) => f.parityPending));
for (const o of official) {
  const ours = implemented.get(o.name);
  if (pending.has(o.name)) {
    expect(ours, `${o.name} is built: remove it from parityPending`).toBeUndefined();
    continue;
  }
  expect(ours, `${o.name} is neither built nor pending`).toBeDefined();
  const req: string[] = o.inputSchema.required ?? [];
  for (const p of req) expect(ours!.properties).toHaveProperty(p); // official names exist
  expect(ours!.required ?? []).toEqual(expect.arrayContaining(req)); // required: superset
  const extra = (ours!.required ?? []).filter((p) => !req.includes(p));
  expect(extra).toEqual(PARAM_EXCEPTIONS[o.name] ?? []); // extra required needs a reason
}
```

- Official names must be a subset of implemented plus pending. A name leaves `parityPending` only by being built (the first branch fails otherwise) and cannot vanish from both (the second fails), so the pending lists only shrink. All are empty after M21.
- M5 creates every family file with `tools: []` and `parityPending` holding that family's official names, so a family milestone shrinks its own list and never edits the test.
- `PARAM_EXCEPTIONS` lives in the test, one entry per tool with a reason comment, and starts empty: an extra required param breaks callers written against the official tools.
- Our additions (`account`, `maxBodyChars`) are optional and never affect the superset check.

## 6. Test strategy

- **Runner.** `vitest` with `cloudflareTest()` from `@cloudflare/vitest-plugin` and the committed `wrangler.example.jsonc` (the scaffold's `vitest.config.ts`). M4 switches to the function form to add test bindings through `miniflare.bindings` (VP:33-37, 87; s.1.6): `PUBLIC_URL=https://mcp.example.com`, `OWNER_CONTACT=https://example.com/contact` (not an address, so no held-action notice is sent unless a test sets `NOTIFY_EMAIL`), `OWNER_EMAILS=owner@example.com,owner2@example.com`, fixed test `TOKEN_KEK` and `COOKIE_SECRET`, `GOOGLE_CLIENT_ID=test-client`, `GOOGLE_CLIENT_SECRET=test-secret`.
- **D1.** `vitest.config.ts` calls `readD1Migrations('./migrations')` (VP:113) and passes the result as a `TEST_MIGRATIONS` binding; a `setupFiles` entry calls `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)` (VT:211-215). Tests create their own owner and account ids: storage is not rolled back between tests. `reset()` (VT:94) drops the applied tables and `d1_migrations` too (s.1.6), so a test that uses it re-applies migrations afterwards.
- **Fake Google** (`test/helpers/google.ts`). `vi.spyOn(globalThis, 'fetch')` with a route table keyed by method and URL prefix: `oauth2.googleapis.com/token`, `gmail.googleapis.com`, `www.googleapis.com/batch/gmail/v1`, `www.googleapis.com/calendar/v3`, `www.googleapis.com/drive/v3`, `people.googleapis.com`. An unmatched request throws, so no test reaches the network. The broker tests (`test/token-broker.test.ts`) keep their own small token-endpoint fake. Each family adds `test/fixtures/google/<family>.json`. Error cases per tool: 401 then refresh and one retry, 403 insufficient permissions, 404, 429, 500.
- **Google sign-in.** The fake token endpoint returns an ID token with test claims. The ID token comes straight from Google's token endpoint over TLS, so `google-oidc.ts` checks `iss`, `aud`, `exp`, `nonce` and `email_verified` and skips the signature (OpenID Connect Core 1.0, s.3.1.3.7, item 6). That also avoids a JWKS fetch and RSA work inside the CPU budget.
- **MCP tokens** (`test/helpers/tokens.ts`). `mintToken({ kind, scopes, ownerId })`: `getOAuthApi(env).createClient()` with a public client and a redirect URI on `client.example.com` (OP:1286); an `/authorize` request with PKCE S256 and `resource=resourceUrl(kind, issuer)`; `parseAuthRequest` (OP:1209); `completeAuthorization` with the scopes and `props: { ownerId }` (OP:1224); then the code exchange at `/oauth/token` through `exports.default.fetch`. The real token and audience code runs; nothing in the OAuth library is stubbed. `authorizeCode(options)` and `exchangeCode(code, { verifier })` expose the two halves for PKCE tests (`verifier: null` omits `code_verifier`).
- **MCP calls** (`test/helpers/mcp.ts`). `mcpCall(token, kind, method, params)` posts JSON-RPC to `PATH[kind]` through `exports.default.fetch`. Required request headers (2025-era lane, pinned in `test/mcp.test.ts`): `Host` matching the issuer (else 403 `Missing Host header`; workerd's `new Request()` sets none), `Content-Type: application/json` (else 415), `Accept` with both `application/json` and `text/event-stream` (else 406), and the bearer token. A browser `Origin` header other than a localhost-class or `workers.dev` host gets 403 (the agents default; MCP clients send none). The answer is SSE: one `data:` line holding the JSON-RPC response. A test that needs a tool the families lack compiles its own registry with `compileRegistry([...FAMILIES, testFamily])` and calls `mcpHandler(kind, issuer, registry)` directly.
- **Required auth tests (M4, M5, M14).** No token gives 401 with `resource_metadata`. A token for `/mcp` gets 401 at `/mcp/ro` and `/mcp/admin`, and the reverse. Both owner addresses reach the same owner. After setup mode, an unpinned email and a pinned email with a different `sub` are refused (403 page, no cookie, no grant). Missing PKCE gives 400. A grant without `mail.send` does not see `send_message` in `tools/list` and gets 403 `insufficient_scope` when it calls it. On `/mcp/ro`, `send_message` is not listed and a forged call returns `InvalidParams`. An MCP token cannot approve a pending action. M4a covers the 401, audience, PKCE and RS 403 tests; M4b the owner tests, in `test/signin.test.ts`: the full owner flow to a token that works at `/mcp`, the non-owner refusal (403, no `Set-Cookie`, no grant in KV), the setup-mode refusals, state replay and cookie mismatch, the `/mcp/ro` clamp, a missing CSRF token, and the 503 when sign-in is not configured while `/health` stays 200 (`test/web.test.ts`).
- **Link tests (M7a)**, in `test/accounts.test.ts`, with the sign-in fake extended by fresh refresh and access tokens per code, the requested scopes echoed as granted, Gmail's sendAs list and the revoke endpoint: `/accounts` without a session goes through sign-in and back; the full link stores the account, sealed tokens that open to what Google issued and the sendAs rows; the scopes asked for match the chosen components exactly; an address not on `LINKABLE_EMAILS` is refused with no rows; a flow of another owner, a callback without the session or without the flow cookie, and a replayed state are refused before any code exchange; link and unlink without the CSRF token are refused; unlink revokes and removes the rows; a relink updates in place; no page or log line carries a token.
- **Accounts controls tests (M7b)**, in `test/accounts.test.ts`, same fakes plus the revoke log and a settable grant: turning a component on asks for only the added scopes, with `login_hint`, and the callback updates components, scopes and tokens in place; turning it on when the scopes are already granted, and turning one off, make no Google call; re-link minimal revokes the old refresh token, asks for the reduced set and ends `ok` with only those scopes (and changes nothing when the revoke is not confirmed or the key is missing); relink of a `needs_relink` account resets it to `ok`, and a different Google account is refused with the new grant revoked; the default account is set, refused for another owner's account, cleared, and cleared by unlink; re-encrypt with `CURRENT_KEY_VERSION=2` moves both rows to key version 2, they open under the new key, a second run moves none, and no token appears in the page or logs; every new POST without a session, without the token or with another session's token is refused with no change and no Google call; a refused link revokes the new grant unless an account holds the address; an identity-only grant is refused.
- **Unit.** Crypto round trip and AAD mismatch, ids, cursors, untrusted wrapping, MIME, sendAs check, rate counters, scope clamping, registry load-time checks.
- **CI.** The scaffold's `typecheck`, `lint` and `test` scripts; no network, no real secrets.

## 7. Build order (M4-M21)

**Family rule.** M5 writes `src/tools/index.ts` with one import per family and creates every family file as an empty `Family` (s.5). A family milestone then edits only its own `tools/<family>.ts`, `services/<cap>.ts`, `providers/google/<cap>.ts`, `test/<family>.test.ts` and `test/fixtures/google/<family>.json`, and changes no shared line. A family added after M5 adds one import line and one `FAMILIES` entry to `src/tools/index.ts`.

| M   | Scope                                                                                    | Files owned                                                                                                                                                                                                                                                              | Depends on    | Parallel with                     |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | --------------------------------- |
| M4a | AS, three RS, metadata, CIMD, DCR and its rate limit, pages, sign-in placeholders        | `src/index.ts`, `env.ts`, `auth/{endpoints,server}.ts`, placeholder `auth/{mcp-factory,consent,callback}.ts`, `web/{app,html,public}.ts`, `core/{crypto,db}.ts`, `migrations/0001_auth.sql`, `vitest.config.ts`, `test/helpers/tokens.ts`, `wrangler.example.jsonc` vars | M3            | none                              |
| M4b | Google sign-in, owner identities, session, consent and callback bodies                   | `auth/{google-oidc,owners,session,flow-state}.ts`, `auth/{consent,callback}.ts` (bodies), `test/helpers/{google,session}.ts`                                                                                                                                             | M4a           | M5, M6                            |
| M5  | `/mcp` handler, registry, `whoami`, parity test                                          | `auth/mcp-factory.ts`, `registry/*`, `core/errors.ts`, `tools/index.ts`, every family stub, `tools/meta.ts`, `test/parity.test.ts`, `test/helpers/mcp.ts`                                                                                                                | M4a           | M4b, M6, M7, M8                   |
| M6  | Core schema, AES-GCM                                                                     | `migrations/0002_core.sql`, `core/crypto.ts` (seal, open), `core/db.ts` (rows), `test/core.test.ts`                                                                                                                                                                      | M4a           | M4b, M5                           |
| M7  | Link flow, `/accounts`, components, unlink                                               | `auth/link.ts`, `auth/callback.ts` (link branch), `web/accounts.ts` + one `web/app.ts` line, `providers/google/base.ts`                                                                                                                                                  | M4b, M6       | M5, M8, M9                        |
| M8  | Token broker                                                                             | `core/token-broker.ts`                                                                                                                                                                                                                                                   | M6            | M5, M7                            |
| M9  | Services, providers, resolution, ids, cursors, untrusted, guardrail stubs, account tools | `services/{capability,types}.ts`, `providers/registry.ts`, `providers/google/http.ts`, `core/{accounts,ids,cursor,untrusted,send-as,audit,ratelimit,pending}.ts`, `registry/{types,context}.ts`, `tools/account.ts`                                                      | M5, M6, M8    | M7                                |
| M10 | Mail read                                                                                | `mail-read` family, `providers/google/batch.ts`, `core/html-text.ts`                                                                                                                                                                                                     | M9            | M11-M14, M18, M19, M21            |
| M11 | Labels                                                                                   | `mail-labels` family                                                                                                                                                                                                                                                     | M9            | M10, M12-M14, M18, M19, M21       |
| M12 | State, spam, trash, sensitive labels                                                     | `mail-state` family                                                                                                                                                                                                                                                      | M9            | M10, M11, M13, M14, M18, M19, M21 |
| M13 | Drafts                                                                                   | `mail-drafts` family, `core/mime.ts`, `tools/mail-common.ts` (shared mail params)                                                                                                                                                                                        | M9            | M10-M12, M14, M18, M19, M21       |
| M14 | Guardrails, approvals, kill switch, `/mcp/ro` tests                                      | `core/{send-as,audit,ratelimit,pending}.ts` (bodies), `services/mail-sendas.ts`, `providers/google/gmail-sendas.ts`, `tools/guardrails.ts`, `web/guardrails.ts` + one `web/app.ts` line, `scheduled` in `src/index.ts`, cron in `wrangler.example.jsonc`                 | M9            | M10-M13, M18, M19, M21            |
| M15 | Send, reply, forward                                                                     | `mail-send` family                                                                                                                                                                                                                                                       | M13, M14      | M17, M20, unfinished M10-M21      |
| M16 | Attachments                                                                              | `mail-attachments` family; edits `core/mime.ts`, `tools/mail-common.ts`                                                                                                                                                                                                  | M10, M13, M15 | M17, M20, unfinished M18-M21      |
| M17 | Filters (`forward` action needs approval)                                                | `mail-filters` family                                                                                                                                                                                                                                                    | M14           | M15, M16, M20, unfinished M10-M21 |
| M18 | Calendar                                                                                 | `calendar` family                                                                                                                                                                                                                                                        | M9            | M10-M17, M19-M21                  |
| M19 | Drive read                                                                               | `drive-read` family                                                                                                                                                                                                                                                      | M9            | M10-M18, M21                      |
| M20 | Drive write (`share_file` to `anyone` needs approval)                                    | `drive-write` family                                                                                                                                                                                                                                                     | M14, M19      | M15-M18, M21                      |
| M21 | Contacts                                                                                 | `contacts` family                                                                                                                                                                                                                                                        | M9            | M10-M20                           |

Planned exceptions to the family rule: M14 replaces the bodies of the M9 stubs without changing signatures; M16 edits `core/mime.ts` and `tools/mail-common.ts` after M13 and M15 have landed; M7 fills the link branch that M4b leaves as one dispatch line in `auth/callback.ts`. M4b replaces the bodies of the M4a placeholders in `auth/consent.ts` and `auth/callback.ts`, without changing signatures, and M5 the body of `mcpHandler` in `auth/mcp-factory.ts`, adding only an optional test parameter. Page modules each add one `app.route()` line to `web/app.ts`.

**Deviation from plan (order).** Plan M4 comes before the D1 milestone (M6), but owner `sub` pinning and sign-in state need storage, so M4 creates the auth tables (`0001_auth.sql`) and M6 the rest. M4 also builds all three resource servers (plan M14 adds `/mcp/ro`), since M4's audience test already spans the three; M14 keeps the no-send tests. `core/untrusted.ts` moves from M10 to M9 so calendar, drive and contacts do not wait for mail.

**Split of M7 (M7a, M7b).** M7a ships the link form, the link branch, the account list and unlink. M7b (built) adds, in `web/accounts.ts` and `auth/link.ts`: component toggles with incremental consent, the default account, relink, "re-link minimal" and "re-encrypt all", plus `listOwnerTokens` in `core/db.ts` and `excessScopes` in `providers/google/base.ts`.

**Split of M4 (M4a, M4b).** M4 ships as two PRs so the OAuth skeleton can be deployed and tested before Google sign-in exists: M4a builds the AS, the three RS, the pages and placeholders that answer 503 on `/authorize` and `/oauth/google/callback`; M4b adds the sign-in modules and those two bodies. M5 and M6 need only M4a; M7 needs M4b.

Parallel groups (critical path M4a, M6, M8, M9, M13 and M14, M15, M16):
1. M4a alone.
2. M4b, M5 and M6.
3. M7 (once M4b and M6 land) and M8, while M5 may still run.
4. M9 (M7 may still run).
5. M10, M11, M12, M13, M14, M18, M19, M21.
6. M15, M17, M20, each once its dependencies land.
7. M16.

## 8. Free-tier notes

Limits (Workers Free, checked against the Cloudflare docs at M22): 10 ms CPU per request; 1 s startup; 50 subrequests per request (KV and D1 calls count, with a separate 1,000 for Cloudflare-service calls); 64 MiB uncompressed bundle (there is no compressed limit; the earlier "3 MB gzip" assumption was the Paid plan's old figure); 128 MB per isolate; 100k requests a day. KV: 100k reads, 1,000 writes, 1,000 deletes and 1,000 lists a day, 1,000 operations per invocation. D1: 5M rows read and 100k rows written a day, 50 queries per invocation (a batch counts as one). Time spent waiting on the network is not CPU time.

- **A server per request.** The factory runs once per HTTP request (SDK:3876-3894), so the per-request work must stay small: construct `McpServer`, call `registerTool` for the endpoint's tools (about 60 on `/mcp`), install the `tools/list` override. Everything else is module scope and runs once per isolate: the AS and RS objects (`getAuth`, memoised as at wb-proto:55-76), compiled schemas and frozen `Tool` objects, the `listFor` memo, parsed config, and `preloadSchemas()` (SDK:2786-2799).
- **No schema work per request.** `precomputed()` returns the module-scope JSON Schema, so the SDK's lazy conversion (SDKJ:1679-1690) is a lookup, and `tools/list` returns a frozen array without touching zod. Zod validation runs only for the tool called.
- **Memo size.** `listFor` keys on kind plus sorted granted scopes: a few dozen entries per isolate at most.
- **Fallback (not needed).** M22 measured registration at about 1 ms per request (table below), so this stays unbuilt. If it is ever over budget, switch to plan s.3.4's option: a low-level server whose `tools/list` returns `listFor()` and whose `tools/call` looks the tool up in a map and runs the same wrapper. The SDK's 403 challenge then no longer applies, so the RS handler reads `params.name` from a clone of each `tools/call` body and returns `insufficientScope()` (OP:597) when the grant lacks the tool's scopes. Only `mcp-factory.ts`, `register.ts` and `auth/server.ts` change; families do not.
- **Subrequests.** A tool call costs the library's KV token lookup (1 KV get), 1 to 2 D1 queries for the account and its token (the access token is also cached in isolate memory for its lifetime), and Google fetches. `account: "all"` costs 2 Google subrequests per account for `search_threads`, `list_events` and `search_events` (list plus one batch), 4 for a cold `search_contacts`, and 1 for the Drive tools, with at most 25 results per account.
- **KV writes.** The 1,000 writes a day cap is why MCP access tokens last 4 h and Google tokens stay out of KV; counters and audit rows go to D1. A tool call writes nothing to KV; only OAuth steps do (2 puts each for a token exchange or a refresh rotation).
- **Crypto.** HMAC, SHA-256 and AES-GCM are native WebCrypto; sign-in does no JWKS or RSA work (s.6).
- **Cleanup.** A daily `scheduled` handler (M14) expires pending actions and flow states, trims rate counters and old audit rows, and calls the library's `purgeExpiredData()` (OP:1347) in small batches.

### Measured budget (M22, offline)

`bench/bench.mjs` produced these numbers: `cd server && node bench/bench.mjs --runs=60 --warmup=10`. It is not part of `npm test`. It bundles the real Worker with esbuild for Node 24 (`cloudflare:workers` stubbed), mints real OAuth tokens through the library, and fakes the outside world: `node:sqlite` as D1 running the real migrations, a Map as KV, and a canned-response `fetch` for Google. Counters (subrequests, D1 queries and rows, KV operations) are exact counts of calls made. CPU is wall time minus the time spent inside the synchronous parts of the fakes.

**Caveat.** This is Node V8, not workerd. Both run V8, but workerd freezes `performance.now()` during JS, uses a different GC and JIT setup, and Node's WebCrypto runs off-thread, so crypto cost is under-counted here. Treat the CPU figures as relative (which scenario costs more) and as a lower bound; the authority is the Workers analytics CPU-time percentiles after a live run.

| Item                                                               | Free limit           | Measured                                                                                           | How obtained                                                                        | Verdict                                                                        |
| ------------------------------------------------------------------ | -------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Bundle                                                             | 64 MiB               | 1,945.82 KiB (387.54 KiB gzip)                                                                     | `wrangler deploy --dry-run --outfile`, then `wrangler check startup --workerBundle` | 3% of limit                                                                    |
| Startup                                                            | 1 s                  | 62.0 ms active (4.6 ms GC), 103.8 ms profile window; Node bundle import 82.5 ms                    | local workerd profile from `wrangler check startup`                                 | 6% of limit; live check                                                        |
| Cold first request                                                 | 10 ms                | 15.0 ms (Node, includes JIT warm-up of the whole request path)                                     | `bench.mjs`, first request after import                                             | Node cold JIT; live check                                                      |
| `initialize` `/mcp`                                                | 10 ms                | p50 0.76, p95 1.56 ms                                                                              | 60 runs                                                                             | ok                                                                             |
| `tools/list` `/mcp` (63 tools)                                     | 10 ms                | p50 0.89, p95 1.36 ms                                                                              | 60 runs                                                                             | ok                                                                             |
| `initialize` `/mcp/ro`                                             | 10 ms                | p50 0.90, p95 1.19 ms                                                                              | 60 runs                                                                             | ok                                                                             |
| `tools/list` `/mcp/ro` (27 tools)                                  | 10 ms                | p50 0.96, p95 1.27 ms                                                                              | 60 runs                                                                             | ok                                                                             |
| `search_threads`, `account: "all"`, 2 accounts, 25 per page        | 10 ms                | p50 2.08, p95 3.09 ms                                                                              | 60 runs, canned Gmail list plus batch                                               | ok                                                                             |
| `get_thread`, typical 20 messages (1.2 MB JSON)                    | 10 ms                | p50 2.39, p95 4.54 ms                                                                              | 60 runs                                                                             | ok                                                                             |
| `get_thread`, 20 messages with 300 KB HTML each (8.0 MB JSON)      | 10 ms                | p50 42.3, p95 47.4 ms                                                                              | 60 runs                                                                             | **over budget** (see below)                                                    |
| `send_message`, attachment at `MAX_SEND_ATTACHMENT_BYTES` (512 KB) | 10 ms                | p50 3.45, p95 6.70 ms                                                                              | 60 runs, media upload path                                                          | ok in Node; p95 at 67% of limit and Node is a lower bound, live check required |
| `download_file_content` at the 512 KB cap                          | 10 ms                | p50 4.76, p95 8.68 ms (was 21 ms before this pass)                                                 | 60 runs                                                                             | ok in Node; p95 at 87% of limit and Node is a lower bound, live check required |
| Google token refresh plus `search_files`                           | 10 ms                | p50 1.34, p95 1.58 ms                                                                              | 60 runs                                                                             | ok                                                                             |
| OAuth code exchange, refresh rotation                              | 10 ms                | p50 1.04 and 0.92 ms                                                                               | 60 runs                                                                             | ok                                                                             |
| Daily cron (`cleanup`)                                             | 10 ms                | 1.32 ms, 1 D1 batch, 455 KV gets and 6 lists (bench state)                                         | one run after the other scenarios                                                   | see recommendation 2                                                           |
| Subrequests, worst `account: "all"` at 4 accounts                  | 50                   | 8 (`search_threads`, `list_events`, `search_events`), 16 cold (`search_contacts`), 4 (Drive tools) | counted per tool at 1, 2 and 4 accounts, cold and warm token cache                  | ok at 4 accounts; scales linearly (see recommendation 3)                       |
| KV operations per tool call                                        | 1,000 per invocation | 1 get, 0 puts                                                                                      | counted                                                                             | ok                                                                             |
| KV writes a day                                                    | 1,000                | about 85 for 300 calls and 5 clients                                                               | derived below                                                                       | 9% of limit                                                                    |
| KV reads a day                                                     | 100k                 | about 450                                                                                          | derived below                                                                       | under 1%                                                                       |
| D1 rows written a day                                              | 100k                 | about 400                                                                                          | derived below                                                                       | under 1%                                                                       |

**Derivations.** Counts per step were measured; the daily totals are arithmetic on them.
- KV writes: a tool call does 0 puts. A token exchange and a refresh rotation do 2 puts each (grant and token); client registration does 1, authorize 2. With a 4 h access token, an always-on client rotates 6 times a day: 6 x 2 x 5 clients = 60 puts. If each client also re-registers, authorizes and exchanges once a day (1 + 2 + 2 = 5 puts): 25. Total about 85. Refresh rotation did 0 deletes.
- KV reads: 1 get per tool call (300), 2 per rotation (60), a few for `initialize`: about 450.
- D1 rows written: a read tool writes 0 rows. `send_message` writes at most 6 (4 rate-counter rows and 2 audit rows; the figure is an upper bound that counts one extra row per index). A Google token refresh writes 2 rows and happens at most hourly per account. For 300 calls with 10% sends and 2 accounts: 30 x 6 + 24 x 2 x 2 = 276, plus cron deletions: about 400. Even if all 300 were sends, the per-account hourly and daily limits cap it well below 2,000.
- D1 queries per call: 1 to 2 for reads, 8 for a send (one batch counts as one); the limit is 50.

**Fixed in M22.** `bytesToB64` spread each 8 KB chunk into `String.fromCharCode(...)` (13 ms for 512 KB) and `b64urlToBytes` built the array with `Uint8Array.from(atob(s), cb)` (35 ms for 512 KB). They now use `fromCharCode.apply` (2 ms) and a plain `charCodeAt` loop (1.2 ms), in `core/mime.ts`, with a test against `Buffer`. `download_file_content` at the cap went from p50 21 ms to 4.8 ms.

**Recommendations (not built).**
1. `get_thread` on very large threads. In the 8 MB bench (20 messages, 300 KB HTML each) CPU was 42 ms at a 10-message window and 12.8 ms at a 1-message window, and 4 MB and 16 MB threads cost 36 and 50 ms. So the cost is mostly decoding and `htmlToText` on each windowed message (about 3 ms per large HTML message), not the size of the Gmail JSON. Fetching with `format=minimal` and then only the windowed messages (option b) would not remove that; the fix must also bound the decode work per message and per call (for example a cumulative decoded-byte budget that truncates later messages). This is being fixed in a separate PR; it needs a live Gmail check.
2. Cron purge (done in M22: `PURGE_ROUNDS` is now 3). It was 5, which with batches of 50 can cost up to about 500 KV gets plus 500 deletes plus lists in one invocation, which is at the 1,000 operations per invocation limit and half the 1,000 deletes a day. At 3 (about 600 operations; 150 grants and 150 tokens a day against a few dozen created) it stays well under the cap. Whether KV TTL expiry counts toward the delete cap is undocumented: live check.
3. `account: "all"` has no cap on the number of accounts. Counting Google fetches only, at 2 subrequests per account it reaches 50 at 25 accounts (`search_contacts` cold: 4 per account, 12 accounts); if KV and D1 calls share the 50 (as the limits paragraph assumes), it is about 16 accounts (about 10 for cold `search_contacts`). A personal deployment has a handful, so this is not urgent; if it grows, cap the fan-out at 10 accounts per call and say so in the result.

**Needs a live check** (Workers analytics, or `wrangler tail` with CPU time, after a real deploy):
- p50 and p95 CPU time per request for the table's scenarios, in particular `send_message` with an attachment and `download_file_content` at the cap (the p95s that came within 70% of the limit in Node).
- Startup time on Cloudflare (local profile only so far) and the cold first request.
- Whether KV TTL expiry and library purge deletes count against the 1,000 deletes a day.
- Whether KV and D1 calls share the 50 subrequest limit on Free (the limits paragraph assumes they do; the table counts Google fetches only).
- Subrequest counts against real Gmail pagination (the bench uses one list page and one batch per account).
- Real-world thread sizes for `get_thread` (recommendation 1).

## 9. Open items

- M14: the Free plan accepts the `ratelimits` binding (M3 deploy) and miniflare emulates it (s.1.6), so M4a uses it for DCR; the live limiter has not been tripped. Decide whether the per-grant limit uses it or the D1 `rate_counters` (s.4).
- M22 (offline part done): registration CPU measured at about 1 ms per request, so the s.8 fallback stays unbuilt; the budget table is in s.8. Still owed: the live Workers-analytics CPU check and the s.8 recommendations (large-thread `get_thread`, an `account: "all"` cap; cron `PURGE_ROUNDS` is now 3).
