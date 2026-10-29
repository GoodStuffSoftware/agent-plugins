// The mail.send capability (ARCHITECTURE s.3.6): what the send, reply and forward tools need from a
// provider. Sending is two steps so the guardrails can sit between them: `prepare` only reads
// (the answered or forwarded message, a draft's headers) and returns the recipients the message
// will really have; the tool then runs the send checks; `deliver` builds the message and sends it.
// Values are raw provider data: the tools prefix ids and wrap third-party text.

import type { MimeAttachment } from "../core/mime";
import type { SendAsAddress } from "../core/send-as";
import { capability } from "./capability";
import type { AccountRef } from "./types";

/** What a tool asks to be prepared. Recipient lists are the caller's, already checked. */
export type PrepareInput =
  | {
      kind: "send";
      to: string[];
      cc: string[];
      bcc: string[];
      subject?: string;
      body?: string;
      htmlBody?: string;
      /** Thread the message under this thread (the preferred way for a send-only client). */
      replyThreadId?: string;
      /** The provider id of the message this one answers: sets In-Reply-To and References. */
      replyToMessageId?: string;
      /** Files the caller gave, already checked and within the cap. */
      attachments?: MimeAttachment[];
    }
  | {
      kind: "reply";
      messageId: string;
      replyAll: boolean;
      /** Replace the default recipients when not empty. */
      to: string[];
      cc: string[];
      bcc: string[];
      body?: string;
      htmlBody?: string;
      /** Every address the account sends as: a reply leaves them out of its recipients. */
      selfAddresses: string[];
      /** Files the caller gave, already checked and within the cap. */
      attachments?: MimeAttachment[];
    }
  | {
      kind: "forward";
      messageId: string;
      to: string[];
      cc: string[];
      bcc: string[];
      forwardText?: string;
      htmlBody?: string;
      /** Files the caller gave, already checked and within the cap. */
      attachments?: MimeAttachment[];
      /** Carry the original's files along (they are fetched only once the send is allowed). */
      includeOriginalAttachments: boolean;
      /** Cap on the files of the whole message, the caller's and the original's together. */
      maxAttachmentBytes: number;
    };

/** The original's files a forward carries. Fetched by `deliver`, never by `prepare`. */
export type CarriedAttachments = {
  messageId: string;
  files: { attachmentId: string; filename: string; mimeType: string; size: number }[];
};

/** A message ready to send once the From address is known. */
export type PreparedMessage = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  htmlBody?: string;
  /** The quoted or forwarded original, in both forms, appended below the text. */
  quote?: { plain: string; html: string };
  /** `<id@host>` of the answered message. */
  inReplyTo?: string;
  references?: string;
  threadId?: string;
  /** Files the caller gave. */
  attachments: MimeAttachment[];
  /** The original's files a forward carries; fetched at delivery. */
  carried?: CarriedAttachments;
  /** Every file the message will hold (the caller's and the carried ones), for the audit row. */
  attachmentTotals: AttachmentTotals;
};

/** How many files a message holds and their size in bytes. Never their content. */
export type AttachmentTotals = { count: number; bytes: number };

/** A draft's header fields, enough to check recipients and From before sending it. */
export type DraftEnvelope = {
  /** The From header, as written; absent when the draft has none. */
  from?: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  /** The files the draft holds, for the audit row. */
  attachmentTotals: AttachmentTotals;
  /**
   * The message exactly as read (base64url RFC 822), which the fields above were taken from.
   * `sendDraft` sends these bytes and nothing else.
   */
  raw: string;
  /** The thread the draft belongs to, kept when the message is sent. */
  threadId?: string;
};

export type SentMessage = { id: string; threadId: string; labelIds?: string[] };

export interface SendService {
  prepare(a: AccountRef, input: PrepareInput): Promise<PreparedMessage>;
  /** `from` is set only when the caller named one. */
  deliver(
    a: AccountRef,
    m: PreparedMessage,
    opts: {
      from?: SendAsAddress | undefined;
      includeSignature: boolean;
      /** The signature came from the account's default, not the caller: a failed fetch skips it. */
      signatureOptional?: boolean | undefined;
      /** Cap on the files of the message; checked again against what was really fetched. */
      maxAttachmentBytes: number;
    },
  ): Promise<SentMessage>;
  /** Refused as `too_large` when the message is past `maxBytes` of files plus room for its text. */
  readDraft(a: AccountRef, draftId: string, maxBytes: number): Promise<DraftEnvelope>;
  /**
   * Sends `draft.raw` (what `readDraft` returned and the caller checked, never a fresh copy of the
   * draft) and then deletes the draft `draftId`.
   */
  sendDraft(a: AccountRef, draftId: string, draft: DraftEnvelope): Promise<SentMessage>;
  /**
   * Of `addresses` (already checked as plain, lowercase addresses), those the account has sent a
   * message to before: one batch request of `in:sent to:<address>` lookups. Used by the "hold
   * sends to new recipients" rule; it fails closed (an address that could not be checked is
   * left out).
   */
  sentTo(a: AccountRef, addresses: readonly string[]): Promise<string[]>;
}

export const SEND = capability<SendService>("mail.send", "mail");
