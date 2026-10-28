// The mail.labels capability (ARCHITECTURE s.3.6): label management and label changes.

import { capability } from "./capability";
import type { AccountRef } from "./types";

export type LabelListVisibility = "LABEL_SHOW" | "LABEL_SHOW_IF_UNREAD" | "LABEL_HIDE";
export type MessageListVisibility = "SHOW" | "HIDE";

export interface LabelColor {
  backgroundColor: string;
  textColor: string;
}

export interface Label {
  id: string;
  name: string;
  type: "system" | "user";
  labelListVisibility?: string;
  messageListVisibility?: string;
  color?: LabelColor;
}

/** Fields a label can be created or updated with; `undefined` means unchanged. */
export interface LabelInput {
  name?: string;
  labelListVisibility?: LabelListVisibility;
  messageListVisibility?: MessageListVisibility;
  color?: LabelColor;
}

export interface LabelTarget {
  kind: "message" | "thread";
  id: string;
}

export interface LabelService {
  list(a: AccountRef): Promise<Label[]>;
  create(a: AccountRef, l: LabelInput & { name: string }): Promise<Label>;
  update(a: AccountRef, id: string, l: LabelInput): Promise<Label>;
  remove(a: AccountRef, id: string): Promise<void>;
  modify(
    a: AccountRef,
    t: LabelTarget,
    change: { add?: string[]; remove?: string[] },
  ): Promise<void>;
}

export const LABELS = capability<LabelService>("mail.labels", "mail");
