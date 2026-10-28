// M9a: account-scoped ids (ARCHITECTURE s.3.4).

import { describe, expect, it } from "vitest";
import { ToolError } from "../src/core/errors";
import { accountKey, decodeId, encodeId, ids, PREFIXED_ID, parseId } from "../src/core/ids";

describe("account-scoped ids", () => {
  it("round-trips plain provider ids", () => {
    const id = encodeId(3, "18c2f0a1b2c3d4e5");
    expect(id).toBe("a3:18c2f0a1b2c3d4e5");
    expect(decodeId(id)).toEqual({ shortId: 3, providerId: "18c2f0a1b2c3d4e5" });
    expect(encodeId({ shortId: 12 }, "x")).toBe("a12:x");
  });

  it("keeps People ids with a slash and calendar ids with @ intact", () => {
    const people = encodeId(2, "people/c1234567890");
    expect(decodeId(people)).toEqual({ shortId: 2, providerId: "people/c1234567890" });
    const cal = encodeId(1, "owner@example.com");
    expect(decodeId(cal)).toEqual({ shortId: 1, providerId: "owner@example.com" });
    const group = encodeId(1, "abc123@group.calendar.google.com");
    expect(decodeId(group)?.providerId).toBe("abc123@group.calendar.google.com");
  });

  it("splits at the first colon only", () => {
    expect(decodeId("a4:one:two:three")).toEqual({ shortId: 4, providerId: "one:two:three" });
    expect(decodeId(encodeId(4, "x:y"))).toEqual({ shortId: 4, providerId: "x:y" });
  });

  it("takes bare ids for bare ids", () => {
    for (const bare of [
      "18c2f0a1b2c3d4e5",
      "people/c1",
      "owner@example.com",
      "abc:def",
      "A1:x",
      "",
    ]) {
      expect(decodeId(bare)).toBeNull();
      expect(parseId(bare)).toBeNull();
    }
  });

  it("refuses malformed prefixed ids in parseId, and leaves decodeId null", () => {
    for (const malformed of ["a0:x", "a01:x", "a1:", "a1234567890:x", "a99999999999:y"]) {
      expect(decodeId(malformed)).toBeNull();
      expect(() => parseId(malformed)).toThrowError(ToolError);
      try {
        parseId(malformed);
      } catch (e) {
        expect((e as ToolError).code).toBe("invalid_argument");
      }
    }
  });

  it("accepts 9-digit short ids and refuses 10", () => {
    expect(decodeId("a999999999:x")?.shortId).toBe(999_999_999);
    expect(decodeId("a1000000000:x")).toBeNull();
  });

  it("refuses to encode a bad short id or an empty id", () => {
    for (const bad of [0, -1, 1.5, 1_000_000_000, Number.NaN]) {
      expect(() => encodeId(bad, "x")).toThrowError(ToolError);
    }
    expect(() => encodeId(1, "")).toThrowError(ToolError);
  });

  it("matches the documented regex and exposes the codec", () => {
    expect(PREFIXED_ID.source).toBe("^a([1-9][0-9]{0,8}):(.+)$");
    expect(accountKey(7)).toBe("a7");
    expect(ids.encode(7, "m")).toBe("a7:m");
    expect(ids.decode("a7:m")).toEqual({ shortId: 7, providerId: "m" });
  });
});
