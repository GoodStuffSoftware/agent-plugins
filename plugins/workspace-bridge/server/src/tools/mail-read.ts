// The mail.read family (ARCHITECTURE s.2, s.5): `search_threads`, `get_thread`, `get_message`.
// Subjects, sender names, snippets, bodies and attachment names are written by others, so every
// one goes through `ctx.untrusted.wrap` (s.3.7).

import { z } from "zod";
import { mergePages, startFromCursor } from "../core/cursor";
import { ToolError } from "../core/errors";
import { accountKey } from "../core/ids";
import { MAX_BATCH_ITEMS } from "../providers/google/batch";
import { googleMailRead } from "../providers/google/mail-read";
import { defineTool, type Family, type ToolContext } from "../registry/types";
import { provide } from "../services/capability";
import {
  DEFAULT_MAX_BODY_CHARS,
  MAIL_READ,
  MAX_BODY_CHARS,
  type MailMessage,
  type MailReader,
  MESSAGE_FORMATS,
  type ThreadSummary,
} from "../services/mail-read";
import type { AccountRef } from "../services/types";

const ACCOUNT = z
  .string()
  .optional()
  .describe("Label, address or a1 of the account; the default account when omitted.");
const MAX_PAGE = 25;
const DEFAULT_PAGE = 20;
const MAX_MESSAGE_LIMIT = 25;
const DEFAULT_MESSAGE_LIMIT = 10;

const MESSAGE_FORMAT = z
  .enum(["MESSAGE_FORMAT_UNSPECIFIED", ...MESSAGE_FORMATS])
  .optional()
  .describe(
    "FULL_CONTENT (default) and PLAIN_TEXT return the text body (the text/plain part, else the HTML converted to text) and attachment details. MINIMAL returns the headers, subject and snippet without the body. METADATA_ONLY returns sender, recipients, date and labels only.",
  );
const MAX_BODY = z
  .number()
  .int()
  .min(100)
  .max(MAX_BODY_CHARS)
  .optional()
  .describe(
    `Characters kept per body (default ${DEFAULT_MAX_BODY_CHARS}, at most ${MAX_BODY_CHARS}); a longer body ends with a truncation marker.`,
  );
const INCLUDE_HTML = z
  .boolean()
  .optional()
  .describe("Also return the HTML body (cut to the same limit). Off by default.");

const normalFormat = (
  f: (typeof MESSAGE_FORMATS)[number] | "MESSAGE_FORMAT_UNSPECIFIED" | undefined,
) => (f === undefined || f === "MESSAGE_FORMAT_UNSPECIFIED" ? "FULL_CONTENT" : f);

const iso = (ms: number): string => new Date(ms).toISOString();
const viewUrl = (a: AccountRef, id: string): string =>
  `https://mail.google.com/mail/u/${encodeURIComponent(a.address)}/#all/${encodeURIComponent(id)}`;

/** A message as the tool returns it: ids prefixed, third-party text wrapped. */
function messageOut(m: MailMessage, a: AccountRef, ctx: ToolContext, format: string) {
  const wrap = (text: string) =>
    ctx.untrusted.wrap(text, {
      source: "email",
      account: accountKey(a.shortId),
      ...(m.from === "" ? {} : { from: m.from }),
    });
  const body = format === "FULL_CONTENT" || format === "PLAIN_TEXT";
  return {
    id: ctx.ids.encode(a, m.id),
    threadId: ctx.ids.encode(a, m.threadId),
    viewUrl: viewUrl(a, m.id),
    date: iso(m.date),
    labelIds: m.labelIds,
    sizeEstimate: m.sizeEstimate,
    ...(m.from === "" ? {} : { from: wrap(m.from) }),
    ...(m.to === "" ? {} : { to: wrap(m.to) }),
    ...(m.cc === "" ? {} : { cc: wrap(m.cc) }),
    ...(m.bcc === "" ? {} : { bcc: wrap(m.bcc) }),
    ...(format === "METADATA_ONLY" || m.subject === "" ? {} : { subject: wrap(m.subject) }),
    ...(format === "MINIMAL" && m.snippet !== "" ? { snippet: wrap(m.snippet) } : {}),
    ...(body && m.text !== undefined ? { text: wrap(m.text) } : {}),
    ...(body && m.html !== undefined ? { html: wrap(m.html) } : {}),
    ...(body ? { truncated: m.truncated } : {}),
    ...(body
      ? {
          attachments: m.attachments.map((x) => ({
            attachmentId: x.attachmentId,
            filename: wrap(x.filename),
            // The sender wrote the Content-Type too.
            mimeType: wrap(x.mimeType),
            size: x.size,
          })),
        }
      : {}),
  };
}

type Skipped = { account: string; code: string; message: string };

const searchThreads = defineTool({
  name: "search_threads",
  title: "Search mail threads",
  description:
    'Lists Gmail threads that match a query in Gmail search syntax (from:, subject:, newer_than:, is:unread, label:, has:attachment ...), newest first, with the thread id, message count, subject, last sender, snippet and date. Use get_thread with a thread id to read it. Pass account "all" to search every linked mailbox and merge the results by date; an account whose mail component is off is skipped and listed in skippedAccounts. Pass the nextPageToken of an earlier answer as pageToken for the next page.',
  component: "mail",
  scopes: ["mail.read"],
  endpoints: ["full", "ro"],
  annotations: { readOnlyHint: true, openWorldHint: false },
  untrusted: true,
  input: z.object({
    account: z
      .string()
      .optional()
      .describe(
        'Label, address or a1 of the account; "all" searches every linked account; the default account when omitted.',
      ),
    query: z
      .string()
      .max(2000)
      .optional()
      .describe("Gmail search query. Empty lists the newest threads."),
    labelIds: z
      .array(z.string().min(1).max(256))
      .max(20)
      .optional()
      .describe(
        "Only threads with all of these label ids (see list_labels), such as INBOX or UNREAD.",
      ),
    includeTrash: z
      .boolean()
      .optional()
      .describe("Also search Trash and Spam, which are left out by default."),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE)
      .optional()
      .describe(`Threads per page (default ${DEFAULT_PAGE}, at most ${MAX_PAGE}).`),
    pageToken: z
      .string()
      .max(40_000)
      .optional()
      .describe("The nextPageToken of an earlier answer."),
    view: z
      .enum(["THREAD_VIEW_UNSPECIFIED", "THREAD_VIEW_METADATA_ONLY", "THREAD_VIEW_MINIMAL"])
      .optional()
      .describe(
        "THREAD_VIEW_MINIMAL (default) includes subject and snippet; THREAD_VIEW_METADATA_ONLY leaves them out.",
      ),
  }),
  async handler(args, ctx) {
    const limit = args.pageSize ?? DEFAULT_PAGE;
    const accounts = await ctx.accounts.resolve(args.account, null, { allowAll: true });
    // S2: an account whose component is off, or whose provider cannot do this, is skipped.
    const eligible: { a: AccountRef; svc: MailReader }[] = [];
    const skipped: Skipped[] = [];
    let firstSkip: ToolError | undefined;
    for (const a of accounts) {
      try {
        eligible.push({ a, svc: ctx.use(MAIL_READ, a) });
      } catch (e) {
        const skip =
          e instanceof ToolError &&
          (e.code === "component_disabled" || e.code === "not_supported_by_provider");
        if (!skip) throw e;
        firstSkip ??= e;
        skipped.push({ account: accountKey(a.shortId), code: e.code, message: e.message });
      }
    }
    if (eligible.length === 0) {
      throw firstSkip ?? new ToolError("account_not_found", "No linked account.");
    }
    const keys = eligible.map(({ a }) => accountKey(a.shortId));
    const query = await ctx.cursors.queryHash({
      q: args.query ?? null,
      labelIds: args.labelIds ?? null,
      includeTrash: args.includeTrash ?? false,
      account: args.account ?? null,
    });
    const cursor = args.pageToken
      ? ctx.cursors.decode(args.pageToken, { tool: "search_threads", query })
      : null;

    type Item = { ms: number; out: Record<string, unknown> };
    const metadataOnly = args.view === "THREAD_VIEW_METADATA_ONLY";
    const toItem = (a: AccountRef, t: ThreadSummary): Item => {
      const wrap = (text: string) =>
        ctx.untrusted.wrap(text, {
          source: "email",
          account: accountKey(a.shortId),
          ...(t.from === "" ? {} : { from: t.from }),
        });
      return {
        ms: t.date,
        out: {
          id: ctx.ids.encode(a, t.id),
          viewUrl: viewUrl(a, t.id),
          messageCount: t.messageCount,
          date: iso(t.date),
          labelIds: t.labelIds,
          ...(t.from === "" ? {} : { from: wrap(t.from) }),
          ...(metadataOnly || t.subject === "" ? {} : { subject: wrap(t.subject) }),
          ...(metadataOnly || t.snippet === "" ? {} : { snippet: wrap(t.snippet) }),
        },
      };
    };

    const pages = await Promise.all(
      startFromCursor(cursor, keys).map(async (s) => {
        const found = eligible.find((e) => accountKey(e.a.shortId) === s.key);
        if (!found) throw new Error("search_threads: cursor account not eligible");
        // Fetch limit + skip threads so the merged page stays full.
        const page = await found.svc.search(found.a, {
          ...(args.query === undefined ? {} : { query: args.query }),
          ...(args.labelIds === undefined ? {} : { labelIds: args.labelIds }),
          includeSpamTrash: args.includeTrash ?? false,
          // One batch carries at most MAX_BATCH_ITEMS threads; a short page is fine for a cursor.
          pageSize: Math.min(limit + s.skip, MAX_BATCH_ITEMS),
          pageToken: s.tok,
        });
        return {
          key: s.key,
          tok: s.tok,
          skip: s.skip,
          next: page.nextPageToken ?? null,
          items: page.items.map((t) => toItem(found.a, t)),
        };
      }),
    );
    const merged = mergePages(pages, {
      tool: "search_threads",
      query,
      limit,
      keys,
      compare: (x, y) => y.ms - x.ms,
    });
    return {
      threads: merged.items.map((i) => i.out),
      ...(merged.nextPageToken === undefined ? {} : { nextPageToken: merged.nextPageToken }),
      ...(skipped.length === 0 ? {} : { skippedAccounts: skipped }),
    };
  },
});

const getThread = defineTool({
  name: "get_thread",
  title: "Read a mail thread",
  description:
    "Reads a Gmail thread: its messages with sender, recipients, subject, date, labels, text body and attachment details. Returns the newest messageLimit messages (default 10, at most 25) unless messageOffset (counted from the oldest message, starting at 0) says otherwise; totalMessages tells whether to page. Bodies are cut to maxBodyChars (default 8192, at most 32768) with a marker; the text/plain part is used when there is one, else the HTML is converted to text. One answer holds at most about 100000 characters of bodies and reads at most about 512 KB of messages in full, newest first: a message left out or cut by that limit says so in its text and has truncated true; read it with get_message. Drafts are left out.",
  component: "mail",
  scopes: ["mail.read"],
  endpoints: ["full", "ro"],
  annotations: { readOnlyHint: true, openWorldHint: false },
  untrusted: true,
  input: z.object({
    account: ACCOUNT,
    threadId: z.string().min(1).max(300).describe("A thread id from search_threads."),
    messageFormat: MESSAGE_FORMAT,
    messageOffset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Index of the first message to return, from the oldest (0). Default: the newest messageLimit.",
      ),
    messageLimit: z
      .number()
      .int()
      .min(1)
      .max(MAX_MESSAGE_LIMIT)
      .optional()
      .describe(
        `Messages to return (default ${DEFAULT_MESSAGE_LIMIT}, at most ${MAX_MESSAGE_LIMIT}).`,
      ),
    maxBodyChars: MAX_BODY,
    includeHtml: INCLUDE_HTML,
  }),
  async handler(args, ctx) {
    const d = ctx.ids.parse(args.threadId);
    const [a] = await ctx.accounts.resolve(args.account, d?.shortId);
    if (!a) throw new Error("unreachable: resolve returns one account");
    const format = normalFormat(args.messageFormat);
    const thread = await ctx.use(MAIL_READ, a).getThread(a, d?.providerId ?? args.threadId, {
      format,
      maxBodyChars: args.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS,
      includeHtml: args.includeHtml ?? false,
      messageLimit: args.messageLimit ?? DEFAULT_MESSAGE_LIMIT,
      ...(args.messageOffset === undefined ? {} : { messageOffset: args.messageOffset }),
    });
    return {
      id: ctx.ids.encode(a, thread.id),
      viewUrl: viewUrl(a, thread.id),
      totalMessages: thread.totalMessages,
      messageOffset: thread.messageOffset,
      messages: thread.messages.map((m) => messageOut(m, a, ctx, format)),
    };
  },
});

const getMessage = defineTool({
  name: "get_message",
  title: "Read a mail message",
  description:
    "Reads one Gmail message by id: sender, recipients, subject, date, labels, text body and attachment details. The body is cut to maxBodyChars (default 8192, at most 32768) with a marker; the text/plain part is used when there is one, else the HTML is converted to text.",
  component: "mail",
  scopes: ["mail.read"],
  endpoints: ["full", "ro"],
  annotations: { readOnlyHint: true, openWorldHint: false },
  untrusted: true,
  input: z.object({
    account: ACCOUNT,
    messageId: z.string().min(1).max(300).describe("A message id, from get_thread."),
    messageFormat: MESSAGE_FORMAT,
    maxBodyChars: MAX_BODY,
    includeHtml: INCLUDE_HTML,
  }),
  async handler(args, ctx) {
    const d = ctx.ids.parse(args.messageId);
    const [a] = await ctx.accounts.resolve(args.account, d?.shortId);
    if (!a) throw new Error("unreachable: resolve returns one account");
    const format = normalFormat(args.messageFormat);
    const m = await ctx.use(MAIL_READ, a).getMessage(a, d?.providerId ?? args.messageId, {
      format,
      maxBodyChars: args.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS,
      includeHtml: args.includeHtml ?? false,
    });
    return messageOut(m, a, ctx, format);
  },
});

export const mailRead: Family = {
  id: "mail.read",
  tools: [searchThreads, getThread, getMessage],
  bindings: { google: [provide(MAIL_READ, googleMailRead)] },
  parityPending: [],
};
