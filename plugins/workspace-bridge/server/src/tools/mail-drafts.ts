// The mail.drafts family (ARCHITECTURE s.2, s.5): create, read, list, change and delete drafts.
// Bodies and headers read back are third-party text, so they are wrapped. `create_draft` and
// `update_draft` take `attachments` in the official shape; they are checked (and the total capped)
// before any Google call.

import { z } from "zod";
import { startFromCursor } from "../core/cursor";
import { ToolError } from "../core/errors";
import { accountKey } from "../core/ids";
import { config } from "../env";
import { googleDrafts } from "../providers/google/mail-drafts";
import { defineTool, type Family, type ToolContext } from "../registry/types";
import { DRAFTS, type Draft, type DraftDepth } from "../services/mail-drafts";
import type { AccountRef } from "../services/types";
import {
  accountParam,
  assertSingleLine,
  attachmentsParam,
  bccParam,
  bodyParam,
  ccParam,
  checkAttachments,
  checkRecipients,
  fromParam,
  htmlBodyParam,
  replyToMessageIdParam,
  subjectParam,
  toParam,
} from "./mail-common";

const draftIdParam = z
  .string()
  .min(1)
  .max(512)
  .describe("The draft id, as returned by create_draft or list_drafts.");

/** The account and provider id of a (possibly prefixed) id: a bare id goes with the `account`. */
function idOf(ctx: ToolContext, id: string): { shortId: number | undefined; providerId: string } {
  const d = ctx.ids.parse(id);
  return d
    ? { shortId: d.shortId, providerId: d.providerId }
    : { shortId: undefined, providerId: id };
}

async function accountFor(
  ctx: ToolContext,
  selector: string | undefined,
  shortId?: number,
): Promise<AccountRef> {
  const [a] = await ctx.accounts.resolve(selector, shortId);
  if (!a) throw new ToolError("account_not_found", "No linked account matches this call.");
  return a;
}

/** A draft as the tool answers: prefixed ids, third-party text wrapped. Empty values are left out. */
function present(ctx: ToolContext, a: AccountRef, d: Draft): Record<string, unknown> {
  const account = accountKey(a.shortId);
  const wrap = (text: string, from?: string) =>
    ctx.untrusted.wrap(text, { source: "email", account, ...(from ? { from } : {}) });
  const text = (s: string | undefined) => (s ? wrap(s, d.from) : undefined);
  const addresses = (list: string[] | undefined) =>
    list && list.length > 0 ? wrap(list.join(", "), d.from) : undefined;
  const out: Record<string, unknown> = {
    draftId: ctx.ids.encode(a, d.id),
    messageId: ctx.ids.encode(a, d.messageId),
    threadId: ctx.ids.encode(a, d.threadId),
    viewUrl: d.viewUrl,
    account,
    labelIds: d.labelIds,
    from: text(d.from),
    to: addresses(d.to),
    cc: addresses(d.cc),
    bcc: addresses(d.bcc),
    subject: text(d.subject),
    date: d.date,
    snippet: text(d.snippet),
    plaintextBody: text(d.plaintextBody),
    htmlBody: text(d.htmlBody),
    raw: text(d.raw),
    attachments: d.attachments?.map((f) => ({
      attachmentId: ctx.ids.encode(a, f.attachmentId),
      filename: wrap(f.filename, d.from),
      mimeType: f.mimeType,
      size: f.size,
    })),
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/** What a write answers: ids and the link, no content. */
const written = (ctx: ToolContext, a: AccountRef, d: Draft) => ({
  draftId: ctx.ids.encode(a, d.id),
  messageId: ctx.ids.encode(a, d.messageId),
  threadId: ctx.ids.encode(a, d.threadId),
  viewUrl: d.viewUrl,
  account: accountKey(a.shortId),
});

const createDraft = defineTool({
  name: "create_draft",
  title: "Create a draft",
  description:
    "Creates a draft email in the account. Nothing is sent. With `replyToMessageId` the draft is a reply: it is threaded under that message, the subject and To default from it (the original sender, minus the account's own addresses) and the original is quoted below your text. `includeSignature` appends the account's Gmail signature. The body is plain text (`body`), HTML (`htmlBody`) or both; HTML alone gets a text alternative made from it. `attachments` adds files (base64 `content`, optional `filename` and `mimeType`; all files together within the server's send size limit).",
  component: "mail",
  scopes: ["mail.write"],
  endpoints: ["full", "ro"],
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  input: z.object({
    account: accountParam,
    to: toParam,
    cc: ccParam,
    bcc: bccParam,
    subject: subjectParam,
    body: bodyParam,
    htmlBody: htmlBodyParam,
    from: fromParam,
    replyToMessageId: replyToMessageIdParam,
    includeSignature: z
      .boolean()
      .optional()
      .describe("Append the account's Gmail signature for the From address."),
    attachments: attachmentsParam,
  }),
  async handler(args, ctx) {
    const attached = checkAttachments(ctx.env, args.attachments);
    assertSingleLine("subject", args.subject);
    const reply = args.replyToMessageId ? idOf(ctx, args.replyToMessageId) : undefined;
    const a = await accountFor(ctx, args.account, reply?.shortId);
    const drafts = ctx.use(DRAFTS, a);
    const recipients = checkRecipients(ctx.env, args);
    const from = await ctx.sendAs.assertFrom(a, args.from);
    const self = (await ctx.sendAs.list(a)).map((s) => s.email);
    const draft = await drafts.create(a, {
      ...recipients,
      ...(args.subject === undefined ? {} : { subject: args.subject }),
      ...(args.body === undefined ? {} : { body: args.body }),
      ...(args.htmlBody === undefined ? {} : { htmlBody: args.htmlBody }),
      ...(args.from === undefined ? {} : { from }),
      ...(args.includeSignature ? { includeSignature: true } : {}),
      ...(reply ? { replyToMessageId: reply.providerId } : {}),
      selfAddresses: self,
      ...(attached.files.length ? { attachments: attached.files } : {}),
    });
    return written(ctx, a, draft);
  },
});

const FORMATS = [
  "MESSAGE_FORMAT_UNSPECIFIED",
  "MINIMAL",
  "FULL_CONTENT",
  "METADATA_ONLY",
  "PLAIN_TEXT",
  "RAW",
] as const;

const DEPTH: Record<(typeof FORMATS)[number], DraftDepth> = {
  MESSAGE_FORMAT_UNSPECIFIED: "full",
  FULL_CONTENT: "full",
  MINIMAL: "headers",
  METADATA_ONLY: "minimal",
  PLAIN_TEXT: "plain",
  RAW: "raw",
};

const getDraft = defineTool({
  name: "get_draft",
  title: "Get a draft",
  description:
    "Reads one draft. `messageFormat`: FULL_CONTENT (default) gives headers, text and HTML bodies and attachments; PLAIN_TEXT leaves out the HTML; MINIMAL gives headers and the snippet; METADATA_ONLY gives ids and labels; RAW gives the whole RFC 822 text, cut at 64,000 characters.",
  component: "mail",
  scopes: ["mail.read"],
  endpoints: ["full", "ro"],
  annotations: { readOnlyHint: true, openWorldHint: false },
  untrusted: true,
  input: z.object({
    account: accountParam,
    draftId: draftIdParam,
    messageFormat: z.enum(FORMATS).optional().describe("How much of the draft to return."),
  }),
  async handler(args, ctx) {
    const id = idOf(ctx, args.draftId);
    const a = await accountFor(ctx, args.account, id.shortId);
    const draft = await ctx
      .use(DRAFTS, a)
      .get(a, id.providerId, DEPTH[args.messageFormat ?? "FULL_CONTENT"]);
    return present(ctx, a, draft);
  },
});

const VIEWS = ["DRAFT_VIEW_UNSPECIFIED", "DRAFT_VIEW_METADATA_ONLY", "DRAFT_VIEW_FULL"] as const;
const MAX_PAGE = 50;
/** Full bodies cost more to read and to return, so a full page is smaller. */
const MAX_FULL_PAGE = 25;

const listDrafts = defineTool({
  name: "list_drafts",
  title: "List drafts",
  description:
    "Lists the account's drafts, newest first. `view`: DRAFT_VIEW_METADATA_ONLY (default) gives headers and the snippet; DRAFT_VIEW_FULL adds the text body (first 4,000 characters), the HTML body and attachments, and returns at most 25 drafts per page. `query` is a Gmail search expression. `pageSize` is 20 by default, 50 at most; pass `nextPageToken` as `pageToken` for the next page.",
  component: "mail",
  scopes: ["mail.read"],
  endpoints: ["full", "ro"],
  annotations: { readOnlyHint: true, openWorldHint: false },
  untrusted: true,
  input: z.object({
    account: accountParam,
    query: z.string().max(1024).optional().describe("A Gmail search expression."),
    pageSize: z.number().int().min(1).max(MAX_PAGE).optional().describe("Drafts per page."),
    pageToken: z
      .string()
      .max(4096)
      .optional()
      .describe("The `nextPageToken` of the previous page."),
    view: z.enum(VIEWS).optional().describe("How much of each draft to return."),
  }),
  async handler(args, ctx) {
    const a = await accountFor(ctx, args.account);
    const drafts = ctx.use(DRAFTS, a);
    const full = args.view === "DRAFT_VIEW_FULL";
    const key = accountKey(a.shortId);
    const query = await ctx.cursors.queryHash({
      account: key,
      query: args.query ?? null,
      view: full ? "full" : "metadata",
    });
    const cursor = args.pageToken
      ? ctx.cursors.decode(args.pageToken, { tool: "list_drafts", query })
      : null;
    const [start] = startFromCursor(cursor, [key]);
    const pageSize = Math.min(args.pageSize ?? 20, full ? MAX_FULL_PAGE : MAX_PAGE);
    const page = await drafts.list(a, {
      ...(args.query ? { query: args.query } : {}),
      pageSize,
      pageToken: start?.tok ?? null,
      full,
    });
    const nextPageToken = page.nextPageToken
      ? ctx.cursors.encode({
          v: 1,
          t: "list_drafts",
          q: query,
          p: { [key]: { tok: page.nextPageToken, skip: 0 } },
        })
      : undefined;
    return {
      drafts: page.items.map((d) => present(ctx, a, d)),
      ...(nextPageToken ? { nextPageToken } : {}),
    };
  },
});

const updateDraft = defineTool({
  name: "update_draft",
  title: "Update a draft",
  description:
    "Changes a draft. Fields you leave out or pass empty keep their value. Sending `body` alone replaces the text and removes the HTML; sending `htmlBody` alone replaces the HTML and rebuilds the text from it. The draft's attachments are kept unless you pass `attachments`, which replaces all of them (an empty list keeps them). A reply draft stays in its thread.",
  component: "mail",
  scopes: ["mail.write"],
  endpoints: ["full", "ro"],
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.object({
    account: accountParam,
    draftId: draftIdParam,
    to: toParam,
    cc: ccParam,
    bcc: bccParam,
    subject: subjectParam,
    body: bodyParam,
    htmlBody: htmlBodyParam,
    from: fromParam,
    attachments: attachmentsParam,
  }),
  async handler(args, ctx) {
    const attached = checkAttachments(ctx.env, args.attachments);
    assertSingleLine("subject", args.subject);
    const id = idOf(ctx, args.draftId);
    const a = await accountFor(ctx, args.account, id.shortId);
    const drafts = ctx.use(DRAFTS, a);
    const some = <T>(list: T[] | undefined): T[] | undefined => (list?.length ? list : undefined);
    const recipients = checkRecipients(ctx.env, args);
    const from = args.from ? await ctx.sendAs.assertFrom(a, args.from) : undefined;
    const to = some(recipients.to);
    const cc = some(recipients.cc);
    const bcc = some(recipients.bcc);
    const draft = await drafts.update(a, id.providerId, {
      ...(to ? { to } : {}),
      ...(cc ? { cc } : {}),
      ...(bcc ? { bcc } : {}),
      ...(args.subject ? { subject: args.subject } : {}),
      ...(args.body ? { body: args.body } : {}),
      ...(args.htmlBody ? { htmlBody: args.htmlBody } : {}),
      ...(from ? { from } : {}),
      ...(attached.files.length ? { attachments: attached.files } : {}),
      maxAttachmentBytes: config(ctx.env).maxSendAttachmentBytes,
    });
    return written(ctx, a, draft);
  },
});

const deleteDraft = defineTool({
  name: "delete_draft",
  title: "Delete a draft",
  description: "Permanently deletes a draft. It does not go to the trash and cannot be restored.",
  component: "mail",
  scopes: ["mail.write"],
  endpoints: ["full"],
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  input: z.object({ account: accountParam, draftId: draftIdParam }),
  async handler(args, ctx) {
    const id = idOf(ctx, args.draftId);
    const a = await accountFor(ctx, args.account, id.shortId);
    await ctx.use(DRAFTS, a).remove(a, id.providerId);
    return {
      deleted: true,
      draftId: ctx.ids.encode(a, id.providerId),
      account: accountKey(a.shortId),
    };
  },
});

export const mailDrafts: Family = {
  id: "mail.drafts",
  tools: [createDraft, getDraft, listDrafts, updateDraft, deleteDraft],
  bindings: { google: [googleDrafts] },
  parityPending: [],
};
