// The mail.state capability (ARCHITECTURE s.3.6): archive, read and star flags, spam and trash on
// messages and threads. Trash is the reversible Trash label (30 days); nothing here deletes for good.

import { capability } from "./capability";
import type { AccountRef } from "./types";

export interface StateTarget {
  kind: "message" | "thread";
  id: string;
}

export interface StateService {
  /** Adds and removes system labels (INBOX, UNREAD, STARRED, SPAM) in one call. */
  modify(
    a: AccountRef,
    t: StateTarget,
    change: { add?: string[]; remove?: string[] },
  ): Promise<void>;
  trash(a: AccountRef, t: StateTarget): Promise<void>;
  untrash(a: AccountRef, t: StateTarget): Promise<void>;
}

export const STATE = capability<StateService>("mail.state", "mail");
