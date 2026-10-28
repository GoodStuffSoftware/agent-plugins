// The drive.read capability (ARCHITECTURE s.3.6): search, list, metadata, content and permissions.

import { capability } from "./capability";
import type { AccountRef, Page } from "./types";

export interface DriveUser {
  displayName?: string;
  emailAddress?: string;
  /** True when the user is the account owner. */
  me?: boolean;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  createdTime?: string;
  /** Bytes; absent for Google-native files and folders. */
  size?: number;
  webViewLink?: string;
  parents?: string[];
  driveId?: string;
  shared?: boolean;
  ownedByMe?: boolean;
  starred?: boolean;
  trashed?: boolean;
  owners?: DriveUser[];
  /** Only from `metadata`. */
  description?: string;
  lastModifyingUser?: DriveUser;
  /** Epoch milliseconds the list is ordered by (`recent`; `search` when `byModified`). */
  sortTime?: number;
}

export interface DrivePermission {
  id: string;
  type: string;
  role: string;
  emailAddress?: string;
  displayName?: string;
  domain?: string;
  deleted?: boolean;
  pendingOwner?: boolean;
}

export type RecentOrder = "recency" | "lastModified" | "lastModifiedByMe";

/** At most `maxBytes` of a body; `more` when the body continued past them. */
export interface DriveContent {
  bytes: Uint8Array;
  more: boolean;
}

export interface DriveReadService {
  /** `query` is a Drive `q` or plain text; `byModified` asks for newest-modified first. */
  search(
    a: AccountRef,
    o: {
      query?: string;
      pageSize: number;
      pageToken?: string;
      includeSharedDrives: boolean;
      byModified: boolean;
    },
  ): Promise<Page<DriveFile>>;
  recent(
    a: AccountRef,
    o: { orderBy: RecentOrder; pageSize: number; pageToken?: string },
  ): Promise<Page<DriveFile>>;
  metadata(a: AccountRef, fileId: string): Promise<DriveFile>;
  /** `more` when Google has further permissions than the first page. */
  permissions(a: AccountRef, fileId: string): Promise<{ items: DrivePermission[]; more: boolean }>;
  /**
   * The file's bytes, or its export when `exportMimeType` is set, stopping after `maxBytes` so a
   * big body is never read whole.
   */
  content(
    a: AccountRef,
    fileId: string,
    o: { exportMimeType?: string; revisionId?: string; maxBytes: number },
  ): Promise<DriveContent>;
}

export const DRIVE_READ = capability<DriveReadService>("drive.read", "files");
