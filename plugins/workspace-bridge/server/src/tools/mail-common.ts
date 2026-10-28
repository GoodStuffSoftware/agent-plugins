// Parameters and checks the mail-writing tools share: the draft tools (M13) and the send, reply and
// forward tools (M15) take the same recipients, subject, bodies, From and threading fields.

import { z } from "zod";
import { ToolError } from "../core/errors";
import { parseAddresses, splitAddressList } from "../core/mime";
import { config, type Env } from "../env";

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

/** The official `attachments` shape. Accepted so a client can send the official call; not built yet. */
export const attachmentsParam = z
  .array(
    z.object({
      content: z.string().describe("The file, base64 encoded."),
      filename: z.string().optional(),
      mimeType: z.string().optional(),
      inline: z.boolean().optional(),
      id: z.string().optional(),
    }),
  )
  .optional()
  .describe("File attachments. Not supported yet: a non-empty list is refused.");

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

/** Attachments arrive with M16; until then a non-empty list is refused rather than dropped. */
export function assertNoAttachments(attachments: readonly unknown[] | undefined): void {
  if (attachments && attachments.length > 0) {
    throw new ToolError(
      "invalid_argument",
      "Attachments are not supported yet. Send the message without the attachments parameter.",
    );
  }
}

/** A subject or similar line from the caller: a line break would split the header. */
export function assertSingleLine(name: string, value: string | undefined): void {
  if (value !== undefined && /[\r\n\0]/.test(value)) {
    throw new ToolError("invalid_argument", `The ${name} must be a single line.`);
  }
}
