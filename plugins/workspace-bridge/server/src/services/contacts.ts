// The contacts capability (ARCHITECTURE s.3.6): search and read the account's contacts.

import { capability } from "./capability";
import type { AccountRef } from "./types";

export interface ContactInfo {
  /** Provider resource name, for example `people/c123` or `otherContacts/c456`. */
  id: string;
  /** `contact` for the account's own contacts, `other` for people the account has emailed. */
  source: "contact" | "other";
  displayName?: string;
  emails: string[];
  phones: string[];
  organizations: { name?: string; title?: string }[];
  notes?: string;
}

export interface ContactService {
  /**
   * Contacts and other contacts matching `query`, merged; an other contact whose emails are
   * all already covered by one of the account's own contacts is dropped, at most `limit` items in total.
   */
  search(a: AccountRef, query: string, limit: number): Promise<ContactInfo[]>;
  /** One of the account's own contacts by resource name (`people/...`). */
  get(a: AccountRef, resourceName: string): Promise<ContactInfo>;
}

export const CONTACTS = capability<ContactService>("contacts", "contacts");
