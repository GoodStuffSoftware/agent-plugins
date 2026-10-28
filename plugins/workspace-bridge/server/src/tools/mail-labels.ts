// The mail.labels family (ARCHITECTURE s.2, s.5): list, create, update and delete labels, and add or
// remove labels on messages and threads. Label names are the owner's data, not third-party text, so
// nothing here is wrapped as untrusted. Label ids are returned prefixed (`a1:Label_1`, `a1:INBOX`)
// and accepted prefixed or bare; system ids (INBOX, UNREAD, STARRED, ...) pass through the same way.

import { z } from "zod";
import { ToolError } from "../core/errors";
import { googleLabels } from "../providers/google/mail-labels";
import { defineTool, type Family, type ToolContext } from "../registry/types";
import { provide } from "../services/capability";
import { LABELS, type Label, type LabelColor, type LabelInput } from "../services/mail-labels";
import type { AccountRef } from "../services/types";

const account = z
  .string()
  .optional()
  .describe("Label, address or a1; the default account when omitted.");

const LIST_VISIBILITY = ["LABEL_SHOW", "LABEL_SHOW_IF_UNREAD", "LABEL_HIDE"] as const;
const MESSAGE_VISIBILITY = ["SHOW", "HIDE"] as const;

/** Preset tiles (gmail.json) as the background and text colors Gmail accepts. */
const PRESETS: Readonly<Record<string, LabelColor>> = {
  LABEL_COLOR_PRESET_BLACK: { backgroundColor: "#000000", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_DARK_GRAY: { backgroundColor: "#434343", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_GRAY: { backgroundColor: "#666666", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_LIGHT_GRAY: { backgroundColor: "#cccccc", textColor: "#000000" },
  LABEL_COLOR_PRESET_WHITE: { backgroundColor: "#ffffff", textColor: "#000000" },
  LABEL_COLOR_PRESET_RED: { backgroundColor: "#fb4c2f", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_ORANGE: { backgroundColor: "#ffad47", textColor: "#000000" },
  LABEL_COLOR_PRESET_YELLOW: { backgroundColor: "#fad165", textColor: "#000000" },
  LABEL_COLOR_PRESET_GREEN: { backgroundColor: "#16a765", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_MINT: { backgroundColor: "#43d692", textColor: "#000000" },
  LABEL_COLOR_PRESET_TEAL: { backgroundColor: "#2da2bb", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_BLUE: { backgroundColor: "#4a86e8", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_PURPLE: { backgroundColor: "#a479e2", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_PINK: { backgroundColor: "#f691b2", textColor: "#000000" },
  LABEL_COLOR_PRESET_DARK_RED: { backgroundColor: "#822111", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_DARK_ORANGE: { backgroundColor: "#a46a21", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_DARK_GREEN: { backgroundColor: "#076239", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_DARK_BLUE: { backgroundColor: "#1c4587", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_DARK_PURPLE: { backgroundColor: "#41236d", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_DARK_PINK: { backgroundColor: "#83334c", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_BROWN: { backgroundColor: "#7a4706", textColor: "#ffffff" },
};
const COLOR_PRESET = ["LABEL_COLOR_PRESET_UNSPECIFIED", ...Object.keys(PRESETS)] as [
  string,
  ...string[],
];

const legacyColor = z
  .object({ backgroundColor: z.string().optional(), textColor: z.string().optional() })
  .optional()
  .describe("Deprecated: use colorPreset. Hex colors Gmail accepts, both fields together.");

const styleInput = {
  labelListVisibility: z.enum(LIST_VISIBILITY).optional(),
  messageListVisibility: z.enum(MESSAGE_VISIBILITY).optional(),
  colorPreset: z
    .enum(COLOR_PRESET)
    .optional()
    .describe("A color tile, such as LABEL_COLOR_PRESET_BLUE."),
  color: legacyColor,
};

function styleOf(args: {
  labelListVisibility?: LabelInput["labelListVisibility"];
  messageListVisibility?: LabelInput["messageListVisibility"];
  colorPreset?: string;
  color?: { backgroundColor?: string; textColor?: string };
}): LabelInput {
  const out: LabelInput = {};
  if (args.labelListVisibility) out.labelListVisibility = args.labelListVisibility;
  if (args.messageListVisibility) out.messageListVisibility = args.messageListVisibility;
  const preset = args.colorPreset ? PRESETS[args.colorPreset] : undefined;
  if (preset) out.color = preset;
  else if (args.color) {
    if (!args.color.backgroundColor || !args.color.textColor) {
      throw new ToolError("invalid_argument", "color needs both backgroundColor and textColor.");
    }
    out.color = { backgroundColor: args.color.backgroundColor, textColor: args.color.textColor };
  }
  return out;
}

/**
 * Resolves the one account an id-taking tool addresses. The first prefixed id (the target's, else
 * a label's) selects the account; every prefixed id must belong to it. Returns the provider ids.
 */
async function resolveIds(
  ctx: ToolContext,
  selector: string | undefined,
  target: string | undefined,
  labelIds: readonly string[],
): Promise<{ a: AccountRef; target: string | undefined; labels: string[] }> {
  const decoded = [...(target === undefined ? [] : [target]), ...labelIds].map((id) => ({
    id,
    d: ctx.ids.parse(id),
  }));
  const first = decoded.find((x) => x.d !== null)?.d ?? null;
  const [a] = await ctx.accounts.resolve(selector, first?.shortId);
  if (!a) throw new ToolError("account_not_found", "No linked account.");
  for (const x of decoded) {
    if (x.d && x.d.shortId !== a.shortId) {
      throw new ToolError("invalid_argument", "The ids belong to different accounts.");
    }
  }
  const provider = (x: { id: string; d: { providerId: string } | null }) => x.d?.providerId ?? x.id;
  const rest = target === undefined ? decoded : decoded.slice(1);
  const head = target === undefined ? undefined : decoded[0];
  return { a, target: head === undefined ? undefined : provider(head), labels: rest.map(provider) };
}

function view(ctx: ToolContext, a: AccountRef, l: Label) {
  return { ...l, id: ctx.ids.encode(a, l.id) };
}

const listLabels = defineTool({
  name: "list_labels",
  title: "List labels",
  description:
    "Lists all labels of the mailbox, system and user labels, with their ids. Use an id with label_message, unlabel_message, label_thread, unlabel_thread and update_message_labels.",
  component: "mail",
  scopes: ["mail.read"],
  endpoints: ["full", "ro"],
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({ account }),
  async handler(args, ctx) {
    const [a] = await ctx.accounts.resolve(args.account);
    if (!a) throw new ToolError("account_not_found", "No linked account.");
    const labels = await ctx.use(LABELS, a).list(a);
    return { labels: labels.map((l) => view(ctx, a, l)) };
  },
});

const createLabel = defineTool({
  name: "create_label",
  title: "Create a label",
  description:
    "Creates a label. A name with `/` (such as `Projects/Alpha`) makes a nested label. A name already in use is refused with invalid_argument.",
  component: "mail",
  scopes: ["mail.write"],
  endpoints: ["full"],
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  input: z.object({
    displayName: z.string().min(1).max(225).describe("The label's name."),
    ...styleInput,
    account,
  }),
  async handler(args, ctx) {
    const [a] = await ctx.accounts.resolve(args.account);
    if (!a) throw new ToolError("account_not_found", "No linked account.");
    const l = await ctx.use(LABELS, a).create(a, { name: args.displayName, ...styleOf(args) });
    return { label: view(ctx, a, l) };
  },
});

const updateLabel = defineTool({
  name: "update_label",
  title: "Update a label",
  description: "Changes a label's name, color or visibility. Fields left out stay as they are.",
  component: "mail",
  scopes: ["mail.write"],
  endpoints: ["full"],
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.object({
    labelId: z.string().min(1).describe("The label's id from list_labels."),
    displayName: z.string().min(1).max(225).optional(),
    ...styleInput,
    account,
  }),
  async handler(args, ctx) {
    const r = await resolveIds(ctx, args.account, undefined, [args.labelId]);
    const [id] = r.labels;
    if (!id) throw new ToolError("invalid_argument", "labelId is required.");
    const change: LabelInput = {
      ...(args.displayName === undefined ? {} : { name: args.displayName }),
      ...styleOf(args),
    };
    if (Object.keys(change).length === 0) {
      throw new ToolError(
        "invalid_argument",
        "Nothing to change: give a name, color or visibility.",
      );
    }
    const l = await ctx.use(LABELS, r.a).update(r.a, id, change);
    return { label: view(ctx, r.a, l) };
  },
});

const deleteLabel = defineTool({
  name: "delete_label",
  title: "Delete a label",
  description:
    "Deletes a user label and removes it from every message and thread. Messages stay. System labels cannot be deleted.",
  component: "mail",
  scopes: ["mail.write"],
  endpoints: ["full"],
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.object({
    labelId: z.string().min(1).describe("The label's id from list_labels."),
    account,
  }),
  async handler(args, ctx) {
    const r = await resolveIds(ctx, args.account, undefined, [args.labelId]);
    const [id] = r.labels;
    if (!id) throw new ToolError("invalid_argument", "labelId is required.");
    await ctx.use(LABELS, r.a).remove(r.a, id);
    return { deleted: ctx.ids.encode(r.a, id) };
  },
});

const labelIds = z
  .array(z.string().min(1))
  .min(1)
  .max(100)
  .describe("Label ids from list_labels, or system ids such as INBOX, UNREAD, STARRED.");

function changeTool(opts: {
  name: string;
  title: string;
  description: string;
  kind: "message" | "thread";
  mode: "add" | "remove";
}) {
  const idKey = opts.kind === "message" ? "messageId" : "threadId";
  return defineTool({
    name: opts.name,
    title: opts.title,
    description: opts.description,
    component: "mail",
    scopes: ["mail.write"],
    endpoints: ["full"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: z.object({
      [idKey]: z.string().min(1).describe(`The ${opts.kind}'s id.`),
      labelIds,
      account,
    }),
    async handler(args, ctx) {
      const a = args as unknown as { account?: string; labelIds: string[] } & Record<
        string,
        string
      >;
      const r = await resolveIds(ctx, a.account, a[idKey], a.labelIds);
      if (r.target === undefined) throw new ToolError("invalid_argument", `${idKey} is required.`);
      await ctx
        .use(LABELS, r.a)
        .modify(
          r.a,
          { kind: opts.kind, id: r.target },
          opts.mode === "add" ? { add: r.labels } : { remove: r.labels },
        );
      return {
        [idKey]: ctx.ids.encode(r.a, r.target),
        [opts.mode === "add" ? "added" : "removed"]: r.labels.map((l) => ctx.ids.encode(r.a, l)),
      };
    },
  });
}

const labelMessage = changeTool({
  name: "label_message",
  title: "Label a message",
  description:
    "Adds labels to one message. For an inbox category tab add the CATEGORY_* label. To trash or mark spam use the trash and spam tools.",
  kind: "message",
  mode: "add",
});
const unlabelMessage = changeTool({
  name: "unlabel_message",
  title: "Unlabel a message",
  description:
    "Removes labels from one message (remove UNREAD to mark it read, INBOX to archive it).",
  kind: "message",
  mode: "remove",
});
const labelThread = changeTool({
  name: "label_thread",
  title: "Label a thread",
  description: "Adds labels to every message of a thread, and to messages added to it later.",
  kind: "thread",
  mode: "add",
});
const unlabelThread = changeTool({
  name: "unlabel_thread",
  title: "Unlabel a thread",
  description:
    "Removes labels from every message of a thread (remove UNREAD to mark it read, INBOX to archive it).",
  kind: "thread",
  mode: "remove",
});

const updateMessageLabels = defineTool({
  name: "update_message_labels",
  title: "Add and remove labels on a message",
  description:
    "Adds and removes labels on one message in one call. Give at least one of addLabelIds or removeLabelIds.",
  component: "mail",
  scopes: ["mail.write"],
  endpoints: ["full"],
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.object({
    messageId: z.string().min(1).describe("The message's id."),
    addLabelIds: z.array(z.string().min(1)).max(100).optional(),
    removeLabelIds: z.array(z.string().min(1)).max(100).optional(),
    account,
  }),
  async handler(args, ctx) {
    const add = args.addLabelIds ?? [];
    const remove = args.removeLabelIds ?? [];
    if (add.length === 0 && remove.length === 0) {
      throw new ToolError("invalid_argument", "Give addLabelIds or removeLabelIds.");
    }
    const r = await resolveIds(ctx, args.account, args.messageId, [...add, ...remove]);
    if (r.target === undefined) throw new ToolError("invalid_argument", "messageId is required.");
    await ctx
      .use(LABELS, r.a)
      .modify(
        r.a,
        { kind: "message", id: r.target },
        { add: r.labels.slice(0, add.length), remove: r.labels.slice(add.length) },
      );
    return {
      messageId: ctx.ids.encode(r.a, r.target),
      added: r.labels.slice(0, add.length).map((l) => ctx.ids.encode(r.a, l)),
      removed: r.labels.slice(add.length).map((l) => ctx.ids.encode(r.a, l)),
    };
  },
});

export const mailLabels: Family = {
  id: "mail.labels",
  tools: [
    listLabels,
    createLabel,
    updateLabel,
    deleteLabel,
    labelMessage,
    unlabelMessage,
    labelThread,
    unlabelThread,
    updateMessageLabels,
  ] as unknown as Family["tools"],
  bindings: { google: [provide(LABELS, googleLabels)] },
  parityPending: [],
};
