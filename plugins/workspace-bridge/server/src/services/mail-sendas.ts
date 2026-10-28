// The `mail.sendas` capability (ARCHITECTURE s.3.6): the From addresses the provider lists for an
// account. `core/send-as.ts` caches them in `send_as` and decides which ones a send may use.

import { capability } from "./capability";
import type { AccountRef } from "./types";

export interface SendAsEntry {
  /** Lowercase. */
  email: string;
  displayName: string | null;
  replyTo: string | null;
  isPrimary: boolean;
  isDefault: boolean;
  /** Gmail's `verificationStatus` (`accepted`, `pending`); null for the primary address. */
  verificationStatus: string | null;
}

export interface SendAsService {
  list(a: AccountRef): Promise<SendAsEntry[]>;
}

export const SENDAS = capability<SendAsService>("mail.sendas", "mail");
