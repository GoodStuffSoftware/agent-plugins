// Read side of mail (ARCHITECTURE s.3.6, "mail.read"): search threads, read a thread or a
// message. Plain data in, plain data out; the tools add ids, wrapping and paging.

import { capability } from "./capability";
import type { AccountRef, Page } from "./types";

export const MESSAGE_FORMATS = ["MINIMAL", "FULL_CONTENT", "METADATA_ONLY", "PLAIN_TEXT"] as const;
export type MessageFormat = (typeof MESSAGE_FORMATS)[number];

export const DEFAULT_MAX_BODY_CHARS = 8192;
export const MAX_BODY_CHARS = 32_768;

export interface SearchQuery {
  query?: string;
  labelIds?: string[];
  includeSpamTrash: boolean;
  pageSize: number;
  pageToken?: string | null;
}

/** A thread as a search lists it, from the metadata of its messages. Times are epoch ms. */
export interface ThreadSummary {
  id: string;
  messageCount: number;
  /** The newest message's time. */
  date: number;
  labelIds: string[];
  /** The first message's subject. */
  subject: string;
  /** The newest message's sender header. */
  from: string;
  /** The newest message's snippet. */
  snippet: string;
}

export interface BodyOpts {
  format: MessageFormat;
  maxBodyChars: number;
  includeHtml: boolean;
}

export interface AttachmentInfo {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

/** A message. Header strings are as the header gives them, "" when absent. */
export interface MailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  /** Epoch ms. */
  date: number;
  sizeEstimate: number;
  subject: string;
  from: string;
  to: string;
  cc: string;
  bcc: string;
  snippet: string;
  /** Plain text, already cut to `maxBodyChars` with a marker when it was longer. */
  text?: string;
  /** The HTML part, same cut; only with `includeHtml`. */
  html?: string;
  truncated: boolean;
  attachments: AttachmentInfo[];
}

export interface ThreadDetail {
  id: string;
  /** Messages in the thread, drafts left out. */
  totalMessages: number;
  messageOffset: number;
  messages: MailMessage[];
}

export interface MailReader {
  search(a: AccountRef, q: SearchQuery): Promise<Page<ThreadSummary>>;
  /** `messageOffset` counts from the oldest message; undefined = the newest `messageLimit`. */
  getThread(
    a: AccountRef,
    id: string,
    opts: BodyOpts & { messageLimit: number; messageOffset?: number },
  ): Promise<ThreadDetail>;
  getMessage(a: AccountRef, id: string, opts: BodyOpts): Promise<MailMessage>;
}

export const MAIL_READ = capability<MailReader>("mail.read", "mail");
