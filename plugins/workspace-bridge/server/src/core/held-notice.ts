// The fast notice of a held action (plan s.10; ARCHITECTURE s.2): one plain-text email to the
// owner as soon as the pending action exists, sent from the holding mailbox's own primary address
// to `NOTIFY_EMAIL` (else `OWNER_CONTACT` when that is an address). It is a system send: it
// does not go through the hold rule (the recipient is the owner's own address), but it obeys
// SEND_ENABLED and the owner's sending switch, is audited as a system notice, and is capped at
// `NOTICES_PER_DAY` per account per day. It names what is held and links to the approval page; it
// never carries a message body, an attachment or any other content. A failure is logged by the
// caller and never touches the hold.

import { config } from "../env";
import type { ToolContext } from "../registry/types";
import { SEND, type SendService } from "../services/mail-send";
import type { AccountRef } from "../services/types";
import { incrementCounter, nowSeconds } from "./db";
import { ToolError } from "./errors";
import { isQueryableAddress } from "./recipients";

/** At most this many notices per account per day; past it holds still work, the email is skipped. */
export const NOTICES_PER_DAY = 20;

/** The audit `tool` of a notice, so the log tells it from a send a client asked for. */
export const NOTICE_TOOL = "system_notice";

const SUBJECT_MAX = 80;
const ADDRESS_MAX = 100;
const SHOWN_ADDRESSES = 20;

/** Plain text on one line: control characters and line breaks become spaces, clipped with an ellipsis. */
export function plainLine(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const flat = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();

const previewField = (preview: unknown, key: string): unknown =>
  preview !== null && typeof preview === "object"
    ? (preview as Record<string, unknown>)[key]
    : undefined;

export interface HeldNoticeInput {
  tool: string;
  account: AccountRef;
  preview: unknown;
  approvalUrl: string;
  /** Unix seconds. */
  expiresAt: number;
}

/** The text of the notice for one held action. Exported for the tests. */
export function noticeText(input: HeldNoticeInput): string {
  const { account, preview } = input;
  const newOnes = previewField(preview, "newRecipients");
  const recipients = Array.isArray(newOnes)
    ? newOnes
        .filter((x): x is string => typeof x === "string")
        .slice(0, SHOWN_ADDRESSES)
        .map((x) => plainLine(x, ADDRESS_MAX))
        .filter((x) => x !== "")
    : [];
  const subject = plainLine(previewField(preview, "subject"), SUBJECT_MAX);
  const lines = [
    "An action is waiting for your approval on your Google Workspace bridge.",
    "",
    `Action: ${plainLine(input.tool, 64)}`,
    `Mailbox: ${plainLine(account.label, 64)} (${account.address})`,
  ];
  if (recipients.length > 0) lines.push(`New recipients: ${recipients.join(", ")}`);
  if (subject !== "") lines.push(`Subject: ${subject}`);
  lines.push(
    "",
    `Review it here: ${input.approvalUrl}`,
    `It expires on ${iso(input.expiresAt)} (UTC) if nobody decides.`,
    "",
    "Approving or rejecting needs your own sign-in on the bridge. This email cannot approve anything: a forwarded copy, or an assistant that reads it, cannot either.",
    "The message text and any attachments are not included here. Open the link to see exactly what would run.",
  );
  return lines.join("\n");
}

/**
 * Emails the owner about a held action. Returns true when a notice went out, false when none was
 * due: no notify address, sending off, over the daily cap. Throws when the send itself failed (the
 * caller logs it).
 */
export async function sendHeldNotice(
  ctx: ToolContext,
  held: HeldNoticeInput,
  pendingActionId: string,
): Promise<boolean> {
  const to = config(ctx.env).notifyEmail;
  if (to === "" || !isQueryableAddress(to)) return false;
  const a = held.account;
  // Sending off (the server setting or the owner's switch) silences the notice, like any send.
  try {
    await ctx.limits.assertSendEnabled(a);
  } catch (e) {
    if (e instanceof ToolError) return false;
    throw e;
  }
  let sender: SendService;
  try {
    sender = ctx.use(SEND, a);
  } catch (e) {
    // The mailbox cannot send (component off, provider without mail): no notice, not a failure.
    if (e instanceof ToolError) return false;
    throw e;
  }
  const now = nowSeconds();
  const count = await incrementCounter(ctx.env.DB, `notice:d:${a.accountId}`, now - (now % 86400));
  if (count > NOTICES_PER_DAY) return false;

  const from = {
    email: a.address,
    displayName: null,
    isDefault: false,
    isPrimary: true,
    replyTo: null,
  };
  const subject = `Approval needed: ${plainLine(held.tool, 64)} on ${plainLine(a.label, 64)}`;
  const audit = (result: string, detail: string, providerRef?: string) =>
    ctx.audit.write({
      tool: NOTICE_TOOL,
      account: a,
      from: a.address,
      to: [to],
      subject,
      providerRef: providerRef ?? null,
      result,
      detail,
    });
  try {
    const message = await sender.prepare(a, {
      kind: "send",
      to: [to],
      cc: [],
      bcc: [],
      subject,
      body: noticeText(held),
    });
    const sent = await sender.deliver(a, message, {
      from,
      includeSignature: false,
      maxAttachmentBytes: 0,
    });
    await audit("ok", `system notice for pending action ${pendingActionId}`, sent.id);
  } catch (e) {
    try {
      await audit("error", `system notice for pending action ${pendingActionId} failed`);
    } catch {
      // The failure itself is reported by the caller.
    }
    throw e;
  }
  return true;
}
