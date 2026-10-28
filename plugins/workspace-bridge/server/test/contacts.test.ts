import { afterEach, describe, expect, it, vi } from "vitest";
import { SCOPES } from "../src/auth/endpoints";
import { warmupRetry } from "../src/providers/google/contacts";
import fixture from "./fixtures/google/contacts.json";
import {
  type GoogleCall,
  googleJson,
  installGoogleRoutes,
  linkGoogleAccount,
  newOwner,
  tokenRoute,
} from "./helpers/google";
import { mcpRpc, toolJson } from "./helpers/mcp";
import { mintToken } from "./helpers/tokens";

afterEach(() => vi.restoreAllMocks());

const P = "https://people.googleapis.com/v1";
const SEARCH = `${P}/people:searchContacts`;
const OTHER = `${P}/otherContacts:search`;

type Out = Record<string, unknown> & { error?: { code: string } };

async function call(
  ownerId: string,
  name: string,
  args: Record<string, unknown>,
  kind: "full" | "ro" = "full",
) {
  const token = await mintToken({ kind, scopes: SCOPES[kind], ownerId });
  const { result } = await mcpRpc(token, kind, "tools/call", { name, arguments: args });
  return {
    isError: (result as { isError?: boolean }).isError === true,
    json: toolJson(result) as Out,
  };
}

async function setup(opts: Parameters<typeof linkGoogleAccount>[1] = {}) {
  const ownerId = await newOwner();
  const acct = await linkGoogleAccount(ownerId, { label: "work", ...opts });
  return { ownerId, ...acct };
}

const q = (c: GoogleCall) => new URL(c.url).searchParams;
const queryOf = (req: Request) => new URL(req.url).searchParams.get("query");

/**
 * A fake People API whose searches answer only after an empty-query warm-up, like Google's cold
 * cache. Warm state is kept per bearer token, so two accounts warm independently.
 */
function peopleRoutes() {
  const warm = new Set<string>();
  const route = (url: string, tag: string, data: unknown) => ({
    url,
    reply: (req: Request) => {
      const key = `${tag}:${req.headers.get("Authorization")}`;
      if (queryOf(req) === "") {
        warm.add(key);
        return googleJson(200, {});
      }
      return googleJson(200, warm.has(key) ? data : {});
    },
  });
  return [
    route(SEARCH, "c", fixture.searchContacts),
    route(OTHER, "o", fixture.otherContactsSearch),
  ];
}

const plain = (s: unknown) => String(s).replace(/<[^>]+>/g, "");

describe("endpoints", () => {
  it("both tools are on full and ro, readOnly", async () => {
    const { ownerId } = await setup();
    for (const kind of ["full", "ro"] as const) {
      const token = await mintToken({ kind, scopes: SCOPES[kind], ownerId });
      const { result } = await mcpRpc(token, kind, "tools/list");
      const tools = (
        result as { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] }
      ).tools;
      for (const n of ["search_contacts", "get_contact"]) {
        expect(tools.find((t) => t.name === n)?.annotations?.readOnlyHint).toBe(true);
      }
    }
  });
});

describe("search_contacts", () => {
  it("warms the cache first, merges both sources and lists a shared email once", async () => {
    const { ownerId, accessToken } = await setup();
    const calls = installGoogleRoutes(peopleRoutes());
    const { json } = await call(ownerId, "search_contacts", { query: "ada" }, "ro");
    const list = json.contacts as Record<string, unknown>[];
    // Ada is in both sources: the contact wins, the other contact is dropped.
    expect(list.map((c) => plain(c.displayName))).toEqual(["Ada Example", "Bo Sample", "Cy Other"]);
    expect(list.map((c) => c.source)).toEqual(["contact", "contact", "other"]);
    expect(list[0]?.id).toBe("a1:people/c1001");
    expect(calls.every((c) => c.authorization === `Bearer ${accessToken}`)).toBe(true);
    // The warm-up (empty query) precedes the real search on each endpoint.
    const forSearch = calls.filter((c) => c.url.startsWith(SEARCH));
    expect(forSearch.map((c) => q(c).get("query"))).toEqual(["", "ada"]);
    expect(q(forSearch[1] as GoogleCall).get("readMask")).toContain("emailAddresses");
    expect(q(forSearch[1] as GoogleCall).get("fields")).toContain("results(person(");
    const forOther = calls.filter((c) => c.url.startsWith(OTHER));
    expect(forOther.map((c) => q(c).get("query"))).toEqual(["", "ada"]);
    expect(q(forOther[1] as GoogleCall).get("readMask")).toBe("names,emailAddresses,phoneNumbers");
    // A second search on the same account does not warm up again.
    await call(ownerId, "search_contacts", { query: "bo" });
    expect(calls.filter((c) => q(c).get("query") === "")).toHaveLength(2);
  });

  it("wraps third-party text as untrusted", async () => {
    const { ownerId } = await setup();
    installGoogleRoutes(peopleRoutes());
    const { json } = await call(ownerId, "search_contacts", { query: "ada" });
    const first = (json.contacts as Record<string, unknown>[])[0] as Record<string, unknown>;
    const re = /^<untrusted-[0-9a-f]{12} source="contact" account="a1">/;
    expect(first.displayName).toMatch(re);
    expect((first.emails as string[])[0]).toMatch(re);
    expect((first.phones as string[])[0]).toMatch(re);
    const org = (first.organizations as Record<string, string>[])[0] as Record<string, string>;
    expect(org.name).toMatch(re);
    expect(org.title).toMatch(re);
    expect(first.notes).toMatch(re);
  });

  it('merges two accounts with account "all"', async () => {
    const ownerId = await newOwner();
    await linkGoogleAccount(ownerId, { label: "work" });
    await linkGoogleAccount(ownerId, { label: "home" });
    const calls = installGoogleRoutes(peopleRoutes());
    const { json } = await call(ownerId, "search_contacts", {
      query: "ada",
      account: "all",
      pageSize: 30,
    });
    const list = json.contacts as { id: string; account: string }[];
    expect(list).toHaveLength(6);
    expect(new Set(list.map((c) => c.account))).toEqual(new Set(["a1", "a2"]));
    expect(list.filter((c) => c.id.startsWith("a2:"))).toHaveLength(3);
    expect(new Set(calls.map((c) => c.authorization)).size).toBe(2);
  });

  it("skips an account whose contacts component is off; errors when none qualifies", async () => {
    const ownerId = await newOwner();
    await linkGoogleAccount(ownerId, { label: "work" });
    await linkGoogleAccount(ownerId, { label: "home", components: ["mail"] });
    installGoogleRoutes(peopleRoutes());
    const ok = await call(ownerId, "search_contacts", { query: "ada", account: "all" });
    const accounts = (ok.json.contacts as { account: string }[]).map((c) => c.account);
    expect(accounts.length).toBeGreaterThan(0);
    expect(accounts.every((a) => a === "a1")).toBe(true);

    const off = await newOwner();
    await linkGoogleAccount(off, { label: "work", components: ["mail"] });
    installGoogleRoutes([]);
    const res = await call(off, "search_contacts", { query: "ada", account: "all" });
    expect(res.json.error?.code).toBe("component_disabled");
    const one = await call(off, "search_contacts", { query: "ada" });
    expect(one.json.error?.code).toBe("component_disabled");
  });

  it("pages with a cursor across two accounts", async () => {
    const ownerId = await newOwner();
    await linkGoogleAccount(ownerId, { label: "work" });
    await linkGoogleAccount(ownerId, { label: "home" });
    installGoogleRoutes(peopleRoutes());
    const seen: string[] = [];
    let token: string | undefined;
    let pages = 0;
    do {
      const { json } = await call(ownerId, "search_contacts", {
        query: "x",
        account: "all",
        pageSize: 3,
        ...(token ? { pageToken: token } : {}),
      });
      for (const c of json.contacts as { id: string }[]) seen.push(c.id);
      token = json.nextPageToken as string | undefined;
      pages++;
    } while (token && pages < 6);
    // Each account has 3 distinct people (2 contacts + Cy; Ada's other entry is merged away).
    expect(seen.sort()).toEqual(
      [
        "a1:otherContacts/c2002",
        "a1:people/c1001",
        "a1:people/c1002",
        "a2:otherContacts/c2002",
        "a2:people/c1001",
        "a2:people/c1002",
      ].sort(),
    );
    expect(pages).toBe(2);
  });

  it("retries an empty first search once, after the warm-up", async () => {
    const { ownerId } = await setup();
    const prev = warmupRetry.ms;
    warmupRetry.ms = 1;
    try {
      let real = 0;
      const calls = installGoogleRoutes([
        {
          url: SEARCH,
          reply: (req) => {
            if (queryOf(req) === "") return googleJson(200, {});
            real++;
            return googleJson(200, real === 1 ? {} : fixture.searchContacts);
          },
        },
        { url: OTHER, reply: () => googleJson(200, {}) },
      ]);
      const { json } = await call(ownerId, "search_contacts", { query: "ada" });
      expect((json.contacts as unknown[]).length).toBe(2);
      expect(calls.filter((c) => c.url.startsWith(SEARCH))).toHaveLength(3);
    } finally {
      warmupRetry.ms = prev;
    }
  });

  it("rejects a pageToken from another query", async () => {
    const { ownerId } = await setup();
    installGoogleRoutes(peopleRoutes());
    const first = await call(ownerId, "search_contacts", { query: "ada", pageSize: 1 });
    const token = first.json.nextPageToken as string;
    expect(token).toBeTruthy();
    const res = await call(ownerId, "search_contacts", { query: "other", pageToken: token });
    expect(res.json.error?.code).toBe("invalid_argument");
  });

  it.each([
    [404, "not_found"],
    [429, "rate_limited"],
  ])("maps Google %i to %s", async (status, code) => {
    const { ownerId } = await setup();
    installGoogleRoutes([
      { url: SEARCH, reply: () => googleJson(status, { error: {} }) },
      { url: OTHER, reply: () => googleJson(200, {}) },
    ]);
    const res = await call(ownerId, "search_contacts", { query: "ada" });
    expect(res.isError).toBe(true);
    expect(res.json.error?.code).toBe(code);
  });

  it("maps a 403 insufficient scope to needs_relink or component_disabled", async () => {
    const { ownerId } = await setup();
    installGoogleRoutes([
      {
        url: SEARCH,
        reply: () =>
          googleJson(403, { error: { errors: [{ reason: "insufficientPermissions" }] } }),
      },
      { url: OTHER, reply: () => googleJson(200, {}) },
    ]);
    const res = await call(ownerId, "search_contacts", { query: "ada" });
    expect(res.isError).toBe(true);
    expect(["needs_relink", "component_disabled"]).toContain(res.json.error?.code);
  });

  it("refreshes once on a 401", async () => {
    const { ownerId } = await setup();
    installGoogleRoutes([
      {
        url: SEARCH,
        reply: (req, n) =>
          n === 0
            ? googleJson(401, {})
            : googleJson(200, queryOf(req) === "" ? {} : fixture.searchContacts),
      },
      { url: OTHER, reply: () => googleJson(200, {}) },
      tokenRoute("ya29.fresh"),
    ]);
    const res = await call(ownerId, "search_contacts", { query: "ada" });
    expect(res.isError).toBe(false);
  });
});

describe("get_contact", () => {
  it("returns one wrapped contact for a prefixed id", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([
      { url: `${P}/people/c1001`, reply: () => googleJson(200, fixture.person) },
    ]);
    const { json, isError } = await call(
      ownerId,
      "get_contact",
      { resourceName: "a1:people/c1001" },
      "ro",
    );
    expect(isError).toBe(false);
    const c = json.contact as Record<string, unknown>;
    expect(c.id).toBe("a1:people/c1001");
    expect(plain(c.displayName)).toBe("Ada Example");
    expect(String(c.displayName)).toMatch(/^<untrusted-/);
    expect(q(calls[0] as GoogleCall).get("personFields")).toContain("names");
  });

  it("maps a Google 404 to not_found", async () => {
    const { ownerId } = await setup();
    installGoogleRoutes([{ url: `${P}/people/c9`, reply: () => googleJson(404, { error: {} }) }]);
    const res = await call(ownerId, "get_contact", { resourceName: "people/c9" });
    expect(res.isError).toBe(true);
    expect(res.json.error?.code).toBe("not_found");
  });

  it("refuses an other-contact id and a malformed name without calling Google", async () => {
    const { ownerId } = await setup();
    const calls = installGoogleRoutes([]);
    for (const resourceName of [
      "a1:otherContacts/c2001",
      "a1:people/../x",
      "a1:people/..",
      "a1:people/.",
      "people/me",
    ]) {
      const res = await call(ownerId, "get_contact", { resourceName });
      expect(res.json.error?.code).toBe("invalid_argument");
    }
    expect(calls).toHaveLength(0);
  });

  it("answers component_disabled when contacts is off", async () => {
    const { ownerId } = await setup({ components: ["mail"] });
    installGoogleRoutes([]);
    const res = await call(ownerId, "get_contact", { resourceName: "people/c1" });
    expect(res.json.error?.code).toBe("component_disabled");
  });
});
