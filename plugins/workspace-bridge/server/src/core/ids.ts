// Account-scoped ids: `a<shortId>:<providerId>` (ARCHITECTURE s.3.4).

import type { AccountRef } from "../services/types";
import { ToolError } from "./errors";

/** Matches a prefixed id; group 1 is the short id, group 2 the provider id (may contain `:`). */
export const PREFIXED_ID = /^a([1-9][0-9]{0,8}):(.+)$/s;

export interface DecodedId {
  shortId: number;
  /** The provider's own id: People ids contain `/`, calendar ids `@`. */
  providerId: string;
}

/** The `a<shortId>` key an account has in ids and cursors. */
export const accountKey = (shortId: number): string => `a${shortId}`;

/** `a<shortId>:<providerId>`. Throws `internal` on a programming error (bad short id, empty id). */
export function encodeId(
  account: Pick<AccountRef, "shortId"> | number,
  providerId: string,
): string {
  const shortId = typeof account === "number" ? account : account.shortId;
  if (!Number.isSafeInteger(shortId) || shortId < 1 || shortId > 999_999_999) {
    throw new ToolError("internal", "Invalid account short id.");
  }
  if (providerId === "") throw new ToolError("internal", "Empty provider id.");
  return `${accountKey(shortId)}:${providerId}`;
}

/** Splits at the first `:` only; null when `id` is not a prefixed id (a bare provider id). */
export function decodeId(id: string): DecodedId | null {
  const m = PREFIXED_ID.exec(id);
  if (!m) return null;
  return { shortId: Number(m[1]), providerId: m[2] as string };
}

/**
 * Like `decodeId`, but a value that starts like a prefixed id and is malformed (`a0:x`, `a1:`,
 * `a12345678901:x`) is `invalid_argument` instead of being taken for a bare id.
 */
export function parseId(id: string): DecodedId | null {
  const d = decodeId(id);
  if (d) return d;
  if (/^a[0-9]+:/.test(id)) {
    throw new ToolError("invalid_argument", `Malformed id "${id.slice(0, 40)}".`);
  }
  return null;
}

/** What `ctx.ids` is (s.3.2). */
export interface IdCodec {
  encode(account: Pick<AccountRef, "shortId"> | number, providerId: string): string;
  decode(id: string): DecodedId | null;
  parse(id: string): DecodedId | null;
}

export const ids: IdCodec = { encode: encodeId, decode: decodeId, parse: parseId };
