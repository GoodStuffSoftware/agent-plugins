// RFC 5322 / RFC 2047 message builder and the reply/forward quoting helpers (ARCHITECTURE s.2;
// plan ADR-001). Adapted from https://github.com/mkpoli/gmail-mcp (src/gmail.ts at commit
// 9aa1b1a3baed8508adfc66c036ae7d019deff5c6), MIT License, Copyright (c) 2026 mkpoli. The full
// notice is in plugins/workspace-bridge/THIRD-PARTY.md. Changes: our `ToolError` replaces `Error`,
// recipients are lists, a message may have no recipient (drafts), bodies are normalised to CRLF,
// and file attachments and inline images are left out (M16 adds them from the same upstream file).
//
// Rules this module enforces, whatever the caller passes:
// - CR, LF or NUL in any header value is refused (`invalid_argument`), so a header can never be
//   smuggled in (a silent Bcc).
// - Non-ASCII subjects and display names are RFC 2047 encoded; addresses stay as given.
// - Text bodies are base64 in 76-column lines; header lines fold at 78 columns where they can.

import { ToolError } from "./errors";

const MAX_BODY_CHARS = 1_000_000;
// RFC 5322 s.2.1.1 caps a line at 998 octets. Folding breaks at spaces, so a stretch without one
// has to fit a line on its own, allowing for the field name.
const MAX_HEADER_RUN = 900;

const bad = (message: string): ToolError => new ToolError("invalid_argument", message);

// ---- Encoding ----------------------------------------------------------------------------------

// Chunked binary-to-base64: a spread into String.fromCharCode overflows the argument limit on
// bodies past a few tens of kilobytes.
export function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function b64urlToBytes(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

// ---- Header safety and folding ------------------------------------------------------------------

// Header values are attacker-influenceable through prompt injection (mail content steers the
// model, the model fills tool arguments), so CR/LF must never reach the raw header block.
function assertHeaderSafe(name: string, value: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw bad(`The ${name} value must be a single line (no line break or NUL).`);
  }
  return value;
}

// Where a header line may be broken: at a space outside a quoted string. One stray quote would
// open a string that never closes, so quotes are honoured only when they balance.
function headerRuns(value: string): string[] {
  const split = (respectQuotes: boolean): string[] => {
    const out: string[] = [];
    let buffer = "";
    let quoted = false;
    for (let i = 0; i < value.length; i++) {
      const ch = value[i];
      if (respectQuotes && ch === '"' && value[i - 1] !== "\\") quoted = !quoted;
      if (ch === " " && !quoted) {
        out.push(buffer);
        buffer = "";
        continue;
      }
      buffer += ch;
    }
    out.push(buffer);
    return quoted ? split(false) : out;
  };
  return split(true);
}

/** True when no unbreakable run of `value` is wider than a header line. */
export function fitsHeaderLine(value: string): boolean {
  return headerRuns(value).every((run) => run.length <= MAX_HEADER_RUN);
}

function assertLiteralFits(name: string, value: string): string {
  if (!fitsHeaderLine(value)) throw bad(`The ${name} value is too long for a header line.`);
  return value;
}

// RFC 2047 encoding for non-ASCII header values. An encoded-word may not exceed 75 octets, so
// longer values become several words joined by folding whitespace, split only on UTF-8 character
// boundaries.
export function encodeHeader(value: string): string {
  // Folding can only break at whitespace, so a run without any is stuck on one line and an ASCII
  // value can still pass the 998-octet limit. Encoded-words break anywhere, and RFC 2047 s.6.2
  // has a receiver drop the whitespace between adjacent ones.
  const foldable = value.split(" ").every((run) => run.length <= 78);
  if (/^[\x20-\x7e]*$/.test(value) && foldable) return value;
  const bytes = new TextEncoder().encode(value);
  // "=?UTF-8?B?" + base64 + "?=" stays within 75 octets when the raw chunk is at most 45 bytes,
  // and a multiple of 3 keeps each word padding-free.
  const MAX_CHUNK = 45;
  const words: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    let take = Math.min(MAX_CHUNK, bytes.length - i);
    // Never cut a multi-byte character: continuation bytes start with 10xxxxxx.
    while (take > 1 && i + take < bytes.length && ((bytes[i + take] ?? 0) & 0xc0) === 0x80) {
      take--;
    }
    words.push(`=?UTF-8?B?${bytesToB64(bytes.subarray(i, i + take))}?=`);
    i += take;
  }
  return words.join("\r\n ");
}

/**
 * Splits an address list on the commas that separate addresses, ignoring the ones inside a quoted
 * display name, an angle-addr or a parenthesised comment, and honouring backslash escapes.
 */
export function splitAddressList(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;
  let comment = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quoted && ch === "\\") {
      current += ch + (value[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "(") comment++;
    else if (!quoted && ch === ")" && comment > 0) comment--;
    else if (ch === "<" && !quoted) angled = true;
    else if (ch === ">" && !quoted) angled = false;
    if (ch === "," && !quoted && !angled && comment === 0) {
      if (current.trim()) out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/**
 * One address as it goes into a header. Display names carry arbitrary text, so a non-ASCII one is
 * RFC 2047 encoded and one with RFC 5322 specials is quoted; the address itself is untouched.
 */
export function encodeAddress(address: string): string {
  const match = address.match(/^(.*?)\s*<([^>]*)>$/);
  if (!match) return address;
  const rawName = match[1] ?? "";
  const addr = match[2] ?? "";
  const trimmed = rawName.trim();
  // Unwrap a quoted display name back to its literal text, quoted-pairs included, so re-quoting
  // below does not escape the escapes.
  const quotedName = /^".*"$/s.test(trimmed);
  const name = quotedName ? trimmed.slice(1, -1).replace(/\\(.)/g, "$1") : trimmed;
  if (!name) return `<${addr}>`;
  if (!/^[\x20-\x7e]*$/.test(name)) return `${encodeHeader(name)} <${addr}>`;
  return /[",;:<>@[\]\\().]/.test(name)
    ? `"${name.replace(/(["\\])/g, "\\$1")}" <${addr}>`
    : `${name} <${addr}>`;
}

// A long recipient list or subject has to fold. Folding inserts CRLF before existing whitespace;
// a receiver unfolds by dropping the CRLF, which is why the break only lands on a space outside a
// quoted string.
function foldHeader(line: string): string {
  // Encoded-words fold themselves, and what follows the fold they inserted still has to fold.
  if (line.includes("\r\n")) {
    // Only the hard limit applies here. Breaking these at the recommended width would split an
    // encoded word from its own header name.
    return line
      .split("\r\n")
      .map((segment) =>
        segment.startsWith(" ")
          ? ` ${foldSegment(segment.slice(1), MAX_HEADER_RUN)}`
          : foldSegment(segment, MAX_HEADER_RUN),
      )
      .join("\r\n");
  }
  return foldSegment(line, 78);
}

function foldSegment(line: string, limit: number): string {
  if (line.length <= limit) return line;
  const lines: string[] = [];
  let current = "";
  for (const token of headerRuns(line)) {
    if (!current) {
      current = token;
    } else if (current.length + 1 + token.length <= limit) {
      current += ` ${token}`;
    } else {
      lines.push(current);
      current = token;
    }
  }
  lines.push(current);
  return lines.join("\r\n ");
}

// ---- Body parts and the message -----------------------------------------------------------------

// RFC 2045 requires encoded body lines within 76 characters.
function wrap76(s: string): string {
  return s.replace(/(.{76})/g, "$1\r\n").replace(/\r\n$/, "");
}

// Text goes out with CRLF line ends, base64 encoded.
const crlf = (text: string): string => text.replace(/\r\n|\r|\n/g, "\r\n");

function textPart(mimeType: string, content: string): string[] {
  return [
    `Content-Type: ${mimeType}; charset="UTF-8"`,
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(bytesToB64(new TextEncoder().encode(crlf(content)))),
  ];
}

// Wraps parts (each a line array with its own headers) into one multipart body.
function multipart(type: string, parts: string[][]): string[] {
  const boundary = `=_wb_${crypto.randomUUID()}`;
  const lines = [`Content-Type: multipart/${type}; boundary="${boundary}"`, ""];
  for (const part of parts) lines.push(`--${boundary}`, ...part, "");
  lines.push(`--${boundary}--`);
  return lines;
}

export interface MimeMessage {
  /** Addresses as `user@example.com` or `Name <user@example.com>`; one address per entry. */
  to?: readonly string[];
  cc?: readonly string[];
  bcc?: readonly string[];
  /** Omit to let Gmail use the account's default address. */
  from?: string;
  subject: string;
  /** Plain text. */
  body?: string;
  /** With `body`, a multipart/alternative; alone, the only part. */
  htmlBody?: string;
  /** A msg-id including the angle brackets, as in the answered message's Message-ID header. */
  inReplyTo?: string;
  /** Space-separated msg-ids. */
  references?: string;
}

/** Raw message text (CRLF lines) for Gmail's `message/rfc822` upload. */
export function buildRfc822(m: MimeMessage, opts: { requireRecipient?: boolean } = {}): string {
  const lists = {
    To: m.to ?? [],
    Cc: m.cc ?? [],
    Bcc: m.bcc ?? [],
  };
  for (const [name, list] of Object.entries(lists)) {
    for (const entry of list) assertHeaderSafe(name, entry);
  }
  if (m.from) assertHeaderSafe("From", m.from);
  assertHeaderSafe("Subject", m.subject);
  if (m.inReplyTo) assertLiteralFits("In-Reply-To", assertHeaderSafe("In-Reply-To", m.inReplyTo));
  if (m.references) assertLiteralFits("References", assertHeaderSafe("References", m.references));
  const encoded = {
    To: lists.To.map(encodeAddress),
    Cc: lists.Cc.map(encodeAddress),
    Bcc: lists.Bcc.map(encodeAddress),
  };
  const from = m.from ? encodeAddress(m.from) : "";
  // What has to fit is the list as it will be written, joined with ", ".
  for (const [name, list] of Object.entries(encoded)) {
    if (list.length > 0) assertLiteralFits(name, list.join(", "));
  }
  if (from) assertLiteralFits("From", from);
  if (opts.requireRecipient && lists.To.length + lists.Cc.length + lists.Bcc.length === 0) {
    throw bad("A message needs at least one recipient in to, cc or bcc.");
  }
  const body = m.body ?? "";
  if (body.length > MAX_BODY_CHARS || (m.htmlBody?.length ?? 0) > MAX_BODY_CHARS) {
    throw new ToolError("too_large", `A message body may not exceed ${MAX_BODY_CHARS} characters.`);
  }

  const headers = [
    // RFC 5322 s.3.6.3 has no empty address-list, so an empty field is left out.
    ...(encoded.To.length ? [`To: ${encoded.To.join(", ")}`] : []),
    ...(encoded.Cc.length ? [`Cc: ${encoded.Cc.join(", ")}`] : []),
    ...(encoded.Bcc.length ? [`Bcc: ${encoded.Bcc.join(", ")}`] : []),
    ...(from ? [`From: ${from}`] : []),
    `Subject: ${encodeHeader(m.subject)}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`] : []),
    ...(m.references ? [`References: ${m.references}`] : []),
    "MIME-Version: 1.0",
  ].map(foldHeader);

  const core = m.htmlBody
    ? multipart("alternative", [textPart("text/plain", body), textPart("text/html", m.htmlBody)])
    : textPart("text/plain", body);
  return [...headers, ...core].join("\r\n");
}

// ---- Addresses, reply and forward ----------------------------------------------------------------

/**
 * Bare, lowercased addresses from a header value, tolerating display names with commas inside
 * quotes (`"Doe, John" <j@example.com>`).
 */
export function parseAddresses(header: string | undefined): string[] {
  if (!header) return [];
  const out: string[] = [];
  for (const entry of splitAddressList(header)) {
    const angled = entry.match(/<([^<>\s]+@[^<>\s]+)>/);
    if (angled) {
      out.push((angled[1] ?? "").toLowerCase());
      continue;
    }
    // No angle-addr: drop comments and quoted text, then take the address token.
    const bare = entry
      .replace(/\([^)]*\)/g, " ")
      .replace(/"(?:[^"\\]|\\.)*"/g, " ")
      // A group ends with a semicolon that belongs to the group, not to the last address in it.
      .match(/([^\s<>@",;]+@[^\s<>@",;]+)/);
    if (bare?.[1]) out.push(bare[1].toLowerCase());
  }
  return [...new Set(out)];
}

/**
 * The entries of an address header in the form `encodeAddress` takes: RFC 2047 names decoded, so
 * the builder does not encode them twice.
 */
export function readAddressList(header: string | undefined): string[] {
  if (!header) return [];
  return splitAddressList(header).map((entry) => {
    const match = entry.match(/^(.*?)\s*<([^>]*)>$/);
    if (!match) return entry;
    const trimmed = (match[1] ?? "").trim();
    const name = /^".*"$/s.test(trimmed) ? trimmed.slice(1, -1).replace(/\\(.)/g, "$1") : trimmed;
    const decoded = singleLine(decodeEncodedWords(name));
    return decoded ? `${decoded} <${match[2] ?? ""}>` : `<${match[2] ?? ""}>`;
  });
}

// Gmail delivers to one mailbox whatever tag or dots an address carries, so a reply has to
// recognise those forms as the account itself instead of copying them back to their owner. Dots
// fold away on gmail.com and its googlemail.com alias; on a Workspace domain they stay.
export function canonicalAddress(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 0) return address.trim().toLowerCase();
  let local = address.slice(0, at).trim().toLowerCase();
  let domain = address
    .slice(at + 1)
    .trim()
    .toLowerCase();
  const tag = local.indexOf("+");
  if (tag >= 0) local = local.slice(0, tag);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replaceAll(".", "");
  return `${local}@${domain}`;
}

/**
 * Who a reply goes to. Reply-To wins over From when present; the account replying (and every
 * address it can send as) drops out. Replying to mail this account sent leaves no other sender to
 * answer, so the original recipients become the audience. With `reply_all` semantics the carbon
 * copies are whoever is left after that.
 */
export function replyRecipients(fields: {
  self: string[];
  from: string[];
  to: string[];
  cc: string[];
  replyTo: string[];
}): { to: string[]; cc: string[] } {
  const selves = new Set(fields.self.map(canonicalAddress));
  const notSelf = (a: string) => !selves.has(canonicalAddress(a));
  // An address wider than a header line has nowhere to fold and cannot be sent.
  const usable = (a: string) => notSelf(a) && fitsHeaderLine(a);
  const primary = (fields.replyTo.length > 0 ? fields.replyTo : fields.from).filter(usable);
  const to = primary.length > 0 ? primary : fields.to.filter(usable);
  const addressed = new Set(to.map((a) => a.trim().toLowerCase()));
  const cc: string[] = [];
  for (const address of [...fields.to, ...fields.cc]) {
    const key = address.trim().toLowerCase();
    if (!usable(address) || addressed.has(key)) continue;
    addressed.add(key);
    cc.push(address);
  }
  return { to, cc };
}

// A subject read from received mail can still hold a line break (Gmail returns some notification
// subjects with a trailing newline). A header built from one is refused, so the value goes back on
// a single line first.
export function singleLine(value: string): string {
  return value.replace(/[\r\n]+[ \t]*/g, " ").trim();
}

// Subjects and display names arrive encoded and go back out encoded. Anything built from them has
// to be read back first, or the words are encoded twice and the reader sees the markup.
export function replySubject(original: string | undefined): string {
  const s = singleLine(decodeEncodedWords(original ?? ""));
  return /^\s*re:/i.test(s) ? s : `Re: ${s}`;
}

export function forwardSubject(original: string | undefined): string {
  const s = singleLine(decodeEncodedWords(original ?? ""));
  return /^\s*(fwd?|fw):/i.test(s) ? s : `Fwd: ${s}`;
}

/** The header block Gmail and Thunderbird both put above forwarded content. */
export function forwardHeaderBlock(fields: {
  from?: string | undefined;
  date?: string | undefined;
  subject?: string | undefined;
  to?: string | undefined;
  cc?: string | undefined;
}): string {
  return [
    "---------- Forwarded message ---------",
    `From: ${fields.from ?? "unknown"}`,
    `Date: ${fields.date ?? "unknown"}`,
    `Subject: ${fields.subject ?? ""}`,
    `To: ${fields.to ?? ""}`,
    ...(fields.cc ? [`Cc: ${fields.cc}`] : []),
  ].join("\n");
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function forwardHtmlBlock(fields: {
  from?: string | undefined;
  date?: string | undefined;
  subject?: string | undefined;
  to?: string | undefined;
  cc?: string | undefined;
  body: string;
}): string {
  const rows = [
    ["From", fields.from],
    ["Date", fields.date],
    ["Subject", fields.subject],
    ["To", fields.to],
    ["Cc", fields.cc],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `<div><b>${k}:</b> ${escapeHtml(String(v))}</div>`)
    .join("\n");
  return [
    "<div>---------- Forwarded message ---------</div>",
    rows,
    '<blockquote style="margin: 0 0 0 0.8ex; border-left: 1px solid #ccc; padding-left: 1ex;">',
    escapeHtml(fields.body).replace(/\n/g, "<br>\n"),
    "</blockquote>",
  ].join("\n");
}

/** RFC 2047 encoded words, as they arrive in From and Subject. Malformed words stay as written. */
export function decodeEncodedWords(value: string): string {
  return (
    value
      // Whitespace between two encoded words separates them and is not part of the text
      // (RFC 2047 s.6.2).
      .replace(/\?=(?:[ \t]|\r?\n[ \t]+)*(?==\?[\w-]+\?[BbQq]\?)/g, "?=")
      .replace(
        /=\?([\w-]+)\?([BbQq])\?([^?]*)\?=/g,
        (word, charset: string, encoding: string, text: string) => {
          try {
            const bytes =
              encoding.toUpperCase() === "B"
                ? Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0))
                : Uint8Array.from(
                    text
                      .replace(/_/g, " ")
                      .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
                        String.fromCharCode(Number.parseInt(hex, 16)),
                      ),
                    (ch) => ch.charCodeAt(0),
                  );
            return new TextDecoder(charset).decode(bytes);
          } catch {
            return word;
          }
        },
      )
  );
}

export function quotePlain(from: string, date: string, body: string): string {
  const quoted = body
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  return `On ${date}, ${from} wrote:\n${quoted}`;
}

export function quoteHtml(from: string, date: string, plainBody: string): string {
  return [
    `<div>On ${escapeHtml(date)}, ${escapeHtml(from)} wrote:</div>`,
    `<blockquote style="margin: 0 0 0 0.8ex; border-left: 1px solid #ccc; padding-left: 1ex;">`,
    escapeHtml(plainBody).replace(/\n/g, "<br>\n"),
    "</blockquote>",
  ].join("\n");
}

/**
 * RFC 5322 s.3.6.4 spells a msg-id `<id-left@id-right>`, and In-Reply-To carries that header
 * value. The Gmail API's own message id contains no "@" and threads nothing, so a caller passing
 * one has to resolve it to the real Message-ID; null says which case this is.
 */
export function normalizeMessageId(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.includes("@")) return null;
  const bare = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(bare)) return null;
  // An id travels literally, so one past the width of a header line cannot be sent.
  if (bare.length + 2 > MAX_HEADER_RUN) return null;
  return `<${bare}>`;
}

/**
 * A References chain as it can be sent on: only ids a receiver can thread on survive, with the
 * answered message's own id appended when a reply extends the chain.
 */
export function sanitizeReferences(
  chain: string | undefined,
  append?: string | null,
): string | undefined {
  const ids = [...(chain ?? "").split(/\s+/).map(normalizeMessageId), append ?? null].filter(
    Boolean,
  );
  return ids.length > 0 ? ids.join(" ") : undefined;
}

// ---- Reading a Gmail message payload ---------------------------------------------------------------

export type GmailHeader = { name?: string | undefined; value?: string | undefined };
export type GmailBody = {
  size?: number | undefined;
  data?: string | undefined;
  attachmentId?: string | undefined;
};
export type GmailPart = {
  mimeType?: string | undefined;
  filename?: string | undefined;
  headers?: GmailHeader[] | undefined;
  body?: GmailBody | undefined;
  parts?: GmailPart[] | undefined;
};

export function headerOf(part: GmailPart | undefined, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return part?.headers?.find((h) => h.name?.toLowerCase() === wanted)?.value;
}

function partCharset(part: GmailPart): string {
  const ct = headerOf(part, "content-type");
  return ct?.match(/charset\s*=\s*"?([\w-]+)"?/i)?.[1] ?? "utf-8";
}

// Decodes part data honouring its declared charset; unknown charsets fall back to UTF-8.
function decodePartData(part: GmailPart): string {
  const bytes = b64urlToBytes(part.body?.data ?? "");
  try {
    return new TextDecoder(partCharset(part)).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

// The entities that turn up in ordinary mail. Anything else is left as written.
const HTML_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  copy: "\u00a9",
  reg: "\u00ae",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  bull: "\u2022",
};

function codePoint(original: string, value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return original;
  if (value >= 0xd800 && value <= 0xdfff) return original;
  return String.fromCodePoint(value);
}

/** Tags stripped with linear regexes (no DOM parser on the free tier). */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>|<\/(?:p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (match, code: string) => codePoint(match, Number(code)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (match, hex: string) =>
      codePoint(match, Number.parseInt(hex, 16)),
    )
    .replace(
      /&(nbsp|amp|lt|gt|quot|apos|copy|reg|mdash|ndash|hellip|lsquo|rsquo|ldquo|rdquo|bull);/g,
      (match, name: string) => HTML_ENTITIES[name] ?? match,
    )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// A part carrying a filename, or marked attachment by its disposition, is a file the sender
// enclosed rather than the message they wrote.
function isBodyPart(part: GmailPart): boolean {
  const disposition = headerOf(part, "content-disposition") ?? "";
  if (part.filename && !/^\s*inline/i.test(disposition)) return false;
  // An enclosed message brings a whole message with it; its parts belong to that message.
  const type = part.mimeType?.toLowerCase() ?? "";
  if (type.startsWith("message/") || type === "multipart/digest") return false;
  return !/^\s*attachment/i.test(disposition);
}

function bodyParts(payload: GmailPart | undefined): GmailPart[] {
  const out: GmailPart[] = [];
  const walk = (p: GmailPart | undefined) => {
    if (!p || !isBodyPart(p)) return;
    out.push(p);
    for (const child of p.parts ?? []) walk(child);
  };
  walk(payload);
  return out;
}

/** The first text/plain part, else the text/html part with tags stripped; CRLF folded to LF. */
export function extractBody(payload: GmailPart | undefined): string {
  const parts = bodyParts(payload);
  const plain = parts.find((p) => p.mimeType === "text/plain" && p.body?.data);
  if (plain) return decodePartData(plain).replace(/\r\n/g, "\n");
  const html = parts.find((p) => p.mimeType === "text/html" && p.body?.data);
  return html ? htmlToText(decodePartData(html)) : "";
}

/** The HTML alternative as written, markup intact, or an empty string. */
export function extractHtmlBody(payload: GmailPart | undefined): string {
  const html = bodyParts(payload).find((p) => p.mimeType === "text/html" && p.body?.data);
  return html ? decodePartData(html).replace(/\r\n/g, "\n") : "";
}

export interface PartAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

/** The files enclosed in a message: parts with a filename and an attachment id. */
export function listAttachments(payload: GmailPart | undefined): PartAttachment[] {
  const out: PartAttachment[] = [];
  const walk = (p: GmailPart | undefined) => {
    if (!p) return;
    const type = (p.mimeType ?? "").toLowerCase();
    if (p.filename && p.body?.attachmentId) {
      out.push({
        attachmentId: p.body.attachmentId,
        filename: p.filename,
        mimeType: p.mimeType ?? "application/octet-stream",
        size: p.body.size ?? 0,
      });
    }
    if (type.startsWith("message/") || type === "multipart/digest") return;
    for (const child of p.parts ?? []) walk(child);
  };
  walk(payload);
  return out;
}

/** Cuts `text` to `limit` characters without splitting a surrogate pair, and says so. */
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const high = text.charCodeAt(limit - 1);
  const low = text.charCodeAt(limit);
  const splitsPair = high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
  const end = splitsPair ? limit - 1 : limit;
  return `${text.slice(0, end)}\n[truncated: ${text.length - end} of ${text.length} characters omitted]`;
}
