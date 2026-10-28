// The drive.write capability (ARCHITECTURE s.3.6): create, update, copy, share and trash Drive
// files. There is no permanent delete: `trash` is reversible from Drive's own trash.

import { capability } from "./capability";
import type { DriveFile } from "./drive-read";
import type { AccountRef } from "./types";

/** Content to upload with a file. Exactly one of `text` and `base64` is set. */
export interface DriveUpload {
  /** The MIME type of the content. */
  mimeType: string;
  text?: string;
  /** Standard base64 (no line breaks), passed to Drive as it is. */
  base64?: string;
  /** Convert the content to the matching Google type (Docs, Sheets, Slides) when there is one. */
  convert?: boolean;
}

export interface DriveCreate {
  name: string;
  /** The file's own type when no content is uploaded (a Google type or a folder). */
  mimeType?: string;
  parentId?: string;
  /** A pregenerated file id. */
  id?: string;
  inheritedPermissionsDisabled?: boolean;
  upload?: DriveUpload;
}

export interface DriveUpdate {
  name?: string;
  description?: string;
  starred?: boolean;
  folderColorRgb?: string;
  /** Moves the file: this becomes its only parent. */
  parentId?: string;
  readOnly?: boolean;
  readOnlyReason?: string;
  writersCanShare?: boolean;
  downloadRestriction?: { restrictedReader?: boolean; restrictedWriter?: boolean };
  inheritedPermissionsDisabled?: boolean;
  /** Replaces the file's content. */
  upload?: DriveUpload;
}

export interface DriveShare {
  type: "user" | "group" | "domain" | "anyone";
  role: "reader" | "commenter" | "writer";
  emailAddress?: string;
  domain?: string;
  expirationTime?: string;
}

export interface DriveGranted {
  id: string;
  type: string;
  role: string;
  emailAddress?: string;
  domain?: string;
  expirationTime?: string;
}

export interface DriveWriteService {
  create(a: AccountRef, o: DriveCreate): Promise<DriveFile>;
  update(a: AccountRef, fileId: string, o: DriveUpdate): Promise<DriveFile>;
  copy(
    a: AccountRef,
    fileId: string,
    o: { name?: string; parentId?: string; id?: string },
  ): Promise<DriveFile>;
  /** Adds (or raises) one permission. Sends Google's notification mail to a user or group. */
  share(a: AccountRef, fileId: string, o: DriveShare): Promise<DriveGranted>;
  /** Moves the file to Drive's trash. Never deletes it for good. */
  trash(a: AccountRef, fileId: string): Promise<void>;
}

export const DRIVE_WRITE = capability<DriveWriteService>("drive.write", "files");
