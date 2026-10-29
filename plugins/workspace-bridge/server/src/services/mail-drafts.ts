// The mail.drafts capability (ARCHITECTURE s.3.6): what the draft tools need from a provider.
// Values are raw provider data; the tools prefix ids and wrap third-party text.

import type { MimeAttachment } from "../core/mime";
import type { SendAsAddress } from "../core/send-as";
import { capability } from "./capability";
import type { AccountRef } from "./types";

export type DraftAttachment = {
  /** The provider's attachment id, for `get_attachment`. */
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
};

/** A draft as a provider reports it. Which fields are set depends on the requested depth. */
export type Draft = {
  id: string;
  messageId: string;
  threadId: string;
  viewUrl: string;
  labelIds?: string[];
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  date?: string;
  snippet?: string;
  plaintextBody?: string;
  htmlBody?: string;
  /** The whole RFC 822 text, for `RAW`. */
  raw?: string;
  attachments?: DraftAttachment[];
};

/** How much of a draft to read: `minimal` is ids and labels, `headers` adds the header fields. */
export type DraftDepth = "minimal" | "headers" | "full" | "plain" | "raw";

export type CreateDraftInput = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject?: string;
  body?: string;
  htmlBody?: string;
  /** Set only when the caller named a From; otherwise the account's default address is used. */
  from?: SendAsAddress;
  includeSignature?: boolean;
  /** The provider id of the message this draft answers. */
  replyToMessageId?: string;
  /** Every address the account sends as, so a reply leaves them out of its recipients. */
  selfAddresses: string[];
  /** Files the caller gave, already checked and within the cap. */
  attachments?: MimeAttachment[];
};

export type UpdateDraftInput = {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  htmlBody?: string;
  from?: SendAsAddress;
  /** Replace the draft's files with these; left out, the draft keeps the files it has. */
  attachments?: MimeAttachment[];
  /** Cap on the files the rewritten draft holds, whether new or kept. */
  maxAttachmentBytes: number;
};

export interface DraftService {
  create(a: AccountRef, input: CreateDraftInput): Promise<Draft>;
  get(a: AccountRef, draftId: string, depth: DraftDepth): Promise<Draft>;
  list(
    a: AccountRef,
    opts: { query?: string; pageSize: number; pageToken?: string | null; full: boolean },
  ): Promise<{ items: Draft[]; nextPageToken?: string | undefined }>;
  update(a: AccountRef, draftId: string, input: UpdateDraftInput): Promise<Draft>;
  remove(a: AccountRef, draftId: string): Promise<void>;
}

export const DRAFTS = capability<DraftService>("mail.drafts", "mail");
