// The mail.filters capability (ARCHITECTURE s.3.6): the mailbox's filters. A filter matches incoming
// mail by criteria and then labels, archives or forwards it. Label ids are the provider's own.

import { capability } from "./capability";
import type { AccountRef } from "./types";

export interface FilterCriteria {
  from?: string;
  to?: string;
  subject?: string;
  query?: string;
  negatedQuery?: string;
  hasAttachment?: boolean;
  excludeChats?: boolean;
  size?: number;
  sizeComparison?: "larger" | "smaller";
}

export interface FilterAction {
  addLabelIds?: string[];
  removeLabelIds?: string[];
  /** A verified forwarding address of the account. */
  forward?: string;
}

export interface FilterInfo {
  id: string;
  criteria: FilterCriteria;
  action: FilterAction;
}

export interface FilterService {
  list(a: AccountRef): Promise<FilterInfo[]>;
  create(
    a: AccountRef,
    filter: { criteria: FilterCriteria; action: FilterAction },
  ): Promise<FilterInfo>;
  remove(a: AccountRef, id: string): Promise<void>;
}

export const FILTERS = capability<FilterService>("mail.filters", "mail");
