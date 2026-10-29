// Gmail binding of the mail.send capability (plan s.3.4, s.8.2).
//
// Messages go up through Gmail's media upload, never as a base64url `raw` string: the RFC 822 text
// is the request body (`uploadType=media`, `Content-Type: message/rfc822`), which spares the base64
// pass on the Worker's 10 ms CPU budget. A plain media upload cannot carry a `threadId`, so a
// threaded message uses `uploadType=multipart`: a `multipart/related` body with the JSON metadata
// `{"threadId":...}` and the `message/rfc822` part. A draft is sent by id (`drafts/send`).
//
// Files go in as base64 MIME parts, the client's own base64 re-wrapped and never decoded. A forward
// carries the original's files: `prepare` only reads their sizes (and refuses past the cap), and
// `deliver` downloads them, so nothing is fetched before the send guardrails have passed.
//
// Sending is never retried: gfetch does not retry a POST, and a second try could send twice.

import { ToolError } from "../../core/errors";
import {
  base64Bytes,
  buildRfc822,
  decodeEncodedWords,
  escapeHtml,
  extractBody,
  forwardHeaderBlock,
  forwardHtmlBlock,
  forwardSubject,
  type GmailPart,
  headerOf,
  htmlToText,
  listAttachments,
  MAX_ATTACHMENTS,
  type MimeAttachment,
  normalizeMessageId,
  type PartAttachment,
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
import type { SendAsAddress } from "../../core/send-as";
import { provide } from "../../services/capability";
import {
  type AttachmentTotals,
  type DraftEnvelope,
  type PreparedMessage,
  type PrepareInput,
  SEND,
  type SendService,
  type SentMessage,
} from "../../services/mail-send";
import type { AccountRef } from "../../services/types";
import { gjson } from "./http";
import { downloadAttachment, listMessageAttachments } from "./mail-attachments";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const UPLOAD = "https://gmail.googleapis.com/upload/gmail/v1/users/me";
/** The part of the original that is quoted or forwarded. */
const MAX_QUOTE = 20_000;
const SENT_FIELDS = "id,threadId,labelIds";

interface GmailMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  payload?: GmailPart;
}

const enc = encodeURIComponent;

/** A Google answer that lacks what every answer has (an id): not the caller's doing. */
const malformed = (): ToolError =>
  new ToolError("upstream_error", "Google sent a message in an unexpected shape.");

// ---- Reading the original ------------------------------------------------------------------------

interface Original {
  threadId: string;
  inReplyTo: string | undefined;
  references: string | undefined;
  subject: string;
  /** Display forms of the headers, decoded and on one line. */
  from: string;
  to: string;
  cc: string;
  date: string;
  fromAddresses: string[];
  toAddresses: string[];
  ccAddresses: string[];
  replyToAddresses: string[];
  body: string;
  attachments: PartAttachment[];
}

async function readOriginal(a: AccountRef, messageId: string): Promise<Original> {
  const m = await gjson<GmailMessage>(
    a,
    `${BASE}/messages/${enc(messageId)}`,
    {},
    { fields: "id,threadId,payload", query: { format: "full" } },
  );
  if (!m.id) throw malformed();
  const p = m.payload;
  const h = (name: string) => headerOf(p, name);
  const shown = (name: string) => singleLine(decodeEncodedWords(h(name) ?? ""));
  const inReplyTo = normalizeMessageId(h("Message-ID") ?? "") ?? undefined;
  return {
    threadId: m.threadId ?? m.id,
    inReplyTo,
    references: sanitizeReferences(h("References"), inReplyTo),
    subject: shown("Subject"),
    from: shown("From"),
    to: shown("To"),
    cc: shown("Cc"),
    date: h("Date") ?? "",
    fromAddresses: parseAddresses(h("From")),
    toAddresses: parseAddresses(h("To")),
    ccAddresses: parseAddresses(h("Cc")),
    replyToAddresses: parseAddresses(h("Reply-To")),
    body: truncate(extractBody(p), MAX_QUOTE),
    attachments: listAttachments(p),
  };
}

const totalsOf = (own: readonly MimeAttachment[], carried: readonly PartAttachment[] = []) => ({
  count: own.length + carried.length,
  bytes: own.reduce((n, f) => n + base64Bytes(f.content), 0) + carried.reduce((n, f) => n + f.size, 0),
});

async function prepare(a: AccountRef, input: PrepareInput): Promise<PreparedMessage> {
  if (input.kind === "send") {
    const attachments = input.attachments ?? [];
    const base: PreparedMessage = {
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject ?? "",
      body: input.body ?? (input.htmlBody ? htmlToText(input.htmlBody) : ""),
      ...(input.htmlBody ? { htmlBody: input.htmlBody } : {}),
      ...(input.replyThreadId ? { threadId: input.replyThreadId } : {}),
      attachments,
      attachmentTotals: totalsOf(attachments),
    };
    if (!input.replyToMessageId) return base;
    const o = await readOriginal(a, input.replyToMessageId);
    return {
      ...base,
      subject: input.subject ?? replySubject(o.subject),
      threadId: input.replyThreadId ?? o.threadId,
      ...(o.inReplyTo ? { inReplyTo: o.inReplyTo } : {}),
      ...(o.references ? { references: o.references } : {}),
    };
  }

  const o = await readOriginal(a, input.messageId);

  if (input.kind === "reply") {
    const defaults = replyRecipients({
      self: input.selfAddresses,
      from: o.fromAddresses,
      to: o.toAddresses,
      cc: o.ccAddresses,
      replyTo: o.replyToAddresses,
    });
    const to = input.to.length > 0 ? input.to : defaults.to;
    const asked = new Set(to.map((x) => (parseAddresses(x)[0] ?? x).toLowerCase()));
    const cc =
      input.cc.length > 0
        ? input.cc
        : input.replyAll
          ? defaults.cc.filter((x) => !asked.has(x.toLowerCase()))
          : [];
    const text = input.body ?? (input.htmlBody ? htmlToText(input.htmlBody) : "");
    return {
      to,
      cc,
      bcc: input.bcc,
      subject: replySubject(o.subject),
      body: text,
      ...(input.htmlBody ? { htmlBody: input.htmlBody } : {}),
      ...(o.body
        ? {
            quote: {
              plain: quotePlain(o.from, o.date, o.body),
              html: quoteHtml(o.from, o.date, o.body),
            },
          }
        : {}),
      ...(o.inReplyTo ? { inReplyTo: o.inReplyTo } : {}),
      ...(o.references ? { references: o.references } : {}),
      threadId: o.threadId,
      attachments: input.attachments ?? [],
      attachmentTotals: totalsOf(input.attachments ?? []),
    };
  }

  // Forward: the comments first, then the original under Gmail's usual header block. A forward
  // starts a new conversation, so it carries no threading headers.
  const fields = {
    from: o.from,
    date: o.date,
    subject: o.subject,
    to: o.to,
    cc: o.cc || undefined,
  };
  const text = input.forwardText ?? (input.htmlBody ? htmlToText(input.htmlBody) : "");
  const own = input.attachments ?? [];
  const carried = input.includeOriginalAttachments ? o.attachments : [];
  // The sizes the parts declare decide here, before anything is downloaded; `deliver` checks the
  // bytes it really gets. Over the cap is a refusal, never a forward with files missing.
  const totals = totalsOf(own, carried);
  if (totals.count > MAX_ATTACHMENTS) {
    throw new ToolError(
      "too_large",
      `A message may hold at most ${MAX_ATTACHMENTS} attachments; this forward would hold ${totals.count}. Set includeAttachments to false or give fewer files.`,
      { maxCount: MAX_ATTACHMENTS, count: totals.count },
    );
  }
  if (totals.bytes > input.maxAttachmentBytes) throw tooLargeForward(input.maxAttachmentBytes, totals.bytes);
  return {
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: forwardSubject(o.subject),
    body: text,
    ...(input.htmlBody ? { htmlBody: input.htmlBody } : {}),
    quote: {
      plain: `${forwardHeaderBlock(fields)}\n\n${o.body}`,
      html: forwardHtmlBlock({ ...fields, body: o.body }),
    },
    attachments: own,
    ...(carried.length > 0 ? { carried: { messageId: input.messageId, files: carried } } : {}),
    attachmentTotals: totals,
  };
}

const tooLargeForward = (cap: number, totalBytes?: number): ToolError =>
  new ToolError(
    "too_large",
    `The files of this forward are larger than the ${cap} byte send limit (the original's and yours together). Nothing was sent. Set includeAttachments to false to forward without the original's files.`,
    totalBytes === undefined ? { maxBytes: cap } : { maxBytes: cap, totalBytes },
  );

/** The original's files, fetched now that the send is allowed, within what the cap leaves. */
async function fetchCarried(
  a: AccountRef,
  m: PreparedMessage,
  cap: number,
): Promise<MimeAttachment[]> {
  if (!m.carried) return [];
  let used = m.attachments.reduce((n, f) => n + base64Bytes(f.content), 0);
  const out: MimeAttachment[] = [];
  for (const f of m.carried.files) {
    const got = await downloadOne(a, m.carried.messageId, f, cap - used).catch((e: unknown) => {
      throw e instanceof ToolError && e.code === "too_large" ? tooLargeForward(cap) : e;
    });
    used += got.bytes;
    out.push({ filename: f.filename, mimeType: f.mimeType, content: got.content });
  }
  return out;
}

async function downloadOne(
  a: AccountRef,
  messageId: string,
  f: PartAttachment,
  budget: number,
): Promise<{ content: string; bytes: number }> {
  try {
    return await downloadAttachment(a, messageId, f.attachmentId, budget);
  } catch (e) {
    // Gmail may hand out a new attachment id for the same part, which turns the old one stale.
    // The same file is then found again by name, type and size.
    const stale = e instanceof ToolError && (e.code === "not_found" || e.code === "invalid_argument");
    if (!stale) throw e;
    const again = (await listMessageAttachments(a, messageId)).find(
      (x) => x.filename === f.filename && x.mimeType === f.mimeType && x.size === f.size,
    );
    if (!again) throw e;
    return downloadAttachment(a, messageId, again.attachmentId, budget);
  }
}

// ---- Sending -------------------------------------------------------------------------------------

async function signatureOf(a: AccountRef, email: string): Promise<string> {
  const s = await gjson<{ signature?: string }>(
    a,
    `${BASE}/settings/sendAs/${enc(email)}`,
    {},
    { fields: "signature" },
  );
  return s.signature ?? "";
}

/** The text and HTML the message carries: comments, then signature, then the quoted original. */
function compose(
  m: PreparedMessage,
  signature: string | undefined,
): { body: string; htmlBody?: string } {
  let text = m.body;
  let html = m.htmlBody ?? (signature ? escapeHtml(text).replace(/\n/g, "<br>\n") : undefined);
  if (signature) {
    text += `\n\n-- \n${htmlToText(signature)}`;
    html = `${html ?? ""}<br>\n-- <br>\n${signature}`;
  }
  if (m.quote) {
    text = text ? `${text}\n\n${m.quote.plain}` : m.quote.plain;
    if (html !== undefined) html += `\n${m.quote.html}`;
  }
  return html === undefined ? { body: text } : { body: text, htmlBody: html };
}

const addressLine = (from: SendAsAddress): string =>
  from.displayName ? `${from.displayName} <${from.email}>` : from.email;

function sent(g: GmailMessage): SentMessage {
  if (!g.id) throw malformed();
  return {
    id: g.id,
    threadId: g.threadId ?? g.id,
    ...(g.labelIds ? { labelIds: g.labelIds } : {}),
  };
}

async function deliver(
  a: AccountRef,
  m: PreparedMessage,
  opts: {
    from?: SendAsAddress | undefined;
    includeSignature: boolean;
    maxAttachmentBytes: number;
  },
): Promise<SentMessage> {
  const signature = opts.includeSignature
    ? await signatureOf(a, opts.from?.email ?? a.address)
    : undefined;
  const carried = await fetchCarried(a, m, opts.maxAttachmentBytes);
  const raw = buildRfc822(
    {
      to: m.to,
      cc: m.cc,
      bcc: m.bcc,
      ...(opts.from ? { from: addressLine(opts.from) } : {}),
      subject: m.subject,
      ...compose(m, signature || undefined),
      ...(m.inReplyTo ? { inReplyTo: m.inReplyTo } : {}),
      ...(m.references ? { references: m.references } : {}),
      attachments: [...m.attachments, ...carried],
    },
    { requireRecipient: true },
  );
  const url = `${UPLOAD}/messages/send`;
  if (!m.threadId) {
    return sent(
      await gjson<GmailMessage>(
        a,
        url,
        { method: "POST", headers: { "Content-Type": "message/rfc822" }, body: raw },
        { fields: SENT_FIELDS, query: { uploadType: "media" } },
      ),
    );
  }
  const boundary = `wb_${crypto.randomUUID()}`;
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify({ threadId: m.threadId }),
    `--${boundary}`,
    "Content-Type: message/rfc822",
    "",
    raw,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return sent(
    await gjson<GmailMessage>(
      a,
      url,
      {
        method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      },
      { fields: SENT_FIELDS, query: { uploadType: "multipart" } },
    ),
  );
}

// ---- Drafts --------------------------------------------------------------------------------------

async function readDraft(a: AccountRef, draftId: string): Promise<DraftEnvelope> {
  const d = await gjson<{ id?: string; message?: GmailMessage }>(
    a,
    `${BASE}/drafts/${enc(draftId)}`,
    {},
    // Full format: only it lists the draft's files (the metadata format leaves the parts out).
    { fields: "id,message(payload)", query: { format: "full" } },
  );
  if (!d.id) throw malformed();
  const p = d.message?.payload;
  const from = headerOf(p, "From");
  const files = listAttachments(p);
  const attachmentTotals: AttachmentTotals = {
    count: files.length,
    bytes: files.reduce((n, f) => n + f.size, 0),
  };
  return {
    ...(from === undefined ? {} : { from: singleLine(decodeEncodedWords(from)) }),
    to: readAddressList(headerOf(p, "To")),
    cc: readAddressList(headerOf(p, "Cc")),
    bcc: readAddressList(headerOf(p, "Bcc")),
    subject: singleLine(decodeEncodedWords(headerOf(p, "Subject") ?? "")),
    attachmentTotals,
  };
}

async function sendDraft(a: AccountRef, draftId: string): Promise<SentMessage> {
  return sent(
    await gjson<GmailMessage>(
      a,
      `${BASE}/drafts/send`,
      { method: "POST", json: { id: draftId } },
      { fields: SENT_FIELDS },
    ),
  );
}

const service: SendService = { prepare, deliver, readDraft, sendDraft };

export const googleSend = provide(SEND, service);
