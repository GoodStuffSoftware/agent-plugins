// The mail.attachments capability (ARCHITECTURE s.3.6): what the `get_attachment` tool needs from a
// provider. Values are raw provider data: the tool prefixes ids and wraps third-party text.

import { capability } from "./capability";
import type { AccountRef } from "./types";

/** One file of a message, read in full. */
export type AttachmentContent = {
  /** The file as standard base64 (not base64url). */
  content: string;
  /** Decoded size in bytes. */
  bytes: number;
  /** From the message's own parts; absent when the message no longer lists the attachment id. */
  filename?: string;
  mimeType?: string;
};

export interface AttachmentService {
  /**
   * Reads one attachment of a message. A file known to be larger than `maxBytes` is refused with
   * `too_large` before it is downloaded; one of unknown size is read through a capped stream and
   * refused when it turns out larger.
   */
  get(
    a: AccountRef,
    messageId: string,
    attachmentId: string,
    maxBytes: number,
  ): Promise<AttachmentContent>;
}

export const ATTACHMENTS = capability<AttachmentService>("mail.attachments", "mail");
