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
- Production (`src/index.ts`, M4a) adds two exact paths before the page app, `/authorize` and `/oauth/google/callback`, each wrapped with the page security headers (their bodies are M4b, s.7), and runs the `DCR_LIMIT` check before `/oauth/register` reaches the AS (s.3.3).

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
- Inside a tool, `getMcpAuthContext()` returns the same props (AG:10-13), and `env` from `cloudflare:workers` is reachable at module scope (both used at wb-proto:3, 48).

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

| Path                            | M       | Responsibility                                                                                                                                                                                    |
| ------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                  | M4a     | Top-level fetch: exact RS paths, AS paths (DCR rate limit, HTTP 429), `/authorize` and `/oauth/google/callback` with security headers, else the page app. `scheduled` added in M14.               |
| `src/version.ts`                | M0      | `VERSION`, also `serverInfo.version`.                                                                                                                                                             |
| `src/env.ts`                    | M4a     | `Env` bindings, vars, secrets and the `Cloudflare.Env` declaration; `config(env)` validates the issuer and parses numbers, flags and email lists once per `env` object.                           |
| `src/auth/endpoints.ts`         | M4a     | `KINDS`, `PATH`, `Kind`, `Scope`, `SCOPES` per kind, `ALL_SCOPES`, `SERVER_NAME`, `resourceUrl(kind, issuer)`, `endpointScopes(kind, granted)`. Pure data.                                        |
| `src/auth/server.ts`            | M4a     | `getAuth(env)`: module-scope memo of the AS and three RS, each with its MCP handler; RS handlers enforce scope (s.1.1). Access tokens 4 h, refresh tokens 30 d.                                   |
| `src/auth/mcp-factory.ts`       | M4a, M5 | M4a: placeholder `mcpHandler(kind, issuer)` answering `{ kind, ownerId, scope }`. M5, same signature: `buildServer(kind, ctx)`: fail-closed audience check, `registerAll`, `tools/list` override. |
| `src/auth/google-oidc.ts`       | M4b     | Google authorize URL (`openid email`, PKCE S256, nonce, `prompt=select_account`), code exchange, ID token claim checks.                                                                           |
| `src/auth/owners.ts`            | M4b     | Owner identities: `OWNER_EMAILS` allowlist, `sub` pinning only in `SETUP_MODE`, `resolveOwner(email, sub)`.                                                                                       |
| `src/auth/session.ts`           | M4b     | Owner session cookie `__Host-wb-session` (HMAC with `COOKIE_SECRET`, 30 min) and CSRF tokens for page forms.                                                                                      |
| `src/auth/flow-state.ts`        | M4b     | `flow_states` rows: create, consume once, `__Host-wb-flow` cookie binding.                                                                                                                        |
| `src/auth/consent.ts`           | M4      | M4a: placeholder answering 503 `sign-in not configured`. M4b: `GET/POST /authorize`: parse, session gate, consent page, approve, clamp scope, `completeAuthorization`.                            |
| `src/auth/callback.ts`          | M4      | M4a: placeholder answering 503. M4b: `GET /oauth/google/callback`: consume state, dispatch to sign-in (M4b) or link (M7).                                                                         |
| `src/auth/link.ts`              | M7      | Link leg: Google URL for chosen components, `LINKABLE_EMAILS` check, store tokens, first sendAs fetch.                                                                                            |
| `src/web/app.ts`                | M4a     | Hono app for pages; one `app.route()` line per page module; security headers.                                                                                                                     |
| `src/web/html.ts`               | M4a     | Escaping `html` tagged template and page shell.                                                                                                                                                   |
| `src/web/public.ts`             | M4a     | `/` and `/privacy` with the contact from var `OWNER_CONTACT`; `/health`.                                                                                                                          |
| `src/web/accounts.ts`           | M7      | `/accounts`: list, link, components, default account, unlink and revoke, re-encrypt.                                                                                                              |
| `src/web/guardrails.ts`         | M14     | `/approvals/:id` approve or reject, kill switch, audit view.                                                                                                                                      |
| `src/core/crypto.ts`            | M4a, M6 | M4a: random ids, SHA-256, HMAC, constant-time compare. M6: AES-256-GCM `seal`/`open` (AAD, per-row key version), `currentKeyVersion`.                                                             |
| `src/core/db.ts`                | M4a, M6 | Typed D1 helpers and row types. M6: core rows, `insertAccount`, `getAccount`, `listAccounts`, `upsertToken`, `getToken`, `incrementCounter`.                                                      |
| `src/core/errors.ts`            | M5      | `ToolError`, codes, `toToolResult`, Google error mapping (s.3.3).                                                                                                                                 |
| `src/core/accounts.ts`          | M9      | Account repository and resolution: label, address, short id, `all`, default.                                                                                                                      |
| `src/core/ids.ts`               | M9      | `a<shortId>:<id>` prefixing (s.3.4).                                                                                                                                                              |
| `src/core/cursor.ts`            | M9      | Multi-account cursor codec (s.3.5).                                                                                                                                                               |
| `src/core/untrusted.ts`         | M9      | Per-response nonce wrapper, escaping, control-character stripping (s.3.7).                                                                                                                        |
| `src/core/token-broker.ts`      | M8      | `TokenBroker`: memory, then D1, then refresh; `invalid_grant` sets `needs_relink`.                                                                                                                |
| `src/core/send-as.ts`           | M9, M14 | sendAs cache (24 h) and `assertFrom()`. M9 stub allows the primary address only.                                                                                                                  |
| `src/core/audit.ts`             | M9, M14 | Audit writes and reads. M9 stub is a no-op.                                                                                                                                                       |
| `src/core/ratelimit.ts`         | M9, M14 | Fixed-window counters and the per-grant call limit. M9 stub never trips.                                                                                                                          |
| `src/core/pending.ts`           | M9, M14 | Pending actions: create, get, decide, expire, execute.                                                                                                                                            |
| `src/core/html-text.ts`         | M10     | Linear HTML-to-text and body truncation.                                                                                                                                                          |
| `src/core/mime.ts`              | M13     | Vendored MIME builder (notice in THIRD-PARTY.md); M16 adds attachments.                                                                                                                           |
| `src/services/capability.ts`    | M9      | `capability<T>()`, `provide()`, `Binding` (s.3.6).                                                                                                                                                |
| `src/services/types.ts`         | M9      | `AccountRef`, `Page<T>`, `ProviderId`, shared value types.                                                                                                                                        |
| `src/services/<cap>.ts`         | family  | One capability interface and its key per file.                                                                                                                                                    |
| `src/providers/registry.ts`     | M9      | Builds providers from the families' bindings; backs `ctx.use()`.                                                                                                                                  |
| `src/providers/google/base.ts`  | M7      | Google OAuth endpoints, `scopesFor(components)`, revoke.                                                                                                                                          |
| `src/providers/google/http.ts`  | M9      | `gfetch`: bearer from the broker, `fields=`, one retry, error mapping.                                                                                                                            |
| `src/providers/google/batch.ts` | M10     | Gmail batch requests (`multipart/mixed`) for metadata.                                                                                                                                            |
| `src/providers/google/<cap>.ts` | family  | One file per capability (`gmail-*`, `calendar`, `drive-*`, `people`).                                                                                                                             |
| `src/registry/types.ts`         | M5      | `ToolDef`, `ToolContext`, `Family`, `Component`; re-exports `Kind` and `Scope` from `auth/endpoints.ts`.                                                                                          |
| `src/registry/compile.ts`       | M5      | Module-scope precompute: JSON Schemas, frozen `Tool[]` per kind, `listFor` memo, load-time checks.                                                                                                |
| `src/registry/register.ts`      | M5      | `registerAll(mcp, kind, auth)`: `scopeChallenge`, per-grant limit, approval gate, error wrapper.                                                                                                  |
| `src/registry/context.ts`       | M5, M9  | Builds the `ToolContext` per call; M9 adds accounts, providers and guardrails.                                                                                                                    |
| `src/tools/index.ts`            | M5      | `FAMILIES`: one import line per family, all present from M5.                                                                                                                                      |
| `src/tools/<family>.ts`         | family  | Exports one `Family`: tools, bindings, parity pending list.                                                                                                                                       |
| `migrations/0001_auth.sql`      | M4a     | `owners`, `owner_identities`, `flow_states`.                                                                                                                                                      |
| `migrations/0002_core.sql`      | M6      | All other tables in s.4.                                                                                                                                                                          |
| `test/helpers/*.ts`             | M4, M5  | `tokens.ts` (M4a: `mintToken`, `authorizeCode`, `exchangeCode`); `google.ts` (fake Google) and `session.ts` (M4b); `mcp.ts` (M5).                                                                 |

Families (`src/tools/<family>.ts` plus their `services/` and `providers/google/` files): `meta` (M5: `whoami`), `account` (M9: `list_accounts`, `link_account_url`), `guardrails` (M14: `list_send_as`, `get_pending_action`), `mail-read` (M10), `mail-labels` (M11), `mail-state` (M12), `mail-drafts` (M13), `mail-send` (M15), `mail-attachments` (M16), `mail-filters` (M17), `calendar` (M18), `drive-read` (M19), `drive-write` (M20), `contacts` (M21); `admin-*` later (A1-A3).

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
  approval?: { when(args: z.output<S>, ctx: ToolContext): boolean | Promise<boolean>;
               preview(args: z.output<S>, ctx: ToolContext): unknown };
  handler(args: z.output<S>, ctx: ToolContext): Promise<unknown>;   // JSON-serialisable
}

export interface Family {
  id: string;                                                   // 'mail.labels'
  tools: readonly ToolDef[];
  bindings: Partial<Record<ProviderId, readonly Binding[]>>;    // capability implementations (s.3.6)
  parityPending: readonly string[];                             // official names not built yet (s.5)
}

// src/registry/compile.ts, module scope, once per isolate
export interface CompiledTool { def: ToolDef; schema: StandardSchemaWithJSON; listed: Tool }
export const BY_KIND: Readonly<Record<Kind, readonly CompiledTool[]>>;
export function listFor(kind: Kind, granted: readonly string[]): readonly Tool[];  // memo: kind + sorted scopes
```

`Kind` and `Scope` are defined in `src/auth/endpoints.ts` (M4a), which the auth layer needs before M5; `registry/types.ts` re-exports them.

`compile.ts` runs `z.toJSONSchema(def.input, { target: 'draft-2020-12', io: 'input' })` once per tool, wraps the result with `precomputed()` (s.1.4) and freezes it. At load it also checks that names are unique and that `scopes` is a subset of `SCOPES[k]` for every `k` in `endpoints` (which keeps `mail.send` off `ro`). A test imports the module, so a bad definition fails CI rather than production.

Endpoint rule (plan s.10.6): `ro` gets read tools plus `create_draft` and `update_draft`, and no send, reply, forward, share, filter, trash or label-write tool. `admin` gets admin tools. Account and meta tools are on all three. Server names per endpoint: `workspace-bridge`, `workspace-bridge-readonly`, `workspace-bridge-admin` (plan s.4.1).

`register.ts` wraps every handler in this order: per-grant rate check, `approval.when` (if true, store a pending action and return its preview), handler, error mapping. An approved pending action later runs the same handler from `/approvals/:id` with a context built from the stored grant.

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
  accounts: AccountResolver; // resolve(selector, idPrefix?) -> AccountRef[]
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

`grantId` is the middle segment of the bearer token (OP:1686), read in one function with its own test. If the format changes, `unwrapToken()` (OP:1338) is the fallback at the cost of a KV read.

### 3.3 Errors

Handlers throw `ToolError(code, message, details?)`. The wrapper returns `{ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code, message, ...details } }) }] }`. Any other exception becomes `internal` with a generic message, so Google error bodies and stack traces never reach the client (the SDK would pass the raw message through, SDKJ:1785). Success is one text block of compact JSON; no `structuredContent` in v1, since there are no output schemas.

| Code                                                     | Raised by                                                                                 | Client sees                                                   | HTTP |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---- |
| (missing or bad token, wrong audience)                   | RS, before MCP                                                                            | `WWW-Authenticate: Bearer ... resource_metadata=`             | 401  |
| `insufficient_scope`                                     | RS (no scope for this endpoint); `scopeChallenge` (registered tool, scope missing)        | `WWW-Authenticate: Bearer error="insufficient_scope", scope=` | 403  |
| (tool not on this endpoint)                              | SDK                                                                                       | JSON-RPC error `InvalidParams`                                | 200  |
| `invalid_argument`                                       | our checks: cursor mismatch, id and account disagree, bad combination                     | tool error                                                    | 200  |
| `account_not_found`, `ambiguous_account`                 | `AccountResolver`                                                                         | tool error, `{ accountsUrl }`                                 | 200  |
| `component_disabled`                                     | `ctx.use`: component off for the account                                                  | tool error, `{ component, accountsUrl }`                      | 200  |
| `not_supported_by_provider`                              | `ctx.use`: no binding                                                                     | tool error, `{ capability, provider }`                        | 200  |
| `needs_relink`                                           | broker `invalid_grant`; Google 401 after one refresh; Google 403 insufficient permissions | tool error, `{ linkUrl }`                                     | 200  |
| `rate_limited`                                           | `ctx.limits`; Google 429 or rate-limit 403                                                | tool error, `{ retryAfterSeconds }`                           | 200  |
| `send_disabled`                                          | kill switch or `SEND_ENABLED=false`                                                       | tool error                                                    | 200  |
| `sender_not_allowed`, `too_many_recipients`, `too_large` | sendAs, `MAX_RECIPIENTS`, `MAX_*_BYTES`                                                   | tool error                                                    | 200  |
| `not_found`                                              | Google 404                                                                                | tool error                                                    | 200  |
| `upstream_error`                                         | Google 5xx after one retry                                                                | tool error, `{ status }`                                      | 200  |
| `internal`                                               | anything else                                                                             | tool error, generic message                                   | 200  |

An approval is not an error: the tool returns `{ status: 'pending_approval', pendingActionId, approvalUrl, preview, expiresAt }` without `isError`. HTTP 429 appears only on `/oauth/register` (DCR limit per `CF-Connecting-IP`, plan s.4.1), with `Retry-After: 60` and body `{ "error": "temporarily_unavailable", ... }`. The SDK rejects zod failures before the handler runs; M5 pins the exact result shape with a test.

**Deviation from plan (s.10.6 test).** A forged `send_message` call on `/mcp/ro` returns `InvalidParams` "Tool not found", not 403: the tool is not registered there (SDKJ:1777), and a 403 would invite a step-up that can never succeed on that endpoint.

### 3.4 Account-scoped ids

Every returned id that belongs to one account is prefixed with the account's short id: `a<shortId>:<providerId>`, matched by `^a([1-9][0-9]{0,8}):(.+)$` and split at the first `:` only (People ids contain `/`, calendar ids `@`). `shortId` is a per-owner integer from `owners.next_short_id`, never reused after unlink and never the label, so renaming `work` cannot send a follow-up call to another mailbox.

A prefixed id selects its account. A bare id needs `account`, else the default account applies. A prefixed id plus a different `account` is `invalid_argument`. Prefixed: thread, message, draft, label, attachment, filter, calendar, event, file, contact. Not prefixed: `pendingActionId` (`pa_` plus random, owner-scoped).

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

| Capability         | Interface and methods                                                                                                                            | M   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | --- |
| `mail.read`        | `MailReader`: `search(a, q)`, `getThread(a, id, BodyOpts)`, `getMessage(a, id, BodyOpts)`                                                        | M10 |
| `mail.labels`      | `LabelService`: above                                                                                                                            | M11 |
| `mail.state`       | `MailStateService`: `setState(a, target, { archived?, read?, starred?, spam?, trashed? })`                                                       | M12 |
| `mail.drafts`      | `DraftService`: `create`, `get`, `list`, `update`, `remove`                                                                                      | M13 |
| `mail.sendas`      | `SendAsService`: `list(a)`                                                                                                                       | M14 |
| `mail.send`        | `SendService`: `send(a, OutgoingMessage)`, `sendDraft(a, draftId)`                                                                               | M15 |
| `mail.attachments` | `AttachmentService`: `get(a, messageId, attachmentId, maxBytes)`                                                                                 | M16 |
| `mail.filters`     | `FilterService`: `list`, `create`, `remove`                                                                                                      | M17 |
| `calendar`         | `CalendarService`: `listCalendars`, `listEvents`, `searchEvents`, `getEvent`, `createEvent`, `updateEvent`, `deleteEvent`, `respond`, `freeBusy` | M18 |
| `files.read`       | `FileReader`: `search`, `recent`, `metadata`, `readText`, `download`, `permissions`                                                              | M19 |
| `files.write`      | `FileWriter`: `create`, `update`, `copy`, `share`, `trash`                                                                                       | M20 |
| `contacts`         | `ContactService`: `search`, `get`                                                                                                                | M21 |
| `admin.directory`  | `DirectoryAdminService`: users, aliases, groups, members, domains                                                                                | A1  |

```ts
// Design. src/providers/registry.ts and src/core/token-broker.ts
export interface Provider {
  id: ProviderId;
  scopesFor(c: readonly Component[]): string[];
  get<T>(cap: Capability<T>): T | undefined;
}
export interface TokenBroker {
  accessToken(a: AccountRef): Promise<string>; // refresh tokens never leave it
  invalidate(a: AccountRef): void;
}
```

`ctx.use(cap, a)` checks, in order: the capability's component is on for the account (`component_disabled`), the account's provider has a binding (`not_supported_by_provider`); then it returns the implementation.

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

`wrap` strips zero-width and bidi controls (U+200B-U+200F, U+202A-U+202E, U+2060-U+2069, U+FEFF), replaces `/<(\/?)untrusted/gi` with `&lt;$1untrusted`, escapes attribute values, and returns `<untrusted-NONCE source="email" account="a1" from="...">...</untrusted-NONCE>`. Tools with `untrusted: true` get the fixed `UNTRUSTED_NOTE` appended to their description. Required unit test: a body containing `</untrusted>` or a guessed `</untrusted-...>` stays inside one block.

## 4. D1 schema outline

`migrations/0001_auth.sql` (M4) and `0002_core.sql` (M6). Times are Unix seconds. Every row is keyed by owner, directly or through `accounts`, except sign-in `flow_states`, `rate_counters` (keyed by bucket) and a refused sign-in in `audit_log`. Foreign keys cascade from `owners` and `accounts`; `audit_log` has none, so it outlives an unlink. All tables are `STRICT`.

| Table              | Columns (key first)                                                                                                                                                                                                                                                                                                 | Notes                                                                                                                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `owners`           | `id` PK (`o_` + 16 base32, no `:`), `default_account_id`, `send_kill_switch`, `next_short_id`, `created_at`                                                                                                                                                                                                         | One row in v1.                                                                                                                                                                                                                                                           |
| `owner_identities` | `email` PK (lowercase), `owner_id`, `sub` (NULL until pinned), `pinned_at`, `last_login_at`; UNIQUE(`sub`)                                                                                                                                                                                                          | `sub` is written only while `SETUP_MODE=true` (`UPDATE ... WHERE sub IS NULL`). After that, a missing or different `sub` is refused.                                                                                                                                     |
| `flow_states`      | `id` PK = sha256(state), `kind` (signin, link), `payload` JSON (PKCE verifier, nonce, returnTo, or owner, label, components), `binding` (hash of the flow cookie), `expires_at`                                                                                                                                     | Consumed with `DELETE ... RETURNING`; 10 min.                                                                                                                                                                                                                            |
| `accounts`         | `id` PK (`ac_` + 16 base32), `owner_id`, `short_id`, `label`, `address` (lowercase), `provider`, `provider_sub`, `components` JSON, `granted_scopes`, `status` (ok, needs_relink), `send_as_fetched_at`, `created_at`, `updated_at`; UNIQUE(`owner_id`, `short_id`), (`owner_id`, `label`), (`owner_id`, `address`) | No token columns. `insertAccount` takes `short_id` from `owners.next_short_id` in one batch, so a failed insert uses none. `provider`, `status` and label rules beyond non-empty are checked in TypeScript. Unlink clears `owners.default_account_id` in the same batch. |
| `account_tokens`   | (`account_id`, `kind`) PK with kind refresh or access, `ciphertext` BLOB (tag included), `iv` BLOB (12 bytes), `key_version`, `expires_at`, `updated_at`                                                                                                                                                            | AES-256-GCM, AAD `ownerId\|accountId\|kind`, fresh IV per seal; `open()` uses the row's `key_version`; version 1 uses `TOKEN_KEK`, version N uses `TOKEN_KEK_vN`; re-encrypted on the next refresh after `CURRENT_KEY_VERSION` moves.                                    |
| `send_as`          | (`account_id`, `email` lowercase) PK, `display_name`, `is_default`, `is_primary`, `verification_status`, `reply_to`                                                                                                                                                                                                 | Refreshed on link and after 24 h.                                                                                                                                                                                                                                        |
| `audit_log`        | `id` INTEGER PK, `at`, `owner_id` (NULL for a refused sign-in), `account_id`, `tool`, `client_id`, `grant_id`, `from_addr`, `to_addrs`, `cc_addrs`, `bcc_addrs`, `subject`, `provider_ref`, `result`, `detail`; INDEX(`owner_id`, `at`)                                                                             | No bodies. Also refused sign-ins (email hash, country). 365-day retention.                                                                                                                                                                                               |
| `rate_counters`    | (`bucket`, `window_start`) PK, `count`                                                                                                                                                                                                                                                                              | One `INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count`; buckets `send:h:<accountId>`, `send:d:<accountId>`, `calls:m:<grantId>`.                                                                                                                   |
| `pending_actions`  | `id` PK (`pa_...`), `owner_id`, `tool`, `account_id`, `params` JSON, `preview` JSON, `client_id`, `grant_id`, `status` (pending, approved, rejected, expired, executed, failed), `created_at`, `expires_at` (+24 h), `decided_at`, `result` JSON; INDEX(`owner_id`, `created_at`), INDEX(`account_id`)              | Decided only on `/approvals/:id` with an owner session and CSRF token, so an MCP token cannot approve.                                                                                                                                                                   |

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

- **Runner.** `vitest` with `cloudflareTest()` from `@cloudflare/vitest-plugin` and the committed `wrangler.example.jsonc` (the scaffold's `vitest.config.ts`). M4 switches to the function form to add test bindings through `miniflare.bindings` (VP:33-37, 87; s.1.6): `PUBLIC_URL=https://mcp.example.com`, `OWNER_CONTACT=privacy@example.com`, `OWNER_EMAILS=owner@example.com,owner2@example.com`, fixed test `TOKEN_KEK` and `COOKIE_SECRET`, `GOOGLE_CLIENT_ID=test-client`.
- **D1.** `vitest.config.ts` calls `readD1Migrations('./migrations')` (VP:113) and passes the result as a `TEST_MIGRATIONS` binding; a `setupFiles` entry calls `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)` (VT:211-215). Tests create their own owner and account ids: storage is not rolled back between tests. `reset()` (VT:94) drops the applied tables and `d1_migrations` too (s.1.6), so a test that uses it re-applies migrations afterwards.
- **Fake Google** (`test/helpers/google.ts`). `vi.spyOn(globalThis, 'fetch')` with a route table keyed by method and URL prefix: `oauth2.googleapis.com/token`, `gmail.googleapis.com`, `www.googleapis.com/batch/gmail/v1`, `www.googleapis.com/calendar/v3`, `www.googleapis.com/drive/v3`, `people.googleapis.com`. An unmatched request throws, so no test reaches the network. Each family adds `test/fixtures/google/<family>.json`. Error cases per tool: 401 then refresh and one retry, 403 insufficient permissions, 404, 429, 500.
- **Google sign-in.** The fake token endpoint returns an ID token with test claims. The ID token comes straight from Google's token endpoint over TLS, so `google-oidc.ts` checks `iss`, `aud`, `exp`, `nonce` and `email_verified` and skips the signature (OpenID Connect Core 1.0, s.3.1.3.7, item 6). That also avoids a JWKS fetch and RSA work inside the CPU budget.
- **MCP tokens** (`test/helpers/tokens.ts`). `mintToken({ kind, scopes, ownerId })`: `getOAuthApi(env).createClient()` with a public client and a redirect URI on `client.example.com` (OP:1286); an `/authorize` request with PKCE S256 and `resource=resourceUrl(kind, issuer)`; `parseAuthRequest` (OP:1209); `completeAuthorization` with the scopes and `props: { ownerId }` (OP:1224); then the code exchange at `/oauth/token` through `exports.default.fetch`. The real token and audience code runs; nothing in the OAuth library is stubbed. `authorizeCode(options)` and `exchangeCode(code, { verifier })` expose the two halves for PKCE tests (`verifier: null` omits `code_verifier`).
- **MCP calls** (`test/helpers/mcp.ts`). `mcpCall(token, kind, method, params)` posts JSON-RPC to `PATH[kind]` through `exports.default.fetch`. M5's first test pins the request headers the stateless handler requires.
- **Required auth tests (M4, M5, M14).** No token gives 401 with `resource_metadata`. A token for `/mcp` gets 401 at `/mcp/ro` and `/mcp/admin`, and the reverse. Both owner addresses reach the same owner. After setup mode, an unpinned email and a pinned email with a different `sub` are refused (403 page, no cookie, no grant). Missing PKCE gives 400. A grant without `mail.send` does not see `send_message` in `tools/list` and gets 403 `insufficient_scope` when it calls it. On `/mcp/ro`, `send_message` is not listed and a forged call returns `InvalidParams`. An MCP token cannot approve a pending action. M4a covers the 401, audience, PKCE and RS 403 tests; M4b the owner tests.
- **Unit.** Crypto round trip and AAD mismatch, ids, cursors, untrusted wrapping, MIME, sendAs check, rate counters, scope clamping, registry load-time checks.
- **CI.** The scaffold's `typecheck`, `lint` and `test` scripts; no network, no real secrets.

## 7. Build order (M4-M21)

**Family rule.** M5 writes `src/tools/index.ts` with one import per family and creates every family file as an empty `Family` (s.5). A family milestone then edits only its own `tools/<family>.ts`, `services/<cap>.ts`, `providers/google/<cap>.ts`, `test/<family>.test.ts` and `test/fixtures/google/<family>.json`, and changes no shared line. A family added after M5 adds exactly one line to `src/tools/index.ts`.

| M   | Scope                                                                                    | Files owned                                                                                                                                                                                                                                                              | Depends on    | Parallel with                     |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | --------------------------------- |
| M4a | AS, three RS, metadata, CIMD, DCR and its rate limit, pages, sign-in placeholders        | `src/index.ts`, `env.ts`, `auth/{endpoints,server}.ts`, placeholder `auth/{mcp-factory,consent,callback}.ts`, `web/{app,html,public}.ts`, `core/{crypto,db}.ts`, `migrations/0001_auth.sql`, `vitest.config.ts`, `test/helpers/tokens.ts`, `wrangler.example.jsonc` vars | M3            | none                              |
| M4b | Google sign-in, owner identities, session, consent and callback bodies                   | `auth/{google-oidc,owners,session,flow-state}.ts`, `auth/{consent,callback}.ts` (bodies), `test/helpers/{google,session}.ts`                                                                                                                                             | M4a           | M5, M6                            |
| M5  | `/mcp` handler, registry, `whoami`, parity test                                          | `auth/mcp-factory.ts`, `registry/*`, `core/errors.ts`, `tools/index.ts`, every family stub, `tools/meta.ts`, `test/parity.test.ts`, `test/helpers/mcp.ts`                                                                                                                | M4a           | M4b, M6, M7, M8                   |
| M6  | Core schema, AES-GCM                                                                     | `migrations/0002_core.sql`, `core/crypto.ts` (seal, open), `core/db.ts` (rows), `test/core.test.ts`                                                                                                                                                                      | M4a           | M4b, M5                           |
| M7  | Link flow, `/accounts`, components, unlink                                               | `auth/link.ts`, `auth/callback.ts` (link branch), `web/accounts.ts` + one `web/app.ts` line, `providers/google/base.ts`                                                                                                                                                  | M4b, M6       | M5, M8, M9                        |
| M8  | Token broker                                                                             | `core/token-broker.ts`                                                                                                                                                                                                                                                   | M6            | M5, M7                            |
| M9  | Services, providers, resolution, ids, cursors, untrusted, guardrail stubs, account tools | `services/{capability,types}.ts`, `providers/registry.ts`, `providers/google/http.ts`, `core/{accounts,ids,cursor,untrusted,send-as,audit,ratelimit,pending}.ts`, `registry/context.ts`, `tools/account.ts`                                                              | M5, M6, M8    | M7                                |
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

Planned exceptions to the family rule: M14 replaces the bodies of the M9 stubs without changing signatures; M16 edits `core/mime.ts` and `tools/mail-common.ts` after M13 and M15 have landed; M7 fills the link branch that M4b leaves as one dispatch line in `auth/callback.ts`. M4b replaces the bodies of the M4a placeholders in `auth/consent.ts` and `auth/callback.ts`, and M5 the body of `mcpHandler` in `auth/mcp-factory.ts`, without changing signatures. Page modules each add one `app.route()` line to `web/app.ts`.

**Deviation from plan (order).** Plan M4 comes before the D1 milestone (M6), but owner `sub` pinning and sign-in state need storage, so M4 creates the auth tables (`0001_auth.sql`) and M6 the rest. M4 also builds all three resource servers (plan M14 adds `/mcp/ro`), since M4's audience test already spans the three; M14 keeps the no-send tests. `core/untrusted.ts` moves from M10 to M9 so calendar, drive and contacts do not wait for mail.

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

Limits (plan s.3.4): 10 ms CPU per request, 50 subrequests, 128 MB, 100k requests a day; time spent waiting on the network is not CPU time.

- **A server per request.** The factory runs once per HTTP request (SDK:3876-3894), so the per-request work must stay small: construct `McpServer`, call `registerTool` for the endpoint's tools (about 60 on `/mcp`), install the `tools/list` override. Everything else is module scope and runs once per isolate: the AS and RS objects (`getAuth`, memoised as at wb-proto:55-76), compiled schemas and frozen `Tool` objects, the `listFor` memo, parsed config, and `preloadSchemas()` (SDK:2786-2799).
- **No schema work per request.** `precomputed()` returns the module-scope JSON Schema, so the SDK's lazy conversion (SDKJ:1679-1690) is a lookup, and `tools/list` returns a frozen array without touching zod. Zod validation runs only for the tool called.
- **Memo size.** `listFor` keys on kind plus sorted granted scopes: a few dozen entries per isolate at most.
- **Fallback.** If M22 measures registration over budget, switch to plan s.3.4's option: a low-level server whose `tools/list` returns `listFor()` and whose `tools/call` looks the tool up in a map and runs the same wrapper. The SDK's 403 challenge then no longer applies, so the RS handler reads `params.name` from a clone of each `tools/call` body and returns `insufficientScope()` (OP:597) when the grant lacks the tool's scopes. Only `mcp-factory.ts`, `register.ts` and `auth/server.ts` change; families do not.
- **Subrequests.** A tool call costs the library's KV token lookup, D1 reads for the account and its token (the access token is also cached in isolate memory for its lifetime), and Google fetches. `account: "all"` stays at 2 Google subrequests per account (list plus one batch), with at most 25 results per account.
- **KV writes.** The 1,000 writes a day cap is why MCP access tokens last 4 h and Google tokens stay out of KV; counters and audit rows go to D1.
- **Crypto.** HMAC, SHA-256 and AES-GCM are native WebCrypto; sign-in does no JWKS or RSA work (s.6).
- **Cleanup.** A daily `scheduled` handler (M14) expires pending actions and flow states, trims rate counters and old audit rows, and calls the library's `purgeExpiredData()` (OP:1347) in small batches.

## 9. Open items

- M14: the Free plan accepts the `ratelimits` binding (M3 deploy) and miniflare emulates it (s.1.6), so M4a uses it for DCR; the live limiter has not been tripped. Decide whether the per-grant limit uses it or the D1 `rate_counters` (s.4).
- M5: pin the SDK's result for a zod failure and the stateless handler's required request headers.
- M22: measure per-request registration CPU and decide on the fallback in s.8.
