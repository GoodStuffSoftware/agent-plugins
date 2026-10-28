// The mail.state family (ARCHITECTURE s.5): archive, read and star flags, spam and trash for
// messages and threads. Full endpoint only. Trash is reversible for 30 days; nothing deletes for good.

import { z } from "zod";
import { ToolError } from "../core/errors";
import { googleState } from "../providers/google/mail-state";
import { defineTool, type Family, type ToolContext } from "../registry/types";
import { provide } from "../services/capability";
import { STATE, type StateTarget } from "../services/mail-state";
import type { AccountRef } from "../services/types";

const account = z
  .string()
  .optional()
  .describe("Label, address or a1; the default account when omitted.");

type Kind = StateTarget["kind"];
type Run = "spam" | "unspam" | "trash" | "untrash";
const idKey = (kind: Kind) => (kind === "message" ? "messageId" : "threadId");

/** Resolves the account from the id's prefix (else the selector) and returns the provider id. */
async function target(ctx: ToolContext, kind: Kind, id: string, selector: string | undefined) {
  const d = ctx.ids.parse(id);
  const [a] = await ctx.accounts.resolve(selector, d?.shortId);
  if (!a) throw new ToolError("account_not_found", "No linked account.");
  if (d && d.shortId !== a.shortId) {
    throw new ToolError("invalid_argument", "The id belongs to a different account.");
  }
  const t: StateTarget = { kind, id: d?.providerId ?? id };
  return { a, t, out: { [idKey(kind)]: ctx.ids.encode(a, t.id) } };
}

const WRITE = {
  component: "mail",
  scopes: ["mail.write"],
  endpoints: ["full"],
} as const;

const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

async function apply(ctx: ToolContext, a: AccountRef, t: StateTarget, run: Run): Promise<void> {
  const svc = ctx.use(STATE, a);
  if (run === "trash") return svc.trash(a, t);
  if (run === "untrash") return svc.untrash(a, t);
  if (run === "spam") return svc.modify(a, t, { add: ["SPAM"], remove: ["INBOX"] });
  return svc.modify(a, t, { add: ["INBOX"], remove: ["SPAM"] });
}

function stateTool(kind: Kind) {
  const key = idKey(kind);
  return defineTool({
    name: `update_${kind}_state`,
    title: `Update a ${kind} state`,
    description: `Archives or unarchives, marks read or unread, and stars or unstars a ${kind}. Give at least one of archived, read, starred.`,
    ...WRITE,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: z.object({
      [key]: z.string().min(1).describe(`The ${kind} id.`),
      archived: z
        .boolean()
        .optional()
        .describe("true removes it from the inbox, false returns it."),
      read: z.boolean().optional().describe("true marks it read, false unread."),
      starred: z.boolean().optional().describe("true stars it, false removes the star."),
      account,
    }),
    async handler(args, ctx) {
      const a = args as unknown as Record<string, string> & {
        archived?: boolean;
        read?: boolean;
        starred?: boolean;
        account?: string;
      };
      const add: string[] = [];
      const remove: string[] = [];
      // archived / read: true removes the label (INBOX / UNREAD); starred: true adds STARRED.
      const flag = (value: boolean | undefined, label: string, trueAdds: boolean) => {
        if (value === undefined) return;
        (value === trueAdds ? add : remove).push(label);
      };
      flag(a.archived, "INBOX", false);
      flag(a.read, "UNREAD", false);
      flag(a.starred, "STARRED", true);
      if (add.length + remove.length === 0) {
        throw new ToolError("invalid_argument", "Give at least one of archived, read, starred.");
      }
      const r = await target(ctx, kind, a[key] ?? "", a.account);
      await ctx.use(STATE, r.a).modify(r.a, r.t, { add, remove });
      return {
        ...r.out,
        added: add.map((l) => ctx.ids.encode(r.a, l)),
        removed: remove.map((l) => ctx.ids.encode(r.a, l)),
      };
    },
  });
}

function simpleTool(opts: {
  name: string;
  title: string;
  description: string;
  kind: Kind;
  run: Run;
}) {
  const key = idKey(opts.kind);
  return defineTool({
    name: opts.name,
    title: opts.title,
    description: opts.description,
    ...WRITE,
    annotations: DESTRUCTIVE,
    input: z.object({ [key]: z.string().min(1).describe(`The ${opts.kind} id.`), account }),
    async handler(args, ctx) {
      const a = args as unknown as Record<string, string> & { account?: string };
      const r = await target(ctx, opts.kind, a[key] ?? "", a.account);
      await apply(ctx, r.a, r.t, opts.run);
      return r.out;
    },
  });
}

function sensitiveTool(kind: Kind) {
  const key = idKey(kind);
  return defineTool({
    name: `apply_sensitive_${kind}_label`,
    title: `Move a ${kind} to Trash or Spam`,
    description: `Prefer trash_${kind} or mark_${kind}_spam. Adds the Trash or Spam label to a ${kind}. labelOption is TRASH or SPAM.`,
    ...WRITE,
    annotations: DESTRUCTIVE,
    input: z.object({
      [key]: z.string().min(1).describe(`The ${kind} id.`),
      labelOption: z
        .enum(["LABEL_OPTION_UNSPECIFIED", "TRASH", "SPAM"])
        .describe("Required. The sensitive label to add: TRASH or SPAM."),
      account,
    }),
    async handler(args, ctx) {
      const a = args as unknown as Record<string, string> & { account?: string };
      if (a.labelOption !== "TRASH" && a.labelOption !== "SPAM") {
        throw new ToolError("invalid_argument", "labelOption must be TRASH or SPAM.");
      }
      const r = await target(ctx, kind, a[key] ?? "", a.account);
      await apply(ctx, r.a, r.t, a.labelOption === "TRASH" ? "trash" : "spam");
      return { ...r.out, labelOption: a.labelOption };
    },
  });
}

const KINDS = ["message", "thread"] as const;

const spamTools = KINDS.flatMap((kind) => [
  simpleTool({
    name: `mark_${kind}_spam`,
    title: `Mark a ${kind} as spam`,
    description: `Marks a ${kind} as Spam and removes it from the inbox.`,
    kind,
    run: "spam",
  }),
  simpleTool({
    name: `unmark_${kind}_spam`,
    title: `Unmark a ${kind} as spam`,
    description: `Removes the Spam label from a ${kind} and returns it to the inbox.`,
    kind,
    run: "unspam",
  }),
]);

const trashTools = KINDS.flatMap((kind) => [
  simpleTool({
    name: `trash_${kind}`,
    title: `Move a ${kind} to Trash`,
    description: `Moves a ${kind} to the Trash (soft delete; Gmail keeps it 30 days and untrash_${kind} restores it). Never deletes permanently.`,
    kind,
    run: "trash",
  }),
  simpleTool({
    name: `untrash_${kind}`,
    title: `Restore a ${kind} from Trash`,
    description: `Removes a ${kind} from the Trash.`,
    kind,
    run: "untrash",
  }),
]);

export const mailState: Family = {
  id: "mail.state",
  tools: [
    stateTool("thread"),
    stateTool("message"),
    ...spamTools,
    ...trashTools,
    sensitiveTool("message"),
    sensitiveTool("thread"),
  ] as unknown as Family["tools"],
  bindings: { google: [provide(STATE, googleState)] },
  parityPending: [],
};
