// Gmail binding of the read side of mail (`MAIL_READ`): `threads.list` plus one batch request for
// the thread metadata, `threads.get` and `messages.get` with partial responses. Bodies are
// decoded only as far as the caller will show them (plan s.3.4): the text/plain part when there is
// one, else the HTML converted with the linear stripper in `core/html-text.ts`.

import { ToolError } from "../../core/errors";
import { htmlToText, truncateBody } from "../../core/html-text";
import {
  type AttachmentInfo,
  type BodyOpts,
  MAX_RESPONSE_BODY_CHARS,
  MAX_RESPONSE_FETCH_BYTES,
  type MailMessage,
  type MailReader,
  OMITTED_NOTE,
  RESPONSE_CAP_NOTE,
  type ThreadDetail,
  type ThreadSummary,
} from "../../services/mail-read";
import { batchJson, gmailBatch } from "./batch";
import { gjson } from "./http";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
/** Raw HTML bytes decoded for a conversion to text. */
const HTML_DECODE_BYTES = 256 * 1024;
const SUMMARY_HEADERS = ["From", "Subject"];
const MESSAGE_HEADERS = ["From", "To", "Cc", "Bcc", "Subject", "Date"];

interface GHeader {
  name?: string;
  value?: string;
}
interface GPart {
  mimeType?: string;
  filename?: string;
  headers?: GHeader[];
  body?: { size?: number; attachmentId?: string; data?: string };
  parts?: GPart[];
}
interface GMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  sizeEstimate?: number;
  payload?: GPart;
}
interface GThread {
  id: string;
  messages?: GMessage[];
}

/** Gmail's partial-response syntax cannot recurse, so the part tree is spelled out to this depth. */
const PART_DEPTH = 6;
const partFields = (depth: number): string =>
  `mimeType,filename,headers(name,value),body(size,attachmentId,data)${
    depth > 0 ? `,parts(${partFields(depth - 1)})` : ""
  }`;
const META_MESSAGE_FIELDS =
  "id,threadId,labelIds,snippet,internalDate,sizeEstimate,payload(headers(name,value))";
const FULL_MESSAGE_FIELDS = `id,threadId,labelIds,snippet,internalDate,sizeEstimate,payload(${partFields(PART_DEPTH)})`;
/**
 * What `get_thread` asks of the whole thread when it reads bodies: ids, order, drafts and the part
 * tree with sizes but no data, so the answer stays small whatever the messages weigh.
 */
const indexPartFields = (depth: number): string =>
  `mimeType,filename,body(size,attachmentId)${depth > 0 ? `,parts(${indexPartFields(depth - 1)})` : ""}`;
const THREAD_INDEX_FIELDS = `id,messages(id,labelIds,payload(${indexPartFields(PART_DEPTH)}))`;
/** Below this many characters left in the response budget, another body is not started. */
const MIN_BODY_CHARS = 256;
const SUMMARY_FIELDS = "id,messages(labelIds,snippet,internalDate,payload(headers(name,value)))";

const header = (headers: GHeader[] | undefined, name: string): string => {
  const want = name.toLowerCase();
  for (const h of headers ?? []) if (h.name?.toLowerCase() === want) return h.value ?? "";
  return "";
};

const hasBody = (format: BodyOpts["format"]): boolean =>
  format === "FULL_CONTENT" || format === "PLAIN_TEXT";

/** `charset=` of a Content-Type value; utf-8 when absent or unknown to TextDecoder. */
function decoderFor(contentType: string): TextDecoder {
  const label = /charset\s*=\s*"?([A-Za-z0-9._:-]{1,40})/i.exec(contentType)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(label);
  } catch {
    return new TextDecoder();
  }
}

/** Decodes up to `maxBytes` of a base64url body; `clipped` says bytes were left out. */
function decodeData(
  data: string,
  contentType: string,
  maxBytes: number,
): { text: string; clipped: boolean } {
  const want = Math.ceil(maxBytes / 3) * 4;
  const clipped = data.length > want;
  let b64 = (clipped ? data.slice(0, want) : data).replace(/-/g, "+").replace(/_/g, "/");
  b64 = b64.replace(/=+$/, "");
  b64 += "=".repeat((4 - (b64.length % 4)) % 4);
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return { text: "", clipped: false };
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { text: decoderFor(contentType).decode(bytes), clipped };
}

interface Found {
  plain: GPart[];
  html: GPart[];
  attachments: AttachmentInfo[];
}

/** Sorts the leaves of a MIME tree into inline text, inline HTML and attachments. */
function collect(part: GPart | undefined, into: Found): void {
  if (!part) return;
  const type = (part.mimeType ?? "").toLowerCase();
  if (type.startsWith("multipart/")) {
    for (const p of part.parts ?? []) collect(p, into);
    return;
  }
  const filename = part.filename ?? "";
  if (filename !== "") {
    if (part.body?.attachmentId) {
      into.attachments.push({
        attachmentId: part.body.attachmentId,
        filename,
        mimeType: part.mimeType ?? "application/octet-stream",
        size: part.body.size ?? 0,
      });
    }
    return;
  }
  if (type === "text/plain") into.plain.push(part);
  else if (type === "text/html") into.html.push(part);
}

/** Bytes of inline text (plain and HTML) in a message: what reading it in full costs. */
function inlineBytes(m: GMessage): number {
  const found: Found = { plain: [], html: [], attachments: [] };
  collect(m.payload, found);
  let n = 0;
  for (const p of found.plain) n += p.body?.size ?? 0;
  for (const p of found.html) n += p.body?.size ?? 0;
  return n;
}

/** The joined text of inline parts, decoded as far as `maxBytes` of each. */
function joinParts(
  parts: GPart[],
  maxBytes: number,
  enough: number,
): { text: string; clipped: boolean } {
  const pieces: string[] = [];
  let length = 0;
  let clipped = false;
  for (const p of parts) {
    const data = p.body?.data;
    if (!data) continue;
    const ct = header(p.headers, "Content-Type");
    const d = decodeData(data, ct, maxBytes);
    pieces.push(d.text);
    length += d.text.length;
    if (d.clipped) clipped = true;
    if (length > enough) {
      if (p !== parts[parts.length - 1]) clipped = true;
      break;
    }
  }
  return { text: pieces.join("\n\n"), clipped };
}

function toMessage(m: GMessage, opts: BodyOpts): MailMessage {
  const h = m.payload?.headers;
  const out: MailMessage = {
    id: m.id,
    threadId: m.threadId ?? m.id,
    labelIds: m.labelIds ?? [],
    date: Number(m.internalDate) || 0,
    sizeEstimate: m.sizeEstimate ?? 0,
    subject: header(h, "Subject"),
    from: header(h, "From"),
    to: header(h, "To"),
    cc: header(h, "Cc"),
    bcc: header(h, "Bcc"),
    snippet: m.snippet ?? "",
    truncated: false,
    attachments: [],
  };
  if (!hasBody(opts.format)) return out;

  const found: Found = { plain: [], html: [], attachments: [] };
  collect(m.payload, found);
  out.attachments = found.attachments;
  const max = opts.maxBodyChars;

  const plain = joinParts(found.plain, max * 4, max);
  if (plain.text.trim() !== "") {
    const t = truncateBody(plain.text, max, plain.clipped);
    out.text = t.text;
    out.truncated = t.truncated;
  } else if (found.html.length > 0) {
    const decode = opts.htmlBytes ?? HTML_DECODE_BYTES;
    const html = joinParts(found.html, decode, decode);
    const t = truncateBody(htmlToText(html.text, { maxChars: max * 4 + 4096 }), max, html.clipped);
    out.text = t.text;
    out.truncated = t.truncated;
  } else {
    out.text = "";
  }
  if (opts.includeHtml && found.html.length > 0) {
    const html = joinParts(found.html, max * 4, max);
    const t = truncateBody(html.text, max, html.clipped);
    out.html = t.text;
    out.truncated = out.truncated || t.truncated;
  }
  return out;
}

const formatOf = (format: BodyOpts["format"]): "full" | "metadata" =>
  hasBody(format) ? "full" : "metadata";

function summarize(t: GThread): ThreadSummary | null {
  const messages = t.messages ?? [];
  const first = messages[0];
  const last = messages[messages.length - 1];
  if (!first || !last) return null;
  const labels = new Set<string>();
  let date = 0;
  for (const m of messages) {
    for (const l of m.labelIds ?? []) labels.add(l);
    date = Math.max(date, Number(m.internalDate) || 0);
  }
  return {
    id: t.id,
    messageCount: messages.length,
    date,
    labelIds: [...labels],
    subject: header(first.payload?.headers, "Subject"),
    from: header(last.payload?.headers, "From"),
    snippet: last.snippet ?? "",
  };
}

/** `text` with its trailing truncation marker (see `truncateBody`) swapped for the cap note. */
function swapMarker(text: string): string {
  const at = text.lastIndexOf("\n[truncated after ");
  return at < 0 ? text : `${text.slice(0, at)}\n${RESPONSE_CAP_NOTE}`;
}

/** Swaps the "pass maxBodyChars" marker for one that says the response limit cut this body. */
function capNote(m: MailMessage): void {
  const swap = (t: string | undefined): string | undefined => (t === undefined ? t : swapMarker(t));
  m.text = swap(m.text);
  if (m.html !== undefined) m.html = swap(m.html);
}

export const googleMailRead: MailReader = {
  async search(a, q) {
    const list = await gjson<{ threads?: { id: string }[]; nextPageToken?: string }>(
      a,
      `${BASE}/threads`,
      {},
      {
        fields: "nextPageToken,threads(id)",
        query: {
          q: q.query === undefined || q.query === "" ? undefined : q.query,
          labelIds: q.labelIds && q.labelIds.length > 0 ? q.labelIds : undefined,
          includeSpamTrash: q.includeSpamTrash ? true : undefined,
          maxResults: q.pageSize,
          pageToken: q.pageToken ?? undefined,
        },
      },
    );
    const ids = (list?.threads ?? []).map((t) => t.id);
    const next = list?.nextPageToken;
    if (ids.length === 0) return { items: [], ...(next ? { nextPageToken: next } : {}) };

    const params = new URLSearchParams({ format: "metadata", fields: SUMMARY_FIELDS });
    for (const name of SUMMARY_HEADERS) params.append("metadataHeaders", name);
    const parts = await gmailBatch(
      a,
      ids.map((id, i) => ({
        id: `t${i}`,
        path: `/gmail/v1/users/me/threads/${encodeURIComponent(id)}?${params.toString()}`,
      })),
    );
    const byId = new Map(parts.map((p) => [p.id, p]));
    const items: ThreadSummary[] = [];
    for (let i = 0; i < ids.length; i++) {
      const part = byId.get(`t${i}`);
      // A thread deleted between the list and the batch answers 404: it is simply gone.
      if (part?.status === 404) continue;
      // No readable answer is not a deletion: fail so a retry gets the thread instead of losing it.
      if (!part) throw new ToolError("upstream_error", "Google's batch reply was incomplete.");
      const summary = summarize(batchJson<GThread>(a, part));
      if (summary) items.push(summary);
    }
    return { items, ...(next ? { nextPageToken: next } : {}) };
  },

  async getThread(a, id, opts) {
    const limit = Math.max(1, opts.messageLimit);
    const url = `${BASE}/threads/${encodeURIComponent(id)}`;
    const windowOf = (messages: GMessage[]) => {
      const all = messages.filter((m) => !(m.labelIds ?? []).includes("DRAFT"));
      const offset = Math.min(Math.max(0, opts.messageOffset ?? all.length - limit), all.length);
      return { total: all.length, offset, window: all.slice(offset, offset + limit) };
    };

    if (!hasBody(opts.format)) {
      // No bodies: the thread is small at the metadata format, one call is enough.
      const t = await gjson<GThread>(
        a,
        url,
        {},
        {
          fields: `id,messages(${META_MESSAGE_FIELDS})`,
          query: { format: "metadata", metadataHeaders: MESSAGE_HEADERS },
        },
      );
      const w = windowOf(t?.messages ?? []);
      return {
        id: t?.id ?? id,
        totalMessages: w.total,
        messageOffset: w.offset,
        messages: w.window.map((m) => toMessage(m, opts)),
      };
    }

    // Bodies: the thread comes back as an index (ids, order, part sizes), then only the window is read.
    const t = await gjson<GThread>(
      a,
      url,
      {},
      { fields: THREAD_INDEX_FIELDS, query: { format: "full" } },
    );
    const { total, offset, window } = windowOf(t?.messages ?? []);
    const thread: ThreadDetail = {
      id: t?.id ?? id,
      totalMessages: total,
      messageOffset: offset,
      messages: [],
    };
    if (window.length === 0) return thread;

    // The newest messages are read in full while their inline text fits the budget (the newest
    // always is); the rest of the window comes back at the metadata format. Attachments weigh
    // nothing here: the full format only names them.
    const full = new Set<number>();
    let bytes = 0;
    for (let i = window.length - 1; i >= 0; i--) {
      bytes += inlineBytes(window[i] as GMessage);
      if (full.size > 0 && bytes > MAX_RESPONSE_FETCH_BYTES) break;
      full.add(i);
    }
    const fullParams = new URLSearchParams({ format: "full", fields: FULL_MESSAGE_FIELDS });
    const metaParams = new URLSearchParams({ format: "metadata", fields: META_MESSAGE_FIELDS });
    for (const name of MESSAGE_HEADERS) metaParams.append("metadataHeaders", name);
    const parts = await gmailBatch(
      a,
      window.map((m, i) => ({
        id: `m${i}`,
        path: `/gmail/v1/users/me/messages/${encodeURIComponent(m.id)}?${(full.has(i) ? fullParams : metaParams).toString()}`,
      })),
    );
    const byId = new Map(parts.map((p) => [p.id, p]));
    const fetched: (GMessage | null)[] = window.map((_, i) => {
      const part = byId.get(`m${i}`);
      // A message deleted since the index was read answers 404: it is simply gone.
      if (part?.status === 404) return null;
      // No readable answer is not a deletion: fail so a retry gets the message.
      if (!part) throw new ToolError("upstream_error", "Google's batch reply was incomplete.");
      return batchJson<GMessage>(a, part);
    });

    // Bodies are built newest first so a long thread spends its character budget on the newest.
    let left = MAX_RESPONSE_BODY_CHARS;
    const built: (MailMessage | null)[] = fetched.map(() => null);
    for (let i = window.length - 1; i >= 0; i--) {
      const f = fetched[i];
      if (!f) continue;
      if (!full.has(i) || left < MIN_BODY_CHARS) {
        // The index names the attachments of every message of the window.
        const found: Found = { plain: [], html: [], attachments: [] };
        collect((window[i] as GMessage).payload, found);
        built[i] = {
          ...toMessage(f, { ...opts, format: "METADATA_ONLY" }),
          text: OMITTED_NOTE,
          truncated: true,
          attachments: found.attachments,
        };
        continue;
      }
      // The text and the HTML (includeHtml) share the character budget.
      const maxBodyChars = Math.min(
        opts.maxBodyChars,
        Math.floor(left / (opts.includeHtml ? 2 : 1)),
      );
      // Markup runs about 12 bytes to a character of text, so a thread decodes only what the cut needs
      // (get_message keeps the full budget).
      const htmlBytes = Math.min(HTML_DECODE_BYTES, Math.max(32 * 1024, maxBodyChars * 12));
      const m = toMessage(f, { ...opts, maxBodyChars, htmlBytes });
      if (maxBodyChars < opts.maxBodyChars && m.truncated) capNote(m);
      left -= (m.text?.length ?? 0) + (m.html?.length ?? 0);
      built[i] = m;
    }
    thread.messages = built.filter((m): m is MailMessage => m !== null);
    return thread;
  },

  async getMessage(a, id, opts) {
    const m = await gjson<GMessage>(
      a,
      `${BASE}/messages/${encodeURIComponent(id)}`,
      {},
      {
        fields: hasBody(opts.format) ? FULL_MESSAGE_FIELDS : META_MESSAGE_FIELDS,
        query: {
          format: formatOf(opts.format),
          metadataHeaders: hasBody(opts.format) ? undefined : MESSAGE_HEADERS,
        },
      },
    );
    return toMessage(m, opts);
  },
};
