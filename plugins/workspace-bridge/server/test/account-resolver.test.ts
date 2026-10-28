// M9a: account repository and the resolver (ARCHITECTURE s.3.2, s.3.4).

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  createAccountResolver,
  getDefaultAccountId,
  loadAccountRefs,
  toAccountRef,
} from "../src/core/accounts";
import { randomId } from "../src/core/crypto";
import { insertAccount, run } from "../src/core/db";
import { ToolError } from "../src/core/errors";
import type { AccountRef } from "../src/services/types";

const PUBLIC_URL = "https://mcp.example.com";

async function newOwner(): Promise<string> {
  const id = randomId("o_");
  await run(env.DB, "INSERT INTO owners (id, created_at) VALUES (?, 0)", id);
  return id;
}

/** Links accounts a1..aN in order; returns the owner and refs. */
async function ownerWith(
  ...accounts: [label: string, address: string][]
): Promise<{ ownerId: string; refs: AccountRef[] }> {
  const ownerId = await newOwner();
  const refs: AccountRef[] = [];
  for (const [label, address] of accounts) {
    const row = await insertAccount(env.DB, { ownerId, label, address, provider: "google" });
    if (!row) throw new Error("insert failed");
    refs.push(toAccountRef(row));
  }
  return { ownerId, refs };
}

const resolverFor = (ownerId: string) =>
  createAccountResolver({ db: env.DB, ownerId, publicUrl: PUBLIC_URL });

async function failure(p: Promise<unknown>): Promise<ToolError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ToolError) return e;
    throw e;
  }
  throw new Error("expected a ToolError");
}

const setDefault = (ownerId: string, accountId: string | null) =>
  run(env.DB, "UPDATE owners SET default_account_id = ? WHERE id = ?", accountId, ownerId);

describe("account repository", () => {
  it("maps rows to AccountRefs by short id, including needs_relink accounts", async () => {
    const { ownerId, refs } = await ownerWith(
      ["work", "Work@Example.com"],
      ["home", "h@example.com"],
    );
    await run(
      env.DB,
      "UPDATE accounts SET status = 'needs_relink' WHERE id = ?",
      refs[0]?.accountId,
    );
    const loaded = await loadAccountRefs(env.DB, ownerId);
    expect(loaded).toEqual([
      {
        ownerId,
        accountId: refs[0]?.accountId,
        shortId: 1,
        label: "work",
        address: "work@example.com",
        provider: "google",
      },
      expect.objectContaining({ shortId: 2, label: "home" }),
    ]);
  });

  it("reads the owner's default account id", async () => {
    const { ownerId, refs } = await ownerWith(["work", "w@example.com"]);
    expect(await getDefaultAccountId(env.DB, ownerId)).toBeNull();
    await setDefault(ownerId, refs[0]?.accountId ?? null);
    expect(await getDefaultAccountId(env.DB, ownerId)).toBe(refs[0]?.accountId);
    expect(await getDefaultAccountId(env.DB, "o_missing")).toBeNull();
  });

  it("never sees another owner's accounts", async () => {
    await ownerWith(["work", "w@example.com"]);
    const other = await ownerWith(["work", "w2@example.com"]);
    const refs = await loadAccountRefs(env.DB, other.ownerId);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.address).toBe("w2@example.com");
  });
});

describe("AccountResolver", () => {
  it("resolves by label, address, short id and prefix", async () => {
    const { ownerId, refs } = await ownerWith(
      ["work", "work@example.com"],
      ["home", "me@home.org"],
    );
    const r = resolverFor(ownerId);
    expect(await r.resolve("home")).toEqual([refs[1]]);
    expect(await r.resolve("work@example.com")).toEqual([refs[0]]);
    expect(await r.resolve("WORK@Example.com")).toEqual([refs[0]]);
    expect(await r.resolve("Home")).toEqual([refs[1]]);
    expect(await r.resolve("a2")).toEqual([refs[1]]);
    expect(await r.resolve("2")).toEqual([refs[1]]);
    expect(await r.resolve("  work ")).toEqual([refs[0]]);
  });

  it("prefers an exact label over a short id lookalike", async () => {
    const { ownerId, refs } = await ownerWith(["2", "a@example.com"], ["x", "b@example.com"]);
    expect(await resolverFor(ownerId).resolve("2")).toEqual([refs[0]]);
    expect(await resolverFor(ownerId).resolve("a2")).toEqual([refs[1]]);
  });

  it("uses the default account when the selector is omitted", async () => {
    const { ownerId, refs } = await ownerWith(["work", "w@example.com"], ["home", "h@example.com"]);
    await setDefault(ownerId, refs[1]?.accountId ?? null);
    const r = resolverFor(ownerId);
    expect(await r.resolve()).toEqual([refs[1]]);
    expect(await r.resolve(undefined)).toEqual([refs[1]]);
    expect(await r.resolve(null)).toEqual([refs[1]]);
  });

  it("falls back to the only account when no default is set, else asks", async () => {
    const one = await ownerWith(["work", "w@example.com"]);
    expect(await resolverFor(one.ownerId).resolve()).toEqual(one.refs);

    const two = await ownerWith(["work", "w@example.com"], ["home", "h@example.com"]);
    const err = await failure(resolverFor(two.ownerId).resolve());
    expect(err.code).toBe("ambiguous_account");
    expect(err.details).toEqual({
      accountsUrl: `${PUBLIC_URL}/accounts`,
      candidates: ["work", "home"],
    });

    const none = await newOwner();
    expect((await failure(resolverFor(none).resolve())).code).toBe("account_not_found");
  });

  it("returns every account for all, only where allowed", async () => {
    const { ownerId, refs } = await ownerWith(["work", "w@example.com"], ["home", "h@example.com"]);
    const r = resolverFor(ownerId);
    expect(await r.resolve("all", undefined, { allowAll: true })).toEqual(refs);
    expect(await r.resolve("ALL", undefined, { allowAll: true })).toEqual(refs);
    const refused = await failure(r.resolve("all"));
    expect(refused.code).toBe("invalid_argument");
    expect(refused.details).toEqual({ accountsUrl: `${PUBLIC_URL}/accounts` });
    expect((await failure(r.resolve("all", undefined, { allowAll: false }))).code).toBe(
      "invalid_argument",
    );
    const none = await newOwner();
    expect(
      (await failure(resolverFor(none).resolve("all", undefined, { allowAll: true }))).code,
    ).toBe("account_not_found");
  });

  it("reports unknown accounts with accountsUrl", async () => {
    const { ownerId } = await ownerWith(["work", "w@example.com"]);
    const err = await failure(resolverFor(ownerId).resolve("nope"));
    expect(err.code).toBe("account_not_found");
    expect(err.details).toEqual({ accountsUrl: `${PUBLIC_URL}/accounts` });
    expect((await failure(resolverFor(ownerId).resolve("a9"))).code).toBe("account_not_found");
    expect((await failure(resolverFor(ownerId).resolve("nope@example.com"))).code).toBe(
      "account_not_found",
    );
  });

  it("does not resolve another owner's account", async () => {
    await ownerWith(["secret", "s@example.com"]);
    const mine = await ownerWith(["work", "w@example.com"]);
    const r = resolverFor(mine.ownerId);
    expect((await failure(r.resolve("secret"))).code).toBe("account_not_found");
    expect((await failure(r.resolve("s@example.com"))).code).toBe("account_not_found");
  });

  it("is ambiguous when a selector matches two accounts", async () => {
    // Labels are unique per owner but not across case; an address can equal another's label.
    const { ownerId } = await ownerWith(
      ["Work", "a@example.com"],
      ["work", "b@example.com"],
      ["b@example.com2", "c@example.com"],
    );
    const r = resolverFor(ownerId);
    // Exact case wins.
    expect((await r.resolve("Work"))[0]?.shortId).toBe(1);
    expect((await r.resolve("work"))[0]?.shortId).toBe(2);
    // Neither case matches exactly.
    const err = await failure(r.resolve("WORK"));
    expect(err.code).toBe("ambiguous_account");
    expect(err.details).toEqual({
      accountsUrl: `${PUBLIC_URL}/accounts`,
      candidates: ["Work", "work"],
    });
  });

  it("is ambiguous when a label equals another account's address", async () => {
    const { ownerId } = await ownerWith(["Bob", "x@example.com"], ["other", "y@example.com"]);
    await run(
      env.DB,
      "UPDATE accounts SET label = 'y@example.com' WHERE owner_id = ? AND short_id = 1",
      ownerId,
    );
    // Exact label match still wins over the other account's address.
    expect((await resolverFor(ownerId).resolve("y@example.com"))[0]?.shortId).toBe(1);
    // Case differs from the label, so label (loose) and address both match, on two accounts.
    await run(
      env.DB,
      "UPDATE accounts SET label = 'Y@example.com' WHERE owner_id = ? AND short_id = 1",
      ownerId,
    );
    expect((await failure(resolverFor(ownerId).resolve("y@example.com"))).code).toBe(
      "ambiguous_account",
    );
  });

  it("still resolves accounts in needs_relink", async () => {
    const { ownerId, refs } = await ownerWith(["work", "w@example.com"], ["home", "h@example.com"]);
    await run(env.DB, "UPDATE accounts SET status = 'needs_relink'  WHERE owner_id = ?", ownerId);
    const r = resolverFor(ownerId);
    expect(await r.resolve("work")).toEqual([refs[0]]);
    expect(await r.resolve("all", undefined, { allowAll: true })).toEqual(refs);
    await setDefault(ownerId, refs[1]?.accountId ?? null);
    expect(await resolverFor(ownerId).resolve()).toEqual([refs[1]]);
  });

  it("rejects an empty selector", async () => {
    const { ownerId } = await ownerWith(["work", "w@example.com"]);
    expect((await failure(resolverFor(ownerId).resolve(""))).code).toBe("invalid_argument");
    expect((await failure(resolverFor(ownerId).resolve("   "))).code).toBe("invalid_argument");
  });

  describe("with an id prefix", () => {
    it("selects the prefix's account when the selector is omitted, ignoring the default", async () => {
      const { ownerId, refs } = await ownerWith(
        ["work", "w@example.com"],
        ["home", "h@example.com"],
      );
      await setDefault(ownerId, refs[0]?.accountId ?? null);
      const r = resolverFor(ownerId);
      expect(await r.resolve(undefined, "a2")).toEqual([refs[1]]);
      expect(await r.resolve(null, 2)).toEqual([refs[1]]);
    });

    it("accepts a selector naming the same account", async () => {
      const { ownerId, refs } = await ownerWith(
        ["work", "w@example.com"],
        ["home", "h@example.com"],
      );
      const r = resolverFor(ownerId);
      expect(await r.resolve("home", "a2")).toEqual([refs[1]]);
      expect(await r.resolve("h@example.com", "a2")).toEqual([refs[1]]);
      expect(await r.resolve("a2", "a2")).toEqual([refs[1]]);
    });

    it("refuses a different account as invalid_argument", async () => {
      const { ownerId } = await ownerWith(["work", "w@example.com"], ["home", "h@example.com"]);
      const r = resolverFor(ownerId);
      const err = await failure(r.resolve("work", "a2"));
      expect(err.code).toBe("invalid_argument");
      expect(err.details).toEqual({ accountsUrl: `${PUBLIC_URL}/accounts` });
      expect((await failure(r.resolve("all", "a2", { allowAll: true }))).code).toBe(
        "invalid_argument",
      );
    });

    it("reports an unknown prefix or selector, and a malformed prefix", async () => {
      const { ownerId } = await ownerWith(["work", "w@example.com"]);
      const r = resolverFor(ownerId);
      expect((await failure(r.resolve(undefined, "a7"))).code).toBe("account_not_found");
      expect((await failure(r.resolve("nope", "a1"))).code).toBe("account_not_found");
      expect((await failure(r.resolve(undefined, "x7"))).code).toBe("invalid_argument");
      expect((await failure(r.resolve(undefined, 0))).code).toBe("invalid_argument");
    });
  });
});
