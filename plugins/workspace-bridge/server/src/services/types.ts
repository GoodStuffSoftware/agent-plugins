// Value types shared by every service and tool (ARCHITECTURE s.3.6).

export type ProviderId = "google" | "msgraph" | "imap";

/** One linked account as handlers see it. `shortId` is the `a<shortId>` prefix of its ids (s.3.4). */
export type AccountRef = {
  ownerId: string;
  accountId: string;
  shortId: number;
  label: string;
  /** Lowercase. */
  address: string;
  provider: ProviderId;
};

export type Page<T> = { items: T[]; nextPageToken?: string };
