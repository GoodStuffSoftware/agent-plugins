// The mail.filters family (ARCHITECTURE s.5, plan s.8.2, s.10): list, create and delete Gmail filters.
// Full endpoint only. There is no official filter tool, so nothing here is a parity item. A filter
// that forwards mail is held for the owner's approval (`approval.when`, M14) and every create and
// delete writes an audit row. Gmail cannot edit a filter, and this family never adds forwarding
// addresses: Gmail verifies those with their owner.

import { z } from "zod";
import { internalErrorLine, ToolError } from "../core/errors";
import { accountKey } from "../core/ids";
import { googleFilters } from "../providers/google/mail-filters";
import { defineTool, type Family, type ToolContext } from "../registry/types";
import { provide } from "../services/capability";
import {
  FILTERS,
  type FilterAction,
  type FilterCriteria,
  type FilterInfo,
} from "../services/mail-filters";
import type { AccountRef } from "../services/types";

const account = z
  .string()
  .optional()
  .describe("Label, address or a1; the default account when omitted.");

const text = (what: string) => z.string().min(1).max(500).optional().describe(what);
const labelIds = (what: string) =>
  z
    .array(z.string().min(1).max(200))
    .max(50)
    .optional()
    .describe(`${what} Label ids from list_labels, prefixed or bare.`);

const criteriaSchema = z.object({
  from: text("Matches the sender."),
  to: text("Matches a recipient."),
  subject: text("Matches words in the subject."),
  query: text("Matches this Gmail search query (the same syntax as search_threads)."),
  negatedQuery: text("Matches mail that does not match this Gmail search query."),
  hasAttachment: z.boolean().optional().describe("true matches only mail with an attachment."),
  size: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("A size in bytes; give it together with sizeComparison."),
  sizeComparison: z
    .enum(["larger", "smaller"])
    .optional()
    .describe("Whether the mail must be larger or smaller than size."),
});

const actionSchema = z.object({
  addLabelIds: labelIds("Labels to add to matching mail."),
  removeLabelIds: labelIds(
    "Labels to remove from matching mail; INBOX archives it, UNREAD marks it read.",
  ),
  forward: z
    .email()
    .max(320)
    .optional()
    .describe(
      "Forward matching mail to this address. It must already be a verified forwarding address of the account; this tool cannot add one. The filter waits for the owner's approval.",
    ),
});

type CreateArgs = {
  criteria: z.output<typeof criteriaSchema>;
  action: z.output<typeof actionSchema>;
  account?: string;
};

const CRITERIA_KEYS = ["from", "to", "subject", "query", "negatedQuery", "size"] as const;

/** Rejects a filter Gmail would refuse anyway, with a clearer message and before it is held. */
function check({ criteria, action }: CreateArgs): void {
  // hasAttachment: false matches nothing in particular, so only true counts as a criterion.
  if (!CRITERIA_KEYS.some((k) => criteria[k] !== undefined) && criteria.hasAttachment !== true) {
    throw new ToolError("invalid_argument", "Give at least one criterion for the filter to match.");
  }
  if ((criteria.size === undefined) !== (criteria.sizeComparison === undefined)) {
    throw new ToolError("invalid_argument", "size and sizeComparison go together.");
  }
  if (!action.addLabelIds?.length && !action.removeLabelIds?.length && !action.forward) {
    throw new ToolError(
      "invalid_argument",
      "Give at least one action: addLabelIds, removeLabelIds or forward.",
    );
  }
}

const bare = (id: string) => id.replace(/^a[0-9]+:/, "");

/**
 * Resolves the one account a filter addresses. The first prefixed label id selects the account
 * (else the selector or the default does); every prefixed id must belong to it. Returns the
 * provider's label ids.
 */
async function resolveAccount(
  ctx: ToolContext,
  selector: string | undefined,
  ids: readonly string[],
): Promise<AccountRef> {
  const parsed = ids.map((id) => ctx.ids.parse(id));
  const first = parsed.find((d) => d !== null) ?? null;
  const [a] = await ctx.accounts.resolve(selector, first?.shortId);
  if (!a) throw new ToolError("account_not_found", "No linked account.");
  if (parsed.some((d) => d && d.shortId !== a.shortId)) {
    throw new ToolError("invalid_argument", "The ids belong to different accounts.");
  }
  return a;
}

const idsOf = (action: z.output<typeof actionSchema>) => [
  ...(action.addLabelIds ?? []),
  ...(action.removeLabelIds ?? []),
];

/** Mail-sourced criteria text is third-party text (plan s.10.4): wrapped on every output. */
function criteriaView(ctx: ToolContext, a: AccountRef, c: FilterCriteria) {
  const wrap = (s: string) =>
    ctx.untrusted.wrap(s, { source: "email", account: accountKey(a.shortId) });
  const out: Record<string, unknown> = { ...c };
  for (const k of ["from", "to", "subject", "query", "negatedQuery"] as const) {
    const v = c[k];
    if (v !== undefined) out[k] = wrap(v);
  }
  return out;
}

function filterView(ctx: ToolContext, a: AccountRef, f: FilterInfo) {
  const enc = (ids: string[] | undefined) => ids?.map((l) => ctx.ids.encode(a, l));
  const action: Record<string, unknown> = { ...f.action };
  if (f.action.addLabelIds) action.addLabelIds = enc(f.action.addLabelIds);
  if (f.action.removeLabelIds) action.removeLabelIds = enc(f.action.removeLabelIds);
  return { id: ctx.ids.encode(a, f.id), criteria: criteriaView(ctx, a, f.criteria), action };
}

/** Runs `fn`, then writes the audit row: `ok` with the filter id, or `error` with the error code. */
async function audited<T extends { id: string }>(
  ctx: ToolContext,
  a: AccountRef,
  entry: { tool: string; to?: string[]; subject?: string | null; detail: string },
  fn: () => Promise<T>,
): Promise<T> {
  let out: T;
  try {
    out = await fn();
  } catch (e) {
    const code = e instanceof ToolError ? e.code : "internal";
    // The audit row is best effort here: the caller needs the original error.
    await ctx.audit
      .write({ account: a, result: "error", ...entry, detail: `${entry.detail}: ${code}` })
      .catch(() => undefined);
    throw e;
  }
  // The change is made: a failing audit write must not turn it into an error the caller would retry.
  await ctx.audit
    .write({ account: a, result: "ok", providerRef: out.id, ...entry })
    .catch((e) => console.error(internalErrorLine("filter audit", e)));
  return out;
}

const listFilters = defineTool({
  name: "list_filters",
  title: "List filters",
  description:
    "Lists the mailbox's filters: what each matches and what it does (labels, archive, forward).",
  component: "mail",
  scopes: ["mail.read"],
  endpoints: ["full"],
  annotations: { readOnlyHint: true, openWorldHint: false },
  untrusted: true,
  input: z.object({ account }),
  async handler(args, ctx) {
    const [a] = await ctx.accounts.resolve(args.account);
    if (!a) throw new ToolError("account_not_found", "No linked account.");
    const filters = await ctx.use(FILTERS, a).list(a);
    return { filters: filters.map((f) => filterView(ctx, a, f)) };
  },
});

const createFilter = defineTool({
  name: "create_filter",
  title: "Create a filter",
  description:
    "Creates a Gmail filter that labels, archives or forwards incoming mail matching its criteria. A filter cannot be edited: delete it and create another. A filter that forwards mail is held until the owner approves it on the approval page (the answer carries the approvalUrl); the forwarding address must already be verified in Gmail.",
  component: "mail",
  scopes: ["mail.write"],
  endpoints: ["full"],
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  untrusted: true,
  input: z.object({
    criteria: criteriaSchema.describe("What a message must match. Give at least one field."),
    action: actionSchema.describe("What to do with a match. Give at least one field."),
    account,
  }),
  approval: {
    when(args) {
      check(args);
      return args.action.forward !== undefined;
    },
    async preview(args, ctx) {
      const a = await resolveAccount(ctx, args.account, idsOf(args.action));
      return {
        summary: `Create a filter on ${a.address} that forwards matching mail to ${args.action.forward}.`,
        account: a.address,
        criteria: args.criteria,
        action: {
          ...args.action,
          ...(args.action.addLabelIds ? { addLabelIds: args.action.addLabelIds.map(bare) } : {}),
          ...(args.action.removeLabelIds
            ? { removeLabelIds: args.action.removeLabelIds.map(bare) }
            : {}),
        },
      };
    },
  },
  async handler(args, ctx) {
    check(args);
    const a = await resolveAccount(ctx, args.account, idsOf(args.action));
    const svc = ctx.use(FILTERS, a);
    const action: FilterAction = {};
    if (args.action.addLabelIds?.length) action.addLabelIds = args.action.addLabelIds.map(bare);
    if (args.action.removeLabelIds?.length) {
      action.removeLabelIds = args.action.removeLabelIds.map(bare);
    }
    if (args.action.forward) action.forward = args.action.forward;
    const created = await audited(
      ctx,
      a,
      {
        tool: "create_filter",
        to: action.forward ? [action.forward] : undefined,
        subject: args.criteria.subject ?? null,
        detail: action.forward ? "filter that forwards" : "filter",
      },
      () => svc.create(a, { criteria: args.criteria, action }),
    );
    return filterView(ctx, a, created);
  },
});

const deleteFilter = defineTool({
  name: "delete_filter",
  title: "Delete a filter",
  description:
    "Deletes a Gmail filter by id (from list_filters). Mail it already handled stays as it is.",
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
    filterId: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$|^a[0-9]+:[A-Za-z0-9_-]+$/, "Not a filter id.")
      .max(200)
      .describe("The filter's id from list_filters."),
    account,
  }),
  async handler(args, ctx) {
    const d = ctx.ids.parse(args.filterId);
    const [a] = await ctx.accounts.resolve(args.account, d?.shortId);
    if (!a) throw new ToolError("account_not_found", "No linked account.");
    if (d && d.shortId !== a.shortId) {
      throw new ToolError("invalid_argument", "The id belongs to a different account.");
    }
    const id = d?.providerId ?? args.filterId;
    const svc = ctx.use(FILTERS, a);
    await audited(ctx, a, { tool: "delete_filter", detail: "filter" }, async () => {
      await svc.remove(a, id);
      return { id };
    });
    return { filterId: ctx.ids.encode(a, id), deleted: true };
  },
});

export const mailFilters: Family = {
  id: "mail.filters",
  tools: [listFilters, createFilter, deleteFilter] as unknown as Family["tools"],
  bindings: { google: [provide(FILTERS, googleFilters)] },
  parityPending: [],
};
