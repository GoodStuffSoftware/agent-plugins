// Google Drive v3 binding for drive.read. Reads only; every call carries `fields=`.

import { ToolError } from "../../core/errors";
import type {
  DriveContent,
  DriveFile,
  DrivePermission,
  DriveReadService,
  RecentOrder,
} from "../../services/drive-read";
import { gfetch, gjson } from "./http";

const BASE = "https://www.googleapis.com/drive/v3";

const LIST_FIELDS =
  "id,name,mimeType,modifiedTime,createdTime,size,webViewLink,parents,driveId,shared,ownedByMe,starred,trashed,owners(displayName,emailAddress,me)";
const META_FIELDS = `${LIST_FIELDS},description,lastModifyingUser(displayName,emailAddress,me)`;
const RECENT_FIELDS = `${LIST_FIELDS},viewedByMeTime,modifiedByMeTime,sharedWithMeTime`;

const enc = encodeURIComponent;

interface RawFile extends Omit<DriveFile, "size" | "sortTime"> {
  /** Drive sends the byte count as a string. */
  size?: string;
  viewedByMeTime?: string;
  modifiedByMeTime?: string;
  sharedWithMeTime?: string;
}

const ms = (t: string | undefined): number => {
  const v = t ? Date.parse(t) : Number.NaN;
  return Number.isNaN(v) ? 0 : v;
};

function toFile(r: RawFile, sortTime?: number): DriveFile {
  const { size, viewedByMeTime, modifiedByMeTime, sharedWithMeTime, ...rest } = r;
  const f: DriveFile = { ...rest };
  if (size !== undefined && size !== "" && !Number.isNaN(Number(size))) f.size = Number(size);
  if (sortTime !== undefined) f.sortTime = sortTime;
  return f;
}

// ---- The query dialect ---------------------------------------------------------------------------

const QUOTED = /'(?:[^'\\]|\\.)*'/g;
const HOLE = "\u0000(\\d+)\u0000";
const FIELD_USE = new RegExp(
  "\\b(?:name|title|fullText|mimeType|modifiedTime|viewedByMeTime|createdTime|parentId|owner|sharedWithMe|starred|trashed|properties|appProperties|visibility|folderProperties)\\s*(?:contains|!=|<=|>=|=|<|>|has|in)(?![A-Za-z0-9_])" +
    `|${HOLE}\\s+in\\s+(?:parents|owners|writers|readers)\\b`,
  "i",
);

/**
 * A Drive `q` for what the caller typed. Plain text becomes `fullText contains`. A structured
 * query is passed on, with the official tool's `title`, `parentId` and `owner` terms rewritten to
 * Drive's `name`, `'x' in parents` and `'x' in owners` (a bridge-prefixed id such as `a1:abc` in
 * `parentId` loses its prefix). Trashed files are left out unless the query mentions `trashed`.
 */
export function driveQuery(raw: string | undefined): string {
  const text = (raw ?? "").replaceAll("\u0000", "").trim();
  if (text === "") return "trashed = false";
  const quoted: string[] = [];
  const masked = text.replace(QUOTED, (m) => `\u0000${quoted.push(m) - 1}\u0000`);
  const restore = (s: string): string =>
    s.replace(new RegExp(HOLE, "g"), (_m, i: string) => quoted[Number(i)] ?? "");
  if (!FIELD_USE.test(masked)) {
    const escaped = text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    return `fullText contains '${escaped}' and trashed = false`;
  }
  const q = restore(
    masked
      .replace(
        new RegExp(`\\bparentId\\s*(!=|=)\\s*(${HOLE})`, "gi"),
        (_m, op: string, hole: string) =>
          `${op === "=" ? "" : "not "}${restore(hole).replace(/^'a[1-9][0-9]{0,8}:/, "'")} in parents`,
      )
      .replace(
        new RegExp(`\\bowner\\s*(!=|=)\\s*(${HOLE})`, "gi"),
        (_m, op: string, hole: string) => `${op === "=" ? "" : "not "}${restore(hole)} in owners`,
      )
      .replace(/\btitle\b(?=\s*(?:contains|!=|=))/gi, "name"),
  );
  return /\btrashed\b/i.test(masked) ? q : `(${q}) and trashed = false`;
}

// ---- Recent files --------------------------------------------------------------------------------

const ORDER: Record<RecentOrder, string> = {
  recency: "recency desc",
  lastModified: "modifiedTime desc",
  lastModifiedByMe: "modifiedByMeTime desc",
};

function recentTime(r: RawFile, order: RecentOrder): number {
  if (order === "lastModified") return ms(r.modifiedTime);
  if (order === "lastModifiedByMe") return ms(r.modifiedByMeTime);
  return Math.max(
    ms(r.modifiedTime),
    ms(r.viewedByMeTime),
    ms(r.modifiedByMeTime),
    ms(r.createdTime),
    ms(r.sharedWithMeTime),
  );
}

// ---- Bodies --------------------------------------------------------------------------------------

/** Reads at most `max` bytes of a body and cancels the rest. */
async function readCapped(res: Response, max: number): Promise<DriveContent> {
  const reader = res.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(0), more: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let more = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.length > max) {
        chunks.push(value.subarray(0, max - total));
        total = max;
        more = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } catch {
    throw new ToolError("upstream_error", "Google's reply did not arrive in time.");
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return { bytes, more };
}

export const googleDriveRead: DriveReadService = {
  async search(a, o) {
    const r = await gjson<{ files?: RawFile[]; nextPageToken?: string }>(
      a,
      `${BASE}/files`,
      {},
      {
        fields: `nextPageToken,files(${LIST_FIELDS})`,
        query: {
          q: driveQuery(o.query),
          pageSize: o.pageSize,
          pageToken: o.pageToken,
          orderBy: o.byModified ? "modifiedTime desc" : undefined,
          supportsAllDrives: true,
          includeItemsFromAllDrives: o.includeSharedDrives ? true : undefined,
          corpora: o.includeSharedDrives ? "allDrives" : undefined,
        },
      },
    );
    return {
      items: (r.files ?? []).map((f) => toFile(f, ms(f.modifiedTime))),
      ...(r.nextPageToken ? { nextPageToken: r.nextPageToken } : {}),
    };
  },

  async recent(a, o) {
    const r = await gjson<{ files?: RawFile[]; nextPageToken?: string }>(
      a,
      `${BASE}/files`,
      {},
      {
        fields: `nextPageToken,files(${RECENT_FIELDS})`,
        query: {
          q: "trashed = false",
          pageSize: o.pageSize,
          pageToken: o.pageToken,
          orderBy: ORDER[o.orderBy],
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        },
      },
    );
    return {
      items: (r.files ?? []).map((f) => toFile(f, recentTime(f, o.orderBy))),
      ...(r.nextPageToken ? { nextPageToken: r.nextPageToken } : {}),
    };
  },

  async metadata(a, fileId) {
    const r = await gjson<RawFile>(
      a,
      `${BASE}/files/${enc(fileId)}`,
      {},
      { fields: META_FIELDS, query: { supportsAllDrives: true } },
    );
    return toFile(r);
  },

  async permissions(a, fileId) {
    const r = await gjson<{ permissions?: DrivePermission[]; nextPageToken?: string }>(
      a,
      `${BASE}/files/${enc(fileId)}/permissions`,
      {},
      {
        fields:
          "nextPageToken,permissions(id,type,role,emailAddress,displayName,domain,deleted,pendingOwner)",
        query: { supportsAllDrives: true, pageSize: 100 },
      },
    );
    return { items: r.permissions ?? [], more: Boolean(r.nextPageToken) };
  },

  async content(a, fileId, o) {
    const file = `${BASE}/files/${enc(fileId)}`;
    const res = o.exportMimeType
      ? await gfetch(a, `${file}/export`, {}, { query: { mimeType: o.exportMimeType } })
      : o.revisionId
        ? await gfetch(a, `${file}/revisions/${enc(o.revisionId)}`, {}, { query: { alt: "media" } })
        : await gfetch(a, file, {}, { query: { alt: "media", supportsAllDrives: true } });
    return readCapped(res, o.maxBytes);
  },
};
