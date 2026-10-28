import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  ALL_SCOPES,
  endpointScopes,
  KINDS,
  type Kind,
  PATH,
  resourceUrl,
  SCOPES,
  SERVER_NAME,
} from "../src/auth/endpoints";
import { base32, hex, hmacSha256, randomId, sha256Hex, timingSafeEqual } from "../src/core/crypto";
import { mcpRpc, toolJson } from "./helpers/mcp";
import { authorizeCode, exchangeCode, mintToken, REDIRECT_URI } from "./helpers/tokens";

const ISSUER = "https://mcp.example.com";
const prm = (kind: Kind) => `${ISSUER}/.well-known/oauth-protected-resource${PATH[kind]}`;

function call(path: string, token?: string): Promise<Response> {
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return exports.default.fetch(new Request(ISSUER + path, { method: "POST", headers }));
}

describe("authorization server metadata", () => {
  it("emits the RFC 8414 fields and the RFC 9207 iss flag", async () => {
    const res = await exports.default.fetch(`${ISSUER}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const meta = await res.json<Record<string, unknown>>();
    // The full field list this library version emits, recorded for M4a.
    expect(Object.keys(meta).sort()).toEqual([
      "authorization_endpoint",
      "authorization_response_iss_parameter_supported",
      "client_id_metadata_document_supported",
      "code_challenge_methods_supported",
      "grant_types_supported",
      "issuer",
      "protected_resources",
      "registration_endpoint",
      "response_modes_supported",
      "response_types_supported",
      "revocation_endpoint",
      "scopes_supported",
      "token_endpoint",
      "token_endpoint_auth_methods_supported",
      "token_endpoint_auth_signing_alg_values_supported",
    ]);
    expect(meta).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/oauth/token`,
      registration_endpoint: `${ISSUER}/oauth/register`,
      scopes_supported: [...ALL_SCOPES],
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
      protected_resources: KINDS.map((k) => resourceUrl(k, ISSUER)),
    });
  });
});

describe("protected resource metadata", () => {
  it.each(KINDS)("serves RFC 9728 metadata for %s", async (kind) => {
    const res = await exports.default.fetch(prm(kind));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      resource: resourceUrl(kind, ISSUER),
      authorization_servers: [ISSUER],
      scopes_supported: [...SCOPES[kind]],
      resource_name: SERVER_NAME[kind],
    });
  });
});

describe("resource servers", () => {
  it.each(KINDS)("challenges %s without a token: 401 with resource_metadata", async (kind) => {
    const res = await call(PATH[kind]);
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain(`resource_metadata="${prm(kind)}"`);
  });

  const cases = KINDS.flatMap((tokenKind) => KINDS.map((at) => ({ tokenKind, at })));
  it.each(cases)(
    "a $tokenKind token at $at works only at its own endpoint",
    async ({ tokenKind, at }) => {
      const ownerId = randomId("o_");
      const token = await mintToken({ kind: tokenKind, scopes: SCOPES[tokenKind], ownerId });
      if (tokenKind === at) {
        const res = await mcpRpc(token, at, "tools/call", { name: "whoami", arguments: {} });
        expect(toolJson(res.result)).toMatchObject({ kind: at, ownerId, scopes: [...SCOPES[at]] });
      } else {
        const res = await call(PATH[at], token);
        expect(res.status).toBe(401);
        expect(res.headers.get("WWW-Authenticate")).toContain(`resource_metadata="${prm(at)}"`);
      }
    },
  );

  it("answers 403 insufficient_scope when the grant holds none of the endpoint's scopes", async () => {
    const admin = await mintToken({
      kind: "admin",
      scopes: ["mail.read"],
      ownerId: randomId("o_"),
    });
    const res = await call(PATH.admin, admin);
    expect(res.status).toBe(403);
    const challenge = res.headers.get("WWW-Authenticate") ?? "";
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="admin"');
    expect(challenge).toContain(`resource_metadata="${prm("admin")}"`);
    expect(await res.json()).toMatchObject({ error: "insufficient_scope" });

    const ro = await mintToken({ kind: "ro", scopes: ["mail.send"], ownerId: randomId("o_") });
    const roRes = await call(PATH.ro, ro);
    expect(roRes.status).toBe(403);
    expect(roRes.headers.get("WWW-Authenticate")).toContain(`scope="${SCOPES.ro.join(" ")}"`);
  });

  it("passes only the endpoint's scopes to the MCP layer", async () => {
    const ownerId = randomId("o_");
    const token = await mintToken({ kind: "ro", scopes: [...ALL_SCOPES], ownerId });
    const res = await mcpRpc(token, "ro", "tools/call", { name: "whoami", arguments: {} });
    expect(toolJson(res.result)).toMatchObject({ kind: "ro", ownerId, scopes: [...SCOPES.ro] });
  });

  it("keeps only the endpoint's own scopes", () => {
    expect(endpointScopes("ro", ["mail.send", "files", "admin", "mail.read"])).toEqual([
      "mail.read",
      "files",
    ]);
    expect(endpointScopes("admin", ["mail.read"])).toEqual([]);
    expect(SCOPES.ro).not.toContain("mail.send");
  });
});

describe("token endpoint", () => {
  it("refuses a code exchange without the PKCE verifier", async () => {
    const code = await authorizeCode({
      kind: "full",
      scopes: ["mail.read"],
      ownerId: randomId("o_"),
    });
    const res = await exchangeCode(code, { verifier: null });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });

  it("refuses a code exchange with the wrong PKCE verifier", async () => {
    const code = await authorizeCode({
      kind: "full",
      scopes: ["mail.read"],
      ownerId: randomId("o_"),
    });
    const res = await exchangeCode(code, { verifier: "x".repeat(64) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
  });
});

describe("dynamic client registration", () => {
  const register = (ip: string) =>
    exports.default.fetch(
      new Request(`${ISSUER}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json", "CF-Connecting-IP": ip },
        body: JSON.stringify({
          redirect_uris: [REDIRECT_URI],
          client_name: "dcr test",
          token_endpoint_auth_method: "none",
        }),
      }),
    );

  it("registers a client", async () => {
    const res = await register("192.0.2.1");
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ client_id: expect.any(String) });
  });

  // Miniflare emulates the ratelimits binding from wrangler.example.jsonc (10 per 60 s).
  it("answers 429 once the DCR_LIMIT binding trips, per client IP", async () => {
    for (let i = 0; i < 10; i++) expect((await register("192.0.2.2")).status).toBe(201);
    const res = await register("192.0.2.2");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(await res.json()).toMatchObject({ error: "temporarily_unavailable" });
    expect((await register("192.0.2.3")).status).toBe(201);
  });
});

describe("core helpers and auth tables", () => {
  it("makes owner ids the auth tables accept", async () => {
    const id = randomId("o_");
    expect(id).toMatch(/^o_[a-z2-7]{16}$/);
    await env.DB.prepare("INSERT INTO owners (id, created_at) VALUES (?, 0)").bind(id).run();
    await expect(
      env.DB.prepare("INSERT INTO owners (id, created_at) VALUES (?, 0)")
        .bind("o_aaaaaaaa:aaaaaaa")
        .run(),
    ).rejects.toThrow();
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('owners', 'owner_identities', 'flow_states') ORDER BY name",
    ).all<{ name: string }>();
    expect(tables.results.map((t) => t.name)).toEqual([
      "flow_states",
      "owner_identities",
      "owners",
    ]);
  });

  it("hashes, signs and compares", async () => {
    expect(base32(new TextEncoder().encode("foobar"))).toBe("mzxw6ytboi");
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    // RFC 4231 test case 2.
    expect(hex(await hmacSha256("Jefe", "what do ya want for nothing?"))).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
    expect(timingSafeEqual("same", "same")).toBe(true);
    expect(timingSafeEqual("same", "sane")).toBe(false);
    expect(timingSafeEqual("same", "longer")).toBe(false);
  });
});
