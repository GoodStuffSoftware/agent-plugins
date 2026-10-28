// The account family (ARCHITECTURE s.2, s.5): `list_accounts` and `link_account_url` on every
// endpoint. Neither needs a component or a provider binding, and neither returns a token.

import { z } from "zod";
import { KINDS } from "../auth/endpoints";
import { normalizeLabel } from "../auth/link";
import { getDefaultAccountId, parseComponents } from "../core/accounts";
import { listAccounts } from "../core/db";
import { ToolError } from "../core/errors";
import { accountKey } from "../core/ids";
import { ACCOUNT_COMPONENTS, parseScopes } from "../providers/google/base";
import { defineTool, type Family } from "../registry/types";

const listAccountsTool = defineTool({
  name: "list_accounts",
  title: "List linked accounts",
  description:
    "Lists the mailboxes linked to this server: short id (use it, the label or the address as `account` in other tools), label, address, provider, enabled components, granted scopes, status and whether it is the default account. `needs_relink` means the account must be linked again at `accountsUrl`.",
  component: null,
  scopes: [],
  endpoints: KINDS,
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({}),
  async handler(_args, ctx) {
    const rows = await listAccounts(ctx.env.DB, ctx.ownerId);
    const set = await getDefaultAccountId(ctx.env.DB, ctx.ownerId);
    // The account a tool uses when it names none: the stored default, else the only account.
    const defaultId = rows.some((r) => r.id === set) ? set : rows.length === 1 ? rows[0]?.id : null;
    return {
      accounts: rows.map((r) => ({
        account: accountKey(r.short_id),
        label: r.label,
        address: r.address,
        provider: r.provider,
        components: parseComponents(r.components),
        grantedScopes: parseScopes(r.granted_scopes),
        status: r.status,
        default: r.id === defaultId,
      })),
      accountsUrl: `${ctx.publicUrl}/accounts`,
    };
  },
});

const linkAccountUrl = defineTool({
  name: "link_account_url",
  title: "Link an account",
  description:
    "Returns the URL of the accounts page, where the owner links a Google mailbox in a browser. Linking cannot happen inside a tool call: give the URL to the user. `label` and `components` only fill the instructions.",
  component: null,
  scopes: [],
  endpoints: KINDS,
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    label: z
      .string()
      .max(64)
      .optional()
      .describe(
        "The label to give the account, such as `work`: lowercase letters, digits, `.`, `_`, `-`.",
      ),
    components: z
      .array(z.enum(ACCOUNT_COMPONENTS))
      .max(ACCOUNT_COMPONENTS.length)
      .optional()
      .describe("The components to tick on the page."),
  }),
  async handler(args, ctx) {
    let label: string | undefined;
    if (args.label !== undefined) {
      label = normalizeLabel(args.label);
      if (label === undefined) {
        throw new ToolError(
          "invalid_argument",
          "A label is 1 to 32 lowercase letters, digits, `.`, `_` or `-`, starts with a letter or digit, and is not `all`.",
        );
      }
    }
    const components = args.components === undefined ? undefined : [...new Set(args.components)];
    const steps = [
      "Open the URL in a browser and sign in.",
      label === undefined ? "Enter a label." : `Enter the label ${label}.`,
      components === undefined
        ? "Tick the components to grant."
        : `Tick only ${components.join(", ")}.`,
      "Press Link with Google and accept Google's consent screen.",
    ];
    return {
      url: `${ctx.publicUrl}/accounts`,
      ...(label === undefined ? {} : { label }),
      ...(components === undefined ? {} : { components }),
      steps: steps.join(" "),
    };
  },
});

export const account: Family = {
  id: "account",
  tools: [listAccountsTool, linkAccountUrl],
  bindings: {},
  parityPending: [],
};
