// M8: Google token broker (ARCHITECTURE s.3.6). Google's token endpoint is faked with
// vi.spyOn(globalThis, "fetch"); an unexpected request throws, so nothing reaches the network.

import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { GOOGLE_TOKEN_URL } from "../src/auth/google-oidc";
import { open, randomBytes, randomId, type SealAad, type Sealed, seal } from "../src/core/crypto";
import { getToken, insertAccount, nowSeconds, upsertToken } from "../src/core/db";
import { type BrokerAccount, createTokenBroker } from "../src/core/token-broker";
import type { Env } from "../src/env";
import { GOOGLE_CLIENT_SECRET as CLIENT_SECRET, GOOGLE_CLIENT_ID } from "./helpers/google";

const LINK_URL = "https://mcp.example.com/accounts";

/** The test env with some values replaced (undefined removes one). */
const envWith = (overrides: Record<string, string | undefined> = {}): Env =>
  ({ ...env, ...overrides }) as Env;
const ENV = envWith();

const randomKey = (): string => btoa(String.fromCharCode(...randomBytes(32)));
const refreshTokenValue = (): string => `1//${randomId("rt-")}`;
const accessTokenValue = (): string => `ya29.${randomId("at-")}`;

// Fake Google token endpoint: each POST takes the next queued reply.
type Reply = Response | Error | ((form: URLSearchParams) => Response | Promise<Response>);
let replies: Reply[] = [];
let forms: URLSearchParams[] = [];
let fetchSpy: MockInstance<typeof fetch>;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const granted = (access_token: string, extra: Record<string, unknown> = {}): Response =>
  json(200, { access_token, expires_in: 3599, token_type: "Bearer", scope: "openid", ...extra });
const invalidGrant = (): Response =>
  json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });

beforeEach(() => {
  replies = [];
  forms = [];
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    if (req.method !== "POST" || req.url !== GOOGLE_TOKEN_URL) {
      throw new Error(`unexpected request ${req.method} ${req.url}`);
    }
    expect(req.headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(new TextDecoder().decode(await req.arrayBuffer()));
    forms.push(form);
    const reply = replies.shift();
    if (!reply) throw new Error("no fake Google reply queued");
    if (reply instanceof Error) throw reply;
    return typeof reply === "function" ? reply(form) : reply;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface Linked {
  a: BrokerAccount;
  refreshToken: string;
  accessToken: string;
}

async function newOwner(): Promise<string> {
  const id = randomId("o_");
  await env.DB.prepare("INSERT INTO owners (id, created_at) VALUES (?, 0)").bind(id).run();
  return id;
}

/**
 * A linked Google account with a sealed refresh token and, unless `accessExpiresIn` is null, a
 * sealed access token expiring that many seconds from now.
 */
async function link(
  opts: { ownerId?: string; label?: string; accessExpiresIn?: number | null; keys?: Env } = {},
): Promise<Linked> {
  const ownerId = opts.ownerId ?? (await newOwner());
  const label = opts.label ?? "work";
  const account = await insertAccount(env.DB, {
    ownerId,
    label,
    address: `${label}@example.com`,
    provider: "google",
  });
  if (!account) throw new Error("account insert failed");
  const a: BrokerAccount = { ownerId, accountId: account.id };
  const keys = opts.keys ?? ENV;
  const refreshToken = refreshTokenValue();
  const accessToken = accessTokenValue();
  await upsertToken(env.DB, {
    accountId: a.accountId,
    kind: "refresh",
    sealed: await seal(refreshToken, aad(a, "refresh"), keys),
  });
  const expiresIn = opts.accessExpiresIn === undefined ? 3600 : opts.accessExpiresIn;
  if (expiresIn !== null) {
    await upsertToken(env.DB, {
      accountId: a.accountId,
      kind: "access",
      sealed: await seal(accessToken, aad(a, "access"), keys),
      expiresAt: nowSeconds() + expiresIn,
    });
  }
  return { a, refreshToken, accessToken };
}

const aad = (a: BrokerAccount, kind: SealAad["kind"]): SealAad => ({ ...a, kind });

const status = async (a: BrokerAccount): Promise<string | undefined> =>
  (
    await env.DB.prepare("SELECT status FROM accounts WHERE id = ?")
      .bind(a.accountId)
      .first<{ status: string }>()
  )?.status;

/** `env.DB` behind a proxy that records every statement prepared and every batch. */
function spyDb(base: Env = ENV): { env: Env; sql: string[]; batches: string[][] } {
  const sql: string[] = [];
  const batches: string[][] = [];
  // Wrapped statement -> [real statement, its SQL]; `bind()` returns a new statement.
  const wrapped = new WeakMap<D1PreparedStatement, [D1PreparedStatement, string]>();
  const wrap = (statement: D1PreparedStatement, query: string): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, prop) {
        if (prop === "bind") {
          return (...values: unknown[]) => wrap(target.bind(...values), query);
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    wrapped.set(proxy, [statement, query]);
    return proxy;
  };
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (query: string) => {
          sql.push(query);
          return wrap(target.prepare(query), query);
        };
      }
      if (prop === "batch") {
        return (statements: D1PreparedStatement[]) => {
          batches.push(statements.map((s) => wrapped.get(s)?.[1] ?? ""));
          return target.batch(statements.map((s) => wrapped.get(s)?.[0] ?? s));
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { env: { ...base, DB: db } as Env, sql, batches };
}

const writes = (sql: readonly string[]): string[] =>
  sql.filter((q) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(q));

async function caught(p: Promise<unknown>): Promise<Error & { code?: string; details?: unknown }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Error) return e;
    throw new Error(`expected an Error, got ${String(e)}`);
  }
  throw new Error("expected a rejection");
}

describe("token broker: cache layers", () => {
  it("serves a token from isolate memory without reading D1", async () => {
    const { a, accessToken } = await link();
    expect(await createTokenBroker(ENV).accessToken(a)).toBe(accessToken);

    const spy = spyDb();
    expect(await createTokenBroker(spy.env).accessToken(a)).toBe(accessToken);
    expect(spy.sql).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses a D1 access token that is not expiring without calling Google", async () => {
    const { a, accessToken } = await link({ accessExpiresIn: 3600 });
    // No Google client secret is needed while no refresh is.
    const spy = spyDb(envWith({ GOOGLE_CLIENT_SECRET: undefined }));
    expect(await createTokenBroker(spy.env).accessToken(a)).toBe(accessToken);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(spy.sql).toHaveLength(1);
    expect(spy.sql[0]).toMatch(/^SELECT \* FROM account_tokens/);
    expect(writes(spy.sql)).toEqual([]);
  });

  it("refreshes a token expiring within 5 minutes and stores the new one sealed", async () => {
    const { a, refreshToken } = await link({ accessExpiresIn: 299 });
    const refreshBefore = await getToken(env.DB, a.accountId, "refresh");
    const fresh = accessTokenValue();
    replies.push(granted(fresh));

    const spy = spyDb();
    expect(await createTokenBroker(spy.env).accessToken(a)).toBe(fresh);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(Object.fromEntries(forms[0] ?? [])).toEqual({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
    // One write: a single batch holding only the access token.
    expect(spy.batches).toHaveLength(1);
    expect(writes(spy.batches[0] ?? [])).toHaveLength(1);
    expect(writes(spy.sql)).toHaveLength(1);

    const row = await getToken(env.DB, a.accountId, "access");
    expect(row?.key_version).toBe(1);
    expect(row?.expires_at).toBeGreaterThanOrEqual(nowSeconds() + 3590);
    expect(row?.expires_at).toBeLessThanOrEqual(nowSeconds() + 3599);
    expect(new TextDecoder().decode(row?.ciphertext)).not.toContain(fresh);
    expect(await open(row as Sealed, aad(a, "access"), ENV)).toBe(fresh);
    // The refresh row was not rewritten.
    expect((await getToken(env.DB, a.accountId, "refresh"))?.iv).toEqual(refreshBefore?.iv);

    // The next call is a memory hit.
    expect(await createTokenBroker(ENV).accessToken(a)).toBe(fresh);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("shares one refresh among concurrent calls in the isolate", async () => {
    const { a } = await link({ accessExpiresIn: null });
    const fresh = accessTokenValue();
    replies.push(granted(fresh));

    const spy = spyDb();
    const brokers = [createTokenBroker(spy.env), createTokenBroker(spy.env)];
    const tokens = await Promise.all(
      Array.from({ length: 6 }, (_, i) => brokers[i % 2]?.accessToken(a)),
    );
    expect(tokens).toEqual(Array(6).fill(fresh));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(spy.batches).toHaveLength(1);
  });

  it("stores a rotated refresh token and uses it on the next refresh", async () => {
    const { a } = await link({ accessExpiresIn: 0 });
    const rotated = refreshTokenValue();
    replies.push(granted(accessTokenValue(), { refresh_token: rotated }));

    const spy = spyDb();
    const broker = createTokenBroker(spy.env);
    await broker.accessToken(a);
    expect(spy.batches).toHaveLength(1);
    expect(writes(spy.batches[0] ?? [])).toHaveLength(2);
    const row = await getToken(env.DB, a.accountId, "refresh");
    expect(await open(row as Sealed, aad(a, "refresh"), ENV)).toBe(rotated);

    replies.push(granted(accessTokenValue()));
    broker.invalidate(a);
    await broker.accessToken(a);
    expect(forms[1]?.get("refresh_token")).toBe(rotated);
  });

  it("invalidate() makes the next call refresh although D1 holds the refused token", async () => {
    const { a, accessToken } = await link({ accessExpiresIn: 3600 });
    const broker = createTokenBroker(ENV);
    expect(await broker.accessToken(a)).toBe(accessToken);
    expect(fetchSpy).not.toHaveBeenCalled();

    // M9's Google client got a 401 with that token.
    const fresh = accessTokenValue();
    replies.push(granted(fresh));
    broker.invalidate(a);
    expect(await broker.accessToken(a)).toBe(fresh);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(
      await open((await getToken(env.DB, a.accountId, "access")) as Sealed, aad(a, "access"), ENV),
    ).toBe(fresh);
    // Back to normal: memory, no further refresh.
    expect(await broker.accessToken(a)).toBe(fresh);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("re-seals both rows under v2 on the first refresh after CURRENT_KEY_VERSION moves", async () => {
    const { a, refreshToken } = await link({ accessExpiresIn: 60 });
    expect((await getToken(env.DB, a.accountId, "refresh"))?.key_version).toBe(1);

    const rotatedKeys = envWith({ CURRENT_KEY_VERSION: "2", TOKEN_KEK_v2: randomKey() });
    const fresh = accessTokenValue();
    replies.push(granted(fresh));
    const spy = spyDb(rotatedKeys);
    expect(await createTokenBroker(spy.env).accessToken(a)).toBe(fresh);
    expect(spy.batches).toHaveLength(1);

    const refreshRow = await getToken(env.DB, a.accountId, "refresh");
    const accessRow = await getToken(env.DB, a.accountId, "access");
    expect(refreshRow?.key_version).toBe(2);
    expect(accessRow?.key_version).toBe(2);
    expect(await open(refreshRow as Sealed, aad(a, "refresh"), rotatedKeys)).toBe(refreshToken);
    expect(await open(accessRow as Sealed, aad(a, "access"), rotatedKeys)).toBe(fresh);
    await expect(open(refreshRow as Sealed, aad(a, "refresh"), ENV)).rejects.toThrow(
      /TOKEN_KEK_v2 is not set/,
    );
  });
});

describe("token broker: refused and failed refreshes", () => {
  it("marks the account needs_relink on invalid_grant and returns the link URL", async () => {
    const { a } = await link({ accessExpiresIn: 30 });
    replies.push(invalidGrant());
    const broker = createTokenBroker(ENV);

    const error = await caught(broker.accessToken(a));
    expect(error.code).toBe("needs_relink");
    expect(error.details).toEqual({ linkUrl: LINK_URL });
    expect(error.message).toContain(LINK_URL);
    expect(await status(a)).toBe("needs_relink");
    // The cached access token is gone; the refresh row stays for the audit of what happened.
    expect(await getToken(env.DB, a.accountId, "access")).toBeNull();
    expect(await getToken(env.DB, a.accountId, "refresh")).not.toBeNull();

    // Later calls fail the same way without asking Google again.
    const again = await caught(broker.accessToken(a));
    expect(again.code).toBe("needs_relink");
    expect(again.details).toEqual({ linkUrl: LINK_URL });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("leaves a second account of the same owner working", async () => {
    const ownerId = await newOwner();
    const revoked = await link({ ownerId, label: "work", accessExpiresIn: 0 });
    const healthy = await link({ ownerId, label: "home", accessExpiresIn: 0 });
    const fresh = accessTokenValue();
    replies.push(
      (form) =>
        form.get("refresh_token") === revoked.refreshToken ? invalidGrant() : granted(fresh),
      (form) =>
        form.get("refresh_token") === revoked.refreshToken ? invalidGrant() : granted(fresh),
    );
    const broker = createTokenBroker(ENV);

    const [first, second] = await Promise.allSettled([
      broker.accessToken(revoked.a),
      broker.accessToken(healthy.a),
    ]);
    expect(first.status).toBe("rejected");
    expect(second).toEqual({ status: "fulfilled", value: fresh });
    expect(await status(revoked.a)).toBe("needs_relink");
    expect(await status(healthy.a)).toBe("ok");
    expect(await broker.accessToken(healthy.a)).toBe(fresh);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not mark an account whose refresh token was replaced during the refresh", async () => {
    const { a } = await link({ accessExpiresIn: 0 });
    const relinked = refreshTokenValue();
    // A relink stores a new refresh token while Google is refusing the old one.
    replies.push(async () => {
      await upsertToken(env.DB, {
        accountId: a.accountId,
        kind: "refresh",
        sealed: await seal(relinked, aad(a, "refresh"), ENV),
      });
      return invalidGrant();
    });
    const error = await caught(createTokenBroker(ENV).accessToken(a));
    expect(error.code).toBe("upstream_error");
    expect(await status(a)).toBe("ok");
    const row = await getToken(env.DB, a.accountId, "refresh");
    expect(await open(row as Sealed, aad(a, "refresh"), ENV)).toBe(relinked);
  });

  it("maps network errors, 5xx and odd replies to upstream_error without a status change", async () => {
    const { a, refreshToken } = await link({ accessExpiresIn: 10 });
    const accessBefore = await getToken(env.DB, a.accountId, "access");
    const broker = createTokenBroker(ENV);
    const cases: [Reply, Record<string, unknown> | undefined][] = [
      [new TypeError("Network connection lost."), undefined],
      [json(503, { error: "backend_error" }), { status: 503 }],
      [new Response("<html>oops</html>", { status: 500 }), { status: 500 }],
      [json(200, { token_type: "Bearer" }), { status: 200 }],
      [json(200, { access_token: "ya29.x", expires_in: "soon" }), { status: 200 }],
      [json(401, { error: "invalid_grant" }), { status: 401 }],
      [
        new Response(null, { status: 302, headers: { Location: "https://example.com/" } }),
        { status: 302 },
      ],
    ];
    for (const [reply, details] of cases) {
      replies.push(reply);
      const error = await caught(broker.accessToken(a));
      expect(error.code).toBe("upstream_error");
      expect(error.details).toEqual(details);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(cases.length);
    expect(forms.every((f) => f.get("refresh_token") === refreshToken)).toBe(true);
    expect(await status(a)).toBe("ok");
    expect((await getToken(env.DB, a.accountId, "access"))?.iv).toEqual(accessBefore?.iv);

    // Google recovers: the next call refreshes normally.
    const fresh = accessTokenValue();
    replies.push(granted(fresh));
    expect(await broker.accessToken(a)).toBe(fresh);
  });

  it("reports a refused or missing Google client as an internal configuration error", async () => {
    const { a } = await link({ accessExpiresIn: 0 });
    replies.push(json(401, { error: "invalid_client", error_description: "Unauthorized" }));
    const refused = await caught(createTokenBroker(ENV).accessToken(a));
    expect(refused.code).toBe("internal");
    expect(refused.message).toMatch(/GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/);

    for (const missing of ["GOOGLE_CLIENT_SECRET", "GOOGLE_CLIENT_ID"]) {
      const error = await caught(
        createTokenBroker(envWith({ [missing]: undefined })).accessToken(a),
      );
      expect(error.code).toBe("internal");
      expect(error.message).toBe(
        `Google OAuth is not configured: set the ${missing} secret on the Worker.`,
      );
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await status(a)).toBe("ok");
  });

  it("reports an account unlinked meanwhile as account_not_found", async () => {
    const { a } = await link({ accessExpiresIn: 0 });
    await env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(a.accountId).run();
    const error = await caught(createTokenBroker(ENV).accessToken(a));
    expect(error.code).toBe("account_not_found");
    expect(error.details).toEqual({ accountsUrl: LINK_URL });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("puts no token string in any error, even when Google echoes one", async () => {
    const { a, refreshToken, accessToken } = await link({ accessExpiresIn: 0 });
    const echoed = accessTokenValue();
    const broker = createTokenBroker(ENV);
    const errors: Error[] = [];
    const replyCases: Reply[] = [
      new TypeError(`fetch failed for refresh_token=${refreshToken}`),
      json(500, { error: "internal", detail: refreshToken }),
      json(200, { access_token: echoed }), // no expires_in
      json(400, { error: "invalid_request", error_description: `bad ${refreshToken}` }),
      json(401, { error: "invalid_client", error_description: refreshToken }),
      json(400, { error: "invalid_grant", error_description: `revoked ${refreshToken}` }),
    ];
    for (const reply of replyCases) {
      replies.push(reply);
      errors.push(await caught(broker.accessToken(a)));
    }
    // And a missing secret.
    errors.push(
      await caught(createTokenBroker(envWith({ GOOGLE_CLIENT_SECRET: undefined })).accessToken(a)),
    );

    expect(errors.map((e) => (e as { code?: string }).code)).toEqual([
      "upstream_error",
      "upstream_error",
      "upstream_error",
      "upstream_error",
      "internal",
      "needs_relink",
      "internal",
    ]);
    for (const e of errors) {
      const text = JSON.stringify({
        message: e.message,
        details: (e as { details?: unknown }).details,
        stack: e.stack,
        cause: String(e.cause),
        own: Object.getOwnPropertyNames(e).map((p) => String(Reflect.get(e, p))),
      });
      for (const secret of [refreshToken, accessToken, echoed, CLIENT_SECRET]) {
        expect(text).not.toContain(secret);
      }
    }
  });
});
