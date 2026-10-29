// Gmail binding of the mail.attachments capability (plan s.8.2), and the download the forward path
// shares with it.
//
// `messages.attachments.get` answers `{size, data}` with the file as base64url. The Worker has 10 ms
// of CPU, so the file is never decoded: base64url becomes standard base64 by swapping two
// characters and adding padding, which is also what an MCP blob and a MIME part carry. The answer
// is read through a capped stream, so a file larger than its part said is cut off, not buffered.

import { ToolError } from "../../core/errors";
import { base64Bytes, type GmailPart, listAttachments, type PartAttachment } from "../../core/mime";
import { provide } from "../../services/capability";
import {
  ATTACHMENTS,
  type AttachmentContent,
  type AttachmentService,
} from "../../services/mail-attachments";
import type { AccountRef } from "../../services/types";
import { gfetch, gjson } from "./http";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const enc = encodeURIComponent;
/** What the JSON envelope around the base64 data may add: `{"size":N,"data":"..."}`. */
const ENVELOPE_SLACK = 256;

export const tooLarge = (maxBytes: number, sizeBytes?: number): ToolError =>
  new ToolError(
    "too_large",
    `The attachment is larger than the ${maxBytes} byte limit.`,
    sizeBytes === undefined ? { maxBytes } : { maxBytes, sizeBytes },
  );

/** base64url to standard base64: two characters swapped and padding added, nothing decoded. */
export function toStandardBase64(url: string): string {
  const std = url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (std.length % 4)) % 4;
  return pad === 0 ? std : std + "=".repeat(pad);
}

/** Reads at most `max` bytes of a body as text; undefined when there is more. */
async function readCappedText(res: Response, max: number): Promise<string | undefined> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    throw new ToolError("upstream_error", "Google's reply did not arrive in time.");
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(bytes);
}

/** One attachment's content by id, refused as `too_large` past `maxBytes`. No metadata lookup. */
export async function downloadAttachment(
  a: AccountRef,
  messageId: string,
  attachmentId: string,
  maxBytes: number,
): Promise<{ content: string; bytes: number }> {
  const res = await gfetch(
    a,
    `${BASE}/messages/${enc(messageId)}/attachments/${enc(attachmentId)}`,
    {},
    { fields: "size,data" },
  );
  // Base64 is 4 characters to 3 bytes.
  const text = await readCappedText(res, Math.ceil(maxBytes / 3) * 4 + ENVELOPE_SLACK);
  if (text === undefined) throw tooLarge(maxBytes);
  let parsed: { size?: number; data?: string };
  try {
    parsed = JSON.parse(text) as { size?: number; data?: string };
  } catch {
    throw new ToolError("upstream_error", "Google sent a reply that is not valid JSON.");
  }
  const content = toStandardBase64(parsed.data ?? "");
  const bytes = base64Bytes(content);
  if (bytes > maxBytes) throw tooLarge(maxBytes, bytes);
  return { content, bytes };
}

/** The files a message holds, as its parts list them. */
export async function listMessageAttachments(
  a: AccountRef,
  messageId: string,
): Promise<PartAttachment[]> {
  const m = await gjson<{ id?: string; payload?: GmailPart }>(
    a,
    `${BASE}/messages/${enc(messageId)}`,
    {},
    { fields: "id,payload", query: { format: "full" } },
  );
  if (!m.id) throw new ToolError("upstream_error", "Google sent a message in an unexpected shape.");
  return listAttachments(m.payload);
}

async function get(
  a: AccountRef,
  messageId: string,
  attachmentId: string,
  maxBytes: number,
): Promise<AttachmentContent> {
  // The part says how large the file is, so an over-cap file is refused before it is downloaded.
  // Gmail may hand out a different attachment id for the same part on another read; a message that
  // no longer lists this id is still downloaded, just without its filename and type.
  const part = (await listMessageAttachments(a, messageId)).find(
    (f) => f.attachmentId === attachmentId,
  );
  if (part && part.size > maxBytes) throw tooLarge(maxBytes, part.size);
  const file = await downloadAttachment(a, messageId, attachmentId, maxBytes);
  return {
    ...file,
    ...(part ? { filename: part.filename, mimeType: part.mimeType } : {}),
  };
}

const service: AttachmentService = { get };

export const googleAttachments = provide(ATTACHMENTS, service);
