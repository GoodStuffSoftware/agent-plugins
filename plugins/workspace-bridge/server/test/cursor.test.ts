// M9a: multi-account cursors and the merge helper (ARCHITECTURE s.3.5).

import { describe, expect, it } from "vitest";
import {
  type AccountPage,
  type Cursor,
  canonicalJson,
  cursors,
  decodeCursor,
  encodeCursor,
  mergePages,
  queryHash,
  startFromCursor,
} from "../src/core/cursor";
import { ToolError } from "../src/core/errors";

const b64url = (s: string): string =>
  btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof ToolError ? e.code : "other";
  }
  return undefined;
};

describe("cursor codec", () => {
  const q = "0123456789abcdef";
  const cursor: Cursor = {
    v: 1,
    t: "search_threads",
    q,
    p: { a1: { tok: "next-1", skip: 2 }, a2: null, a3: { tok: null, skip: 0 } },
  };

  it("round-trips as base64url JSON", () => {
    const token = encodeCursor(cursor);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(token, { tool: "search_threads", query: q })).toEqual(cursor);
    expect(cursors.decode(cursors.encode(cursor), { tool: "search_threads", query: q })).toEqual(
      cursor,
    );
  });

  it("keeps non-ASCII page tokens", () => {
    const c: Cursor = { ...cursor, p: { a1: { tok: "té日", skip: 0 } } };
    expect(decodeCursor(encodeCursor(c), { tool: "search_threads", query: q })).toEqual(c);
  });

  it("refuses a cursor for another tool or another query", () => {
    const token = encodeCursor(cursor);
    expect(code(() => decodeCursor(token, { tool: "search_events", query: q }))).toBe(
      "invalid_argument",
    );
    expect(code(() => decodeCursor(token, { tool: "search_threads", query: "f".repeat(16) }))).toBe(
      "invalid_argument",
    );
  });

  it("refuses tampered, malformed and oversized tokens", () => {
    const expect_ = { tool: "search_threads", query: q };
    const bad = [
      "",
      "!!!",
      "not base64 at all",
      b64url("not json"),
      b64url("null"),
      b64url("[]"),
      b64url(JSON.stringify({ ...cursor, v: 2 })),
      b64url(JSON.stringify({ ...cursor, p: {} })),
      b64url(JSON.stringify({ ...cursor, p: [] })),
      b64url(JSON.stringify({ ...cursor, p: { a1: { tok: 5, skip: 0 } } })),
      b64url(JSON.stringify({ ...cursor, p: { a1: { tok: "x", skip: -1 } } })),
      b64url(JSON.stringify({ ...cursor, p: { a1: { tok: "x", skip: 1.5 } } })),
      b64url(JSON.stringify({ ...cursor, p: { a1: { tok: "x" } } })),
      b64url(JSON.stringify({ ...cursor, p: { owner: { tok: "x", skip: 0 } } })),
      b64url(JSON.stringify({ ...cursor, p: { a0: null } })),
      b64url(JSON.stringify({ ...cursor, p: { a1: { tok: "x".repeat(9000), skip: 0 } } })),
      "A".repeat(40_000),
    ];
    for (const token of bad) {
      expect(code(() => decodeCursor(token, expect_))).toBe("invalid_argument");
    }
  });

  it("hashes canonical query params: key order does not matter, content does", async () => {
    const a = await queryHash({ q: "from:ann", limit: 20, labels: ["x"], skip: undefined });
    const b = await queryHash({ labels: ["x"], limit: 20, q: "from:ann" });
    const c = await queryHash({ labels: ["x"], limit: 21, q: "from:ann" });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(canonicalJson({ b: 1, a: { d: 1, c: undefined } })).toBe('{"a":{"d":1},"b":1}');
  });

  describe("startFromCursor", () => {
    it("starts every account at its first page without a cursor", () => {
      expect(startFromCursor(null, ["a1", "a2"])).toEqual([
        { key: "a1", tok: null, skip: 0 },
        { key: "a2", tok: null, skip: 0 },
      ]);
    });

    it("drops exhausted accounts and keeps order", () => {
      expect(startFromCursor(cursor, ["a1", "a2", "a3"])).toEqual([
        { key: "a1", tok: "next-1", skip: 2 },
        { key: "a3", tok: null, skip: 0 },
      ]);
    });

    it("refuses a cursor for a different account set", () => {
      expect(code(() => startFromCursor(cursor, ["a1"]))).toBe("invalid_argument");
      expect(code(() => startFromCursor(cursor, ["a1", "a2", "a3", "a4"]))).toBe(
        "invalid_argument",
      );
      expect(code(() => startFromCursor(cursor, ["a1", "a2", "a9"]))).toBe("invalid_argument");
    });
  });
});

describe("mergePages", () => {
  const opts = (limit: number, keys: string[]) => ({
    tool: "t",
    query: "q".repeat(16),
    limit,
    keys,
    // Newest first: bigger numbers first.
    compare: (a: number, b: number) => b - a,
  });

  const page = (
    key: string,
    items: number[],
    next: string | null = null,
    tok: string | null = null,
    skip = 0,
  ): AccountPage<number> => ({ key, tok, skip, items, next });

  const decode = (token: string | undefined): Cursor =>
    decodeCursor(token as string, { tool: "t", query: "q".repeat(16) });

  it("merges 2 accounts and cuts at the limit, recording skip", () => {
    const out = mergePages(
      [page("a1", [9, 7, 5, 3]), page("a2", [8, 6, 4, 2])],
      opts(5, ["a1", "a2"]),
    );
    expect(out.items).toEqual([9, 8, 7, 6, 5]);
    expect(out.taken).toEqual({ a1: 3, a2: 2 });
    expect(decode(out.nextPageToken).p).toEqual({
      a1: { tok: null, skip: 3 },
      a2: { tok: null, skip: 2 },
    });
  });

  it("resumes from skip on the same page token", () => {
    const first = mergePages(
      [page("a1", [9, 7, 5, 3]), page("a2", [8, 6, 4, 2])],
      opts(5, ["a1", "a2"]),
    );
    const cursor = decode(first.nextPageToken);
    const starts = startFromCursor(cursor, ["a1", "a2"]);
    const refetched = [
      page("a1", [9, 7, 5, 3], null, starts[0]?.tok, starts[0]?.skip),
      page("a2", [8, 6, 4, 2], null, starts[1]?.tok, starts[1]?.skip),
    ];
    const second = mergePages(refetched, opts(5, ["a1", "a2"]));
    expect(second.items).toEqual([4, 3, 2]);
    expect(second.nextPageToken).toBeUndefined();
  });

  it("merges 3 accounts, breaks ties by account order, and ends with no cursor", () => {
    const out = mergePages(
      [page("a1", [5, 3]), page("a2", [5, 4]), page("a3", [5, 1])],
      opts(10, ["a1", "a2", "a3"]),
    );
    expect(out.items).toEqual([5, 5, 5, 4, 3, 1]);
    expect(out.taken).toEqual({ a1: 2, a2: 2, a3: 2 });
    expect(out.nextPageToken).toBeUndefined();
  });

  it("advances an account to its next provider page once its page is used up", () => {
    const out = mergePages(
      [page("a1", [9, 8], "n1"), page("a2", [1], null)],
      opts(2, ["a1", "a2"]),
    );
    expect(out.items).toEqual([9, 8]);
    expect(decode(out.nextPageToken).p).toEqual({
      a1: { tok: "n1", skip: 0 },
      a2: { tok: null, skip: 0 },
    });
  });

  it("stops at an account whose next page is unknown instead of emitting out of order", () => {
    // a1's next page could hold a 7 or an 8; a2's 6 must not be returned before it is known.
    const out = mergePages(
      [page("a1", [9], "n1"), page("a2", [6, 5], null)],
      opts(5, ["a1", "a2"]),
    );
    expect(out.items).toEqual([9]);
    expect(decode(out.nextPageToken).p).toEqual({
      a1: { tok: "n1", skip: 0 },
      a2: { tok: null, skip: 0 },
    });
  });

  it("marks an exhausted account null and keeps the others", () => {
    const out = mergePages([page("a1", []), page("a2", [9, 8, 7], "n2")], opts(2, ["a1", "a2"]));
    expect(out.items).toEqual([9, 8]);
    expect(decode(out.nextPageToken).p).toEqual({ a1: null, a2: { tok: null, skip: 2 } });
    expect(out.taken).toEqual({ a1: 0, a2: 2 });
  });

  it("returns no cursor when every page is exhausted, and an empty page for no data", () => {
    expect(mergePages([page("a1", []), page("a2", [])], opts(5, ["a1", "a2"]))).toEqual({
      items: [],
      taken: { a1: 0, a2: 0 },
      nextPageToken: undefined,
    });
    const empty = mergePages([page("a1", [], "n1")], opts(5, ["a1"]));
    expect(empty.items).toEqual([]);
    expect(decode(empty.nextPageToken).p).toEqual({ a1: { tok: "n1", skip: 0 } });
  });

  it("works for a single account", () => {
    const out = mergePages([page("a4", [3, 2, 1], "n")], opts(2, ["a4"]));
    expect(out.items).toEqual([3, 2]);
    expect(decode(out.nextPageToken).p).toEqual({ a4: { tok: null, skip: 2 } });
  });

  it("pages through whole listings without loss or repeats", async () => {
    // A fake provider: a sorted list per account served in pages of `size`, token = start index.
    const lists: Record<string, number[]> = {
      a1: [100, 97, 90, 85, 80, 70, 69, 50, 40, 10],
      a2: [99, 98, 96, 60, 59],
      a3: [95, 94, 93, 92, 91, 30, 20, 5, 4, 3, 2, 1],
      a4: [],
    };
    const expected = Object.values(lists)
      .flat()
      .sort((a, b) => b - a);
    const keys = ["a1", "a2", "a3", "a4"];

    for (const size of [1, 2, 3, 4, 7, 50]) {
      for (const limit of [1, 2, 3, 5, 8, 100]) {
        const fetchPage = (key: string, tok: string | null, skip: number): AccountPage<number> => {
          const all = lists[key] as number[];
          const from = tok === null ? 0 : Number(tok);
          const nextFrom = from + size;
          return {
            key,
            tok,
            skip,
            items: all.slice(from, nextFrom),
            next: nextFrom < all.length ? String(nextFrom) : null,
          };
        };

        const got: number[] = [];
        let cursor: Cursor | null = null;
        for (let calls = 0; calls < 1000; calls++) {
          const starts = startFromCursor(cursor, keys);
          const merged = mergePages(
            starts.map((s) => fetchPage(s.key, s.tok, s.skip)),
            opts(limit, keys),
          );
          got.push(...merged.items);
          if (!merged.nextPageToken) break;
          cursor = decode(merged.nextPageToken);
          // Every call makes progress: items, or at least a moved cursor.
          expect(merged.items.length > 0 || cursor !== null).toBe(true);
        }
        expect(got, `size ${size} limit ${limit}`).toEqual(expected);
      }
    }
  });
});
