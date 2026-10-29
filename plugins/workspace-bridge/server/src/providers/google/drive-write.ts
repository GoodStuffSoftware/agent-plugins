// Google Drive v3 binding for drive.write. Every call carries `fields=`. Uploads use the
// multipart endpoint (metadata and content in one request); the content part is sent as the
// caller gave it, base64 included (`Content-Transfer-Encoding: base64`), so the Worker never
// decodes or re-encodes a file. There is no call that deletes a file for good.

import type { DriveUpload, DriveWriteService } from "../../services/drive-write";
import { META_FIELDS, type RawFile, toFile } from "./drive-read";
import { gjson } from "./http";

const BASE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const enc = encodeURIComponent;

const DOC = "application/vnd.google-apps.document";
const SHEET = "application/vnd.google-apps.spreadsheet";
const SLIDES = "application/vnd.google-apps.presentation";

/** Content types Drive converts to a Google type when asked. */
const CONVERT: Readonly<Record<string, string>> = {
  "text/plain": DOC,
  "text/html": DOC,
  "application/rtf": DOC,
  "application/msword": DOC,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": DOC,
  "text/csv": SHEET,
  "application/vnd.ms-excel": SHEET,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": SHEET,
  "application/vnd.ms-powerpoint": SLIDES,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": SLIDES,
};

type Meta = Record<string, unknown>;

/** A `multipart/related` body: the metadata as JSON, then the content. */
function multipart(meta: Meta, up: DriveUpload): { body: string; contentType: string } {
  const content = up.base64 ?? up.text ?? "";
  let boundary = `wb${crypto.randomUUID().replaceAll("-", "")}`;
  while (content.includes(boundary)) boundary = `wb${crypto.randomUUID().replaceAll("-", "")}`;
  const transfer = up.base64 === undefined ? "" : "Content-Transfer-Encoding: base64\r\n";
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: ${up.mimeType}\r\n${transfer}\r\n${content}\r\n--${boundary}--`;
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

const clean = (o: Meta): Meta => {
  const out: Meta = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
};

export const googleDriveWrite: DriveWriteService = {
  async create(a, o) {
    const meta: Meta = clean({
      name: o.name,
      id: o.id,
      parents: o.parentId === undefined ? undefined : [o.parentId],
      inheritedPermissionsDisabled: o.inheritedPermissionsDisabled,
    });
    const up = o.upload;
    if (!up) {
      if (o.mimeType !== undefined) meta.mimeType = o.mimeType;
      const r = await gjson<RawFile>(
        a,
        `${BASE}/files`,
        { method: "POST", json: meta },
        { fields: META_FIELDS, query: { supportsAllDrives: true } },
      );
      return toFile(r);
    }
    const google = up.convert ? CONVERT[up.mimeType] : undefined;
    if (google !== undefined) meta.mimeType = google;
    const m = multipart(meta, up);
    const r = await gjson<RawFile>(
      a,
      `${UPLOAD}/files`,
      { method: "POST", headers: { "Content-Type": m.contentType }, body: m.body },
      { fields: META_FIELDS, query: { uploadType: "multipart", supportsAllDrives: true } },
    );
    return toFile(r);
  },

  async update(a, fileId, o) {
    const meta = clean({
      name: o.name,
      description: o.description,
      starred: o.starred,
      folderColorRgb: o.folderColorRgb,
      writersCanShare: o.writersCanShare,
      inheritedPermissionsDisabled: o.inheritedPermissionsDisabled,
      contentRestrictions:
        o.readOnly === undefined
          ? undefined
          : [clean({ readOnly: o.readOnly, reason: o.readOnly ? o.readOnlyReason : undefined })],
      downloadRestrictions:
        o.downloadRestriction === undefined
          ? undefined
          : {
              itemDownloadRestriction: clean({
                restrictedForReaders: o.downloadRestriction.restrictedReader,
                restrictedForWriters: o.downloadRestriction.restrictedWriter,
              }),
            },
    });
    // A move replaces the parents: Drive wants the old ones named in `removeParents`.
    let move: { addParents: string; removeParents?: string } | undefined;
    if (o.parentId !== undefined) {
      const cur = await gjson<{ parents?: string[] }>(
        a,
        `${BASE}/files/${enc(fileId)}`,
        {},
        { fields: "parents", query: { supportsAllDrives: true } },
      );
      const old = (cur.parents ?? []).filter((p) => p !== o.parentId);
      if (!(cur.parents ?? []).includes(o.parentId) || old.length > 0) {
        move = {
          addParents: o.parentId,
          ...(old.length > 0 ? { removeParents: old.join(",") } : {}),
        };
      }
    }
    const query = { supportsAllDrives: true, ...move };
    const up = o.upload;
    if (!up) {
      const r = await gjson<RawFile>(
        a,
        `${BASE}/files/${enc(fileId)}`,
        { method: "PATCH", json: meta },
        { fields: META_FIELDS, query },
      );
      return toFile(r);
    }
    const m = multipart(meta, up);
    const r = await gjson<RawFile>(
      a,
      `${UPLOAD}/files/${enc(fileId)}`,
      { method: "PATCH", headers: { "Content-Type": m.contentType }, body: m.body },
      { fields: META_FIELDS, query: { ...query, uploadType: "multipart" } },
    );
    return toFile(r);
  },

  async copy(a, fileId, o) {
    const r = await gjson<RawFile>(
      a,
      `${BASE}/files/${enc(fileId)}/copy`,
      {
        method: "POST",
        json: clean({
          name: o.name,
          id: o.id,
          parents: o.parentId === undefined ? undefined : [o.parentId],
        }),
      },
      { fields: META_FIELDS, query: { supportsAllDrives: true } },
    );
    return toFile(r);
  },

  async share(a, fileId, o) {
    return gjson(
      a,
      `${BASE}/files/${enc(fileId)}/permissions`,
      {
        method: "POST",
        json: clean({
          type: o.type,
          role: o.role,
          emailAddress: o.emailAddress,
          domain: o.domain,
          expirationTime: o.expirationTime,
        }),
      },
      {
        fields: "id,type,role,emailAddress,domain,expirationTime",
        query: { supportsAllDrives: true },
      },
    );
  },

  async trash(a, fileId) {
    await gjson(
      a,
      `${BASE}/files/${enc(fileId)}`,
      { method: "PATCH", json: { trashed: true } },
      { fields: "id,trashed", query: { supportsAllDrives: true } },
    );
  },
};
