// The contacts family (ARCHITECTURE s.2, s.5): search_contacts, get_contact. No official connector
// exists, so there is no parity fixture and `parityPending` is empty.

import { z } from "zod";
import { mergePages, startFromCursor } from "../core/cursor";
import { ToolError } from "../core/errors";
import { accountKey } from "../core/ids";
import { googleContacts, SEARCH_CAP } from "../providers/google/contacts";
import { defineTool, type Family, type ToolContext } from "../registry/types";
import { provide } from "../services/capability";
import { CONTACTS, type ContactInfo, type ContactService } from "../services/contacts";
import type { AccountRef } from "../services/types";

function present(ctx: ToolContext, a: AccountRef, c: ContactInfo) {
  const wrap = (text: string) =>
    ctx.untrusted.wrap(text, { source: "contact", account: accountKey(a.shortId) });
  return {
    id: ctx.ids.encode(a, c.id),
    account: accountKey(a.shortId),
    source: c.source,
    ...(c.displayName ? { displayName: wrap(c.displayName) } : {}),
    emails: c.emails.map(wrap),
    phones: c.phones.map(wrap),
    organizations: c.organizations.map((o) => ({
      ...(o.name ? { name: wrap(o.name) } : {}),
      ...(o.title ? { title: wrap(o.title) } : {}),
    })),
    ...(c.notes ? { notes: wrap(c.notes) } : {}),
  };
}

const searchContacts = defineTool({
  name: "search_contacts",
  title: "Search contacts",
  description:
    'Searches the account\'s contacts and "other contacts" (people it has emailed) by name, email or phone. Each person appears once. Up to 30 matches per account are available, paged with pageToken. Accepts account "all".',
  component: "contacts",
  scopes: ["contacts"],
  endpoints: ["full", "ro"],
  untrusted: true,
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    query: z.string().min(1).describe("Name, email address or phone number to look for."),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(SEARCH_CAP)
      .optional()
      .describe("Default 10, at most 30."),
    pageToken: z.string().optional(),
    account: z
      .string()
      .optional()
      .describe('Label, address or a1, or "all"; the default account when omitted.'),
  }),
  async handler(args, ctx) {
    const limit = args.pageSize ?? 10;
    const accounts = await ctx.accounts.resolve(args.account, null, { allowAll: true });
    const eligible: { a: AccountRef; svc: ContactService }[] = [];
    let firstSkip: ToolError | undefined;
    for (const a of accounts) {
      try {
        eligible.push({ a, svc: ctx.use(CONTACTS, a) });
      } catch (e) {
        const skip =
          e instanceof ToolError &&
          (e.code === "component_disabled" || e.code === "not_supported_by_provider");
        if (!skip) throw e;
        firstSkip ??= e;
      }
    }
    if (eligible.length === 0) {
      throw firstSkip ?? new ToolError("account_not_found", "No linked account.");
    }
    const keys = eligible.map(({ a }) => accountKey(a.shortId));
    const query = await ctx.cursors.queryHash({ q: args.query, account: args.account ?? null });
    const cursor = args.pageToken
      ? ctx.cursors.decode(args.pageToken, { tool: "search_contacts", query })
      : null;
    const pages = await Promise.all(
      startFromCursor(cursor, keys).map(async (s) => {
        const { a, svc } = eligible.find(
          (e) => accountKey(e.a.shortId) === s.key,
        ) as (typeof eligible)[number];
        // The People search has no page token: every call re-reads the whole capped set (30) and
        // `skip` is the offset into it.
        const items = await svc.search(a, args.query, SEARCH_CAP);
        return {
          key: s.key,
          tok: s.tok,
          skip: s.skip,
          next: null,
          items: items.map((c) => present(ctx, a, c)),
        };
      }),
    );
    const merged = mergePages(pages, {
      tool: "search_contacts",
      query,
      limit,
      keys,
      compare: () => 0,
    });
    return { contacts: merged.items, nextPageToken: merged.nextPageToken };
  },
});

const getContact = defineTool({
  name: "get_contact",
  title: "Get contact",
  description:
    'Returns one of the account\'s own contacts by the id search_contacts gave. Ids of source "other" (people only emailed) are refused: search_contacts already returns their full details.',
  component: "contacts",
  scopes: ["contacts"],
  endpoints: ["full", "ro"],
  untrusted: true,
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    resourceName: z.string().min(1).describe('The contact id, for example "a1:people/c123".'),
    account: z
      .string()
      .optional()
      .describe("Label, address or a1; the default account when omitted."),
  }),
  async handler(args, ctx) {
    const d = ctx.ids.parse(args.resourceName);
    const [a] = await ctx.accounts.resolve(args.account, d?.shortId);
    if (!a) throw new ToolError("account_not_found", "No linked account.");
    const contact = await ctx.use(CONTACTS, a).get(a, d?.providerId ?? args.resourceName);
    return { contact: present(ctx, a, contact) };
  },
});

export const contacts: Family = {
  id: "contacts",
  tools: [searchContacts, getContact],
  bindings: { google: [provide(CONTACTS, googleContacts)] },
  parityPending: [],
};
