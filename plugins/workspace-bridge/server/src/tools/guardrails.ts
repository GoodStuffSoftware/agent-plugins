// The guardrails family (ARCHITECTURE s.2, s.5; plan s.10): `list_send_as` (full and ro) and
// `get_pending_action` (every endpoint). Approving is never a tool: only the owner's browser can.

import { z } from "zod";
import { KINDS } from "../auth/endpoints";
import { ToolError } from "../core/errors";
import { accountKey } from "../core/ids";
import type { SendAsAddress } from "../core/send-as";
import { gmailSendAsBinding } from "../providers/google/gmail-sendas";
import { defineTool, type Family } from "../registry/types";

const listSendAs = defineTool({
  name: "list_send_as",
  title: "List send-as addresses",
  description:
    "Lists the From addresses an account may send as: its own address and the aliases Gmail reports as verified. Reads the list from Gmail now. `from` in the send tools must be one of these; the default is used when `from` is omitted.",
  component: "mail",
  scopes: [],
  endpoints: ["full", "ro"],
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    account: z
      .string()
      .max(320)
      .optional()
      .describe("Label, address or short id of the account; the default account when omitted."),
  }),
  async handler(args, ctx) {
    const [a] = await ctx.accounts.resolve(args.account);
    if (!a) throw new ToolError("account_not_found", "No linked account matches.");
    let refreshed = true;
    let addresses: SendAsAddress[];
    try {
      addresses = await ctx.sendAs.refresh(a);
    } catch (e) {
      // Without the mail component (a send-only account) the stored list is all there is.
      if (
        !(e instanceof ToolError) ||
        (e.code !== "component_disabled" && e.code !== "not_supported_by_provider")
      ) {
        throw e;
      }
      refreshed = false;
      addresses = await ctx.sendAs.list(a);
    }
    return {
      account: accountKey(a.shortId),
      label: a.label,
      refreshed,
      addresses: addresses.map((x) => ({
        email: x.email,
        displayName: x.displayName,
        isDefault: x.isDefault,
        isPrimary: x.isPrimary,
        replyTo: x.replyTo,
      })),
    };
  },
});

const getPendingAction = defineTool({
  name: "get_pending_action",
  title: "Check a pending action",
  description:
    "Returns an action that waits for the owner's approval: its status (pending, approved, rejected, expired, executed or failed), its preview and, once it ran, its result. Only the owner can approve or reject it, at the approvalUrl the tool returned; no tool can.",
  component: null,
  scopes: [],
  endpoints: KINDS,
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    pendingActionId: z
      .string()
      .min(4)
      .max(64)
      .describe("The pendingActionId from a pending_approval answer."),
  }),
  async handler(args, ctx) {
    return ctx.pending.get(args.pendingActionId);
  },
});

export const guardrails: Family = {
  id: "guardrails",
  tools: [listSendAs, getPendingAction],
  bindings: { google: [gmailSendAsBinding] },
  parityPending: [],
};
