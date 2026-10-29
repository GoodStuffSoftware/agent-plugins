// M6: AES-256-GCM token sealing and the core D1 tables (ARCHITECTURE s.4).

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  currentKeyVersion,
  type KeyEnv,
  open,
  randomBytes,
  randomId,
  type SealAad,
  type Sealed,
  seal,
} from "../src/core/crypto";
import {
  getAccount,
  getToken,
  incrementCounter,
  insertAccount,
  listAccounts,
  upsertToken,
} from "../src/core/db";
import { config, type Env } from "../src/env";

const randomKey = (): string => btoa(String.fromCharCode(...randomBytes(32)));

/** The test env with some secrets or vars replaced (undefined removes one). */
const withKeys = (overrides: Record<string, string | undefined>): KeyEnv => ({
  ...env,
  ...overrides,
});

const aadFor = (kind: SealAad["kind"] = "refresh"): SealAad => ({
  ownerId: randomId("o_"),
  accountId: randomId("ac_"),
  kind,
});

const flipBit = (bytes: Uint8Array, index: number): Uint8Array => {
  const copy = bytes.slice();
  copy[index] = (copy[index] ?? 0) ^ 1;
  return copy;
};

const DECRYPT_FAILED = /failed to decrypt/;

async function newOwner(): Promise<string> {
  const id = randomId("o_");
  await env.DB.prepare("INSERT INTO owners (id, created_at) VALUES (?, 0)").bind(id).run();
  return id;
}

describe("token sealing", () => {
  it("round-trips through seal and open", async () => {
    const aad = aadFor();
    const sealed = await seal("1//refresh-token-é", aad, env);
    expect(sealed.iv.byteLength).toBe(12);
    expect(sealed.key_version).toBe(1);
    expect(sealed.ciphertext.byteLength).toBe(
      new TextEncoder().encode("1//refresh-token-é").byteLength + 16,
    );
    expect(await open(sealed, aad, env)).toBe("1//refresh-token-é");
  });

  it("refuses another account, kind or owner", async () => {
    const aad = aadFor("refresh");
    const sealed = await seal("secret", aad, env);
    await expect(open(sealed, { ...aad, accountId: randomId("ac_") }, env)).rejects.toThrow(
      DECRYPT_FAILED,
    );
    await expect(open(sealed, { ...aad, kind: "access" }, env)).rejects.toThrow(DECRYPT_FAILED);
    await expect(open(sealed, { ...aad, ownerId: randomId("o_") }, env)).rejects.toThrow(
      DECRYPT_FAILED,
    );
  });

  it("refuses AAD ids that could blur the separator", async () => {
    const aad = aadFor();
    await expect(seal("secret", { ...aad, accountId: "a|b" }, env)).rejects.toThrow(/'\|'/);
    await expect(seal("secret", { ...aad, ownerId: "" }, env)).rejects.toThrow(/'\|'/);
    const bad = { ...aad, kind: "id" } as unknown as SealAad;
    await expect(seal("secret", bad, env)).rejects.toThrow(/refresh or access/);
  });

  it("refuses altered ciphertext, tag or IV", async () => {
    const aad = aadFor();
    const sealed = await seal("secret", aad, env);
    const last = sealed.ciphertext.byteLength - 1;
    const altered: Sealed[] = [
      { ...sealed, ciphertext: flipBit(sealed.ciphertext, 0) },
      { ...sealed, ciphertext: flipBit(sealed.ciphertext, last) },
      { ...sealed, ciphertext: sealed.ciphertext.slice(0, last) },
      { ...sealed, iv: flipBit(sealed.iv, 0) },
    ];
    for (const row of altered) await expect(open(row, aad, env)).rejects.toThrow(DECRYPT_FAILED);
    await expect(open({ ...sealed, iv: sealed.iv.slice(0, 11) }, aad, env)).rejects.toThrow(
      /invalid IV/,
    );
    for (const key_version of [0, 1.5]) {
      await expect(open({ ...sealed, key_version }, aad, env)).rejects.toThrow(
        /invalid key version/,
      );
    }
    // A raw D1 row holds its BLOBs as number arrays; getToken converts them.
    const raw = { ...sealed, iv: [...sealed.iv] } as unknown as Sealed;
    await expect(open(raw, aad, env)).rejects.toThrow(/read the row with getToken/);
  });

  it("uses a fresh IV for every seal", async () => {
    const aad = aadFor();
    const a = await seal("same plaintext", aad, env);
    const b = await seal("same plaintext", aad, env);
    expect(a.iv).not.toEqual(b.iv);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it("opens v1 rows after CURRENT_KEY_VERSION moves to 2, and seals new rows with v2", async () => {
    const aad = aadFor();
    const v1 = await seal("old token", aad, env);
    expect(v1.key_version).toBe(1);

    const rotated = withKeys({ CURRENT_KEY_VERSION: "2", TOKEN_KEK_v2: randomKey() });
    expect(currentKeyVersion(rotated)).toBe(2);
    expect(await open(v1, aad, rotated)).toBe("old token");

    const v2 = await seal("new token", aad, rotated);
    expect(v2.key_version).toBe(2);
    expect(await open(v2, aad, rotated)).toBe("new token");
    // The version picks the key: a v2 row relabelled as v1 does not open under TOKEN_KEK.
    await expect(open({ ...v2, key_version: 1 }, aad, rotated)).rejects.toThrow(DECRYPT_FAILED);
    // Without TOKEN_KEK_v2 the v2 row cannot be opened.
    await expect(open(v2, aad, env)).rejects.toThrow(/TOKEN_KEK_v2 is not set/);
  });

  it("names a missing or malformed key without echoing it", async () => {
    const aad = aadFor();
    await expect(seal("secret", aad, withKeys({ TOKEN_KEK: undefined }))).rejects.toThrow(
      /^TOKEN_KEK is not set; it must be 32 random bytes, base64-encoded/,
    );
    await expect(
      seal("secret", aad, withKeys({ CURRENT_KEY_VERSION: "3", TOKEN_KEK_v3: "" })),
    ).rejects.toThrow(/^TOKEN_KEK_v3 is not set/);
    const malformed = [
      "not base64 at all",
      btoa("sixteen-byte-key"), // 16 bytes
      "0".repeat(64), // hex, not base64
      `${randomKey().slice(0, 43)}==`,
    ];
    for (const value of malformed) {
      const error = await seal("secret", aad, withKeys({ TOKEN_KEK: value })).catch((e) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toMatch(/^TOKEN_KEK is malformed; it must be 32 random bytes/);
      expect(error.message).not.toContain(value);
    }
    for (const value of ["0", "-1", "1.5", "v2", "01", "007"]) {
      const bad = withKeys({ CURRENT_KEY_VERSION: value });
      expect(() => currentKeyVersion(bad)).toThrow(
        /CURRENT_KEY_VERSION must be a positive integer/,
      );
      // config() uses the same parser, so it cannot disagree with seal().
      expect(() => config(bad as Env)).toThrow(/CURRENT_KEY_VERSION must be a positive integer/);
    }
    expect(currentKeyVersion(withKeys({ CURRENT_KEY_VERSION: undefined }))).toBe(1);
    expect(config(withKeys({ CURRENT_KEY_VERSION: "7" }) as Env).currentKeyVersion).toBe(7);
  });

  it("accepts a key with surrounding whitespace or without padding", async () => {
    const aad = aadFor();
    const key = randomKey();
    const sealed = await seal("secret", aad, withKeys({ TOKEN_KEK: `${key}\n` }));
    expect(await open(sealed, aad, withKeys({ TOKEN_KEK: key.slice(0, 43) }))).toBe("secret");
  });
});

describe("core tables", () => {
  it("applies 0002_core.sql", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('accounts', 'account_tokens', 'send_as', 'audit_log', 'rate_counters', 'pending_actions') ORDER BY name",
    ).all<{ name: string }>();
    expect(tables.results.map((t) => t.name)).toEqual([
      "account_tokens",
      "accounts",
      "audit_log",
      "pending_actions",
      "rate_counters",
      "send_as",
    ]);
    const applied = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{
      name: string;
    }>();
    expect(applied.results.map((m) => m.name)).toEqual([
      "0001_auth.sql",
      "0002_core.sql",
      "0003_label_nocase.sql",
    ]);
    const columns = await env.DB.prepare("SELECT name FROM pragma_table_info('accounts')").all<{
      name: string;
    }>();
    expect(columns.results.map((c) => c.name).filter((n) => /token|secret|cipher/.test(n))).toEqual(
      [],
    );
  });

  it("gives each owner's accounts increasing short ids that a failed insert does not use", async () => {
    const owner = await newOwner();
    const other = await newOwner();
    const base = { provider: "google", components: ["mail"] } as const;
    const work = await insertAccount(env.DB, {
      ...base,
      ownerId: owner,
      label: "work",
      address: "Work@Example.com",
    });
    expect(work).toMatchObject({
      owner_id: owner,
      short_id: 1,
      label: "work",
      address: "work@example.com",
      components: '["mail"]',
      status: "ok",
    });
    expect(work?.id).toMatch(/^ac_[a-z2-7]{16}$/);
    await expect(
      insertAccount(env.DB, { ...base, ownerId: owner, label: "work", address: "x@example.com" }),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    await expect(
      insertAccount(env.DB, { ...base, ownerId: owner, label: "x", address: "WORK@example.com" }),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    const home = await insertAccount(env.DB, {
      ...base,
      ownerId: owner,
      label: "home",
      address: "home@example.com",
    });
    expect(home?.short_id).toBe(2);
    const theirs = await insertAccount(env.DB, {
      ...base,
      ownerId: other,
      label: "work",
      address: "work@example.com",
    });
    expect(theirs?.short_id).toBe(1);
    expect(
      await insertAccount(env.DB, { ...base, ownerId: randomId("o_"), label: "a", address: "a@b" }),
    ).toBeNull();

    expect((await listAccounts(env.DB, owner)).map((a) => a.label)).toEqual(["work", "home"]);
    expect(await getAccount(env.DB, owner, home?.id ?? "")).toMatchObject({ label: "home" });
    expect(await getAccount(env.DB, other, home?.id ?? "")).toBeNull();
  });

  it("stores sealed tokens per account and kind, and opens them after a D1 round trip", async () => {
    const ownerId = await newOwner();
    const account = await insertAccount(env.DB, {
      ownerId,
      label: "personal",
      address: "personal@example.com",
      provider: "google",
    });
    const accountId = account?.id ?? "";
    const refresh: SealAad = { ownerId, accountId, kind: "refresh" };
    const access: SealAad = { ownerId, accountId, kind: "access" };

    expect(await getToken(env.DB, accountId, "refresh")).toBeNull();
    // The table refuses an IV that is not 12 bytes.
    await expect(
      env.DB.prepare(
        "INSERT INTO account_tokens (account_id, kind, ciphertext, iv, key_version, updated_at) VALUES (?, 'refresh', ?, ?, 1, 0)",
      )
        .bind(accountId, new Uint8Array(32), new Uint8Array(8))
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    await upsertToken(env.DB, {
      accountId,
      kind: "refresh",
      sealed: await seal("r1", refresh, env),
    });
    await upsertToken(env.DB, {
      accountId,
      kind: "access",
      sealed: await seal("a1", access, env),
      expiresAt: 1_800_000_000,
    });
    await upsertToken(env.DB, {
      accountId,
      kind: "refresh",
      sealed: await seal("r2", refresh, env),
    });

    const storedRefresh = await getToken(env.DB, accountId, "refresh");
    const storedAccess = await getToken(env.DB, accountId, "access");
    expect(storedRefresh?.iv).toBeInstanceOf(Uint8Array);
    expect(storedRefresh?.key_version).toBe(1);
    expect(storedAccess?.expires_at).toBe(1_800_000_000);
    expect(await open(storedRefresh as Sealed, refresh, env)).toBe("r2");
    expect(await open(storedAccess as Sealed, access, env)).toBe("a1");
    // A row copied to another kind does not open.
    await expect(open(storedAccess as Sealed, refresh, env)).rejects.toThrow(DECRYPT_FAILED);

    // Unlinking the account removes its tokens.
    await env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(accountId).run();
    expect(await getToken(env.DB, accountId, "refresh")).toBeNull();
  });

  it("increments a rate counter atomically across repeated calls", async () => {
    const bucket = `send:h:${randomId("ac_")}`;
    const counts = await Promise.all(
      Array.from({ length: 25 }, () => incrementCounter(env.DB, bucket, 3600)),
    );
    expect([...counts].sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(await incrementCounter(env.DB, bucket, 3600)).toBe(26);
    expect(await incrementCounter(env.DB, bucket, 7200)).toBe(1);
    expect(await incrementCounter(env.DB, `${bucket}x`, 3600)).toBe(1);
    const row = await env.DB.prepare(
      "SELECT count FROM rate_counters WHERE bucket = ? AND window_start = 3600",
    )
      .bind(bucket)
      .first<{ count: number }>();
    expect(row?.count).toBe(26);
  });
});
