// Gmail binding of the mail.drafts capability (plan s.8.2, s.3.4).
//
// Drafts are written through Gmail's media upload, never as a base64url `raw` string: the raw
// RFC 822 text goes up as the request body (`uploadType=media`, `Content-Type: message/rfc822`),
// which spares the base64 pass on the Worker's 10 ms CPU budget. A plain media upload cannot carry
// a `threadId`, so a reply draft (and an update of one) uses `uploadType=multipart`: a
// `multipart/related` body with the JSON metadata `{"message":{"threadId":...}}` and the
// `message/rfc822` part.
//
// `list` reads each draft with one batch request (`/batch/gmail/v1`), a single subrequest for up
// to 50 drafts, against the free tier's 50 subrequests per request.

import { ToolError } from "../../core/errors";
import {
  b64urlToBytes,
  buildRfc822,
  decodeEncodedWords,
  escapeHtml,
  extractBody,
  extractHtmlBody,
  type GmailPart,
  headerOf,
  htmlToText,
  listAttachments,
  normalizeMessageId,
  parseAddresses,
  quoteHtml,
  quotePlain,
  readAddressList,
  replyRecipients,
  replySubject,
  sanitizeReferences,
  singleLine,
  truncate,
} from "../../core/mime";
import { provide } from "../../services/capability";
import {
  type CreateDraftInput,
  DRAFTS,
  type Draft,
  type DraftDepth,
  type DraftService,
  type UpdateDraftInput,
} from "../../services/mail-drafts";
import type { AccountRef } from "../../services/types";
import { gfetch, gjson, googleError } from "./http";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const UPLOAD = "https://gmail.googleapis.com/upload/gmail/v1/users/me";
const BATCH = "https://gmail.googleapis.com/batch/gmail/v1";

const MAX_TEXT = 50_000;
const MAX_HTML = 100_000;
const MAX_RAW = 64_000;
/** The part of the answered message that is quoted into a reply draft. */
const MAX_QUOTE = 20_000;
/** A body shown in a list is cut here; `get_draft` has the whole body. */
const MAX_LIST_BODY = 4_000;
const HEADER_NAMES = ["From", "To", "Cc", "Bcc", "Subject", "Date"];

interface GmailMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  raw?: string;
  payload?: GmailPart;
}
interface GmailDraft {
  id?: string;
  message?: GmailMessage;
}

const FIELDS = {
  minimal: "id,message(id,threadId,labelIds)",
  headers: "id,message(id,threadId,labelIds,snippet,payload(headers))",
  full: "id,message(id,threadId,labelIds,snippet,payload)",
  raw: "id,message(id,threadId,labelIds,raw)",
} as const;
const WRITE_FIELDS = "id,message(id,threadId)";

const FORMAT: Record<DraftDepth, string> = {
  minimal: "minimal",
  headers: "metadata",
  full: "full",
  plain: "full",
  raw: "raw",
};
const FIELDS_OF: Record<DraftDepth, string> = {
  minimal: FIELDS.minimal,
  headers: FIELDS.headers,
  full: FIELDS.full,
  plain: FIELDS.full,
  raw: FIELDS.raw,
};

const enc = encodeURIComponent;

const viewUrl = (a: AccountRef, messageId: string): string =>
  `https://mail.google.com/mail/u/${enc(a.address)}/#drafts?compose=${enc(messageId)}`;

/** A Google answer that lacks what every answer has (an id): not the caller's doing. */
const malformed = (): ToolError =>
  new ToolError("upstream_error", "Google sent a draft in an unexpected shape.");

function summary(a: AccountRef, g: GmailDraft): Draft {
  if (!g.id || !g.message?.id) throw malformed();
  return {
    id: g.id,
    messageId: g.message.id,
    threadId: g.message.threadId ?? g.message.id,
    viewUrl: viewUrl(a, g.message.id),
  };
}

// ---- Reading -------------------------------------------------------------------------------------

const list = (header: string | undefined): string[] => readAddressList(header);

function toDraft(a: AccountRef, g: GmailDraft, depth: DraftDepth, bodyLimit?: number): Draft {
  const base = summary(a, g);
  const m = g.message ?? {};
  const out: Draft = { ...base };
  if (m.labelIds) out.labelIds = m.labelIds;
  if (depth === "minimal") return out;
  if (depth === "raw") {
    if (m.raw) out.raw = truncate(new TextDecoder().decode(b64urlToBytes(m.raw)), MAX_RAW);
    return out;
  }
  const p = m.payload;
  const h = (name: string) => headerOf(p, name);
  const from = h("From");
  if (from !== undefined) out.from = singleLine(decodeEncodedWords(from));
  out.to = list(h("To"));
  out.cc = list(h("Cc"));
  out.bcc = list(h("Bcc"));
  out.subject = singleLine(decodeEncodedWords(h("Subject") ?? ""));
  const date = h("Date");
  if (date !== undefined) out.date = date;
  if (m.snippet !== undefined) out.snippet = m.snippet;
  if (depth === "headers") return out;
  out.plaintextBody = truncate(extractBody(p), bodyLimit ?? MAX_TEXT);
  if (depth === "full") out.htmlBody = truncate(extractHtmlBody(p), bodyLimit ?? MAX_HTML);
  out.attachments = listAttachments(p);
  return out;
}

async function fetchDraft(a: AccountRef, id: string, depth: DraftDepth): Promise<GmailDraft> {
  return gjson<GmailDraft>(
    a,
    `${BASE}/drafts/${enc(id)}`,
    {},
    {
      fields: FIELDS_OF[depth],
      query: {
        format: FORMAT[depth],
        metadataHeaders: depth === "headers" ? HEADER_NAMES : undefined,
      },
    },
  );
}

// ---- Writing -------------------------------------------------------------------------------------

/**
 * Sends the RFC 822 text as the draft. Without a thread the plain media upload carries it as the
 * request body; with one the multipart form adds the thread id the media upload has no place for.
 */
async function upload(
  a: AccountRef,
  method: "POST" | "PUT",
  draftId: string | null,
  raw: string,
  threadId: string | undefined,
): Promise<GmailDraft> {
  const url = `${UPLOAD}/drafts${draftId ? `/${enc(draftId)}` : ""}`;
  if (!threadId) {
    return gjson<GmailDraft>(
      a,
      url,
      { method, headers: { "Content-Type": "message/rfc822" }, body: raw },
      { fields: WRITE_FIELDS, query: { uploadType: "media" } },
    );
  }
  const boundary = `wb_${crypto.randomUUID()}`;
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify({ message: { threadId } }),
    `--${boundary}`,
    "Content-Type: message/rfc822",
    "",
    raw,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return gjson<GmailDraft>(
    a,
    url,
    { method, headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body },
    { fields: WRITE_FIELDS, query: { uploadType: "multipart" } },
  );
}

const addressLine = (displayName: string | null, email: string): string =>
  displayName ? `${displayName} <${email}>` : email;

/**
 * The message a reply answers, as `create` and the M15 reply tools need it: the threading headers
 * (`inReplyTo` and `references` are ready for the builder), the sender and recipients, and the
 * text to quote. `self` lists the account's own addresses, which a reply leaves out.
 */
export interface ReplyContext {
  threadId: string;
  /** `<id@host>`, or undefined when the original has no usable Message-ID. */
  inReplyTo: string | undefined;
  references: string | undefined;
  subject: string;
  from: string;
  date: string;
  /** Reply recipients by the plain rule: Reply-To else From, self removed. */
  replyTo: string[];
  replyCc: string[];
  /** The original's text, cut to `MAX_QUOTE` characters. */
  body: string;
}

export async function replyContext(
  a: AccountRef,
  messageId: string,
  self: readonly string[],
): Promise<ReplyContext> {
  const m = await gjson<GmailMessage>(
    a,
    `${BASE}/messages/${enc(messageId)}`,
    {},
    { fields: "id,threadId,payload", query: { format: "full" } },
  );
  if (!m.id) throw malformed();
  const p = m.payload;
  const h = (name: string) => headerOf(p, name);
  const inReplyTo = normalizeMessageId(h("Message-ID") ?? "") ?? undefined;
  const { to, cc } = replyRecipients({
    self: [...self],
    from: parseAddresses(h("From")),
    to: parseAddresses(h("To")),
    cc: parseAddresses(h("Cc")),
    replyTo: parseAddresses(h("Reply-To")),
  });
  return {
    threadId: m.threadId ?? m.id,
    inReplyTo,
    references: sanitizeReferences(h("References"), inReplyTo),
    subject: replySubject(h("Subject")),
    from: singleLine(decodeEncodedWords(h("From") ?? "")),
    date: h("Date") ?? "",
    replyTo: to,
    replyCc: cc,
    body: truncate(extractBody(p), MAX_QUOTE),
  };
}

async function signatureOf(a: AccountRef, email: string): Promise<string> {
  const s = await gjson<{ signature?: string }>(
    a,
    `${BASE}/settings/sendAs/${enc(email)}`,
    {},
    { fields: "signature" },
  );
  return s.signature ?? "";
}

/**
 * The text and HTML a draft carries. HTML given alone gets a text alternative made from it; text
 * given alone stays text unless a signature (HTML) or nothing else calls for HTML.
 */
function compose(parts: {
  body?: string | undefined;
  htmlBody?: string | undefined;
  signature?: string | undefined;
  quote?: { plain: string; html: string } | undefined;
}): { body: string; htmlBody?: string } {
  let text = parts.body ?? (parts.htmlBody ? htmlToText(parts.htmlBody) : "");
  let html =
    parts.htmlBody ?? (parts.signature ? escapeHtml(text).replace(/\n/g, "<br>\n") : undefined);
  if (parts.signature) {
    text += `\n\n-- \n${htmlToText(parts.signature)}`;
    html = `${html ?? ""}<br>\n-- <br>\n${parts.signature}`;
  }
  if (parts.quote) {
    text = text ? `${text}\n\n${parts.quote.plain}` : parts.quote.plain;
    if (html !== undefined) html += `\n${parts.quote.html}`;
  }
  return html === undefined ? { body: text } : { body: text, htmlBody: html };
}

async function create(a: AccountRef, input: CreateDraftInput): Promise<Draft> {
  let to = input.to;
  let subject = input.subject;
  let inReplyTo: string | undefined;
  let references: string | undefined;
  let threadId: string | undefined;
  let quote: { plain: string; html: string } | undefined;
  if (input.replyToMessageId) {
    const ctx = await replyContext(a, input.replyToMessageId, input.selfAddresses);
    threadId = ctx.threadId;
    inReplyTo = ctx.inReplyTo;
    references = ctx.references;
    subject ??= ctx.subject;
    if (to.length === 0) to = ctx.replyTo;
    if (ctx.body) {
      quote = {
        plain: quotePlain(ctx.from, ctx.date, ctx.body),
        html: quoteHtml(ctx.from, ctx.date, ctx.body),
      };
    }
  }
  const signature = input.includeSignature
    ? await signatureOf(a, input.from?.email ?? a.address)
    : undefined;
  const text = compose({
    body: input.body,
    htmlBody: input.htmlBody,
    signature: signature || undefined,
    quote,
  });
  const raw = buildRfc822({
    to,
    cc: input.cc,
    bcc: input.bcc,
    ...(input.from ? { from: addressLine(input.from.displayName, input.from.email) } : {}),
    subject: subject ?? "",
    ...text,
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references ? { references } : {}),
  });
  return summary(a, await upload(a, "POST", null, raw, threadId));
}

async function update(a: AccountRef, draftId: string, input: UpdateDraftInput): Promise<Draft> {
  const current = await fetchDraft(a, draftId, "full");
  const m = current.message;
  if (!m?.id) throw malformed();
  const p = m.payload;
  const h = (name: string) => headerOf(p, name);
  const inReplyTo = normalizeMessageId(h("In-Reply-To") ?? "") ?? undefined;
  const references = sanitizeReferences(h("References"));

  // Fields left out keep what the draft has. Text without HTML drops the HTML and the other way
  // round, as the official tool does; attachments are not carried over.
  let body: string;
  let htmlBody: string | undefined;
  if (input.body === undefined && input.htmlBody === undefined) {
    body = extractBody(p);
    htmlBody = extractHtmlBody(p) || undefined;
  } else {
    const text = compose({ body: input.body, htmlBody: input.htmlBody });
    body = text.body;
    htmlBody = text.htmlBody;
  }
  const fromHeader = input.from
    ? addressLine(input.from.displayName, input.from.email)
    : list(h("From"))[0];
  const raw = buildRfc822({
    to: input.to ?? list(h("To")),
    cc: input.cc ?? list(h("Cc")),
    bcc: input.bcc ?? list(h("Bcc")),
    ...(fromHeader ? { from: fromHeader } : {}),
    subject: input.subject ?? singleLine(decodeEncodedWords(h("Subject") ?? "")),
    body,
    ...(htmlBody ? { htmlBody } : {}),
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references ? { references } : {}),
  });
  const threadId = inReplyTo ? m.threadId : undefined;
  return summary(a, await upload(a, "PUT", draftId, raw, threadId));
}

// ---- Listing -------------------------------------------------------------------------------------

/** Gets many drafts in one batch request; a draft deleted since the listing is left out. */
async function batchGet(
  a: AccountRef,
  ids: readonly string[],
  full: boolean,
): Promise<(GmailDraft | undefined)[]> {
  if (ids.length === 0) return [];
  const depth: DraftDepth = full ? "full" : "headers";
  const boundary = `wb_batch_${crypto.randomUUID()}`;
  const query = new URLSearchParams({ format: FORMAT[depth], fields: FIELDS_OF[depth] });
  if (!full) for (const n of HEADER_NAMES) query.append("metadataHeaders", n);
  const parts = ids.map((id, i) =>
    [
      `--${boundary}`,
      "Content-Type: application/http",
      `Content-ID: <item${i}>`,
      "",
      `GET /gmail/v1/users/me/drafts/${enc(id)}?${query.toString()}`,
      "",
    ].join("\r\n"),
  );
  const res = await gfetch(
    a,
    BATCH,
    {
      method: "POST",
      headers: { "Content-Type": `multipart/mixed; boundary=${boundary}` },
      body: `${parts.join("\r\n")}\r\n--${boundary}--\r\n`,
    },
    { retry: true, component: "mail" },
  );
  const answer = (res.headers.get("Content-Type") ?? "").match(/boundary="?([^";\s]+)"?/i)?.[1];
  const text = await res.text();
  if (!answer)
    throw new ToolError("upstream_error", "Google sent a batch reply of an unknown form.");
  const out: (GmailDraft | undefined)[] = new Array(ids.length).fill(undefined);
  const chunks = text.split(`--${answer}`).slice(1);
  let position = 0;
  for (const chunk of chunks) {
    if (/^--/.test(chunk)) break;
    const idMatch = chunk.match(/Content-ID:\s*<response-item(\d+)/i);
    const index = idMatch ? Number(idMatch[1]) : position;
    position++;
    const at = chunk.indexOf("HTTP/");
    if (at < 0 || index >= ids.length) continue;
    const inner = chunk.slice(at);
    const status = Number(inner.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/)?.[1] ?? 0);
    const split = inner.search(/\r?\n\r?\n/);
    const body = split < 0 ? "" : inner.slice(split).trim();
    if (status === 404) continue;
    if (status < 200 || status > 299) {
      throw googleError(a, status, new Headers(), body, { component: "mail" });
    }
    try {
      out[index] = JSON.parse(body) as GmailDraft;
    } catch {
      throw new ToolError("upstream_error", "Google sent a batch part that is not valid JSON.");
    }
  }
  return out;
}

async function listDrafts(
  a: AccountRef,
  opts: { query?: string; pageSize: number; pageToken?: string | null; full: boolean },
): Promise<{ items: Draft[]; nextPageToken?: string | undefined }> {
  const page = await gjson<{ drafts?: { id?: string }[]; nextPageToken?: string }>(
    a,
    `${BASE}/drafts`,
    {},
    {
      fields: "drafts(id),nextPageToken",
      query: { q: opts.query, maxResults: opts.pageSize, pageToken: opts.pageToken },
    },
  );
  const ids = (page.drafts ?? []).map((d) => d.id).filter((id): id is string => !!id);
  const got = await batchGet(a, ids, opts.full);
  const depth: DraftDepth = opts.full ? "full" : "headers";
  const items = got
    .filter((g): g is GmailDraft => g !== undefined)
    .map((g) => toDraft(a, g, depth, opts.full ? MAX_LIST_BODY : undefined));
  return { items, nextPageToken: page.nextPageToken };
}

const service: DraftService = {
  create,
  async get(a, draftId, depth) {
    return toDraft(a, await fetchDraft(a, draftId, depth), depth);
  },
  list: listDrafts,
  update,
  async remove(a, draftId) {
    await gfetch(a, `${BASE}/drafts/${enc(draftId)}`, { method: "DELETE" });
  },
};

export const googleDrafts = provide(DRAFTS, service);
