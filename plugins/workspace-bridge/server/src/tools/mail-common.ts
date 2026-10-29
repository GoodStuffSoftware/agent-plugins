// Parameters and checks the mail-writing tools share: the draft tools (M13) and the send, reply and
// forward tools (M15) take the same recipients, subject, bodies, From and threading fields.

import { z } from "zod";
import { ToolError } from "../core/errors";
import {
  base64Bytes,
  cleanBase64,
  isMediaType,
  MAX_ATTACHMENTS,
  type MimeAttachment,
  parseAddresses,
  splitAddressList,
} from "../core/mime";
import { config, type Env } from "../env";
import type { AttachmentTotals } from "../services/mail-send";

/** Plain text body cap, in characters. A larger body is `too_large` before any work is done. */
export const MAX_BODY_CHARS = 50_000;
export const MAX_HTML_BODY_CHARS = 100_000;
const MAX_SUBJECT_CHARS = 998;
const MAX_ENTRIES = 100;

export const accountParam = z
  .string()
  .max(128)
  .optional()
  .describe(
    "The account to use: its short id (`a1`), label or address. Omit for the default account, or the account a prefixed id belongs to.",
  );

const recipients = (what: string) =>
  z
    .array(
      z
        .string()
        .min(1)
        .max(320 + 128),
    )
    .max(MAX_ENTRIES)
    .optional()
    .describe(
      `${what} Each entry is one address, \`user@example.com\` or \`Name <user@example.com>\`.`,
    );

export const toParam = recipients("The To recipients.");
export const ccParam = recipients("The Cc recipients.");
export const bccParam = recipients("The Bcc recipients.");

export const subjectParam = z.string().max(MAX_SUBJECT_CHARS).optional().describe("The subject.");

export const bodyParam = z
  .string()
  .max(MAX_BODY_CHARS)
  .optional()
  .describe(`The plain text body, up to ${MAX_BODY_CHARS} characters.`);

export const htmlBodyParam = z
  .string()
  .max(MAX_HTML_BODY_CHARS)
  .optional()
  .describe(
    `The HTML body, up to ${MAX_HTML_BODY_CHARS} characters. Sent with a plain text alternative: \`body\` when given, else the text of the HTML.`,
  );

export const fromParam = z
  .string()
  .max(320)
  .optional()
  .describe(
    "The address to send from, one of the account's own addresses. Omit to use the account's default address.",
  );

/** A sanity bound on one file's base64; the real limit is MAX_SEND_ATTACHMENT_BYTES for the lot. */
const MAX_ATTACHMENT_CHARS = 4_000_000;

/** The official `attachments` shape (content, filename, mimeType, inline, id). */
export const attachmentsParam = z
  .array(
    z.object({
      content: z
        .string()
        .max(MAX_ATTACHMENT_CHARS)
        .describe("The file, standard base64 encoded (whitespace is ignored)."),
      filename: z
        .string()
        .max(255)
        .optional()
        .describe("The file name shown to the recipient. Optional."),
      mimeType: z
        .string()
        .max(255)
        .optional()
        .describe(
          "A plain type/subtype such as application/pdf. Defaults to application/octet-stream.",
        ),
      inline: z
        .boolean()
        .optional()
        .describe(
          "Inline images are not supported: true is refused. Send the file as an attachment.",
        ),
      id: z.string().max(512).optional().describe("Ignored. Present for compatibility."),
    }),
  )
  .max(MAX_ATTACHMENTS)
  .optional()
  .describe(
    `Files to attach, at most ${MAX_ATTACHMENTS}, within the server's send size limit (MAX_SEND_ATTACHMENT_BYTES, 512 KB by default, for all files together). Over the limit is refused before anything is sent.`,
  );

export const replyToMessageIdParam = z
  .string()
  .min(1)
  .max(256)
  .optional()
  .describe(
    "The id of the message this one answers. The message is threaded under it (In-Reply-To, References), the subject and recipients default from it, and the original is quoted.",
  );

/** One entry of a recipient list: a single mailbox on one line, as `addr` or `Name <addr>`. */
function checkRecipient(name: string, entry: string): string {
  const value = entry.trim();
  if (/[\r\n\0]/.test(value)) {
    throw new ToolError("invalid_argument", `A ${name} recipient must be on a single line.`);
  }
  if (splitAddressList(value).length !== 1 || parseAddresses(value).length !== 1) {
    throw new ToolError(
      "invalid_argument",
      `Each ${name} entry must be one address such as user@example.com or Name <user@example.com>.`,
    );
  }
  const [address] = parseAddresses(value);
  // What goes into the header is a bare address or `display name <address>`; a display name that
  // itself holds angle brackets would make the header say something other than what was checked.
  const angle = value.match(/^(?:"(?:[^"\\]|\\.)*"|[^<>"]*)\s*<([^<>]+)>$/s);
  if (value.includes("<") || value.includes(">")) {
    // A display name with an `@` could carry an address-shaped string that a search of the sent
    // mail matches, so it is refused.
    const shown = value.slice(0, value.lastIndexOf("<"));
    if (!angle || angle[1]?.trim().toLowerCase() !== address || shown.includes("@")) {
      throw new ToolError(
        "invalid_argument",
        `Each ${name} entry must be one address such as user@example.com or Name <user@example.com>.`,
      );
    }
  }
  if (!address || !/^[^\s<>@",;()[\]\\]+@[^\s<>@",;()[\]\\]+\.[^\s<>@",;()[\]\\]+$/.test(address)) {
    throw new ToolError("invalid_argument", `A ${name} entry is not a valid email address.`);
  }
  return value;
}

export interface Recipients {
  to: string[];
  cc: string[];
  bcc: string[];
}

/**
 * Checks and counts the recipients of a message: every entry is one valid address, none carries a
 * line break, and the three lists together stay within `MAX_RECIPIENTS` (`too_many_recipients`).
 * Omitted lists are empty.
 */
export function checkRecipients(
  env: Env,
  given: {
    to?: readonly string[] | undefined;
    cc?: readonly string[] | undefined;
    bcc?: readonly string[] | undefined;
  },
): Recipients {
  const out: Recipients = {
    to: (given.to ?? []).map((e) => checkRecipient("to", e)),
    cc: (given.cc ?? []).map((e) => checkRecipient("cc", e)),
    bcc: (given.bcc ?? []).map((e) => checkRecipient("bcc", e)),
  };
  assertRecipientCount(env, out);
  return out;
}

export function assertRecipientCount(env: Env, r: Recipients): void {
  const max = config(env).maxRecipients;
  const total = new Set([...r.to, ...r.cc, ...r.bcc].map((e) => parseAddresses(e)[0] ?? e)).size;
  if (total > max) {
    throw new ToolError(
      "too_many_recipients",
      `A message may have at most ${max} recipients across to, cc and bcc; this one has ${total}.`,
      { max, count: total },
    );
  }
}

type GivenAttachment = {
  content: string;
  filename?: string | undefined;
  mimeType?: string | undefined;
  inline?: boolean | undefined;
};

/**
 * The caller's files, checked before any Google call: no inline images, a plain media type, a
 * filename on one line, standard base64, and a total within `MAX_SEND_ATTACHMENT_BYTES`. Returns
 * the files as the MIME builder takes them (the base64 as given, never decoded) and their totals.
 */
export function checkAttachments(
  env: Env,
  given: readonly GivenAttachment[] | undefined,
): { files: MimeAttachment[]; totals: AttachmentTotals } {
  const files: MimeAttachment[] = [];
  let bytes = 0;
  const cap = config(env).maxSendAttachmentBytes;
  (given ?? []).forEach((f, i) => {
    const name = `attachments[${i}]`;
    if (f.inline === true) {
      throw new ToolError(
        "invalid_argument",
        `${name}: inline attachments are not supported. Send the file as a regular attachment.`,
      );
    }
    const mimeType = (f.mimeType ?? "").trim().toLowerCase() || "application/octet-stream";
    if (!isMediaType(mimeType)) {
      throw new ToolError(
        "invalid_argument",
        `${name}: mimeType must be a plain type/subtype such as application/pdf.`,
      );
    }
    assertSingleLine(`${name} filename`, f.filename);
    const content = cleanBase64(name, f.content);
    bytes += base64Bytes(content);
    if (bytes > cap) throw tooLargeToSend(cap, bytes);
    files.push({ ...(f.filename ? { filename: f.filename } : {}), mimeType, content });
  });
  return { files, totals: { count: files.length, bytes } };
}

/** The refusal for files over the send cap, the same wherever it is found. */
export const tooLargeToSend = (cap: number, totalBytes: number): ToolError =>
  new ToolError(
    "too_large",
    `The attachments are larger than the ${cap} byte send limit (all files together).`,
    { maxBytes: cap, totalBytes },
  );

/** The audit `detail` for a message that holds files: the count and total size, never content. */
export const attachmentDetail = (t: AttachmentTotals): string =>
  `attachments=${t.count} bytes=${t.bytes}`;

/** A subject or similar line from the caller: a line break would split the header. */
export function assertSingleLine(name: string, value: string | undefined): void {
  if (value !== undefined && /[\r\n\0]/.test(value)) {
    throw new ToolError("invalid_argument", `The ${name} must be a single line.`);
  }
}
