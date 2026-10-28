// Account repository and selector resolution (ARCHITECTURE s.3.2, s.3.4).

import type { AccountRef } from "../services/types";
import { type AccountRow, first, listAccounts } from "./db";
import { ToolError } from "./errors";
import { accountKey } from "./ids";

/** The selector that means every account, for tools that allow it. Reserved: no label may be `all`. */
export const ALL_ACCOUNTS = "all";

/** The repository's view of a row: what handlers get. Status is not part of it (the broker reports relink). */
export function toAccountRef(row: AccountRow): AccountRef {
  return {
    ownerId: row.owner_id,
    accountId: row.id,
    shortId: row.short_id,
    label: row.label,
    address: row.address,
    provider: row.provider,
  };
}

/** The owner's accounts by short id, including those in `needs_relink`. */
export async function loadAccountRefs(db: D1Database, ownerId: string): Promise<AccountRef[]> {
  return (await listAccounts(db, ownerId)).map(toAccountRef);
}

/** `owners.default_account_id`, or null when unset (or the owner is unknown). */
export async function getDefaultAccountId(db: D1Database, ownerId: string): Promise<string | null> {
  const row = await first<{ default_account_id: string | null }>(
    db,
    "SELECT default_account_id FROM owners WHERE id = ?",
    ownerId,
  );
  return row?.default_account_id ?? null;
}

export interface ResolveOptions {
  /** Accept the `all` selector. Tools that take an id or write must leave this off. */
  allowAll?: boolean;
}

/** What `ctx.accounts` is (s.3.2). */
export interface AccountResolver {
  /**
   * The accounts a tool call addresses. `selector` is a label, an address, a short id (`a3` or
   * `3`), `"all"` (only with `allowAll`) or omitted for the owner's default account.
   * `idPrefix` is the `a<shortId>` of a prefixed id (or the short id itself): it selects its
   * account when `selector` is omitted, and a `selector` naming a different account is
   * `invalid_argument`. Accounts in `needs_relink` resolve; the broker reports the relink.
   */
  resolve(
    selector?: string | null,
    idPrefix?: string | number | null,
    opts?: ResolveOptions,
  ): Promise<AccountRef[]>;
}

export interface ResolverDeps {
  db: D1Database;
  ownerId: string;
  /** The issuer, for `accountsUrl`. */
  publicUrl: string;
}

const SHORT_ID = /^a?([1-9][0-9]{0,8})$/;

/** One resolver per tool call: it reads the owner's accounts once and reuses them. */
export function createAccountResolver(deps: ResolverDeps): AccountResolver {
  const accountsUrl = `${deps.publicUrl.replace(/\/+$/, "")}/accounts`;
  let loaded: Promise<AccountRef[]> | undefined;
  const accounts = (): Promise<AccountRef[]> => {
    loaded ??= loadAccountRefs(deps.db, deps.ownerId);
    return loaded;
  };

  const notFound = (what: string): ToolError =>
    new ToolError("account_not_found", `No linked account matches ${what}.`, { accountsUrl });
  const invalid = (message: string): ToolError =>
    new ToolError("invalid_argument", message, { accountsUrl });

  async function byShortId(shortId: number, what: string): Promise<AccountRef> {
    const found = (await accounts()).find((a) => a.shortId === shortId);
    if (!found) throw notFound(what);
    return found;
  }

  async function defaultAccount(): Promise<AccountRef> {
    const all = await accounts();
    const id = await getDefaultAccountId(deps.db, deps.ownerId);
    const set = id === null ? undefined : all.find((a) => a.accountId === id);
    if (set) return set;
    const [only, ...rest] = all;
    if (only && rest.length === 0) return only;
    if (!only) throw notFound("the default account (none is linked)");
    throw new ToolError(
      "ambiguous_account",
      "Several accounts are linked and no default is set. Pass `account`.",
      { accountsUrl, candidates: all.map((a) => a.label) },
    );
  }

  async function bySelector(selector: string): Promise<AccountRef> {
    const all = await accounts();
    const lower = selector.toLowerCase();
    const pick = (matches: AccountRef[]): AccountRef | undefined => {
      if (matches.length > 1) {
        throw new ToolError(
          "ambiguous_account",
          `"${selector}" matches ${matches.length} accounts. Use the address or short id.`,
          { accountsUrl, candidates: matches.map((a) => a.label) },
        );
      }
      return matches[0];
    };
    // Exact label first, then label ignoring case or address, then the short id.
    const exact = pick(all.filter((a) => a.label === selector));
    if (exact) return exact;
    const loose = pick(all.filter((a) => a.label.toLowerCase() === lower || a.address === lower));
    if (loose) return loose;
    const m = SHORT_ID.exec(selector);
    if (m) {
      const found = all.find((a) => a.shortId === Number(m[1]));
      if (found) return found;
    }
    throw notFound(`"${selector.slice(0, 80)}"`);
  }

  return {
    async resolve(selector, idPrefix, opts) {
      let prefixShortId: number | undefined;
      if (idPrefix !== undefined && idPrefix !== null) {
        const m = SHORT_ID.exec(String(idPrefix));
        if (!m) throw invalid(`Malformed id prefix "${String(idPrefix).slice(0, 40)}".`);
        prefixShortId = Number(m[1]);
      }

      const sel = selector === undefined || selector === null ? undefined : selector.trim();
      if (sel === "") throw invalid("`account` must not be empty.");

      if (sel !== undefined && sel.toLowerCase() === ALL_ACCOUNTS) {
        if (prefixShortId !== undefined) {
          throw invalid(
            `An id of account ${accountKey(prefixShortId)} cannot be used with account "all".`,
          );
        }
        if (!opts?.allowAll) throw invalid('This tool does not accept account "all".');
        const all = await accounts();
        if (all.length === 0) throw notFound("any account (none is linked)");
        return all;
      }

      if (prefixShortId !== undefined) {
        const owner = await byShortId(prefixShortId, `the id prefix ${accountKey(prefixShortId)}`);
        if (sel !== undefined) {
          const named = await bySelector(sel);
          if (named.accountId !== owner.accountId) {
            throw invalid(
              `The id belongs to account ${accountKey(owner.shortId)} (${owner.label}), not "${sel.slice(0, 80)}".`,
            );
          }
        }
        return [owner];
      }

      return [sel === undefined ? await defaultAccount() : await bySelector(sel)];
    },
  };
}
