// The drive.write family (ARCHITECTURE s.2, s.5; plan s.8.4, s.10): create, update, copy, share
// and trash Drive files. Full endpoint only. There is no permanent delete: trash is reversible.
// `share_file` is held for the owner's approval when it would open a file to anyone, to a whole
// domain or to an address that is not one of the owner's accounts or allowed addresses; every
// share (held, done or failed) writes an audit row. File names and descriptions in the answers
// are wrapped as third-party text: a copy carries the original's name, and a name or description
// is exactly where an injected instruction would sit.

import { z } from "zod";
import { loadAccountRefs } from "../core/accounts";
import { ToolError } from "../core/errors";
import { accountKey } from "../core/ids";
import { config } from "../env";
import { googleDriveWrite } from "../providers/google/drive-write";
import { defineTool, type Family, type ToolContext } from "../registry/types";
import { provide } from "../services/capability";
import type { DriveFile } from "../services/drive-read";
import {
  DRIVE_WRITE,
  type DriveShare,
  type DriveUpload,
  type DriveWriteService,
} from "../services/drive-write";
import type { AccountRef } from "../services/types";

const account = z
  .string()
  .optional()
  .describe("Label, address or a1; the default account when omitted.");
const fileId = z.string().min(1).describe("Required. The ID of the file.");
const parentId = (what: string) => z.string().min(1).optional().describe(what);

const WRITE = { component: "files", scopes: ["files"], endpoints: ["full"] } as const;
const SAFE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

// ---- Targets and views ---------------------------------------------------------------------------

interface Target {
  a: AccountRef;
  svc: DriveWriteService;
  /** The Drive id, without the bridge prefix. */
  id: string;
}

/** The account a prefixed id addresses (else the selector) and the bare Drive id. */
async function target(ctx: ToolContext, selector: string | undefined, id: string): Promise<Target> {
  const d = ctx.ids.parse(id);
  const [a] = await ctx.accounts.resolve(selector, d?.shortId);
  if (!a) throw new ToolError("account_not_found", "No linked account.");
  return { a, svc: ctx.use(DRIVE_WRITE, a), id: d?.providerId ?? id };
}

/** For `create_file`: the account comes from the parent's prefix, else the selector. */
async function createTarget(
  ctx: ToolContext,
  selector: string | undefined,
  parent: string | undefined,
): Promise<{ a: AccountRef; svc: DriveWriteService; parent: string | undefined }> {
  if (parent === undefined) {
    const [a] = await ctx.accounts.resolve(selector);
    if (!a) throw new ToolError("account_not_found", "No linked account.");
    return { a, svc: ctx.use(DRIVE_WRITE, a), parent };
  }
  const t = await target(ctx, selector, parent);
  return { a: t.a, svc: t.svc, parent: t.id };
}

/** A parent id in the same account, bare or prefixed, as a bare Drive id. */
function sameAccount(ctx: ToolContext, a: AccountRef, id: string | undefined): string | undefined {
  if (id === undefined) return undefined;
  const p = ctx.ids.parse(id);
  if (p && p.shortId !== a.shortId) {
    throw new ToolError("invalid_argument", "The parent belongs to a different account.");
  }
  return p?.providerId ?? id;
}

const wrapper = (ctx: ToolContext, a: AccountRef) => (text: string) =>
  ctx.untrusted.wrap(text, { source: "file", account: accountKey(a.shortId) });

function fileView(ctx: ToolContext, a: AccountRef, f: DriveFile) {
  const wrap = wrapper(ctx, a);
  return {
    id: ctx.ids.encode(a, f.id),
    account: accountKey(a.shortId),
    name: wrap(f.name),
    mimeType: f.mimeType,
    modifiedTime: f.modifiedTime,
    createdTime: f.createdTime,
    size: f.size,
    webViewLink: f.webViewLink,
    parents: f.parents?.map((p) => ctx.ids.encode(a, p)),
    driveId: f.driveId,
    shared: f.shared,
    trashed: f.trashed,
    description: f.description ? wrap(f.description) : undefined,
  };
}

// ---- Uploads -------------------------------------------------------------------------------------

const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const contentFields = {
  textContent: z
    .string()
    .optional()
    .describe("The (UTF-8) text content to upload. It's an error to set this and `base64Content`."),
  base64Content: z
    .string()
    .optional()
    .describe("The base64 encoded content to upload. It's an error to set this and `textContent`."),
  contentMimeType: z
    .string()
    .optional()
    .describe(
      "The MIME type of the content being uploaded. Required with `base64Content`; `text/plain` when only `textContent` is given.",
    ),
};

interface ContentArgs {
  textContent?: string | undefined;
  base64Content?: string | undefined;
  contentMimeType?: string | undefined;
}

/**
 * The upload for the caller's content, or undefined for none. Refuses content over
 * MAX_ATTACHMENT_BYTES before any Google call. The base64 text is checked, not decoded.
 */
function uploadOf(
  ctx: ToolContext,
  a: ContentArgs & { content?: string | undefined },
  convert: boolean,
): DriveUpload | undefined {
  const cap = config(ctx.env).maxAttachmentBytes;
  const b64 = a.base64Content ?? a.content;
  const text = a.textContent;
  if (text !== undefined && b64 !== undefined) {
    throw new ToolError("invalid_argument", "Set textContent or base64Content, not both.");
  }
  if (text === undefined && b64 === undefined) return undefined;
  const mimeType = a.contentMimeType ?? (text === undefined ? undefined : "text/plain");
  if (mimeType === undefined) {
    throw new ToolError("invalid_argument", "contentMimeType is required with base64Content.");
  }
  if (!MIME.test(mimeType)) {
    throw new ToolError(
      "invalid_argument",
      "contentMimeType must be a MIME type such as text/csv.",
    );
  }
  const tooLarge = (sizeBytes: number) =>
    new ToolError("too_large", `The content is larger than the ${cap} byte upload limit.`, {
      maxBytes: cap,
      sizeBytes,
    });
  if (text !== undefined) {
    // A UTF-8 byte count is never below the UTF-16 length.
    if (text.length > cap) throw tooLarge(text.length);
    const sizeBytes = new TextEncoder().encode(text).length;
    if (sizeBytes > cap) throw tooLarge(sizeBytes);
    return { mimeType, text, convert };
  }
  const raw = b64 as string;
  // Generous for line breaks, strict enough that nothing huge is scanned.
  if (raw.length > Math.ceil(cap / 3) * 8) throw tooLarge(Math.floor((raw.length * 3) / 4));
  const clean = raw.replace(/\s+/g, "").replaceAll("-", "+").replaceAll("_", "/");
  if (!BASE64.test(clean) || clean.length % 4 === 1) {
    throw new ToolError("invalid_argument", "base64Content is not valid base64.");
  }
  const pad = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const sizeBytes = Math.floor((clean.length * 3) / 4) - pad;
  if (sizeBytes > cap) throw tooLarge(sizeBytes);
  return { mimeType, base64: clean, convert };
}

// ---- Tools ---------------------------------------------------------------------------------------

const createFile = defineTool({
  name: "create_file",
  title: "Create a file",
  description:
    "Creates a file or folder in Drive, optionally with content. Prefer `textContent` for text; use `base64Content` and `contentMimeType` for other data. Content over the upload limit (MAX_ATTACHMENT_BYTES, 512 KB by default) is refused without any Google call. Supported content is converted to a Google type (text/plain becomes a Doc, text/csv a Sheet) unless `disableConversionToGoogleType` is true. Without content, set `contentMimeType` to application/vnd.google-apps.document, .spreadsheet, .presentation or .folder to create that kind of file. Returns the new file.",
  ...WRITE,
  annotations: SAFE,
  untrusted: true,
  input: z.object({
    title: z.string().min(1).describe("Required. The title of the file."),
    ...contentFields,
    disableConversionToGoogleType: z
      .boolean()
      .optional()
      .describe("Keep the content's own type instead of converting it to a Google type."),
    parentId: parentId("The parent folder id of the file."),
    pregeneratedId: z
      .string()
      .min(1)
      .optional()
      .describe("A pregenerated file id for a binary file or folder."),
    inheritedPermissionsDisabled: z
      .boolean()
      .optional()
      .describe("For a folder: restrict access to the people it is shared with directly."),
    content: z.string().optional().describe("Deprecated alias of `base64Content`."),
    mimeType: z.string().optional().describe("Deprecated alias of `contentMimeType`."),
    account,
  }),
  async handler(args, ctx) {
    const contentMimeType = args.contentMimeType ?? args.mimeType;
    const upload = uploadOf(
      ctx,
      {
        textContent: args.textContent,
        base64Content: args.base64Content,
        content: args.content,
        contentMimeType,
      },
      args.disableConversionToGoogleType !== true,
    );
    const t = await createTarget(ctx, args.account, args.parentId);
    const f = await t.svc.create(t.a, {
      name: args.title,
      ...(upload ? { upload } : contentMimeType ? { mimeType: contentMimeType } : {}),
      ...(t.parent === undefined ? {} : { parentId: t.parent }),
      ...(args.pregeneratedId === undefined ? {} : { id: args.pregeneratedId }),
      ...(args.inheritedPermissionsDisabled === undefined
        ? {}
        : { inheritedPermissionsDisabled: args.inheritedPermissionsDisabled }),
    });
    return fileView(ctx, t.a, f);
  },
});

const updateFile = defineTool({
  name: "update_file",
  title: "Update a file",
  description:
    "Updates a Drive file's title, description, starred state, parent folder (a move: the new parent replaces the old ones), folder color, lock (`readOnly`), download restriction or sharing settings. With `textContent` or `base64Content` it also replaces the file's content (same upload limit as create_file). Give at least one field to change. Returns the updated file.",
  ...WRITE,
  annotations: SAFE,
  untrusted: true,
  input: z.object({
    fileId,
    title: z.string().min(1).optional().describe("The updated title of the file."),
    description: z
      .string()
      .optional()
      .describe("The updated description; an empty string clears it."),
    starred: z.boolean().optional().describe("Updates the starred state of the file."),
    parentId: parentId(
      "The updated parent id of the file. The existing parents are replaced (a move).",
    ),
    folderColorRgb: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional()
      .describe("Folder color as #RRGGBB; only applies to folders."),
    readOnly: z
      .boolean()
      .optional()
      .describe("true locks the file against edits; false unlocks a locked file."),
    readOnlyReason: z.string().optional().describe("Why the file is locked (with readOnly true)."),
    writersCanShare: z
      .boolean()
      .optional()
      .describe("Whether users with only writer permission can change sharing."),
    downloadRestriction: z
      .object({
        restrictedReader: z.boolean().optional(),
        restrictedWriter: z.boolean().optional(),
      })
      .optional()
      .describe("Restrictions on downloading, printing and copying the file."),
    inheritedPermissionsDisabled: z
      .boolean()
      .optional()
      .describe("For a folder: whether inherited permissions are disabled."),
    ...contentFields,
    account,
  }),
  async handler(args, ctx) {
    const upload = uploadOf(ctx, args, false);
    const t = await target(ctx, args.account, args.fileId);
    const parent = sameAccount(ctx, t.a, args.parentId);
    const change = {
      ...(args.title === undefined ? {} : { name: args.title }),
      ...(args.description === undefined ? {} : { description: args.description }),
      ...(args.starred === undefined ? {} : { starred: args.starred }),
      ...(parent === undefined ? {} : { parentId: parent }),
      ...(args.folderColorRgb === undefined ? {} : { folderColorRgb: args.folderColorRgb }),
      ...(args.readOnly === undefined ? {} : { readOnly: args.readOnly }),
      ...(args.readOnlyReason === undefined ? {} : { readOnlyReason: args.readOnlyReason }),
      ...(args.writersCanShare === undefined ? {} : { writersCanShare: args.writersCanShare }),
      ...(args.downloadRestriction === undefined
        ? {}
        : { downloadRestriction: args.downloadRestriction }),
      ...(args.inheritedPermissionsDisabled === undefined
        ? {}
        : { inheritedPermissionsDisabled: args.inheritedPermissionsDisabled }),
      ...(upload ? { upload } : {}),
    };
    if (Object.keys(change).length === 0) {
      throw new ToolError("invalid_argument", "Give at least one field to change.");
    }
    return fileView(ctx, t.a, await t.svc.update(t.a, t.id, change));
  },
});

const copyFile = defineTool({
  name: "copy_file",
  title: "Copy a file",
  description:
    "Copies a Drive file. The copy is titled `Copy of {original title}` unless `title` is given, and goes in the original's folder unless `parentId` is given. Returns the new file.",
  ...WRITE,
  annotations: SAFE,
  untrusted: true,
  input: z.object({
    fileId: fileId.describe("Required. The ID of the file to copy."),
    title: z.string().min(1).optional().describe("The title of the new file."),
    parentId: parentId("The parent folder id of the new file; the original's parent when empty."),
    pregeneratedId: z
      .string()
      .min(1)
      .optional()
      .describe("A pregenerated file id; binary files only."),
    account,
  }),
  async handler(args, ctx) {
    const t = await target(ctx, args.account, args.fileId);
    const parent = sameAccount(ctx, t.a, args.parentId);
    const f = await t.svc.copy(t.a, t.id, {
      ...(args.title === undefined ? {} : { name: args.title }),
      ...(parent === undefined ? {} : { parentId: parent }),
      ...(args.pregeneratedId === undefined ? {} : { id: args.pregeneratedId }),
    });
    return fileView(ctx, t.a, f);
  },
});

const trashFile = defineTool({
  name: "trash_file",
  title: "Move a file to the trash",
  description:
    "Moves a Drive file to the trash. It is not deleted for good: it can be restored from Drive's trash. Returns the file id.",
  ...WRITE,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.object({ fileId: fileId.describe("Required. The ID of the file to trash."), account }),
  async handler(args, ctx) {
    const t = await target(ctx, args.account, args.fileId);
    await t.svc.trash(t.a, t.id);
    return { id: ctx.ids.encode(t.a, t.id), account: accountKey(t.a.shortId), trashed: true };
  },
});

// ---- Sharing -------------------------------------------------------------------------------------

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

interface ShareArgs {
  emailAddress?: string | undefined;
  chatSpaceId?: string | undefined;
  type?: "user" | "group" | "domain" | "anyone" | undefined;
  domain?: string | undefined;
  role: "reader" | "commenter" | "writer";
  expirationTime?: string | undefined;
}

/** The permission the arguments ask for; `invalid_argument` for a combination that makes no sense. */
function shareOf(args: ShareArgs): DriveShare {
  const bad = (m: string) => new ToolError("invalid_argument", m);
  if (args.chatSpaceId !== undefined) {
    throw bad("Sharing with a Chat space is not supported. Give emailAddress instead.");
  }
  const email = args.emailAddress?.trim().toLowerCase();
  const type = args.type ?? (email === undefined ? undefined : "user");
  if (type === undefined) throw bad("Give emailAddress, or type domain or anyone.");
  const base = {
    role: args.role,
    ...(args.expirationTime === undefined ? {} : { expirationTime: args.expirationTime }),
  };
  if (type === "anyone" || type === "domain") {
    if (email !== undefined) throw bad(`emailAddress cannot be used with type ${type}.`);
    if (type === "anyone") {
      if (args.domain !== undefined) throw bad("domain cannot be used with type anyone.");
      return { ...base, type };
    }
    const domain = args.domain?.trim().toLowerCase();
    if (domain === undefined || !DOMAIN.test(domain)) {
      throw bad("type domain needs a domain such as example.com.");
    }
    return { ...base, type, domain };
  }
  if (args.domain !== undefined) throw bad(`domain cannot be used with type ${type}.`);
  if (email === undefined || email.length > 320 || !EMAIL.test(email)) {
    throw bad(`type ${type} needs a valid emailAddress.`);
  }
  return { ...base, type, emailAddress: email };
}

/** Who a share goes to, for the audit row and the preview. */
const recipient = (s: DriveShare): string =>
  s.type === "anyone"
    ? "anyone"
    : s.type === "domain"
      ? `domain:${s.domain}`
      : (s.emailAddress ?? "");

/**
 * Why the owner must approve this share, or null. Anyone or a whole domain always needs it; so
 * does a user or group that is not one of the owner's linked accounts or on the owner's allowed
 * addresses (OWNER_EMAILS, LINKABLE_EMAILS).
 */
async function shareRisk(ctx: ToolContext, s: DriveShare): Promise<string | null> {
  if (s.type === "anyone") return "Anyone with the link would get access.";
  if (s.type === "domain") return `Everyone at ${s.domain} would get access.`;
  const cfg = config(ctx.env);
  const own = (await loadAccountRefs(ctx.env.DB, ctx.ownerId)).map((x) => x.address);
  const allowed = new Set([...own, ...cfg.ownerEmails, ...cfg.linkableEmails]);
  return allowed.has(s.emailAddress ?? "")
    ? null
    : `${s.emailAddress} is not one of your accounts or allowed addresses.`;
}

const shareFile = defineTool({
  name: "share_file",
  title: "Share a file",
  description:
    "Shares a Drive file. Give `emailAddress` (a user, or a group with type group) and a `role` of reader, commenter or writer; an existing permission is raised to the new role. type `domain` (with `domain`) or `anyone` opens the file more widely. Sharing with anyone, with a domain, or with an address that is not one of the owner's linked accounts or allowed addresses is held: the answer is a pending_approval with an approvalUrl, nothing is shared until the owner approves it there, and get_pending_action shows the result. Google may email the person. Every share is written to the audit log. Chat spaces are not supported.",
  ...WRITE,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    fileId: fileId.describe("Required. The ID of the file to share."),
    role: z
      .enum(["reader", "commenter", "writer"])
      .describe("Required. The role to grant: writer, commenter or reader."),
    emailAddress: z
      .string()
      .max(320)
      .optional()
      .describe("The email address of the user or group to share with."),
    type: z
      .enum(["user", "group", "domain", "anyone"])
      .optional()
      .describe("Who the permission is for; user when emailAddress is given."),
    domain: z.string().max(255).optional().describe("The domain, with type domain."),
    chatSpaceId: z
      .string()
      .optional()
      .describe("Accepted for compatibility; sharing with a Chat space is not supported."),
    expirationTime: z.iso
      .datetime({ offset: true })
      .optional()
      .describe("When the permission expires (users and groups only); never when omitted."),
    account,
  }),
  approval: {
    async when(args, ctx) {
      const spec = shareOf(args);
      await target(ctx, args.account, args.fileId);
      return (await shareRisk(ctx, spec)) !== null;
    },
    async preview(args, ctx) {
      const spec = shareOf(args);
      const t = await target(ctx, args.account, args.fileId);
      const reason = await shareRisk(ctx, spec);
      await ctx.audit.write({
        tool: "share_file",
        account: t.a,
        to: [recipient(spec)],
        providerRef: null,
        result: "pending",
        detail: `held for approval: role=${spec.role} type=${spec.type} file=${t.id}`,
      });
      return {
        action: "Share a Drive file",
        account: t.a.label,
        fileId: ctx.ids.encode(t.a, t.id),
        role: spec.role,
        to: recipient(spec),
        reason,
      };
    },
  },
  async handler(args, ctx) {
    const spec = shareOf(args);
    const t = await target(ctx, args.account, args.fileId);
    const detail = `role=${spec.role} type=${spec.type} file=${t.id}`;
    let granted: Awaited<ReturnType<DriveWriteService["share"]>>;
    try {
      granted = await t.svc.share(t.a, t.id, spec);
    } catch (e) {
      await ctx.audit.write({
        tool: "share_file",
        account: t.a,
        to: [recipient(spec)],
        result: "error",
        detail: `${e instanceof ToolError ? e.code : "internal"}: ${detail}`,
      });
      throw e;
    }
    await ctx.audit.write({
      tool: "share_file",
      account: t.a,
      to: [recipient(spec)],
      providerRef: granted.id,
      result: "ok",
      detail,
    });
    return {
      id: ctx.ids.encode(t.a, t.id),
      account: accountKey(t.a.shortId),
      permission: {
        id: granted.id,
        type: granted.type,
        role: granted.role,
        emailAddress: granted.emailAddress,
        domain: granted.domain,
        expirationTime: granted.expirationTime,
      },
    };
  },
});

export const driveWrite: Family = {
  id: "drive.write",
  tools: [createFile, updateFile, copyFile, shareFile, trashFile] as never,
  bindings: { google: [provide(DRIVE_WRITE, googleDriveWrite)] },
  parityPending: [],
};
