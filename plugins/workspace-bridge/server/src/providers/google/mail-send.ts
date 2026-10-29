// Gmail binding of the mail.send capability (plan s.3.4, s.8.2).
//
// Messages go up through Gmail's media upload, never as a base64url `raw` string: the RFC 822 text
// is the request body (`uploadType=media`, `Content-Type: message/rfc822`), which spares the base64
// pass on the Worker's 10 ms CPU budget. A plain media upload cannot carry a `threadId`, so a
// threaded message uses `uploadType=multipart`: a `multipart/related` body with the JSON metadata
// `{"threadId":...}` and the `message/rfc822` part. A draft is read in `format=raw` and sent as
// those very bytes through `messages/send`, then deleted (see `sendDraft`): `drafts/send` would send
// whatever the draft holds at that instant, which a concurrent edit could have changed.
//
// Files go in as base64 MIME parts, the client's own base64 re-wrapped and never decoded. A forward
// carries the original's files: `prepare` only reads their sizes (and refuses past the cap), and
// `deliver` downloads them, so nothing is fetched before the send guardrails have passed.
//
// Sending is never retried: gfetch does not retry a POST, and a second try could send twice.

import { ToolError } from "../../core/errors";
import {
  b64urlToBytes,
  base64Bytes,
  binaryToBytes,
  buildRfc822,
  decodeEncodedWords,
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
import { isQueryableAddress } from "../../core/recipients";
import type { SendAsAddress } from "../../core/send-as";
import { appendSignature, signatureFor } from "../../core/signature";
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
import { type BatchRequest, gmailBatch, MAX_BATCH_ITEMS } from "./batch";
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
  bytes:
    own.reduce((n, f) => n + base64Bytes(f.content), 0) + carried.reduce((n, f) => n + f.size, 0),
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
  if (totals.bytes > input.maxAttachmentBytes)
    throw tooLargeForward(input.maxAttachmentBytes, totals.bytes);
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
    const stale =
      e instanceof ToolError && (e.code === "not_found" || e.code === "invalid_argument");
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
  let html = m.htmlBody;
  if (signature) ({ text, html } = appendSignature({ text, html }, signature));
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
    signatureOptional?: boolean | undefined;
    maxAttachmentBytes: number;
  },
): Promise<SentMessage> {
  let signature: string | undefined;
  if (opts.includeSignature) {
    try {
      signature = await signatureFor(
        (email) => signatureOf(a, email),
        opts.from?.email ?? a.address,
        a.address,
      );
    } catch (e) {
      // A signature added by default never stops a send; one the caller asked for does.
      if (!opts.signatureOptional || !(e instanceof ToolError) || e.code === "internal") throw e;
    }
  }
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
  return uploadMessage(a, raw, m.threadId);
}

/**
 * One `messages/send` by media upload: the RFC 822 bytes as the request body, or, to thread the
 * message, a `multipart/related` body with the `{"threadId":...}` metadata. A string is sent as
 * UTF-8 text, bytes exactly as they are.
 */
async function uploadMessage(
  a: AccountRef,
  raw: string | Uint8Array,
  threadId: string | undefined,
): Promise<SentMessage> {
  const url = `${UPLOAD}/messages/send`;
  if (!threadId) {
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
  const head = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify({ threadId }),
    `--${boundary}`,
    "Content-Type: message/rfc822",
    "",
    "",
  ].join("\r\n");
  const body = new Blob([head, raw, `\r\n--${boundary}--\r\n`]);
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

/** Base64 characters allowed on top of the attachment limit, for a draft's text parts and headers. */
const DRAFT_TEXT_ROOM = 262_144;

const unreadable = (): ToolError =>
  new ToolError("invalid_argument", "The draft could not be read as a mail message.");

/**
 * The top-level header fields of a raw message, unfolded, by lowercase name (every occurrence, in
 * order). Strict on purpose: a header line that is neither `name: value` nor a fold, a bare CR or a
 * NUL is refused rather than guessed at, because the recipients checked here must be the ones Gmail
 * will read from the same bytes.
 */
function rawHeaders(bin: string): Map<string, string[]> {
  const end = bin.search(/\r?\n\r?\n/);
  const block = end < 0 ? bin : bin.slice(0, end);
  if (/\r(?!\n)|\0/.test(block)) throw unreadable();
  // 8-bit header text is UTF-8 on the wire; the rest is ASCII.
  const text = new TextDecoder().decode(binaryToBytes(block));
  const out = new Map<string, string[]>();
  let name: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line === "") continue; // the end of a header-only message
    if (/^[ \t]/.test(line)) {
      const list = name === undefined ? undefined : out.get(name);
      if (!list) throw unreadable();
      list[list.length - 1] += ` ${line.trim()}`;
      continue;
    }
    const m = line.match(/^([^\s:]+):[ \t]*(.*)$/);
    if (!m) throw unreadable();
    name = (m[1] ?? "").toLowerCase();
    const list = out.get(name) ?? [];
    list.push((m[2] ?? "").trim());
    out.set(name, list);
  }
  return out;
}

/**
 * The files a raw message holds and about how large they are, for the audit row only (an estimate
 * from the base64 bodies of the parts marked `attachment`).
 */
function rawAttachmentTotals(bin: string): AttachmentTotals {
  // One forward pass (the cursor only moves on), so a crafted body cannot make it slow.
  const lower = bin.toLowerCase();
  const tag = "content-disposition:";
  let count = 0;
  let bytes = 0;
  let at = 0;
  for (;;) {
    const i = lower.indexOf(tag, at);
    if (i < 0) break;
    at = i + tag.length;
    if (i > 0 && lower[i - 1] !== "\n") continue; // not the start of a header line
    if (!/^[ \t]*attachment/.test(lower.slice(at, at + 48))) continue;
    const lf = lower.indexOf("\n\n", at);
    const crlf = lower.indexOf("\r\n\r\n", at);
    const gap = lf < 0 ? crlf : crlf < 0 ? lf : Math.min(lf, crlf);
    if (gap < 0) break;
    const start = gap + (gap === crlf ? 4 : 2);
    const end = lower.indexOf("\n--", start);
    const stop = end < 0 ? lower.length : end;
    count++;
    // Base64 lines of 76 characters plus a line break, three bytes to four characters.
    bytes += Math.floor(((stop - start) * 76 * 3) / (78 * 4));
    at = stop;
  }
  return { count, bytes };
}

/**
 * Reads a draft as the exact message it would send (`format=raw`). The envelope carries those
 * bytes (`raw`), so the recipients the caller checks and the message `sendDraft` sends are one and
 * the same thing, whatever happens to the draft in between.
 */
async function readDraft(a: AccountRef, draftId: string, maxBytes: number): Promise<DraftEnvelope> {
  const d = await gjson<{ id?: string; message?: { threadId?: string; raw?: string } }>(
    a,
    `${BASE}/drafts/${enc(draftId)}`,
    {},
    { fields: "id,message(threadId,raw)", query: { format: "raw" } },
  );
  const raw = d.message?.raw;
  if (!d.id || !raw) throw malformed();
  // The read pulls every byte of the message and it is decoded and scanned here, so a draft past
  // the send limit (the files, as for the other send tools, plus room for the text) is refused
  // before any of that work.
  if (raw.length > Math.ceil((maxBytes * 4) / 3) + DRAFT_TEXT_ROOM) {
    throw new ToolError(
      "too_large",
      `This draft is larger than the ${maxBytes} byte send limit (plus room for its text), so send_message cannot send it. Remove files from it or send a smaller message.`,
      { maxBytes },
    );
  }
  let bin: string;
  try {
    bin = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    throw malformed();
  }
  const h = rawHeaders(bin);
  const one = (name: string) => h.get(name)?.[0];
  // Every To, Cc and Bcc line counts: a message may carry the field twice.
  const list = (name: string) => readAddressList(h.get(name)?.join(", "));
  if ((h.get("from")?.length ?? 0) > 1) throw unreadable();
  const from = one("from");
  return {
    ...(from === undefined ? {} : { from: singleLine(decodeEncodedWords(from)) }),
    to: list("to"),
    cc: list("cc"),
    bcc: list("bcc"),
    subject: singleLine(decodeEncodedWords(one("subject") ?? "")),
    attachmentTotals: rawAttachmentTotals(bin),
    raw,
    ...(d.message?.threadId ? { threadId: d.message.threadId } : {}),
  };
}

/**
 * Sends exactly `draft.raw`, the bytes `readDraft` returned and the caller checked, through
 * `messages/send` (keeping the thread), then deletes the draft as `drafts/send` would have. Nothing
 * that happens to the draft after the read can reach Gmail: an edit adding a recipient changes the
 * draft, not these bytes. The delete is best effort (the message is already sent, and failing the
 * call would invite a second send); an edited draft is deleted too, its edit never having been sent.
 */
async function sendDraft(
  a: AccountRef,
  draftId: string,
  draft: DraftEnvelope,
): Promise<SentMessage> {
  const out = await uploadMessage(a, b64urlToBytes(draft.raw), draft.threadId);
  try {
    await gjson<undefined>(a, `${BASE}/drafts/${enc(draftId)}`, { method: "DELETE" });
  } catch {
    console.error("send_message: the sent draft could not be deleted");
  }
  return out;
}

/** Addresses the account has sent to, by one batch of `in:sent to:<address>` (`maxResults=1`). */
async function sentTo(a: AccountRef, addresses: readonly string[]): Promise<string[]> {
  // Only a plain address ever goes into a query; anything else is simply not found.
  const plain = addresses.filter((x) => isQueryableAddress(x)).slice(0, MAX_BATCH_ITEMS);
  const requests: BatchRequest[] = plain.map((address, i) => ({
    id: `s${i}`,
    path: `/gmail/v1/users/me/messages?${new URLSearchParams({
      q: `in:sent to:${address}`,
      maxResults: "1",
      fields: "messages/id",
    }).toString()}`,
  }));
  const parts = await gmailBatch(a, requests);
  const found: string[] = [];
  for (const part of parts) {
    if (part.status < 200 || part.status > 299) continue;
    try {
      const body = JSON.parse(part.body) as { messages?: { id?: string }[] };
      const address = plain[Number(part.id.slice(1))];
      if (address && (body.messages?.length ?? 0) > 0) found.push(address);
    } catch {
      // An unreadable answer is "not found".
    }
  }
  return found;
}

const service: SendService = { prepare, deliver, readDraft, sendDraft, sentTo };

export const googleSend = provide(SEND, service);
