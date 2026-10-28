// Contacts over the People API v1 (contacts.readonly, contacts.other.readonly).

import { ToolError } from "../../core/errors";
import type { ContactInfo, ContactService } from "../../services/contacts";
import type { AccountRef } from "../../services/types";
import { gjson } from "./http";

const BASE = "https://people.googleapis.com/v1";
/** Both search endpoints cap pageSize at 30 and have no page token. */
export const SEARCH_CAP = 30;

const CONTACT_MASK = "names,emailAddresses,phoneNumbers,organizations,biographies";
const OTHER_MASK = "names,emailAddresses,phoneNumbers";
const PERSON_FIELDS =
  "resourceName,names(displayName),emailAddresses(value),phoneNumbers(value),organizations(name,title),biographies(value)";
const RESULT_FIELDS = `results(person(${PERSON_FIELDS}))`;

interface Person {
  resourceName?: string;
  names?: { displayName?: string }[];
  emailAddresses?: { value?: string }[];
  phoneNumbers?: { value?: string }[];
  organizations?: { name?: string; title?: string }[];
  biographies?: { value?: string }[];
}

function toInfo(p: Person, source: ContactInfo["source"]): ContactInfo | null {
  if (!p.resourceName) return null;
  const strs = (xs?: { value?: string }[]) =>
    (xs ?? []).map((x) => x.value).filter((v): v is string => !!v);
  const info: ContactInfo = {
    id: p.resourceName,
    source,
    emails: strs(p.emailAddresses),
    phones: strs(p.phoneNumbers),
    organizations: (p.organizations ?? [])
      .filter((o) => o.name || o.title)
      .map((o) => ({
        ...(o.name ? { name: o.name } : {}),
        ...(o.title ? { title: o.title } : {}),
      })),
  };
  const name = p.names?.[0]?.displayName;
  if (name) info.displayName = name;
  const notes = p.biographies?.[0]?.value;
  if (notes) info.notes = notes;
  return info;
}

/**
 * Google documents that the search endpoints answer from a per-user cache that a first,
 * empty-query request fills; without it the first real search can come back empty. The warm-up
 * runs once per account and source for the life of the isolate.
 */
const warmed = new Set<string>();

async function search(
  a: AccountRef,
  source: ContactInfo["source"],
  query: string,
  limit: number,
): Promise<ContactInfo[]> {
  const url =
    source === "contact" ? `${BASE}/people:searchContacts` : `${BASE}/otherContacts:search`;
  const readMask = source === "contact" ? CONTACT_MASK : OTHER_MASK;
  const key = `${a.accountId}:${source}`;
  if (!warmed.has(key)) {
    await gjson(a, url, {}, { query: { query: "", readMask, pageSize: 1 }, fields: "results" });
    warmed.add(key);
  }
  const r = await gjson<{ results?: { person?: Person }[] }>(
    a,
    url,
    {},
    { query: { query, readMask, pageSize: Math.min(limit, SEARCH_CAP) }, fields: RESULT_FIELDS },
  );
  return (r?.results ?? [])
    .map((x) => (x.person ? toInfo(x.person, source) : null))
    .filter((x): x is ContactInfo => x !== null);
}

const norm = (e: string) => e.trim().toLowerCase();

export const googleContacts: ContactService = {
  async search(a, query, limit) {
    const [own, other] = await Promise.all([
      search(a, "contact", query, limit),
      search(a, "other", query, limit),
    ]);
    const seen = new Set(own.flatMap((c) => c.emails.map(norm)));
    const out = [...own];
    for (const c of other) {
      const mine = c.emails.map(norm);
      if (mine.length > 0 && mine.every((e) => seen.has(e))) continue;
      for (const e of mine) seen.add(e);
      out.push(c);
    }
    return out.slice(0, limit);
  },

  async get(a, resourceName) {
    if (!/^people\/[A-Za-z0-9._-]+$/.test(resourceName)) {
      throw new ToolError(
        "invalid_argument",
        'resourceName must look like "people/c123". Other contacts cannot be fetched by id; search_contacts returns their full details.',
      );
    }
    const p = await gjson<Person>(
      a,
      `${BASE}/${resourceName}`,
      {},
      { query: { personFields: CONTACT_MASK }, fields: PERSON_FIELDS },
    );
    const info = p ? toInfo(p, "contact") : null;
    if (!info) throw new ToolError("not_found", "No such contact.");
    return info;
  },
};
