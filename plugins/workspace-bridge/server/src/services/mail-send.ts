// The mail.send capability (ARCHITECTURE s.3.6): what the send, reply and forward tools need from a
// provider. Sending is two steps so the guardrails can sit between them: `prepare` only reads
// (the answered or forwarded message, a draft's headers) and returns the recipients the message
// will really have; the tool then runs the send checks; `deliver` builds the message and sends it.
// Values are raw provider data: the tools prefix ids and wrap third-party text.

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
    }
  | {
      kind: "forward";
      messageId: string;
      to: string[];
      cc: string[];
      bcc: string[];
      forwardText?: string;
      htmlBody?: string;
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
  /** Files on the original that are not carried along yet (forward only). */
  omittedAttachments: number;
};

/** A draft's header fields, enough to check recipients and From before sending it. */
export type DraftEnvelope = {
  /** The From header, as written; absent when the draft has none. */
  from?: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
};

export type SentMessage = { id: string; threadId: string; labelIds?: string[] };

export interface SendService {
  prepare(a: AccountRef, input: PrepareInput): Promise<PreparedMessage>;
  /** `from` is set only when the caller named one. */
  deliver(
    a: AccountRef,
    m: PreparedMessage,
    opts: { from?: SendAsAddress | undefined; includeSignature: boolean },
  ): Promise<SentMessage>;
  readDraft(a: AccountRef, draftId: string): Promise<DraftEnvelope>;
  sendDraft(a: AccountRef, draftId: string): Promise<SentMessage>;
}

export const SEND = capability<SendService>("mail.send", "mail");
