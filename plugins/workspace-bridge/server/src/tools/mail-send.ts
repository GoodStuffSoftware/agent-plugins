// The mail.send family (ARCHITECTURE s.2, s.5; plan s.8.2, s.10): send_message, reply and forward.
// Full endpoint only: a send tool is never registered on /mcp/ro.
//
// Every send passes the same guardrails, in this order: the approval rule (the registry runs
// `approval` before the handler; a held send stores {kind, args} and sends nothing; by default a
// send is held only when a recipient is new to the account, see core/recipients.ts), then in the
// handler the sending switch and rate limit (`checkSend`), the From check (`assertFrom`), the
// send itself and one audit row. The audit row never holds a body. A send that is refused or
// fails writes a row too (`refused` before Google was called, `error` after).
//
// Attachments (M16): `attachments` is checked and capped before any Google call (a refusal is
// audited like a recipient refusal). A forward carries the original's files unless
// `includeAttachments` is false; they are fetched only after the guardrails passed. The audit row
// records the count and total size of the files, never their content.

import { z } from "zod";
import { ToolError } from "../core/errors";
import { accountKey } from "../core/ids";
import { parseAddresses } from "../core/mime";
import {
  findNewRecipients,
  heldBecause,
  normalizeRecipients,
  rememberSent,
} from "../core/recipients";
import type { SendAsAddress } from "../core/send-as";
import { config } from "../env";
import { googleSend } from "../providers/google/mail-send";
import { defineTool, type Family, type HeldAction, type ToolContext } from "../registry/types";
import { type AttachmentTotals, SEND, type SentMessage } from "../services/mail-send";
import type { AccountRef } from "../services/types";
import {
  accountParam,
  assertSingleLine,
  attachmentDetail,
  attachmentsParam,
  bccParam,
  bodyParam,
  ccParam,
  checkAttachments,
  checkRecipients,
  fromParam,
  htmlBodyParam,
  type Recipients,
  subjectParam,
  toParam,
} from "./mail-common";

const idParam = (what: string) => z.string().min(1).max(512).describe(what);
const includeSignatureParam = z
  .boolean()
  .optional()
  .describe("Append the account's Gmail signature for the From address. Defaults to false.");

/** The provider id of a (possibly prefixed) id, and the account a prefix names. */
function idOf(ctx: ToolContext, id: string): { shortId: number | undefined; providerId: string } {
  const d = ctx.ids.parse(id);
  return d
    ? { shortId: d.shortId, providerId: d.providerId }
    : { shortId: undefined, providerId: id };
}

async function accountFor(
  ctx: ToolContext,
  selector: string | undefined,
  shortId?: number,
): Promise<AccountRef> {
  const [a] = await ctx.accounts.resolve(selector, shortId);
  if (!a) throw new ToolError("account_not_found", "No linked account matches this call.");
  return a;
}

const bare = (entry: string): string => parseAddresses(entry)[0] ?? entry.trim().toLowerCase();
const entriesOf = (r: Recipients): string[] => [...r.to, ...r.cc, ...r.bcc];
const everyone = (r: Recipients): string[] => entriesOf(r).map(bare);
const nonEmpty = (xs: readonly string[] | undefined): string[] => (xs ? [...xs] : []);

/**
 * The guarded part every send shares: recipient checks, `checkSend`, `assertFrom`, the send and
 * the audit row. `deliver` gets the From to set (only when the caller named one) and must do the
 * one provider send. Errors are audited and rethrown unchanged.
 */
async function guardedSend(
  ctx: ToolContext,
  a: AccountRef,
  meta: {
    tool: string;
    /** The From the caller named, or undefined for the account's default. */
    from: string | undefined;
    subject: string;
    recipients: () => Recipients;
    /** The files the message holds; the audit row says how many and how large, never what. */
    attachments?: AttachmentTotals;
  },
  deliver: (from: SendAsAddress | undefined) => Promise<SentMessage>,
): Promise<{ sent: SentMessage; from: SendAsAddress; recipients: Recipients }> {
  let stage: "refused" | "error" = "refused";
  let recipients: Recipients = { to: [], cc: [], bcc: [] };
  let allowed: SendAsAddress | undefined;
  const audit = async (result: string, providerRef?: string, reason?: string) => {
    const files =
      meta.attachments && meta.attachments.count > 0 ? attachmentDetail(meta.attachments) : "";
    const detail = [reason, files].filter(Boolean).join("; ");
    try {
      await ctx.audit.write({
        tool: meta.tool,
        account: a,
        from: allowed?.email ?? meta.from ?? null,
        to: recipients.to.map(bare),
        cc: recipients.cc.map(bare),
        bcc: recipients.bcc.map(bare),
        subject: meta.subject,
        providerRef: providerRef ?? null,
        result,
        detail: detail || null,
      });
    } catch {
      // The send already happened or was already refused; a failing log must not change the answer.
      console.error(`${meta.tool}: the audit row could not be written`);
    }
  };
  try {
    recipients = meta.recipients();
    const all = everyone(recipients);
    if (all.length === 0) {
      throw new ToolError(
        "invalid_argument",
        "A message needs at least one recipient in to, cc or bcc.",
      );
    }
    await ctx.limits.checkSend(a, all);
    allowed = await ctx.sendAs.assertFrom(a, meta.from);
    stage = "error";
    const sent = await deliver(meta.from ? allowed : undefined);
    await audit("ok", sent.id);
    await rememberSent(ctx, a, entriesOf(recipients));
    return { sent, from: allowed, recipients };
  } catch (e) {
    await audit(stage, undefined, e instanceof ToolError ? e.code : "internal");
    throw e;
  }
}

/** The caller's own recipient lists, checked before any Google call; a refusal is audited. */
const givenRecipients = (
  ctx: ToolContext,
  a: AccountRef,
  tool: string,
  subject: string | undefined,
  args: Parameters<typeof checkRecipients>[1],
): Promise<Recipients> => refusing(ctx, a, tool, subject, () => checkRecipients(ctx.env, args));

/** The caller's own files, checked and capped before any Google call; a refusal is audited. */
const givenAttachments = (
  ctx: ToolContext,
  a: AccountRef,
  tool: string,
  subject: string | undefined,
  given: Parameters<typeof checkAttachments>[1],
) => refusing(ctx, a, tool, subject, () => checkAttachments(ctx.env, given));

/** Runs a check made before any Google call; when it refuses, writes the audit row and rethrows. */
async function refusing<T>(
  ctx: ToolContext,
  a: AccountRef,
  tool: string,
  subject: string | undefined,
  check: () => T,
): Promise<T> {
  try {
    return await check();
  } catch (e) {
    try {
      await ctx.audit.write({
        tool,
        account: a,
        from: null,
        to: [],
        cc: [],
        bcc: [],
        subject: subject ?? "",
        providerRef: null,
        result: "refused",
        detail: e instanceof ToolError ? e.code : "internal",
      });
    } catch {
      console.error(`${tool}: the audit row could not be written`);
    }
    throw e;
  }
}

/** What a send answers: the Gmail message, ids prefixed, and how many files it carried. */
function answer(
  ctx: ToolContext,
  a: AccountRef,
  s: SentMessage,
  files?: AttachmentTotals,
): Record<string, unknown> {
  return {
    id: ctx.ids.encode(a, s.id),
    threadId: ctx.ids.encode(a, s.threadId),
    ...(s.labelIds ? { labelIds: s.labelIds.map((l) => ctx.ids.encode(a, l)) } : {}),
    account: accountKey(a.shortId),
    ...(files && files.count > 0 ? { attachments: files } : {}),
  };
}

/** The files an approval summary names: what they are called and about how large, never content. */
const attachmentsPreview = (
  files:
    | readonly { content: string; filename?: string | undefined; mimeType?: string | undefined }[]
    | undefined,
) =>
  (files ?? []).map((f) => ({
    filename: f.filename ?? null,
    mimeType: f.mimeType ?? null,
    approxBytes: Math.floor((f.content.length * 3) / 4),
  }));

/** The recipients a hold found new, by the call's arguments: `when` writes, `preview` reads. */
const newOnes = new WeakMap<object, string[]>();

const mode = (ctx: ToolContext) => config(ctx.env).sendApprovalMode;

/**
 * Whether a send is held under `new_recipients`: true when at least one recipient is new to the
 * account (they are kept for the preview). `entries` must be the recipients the message will
 * really have.
 */
async function holdsForNew(
  ctx: ToolContext,
  args: object,
  a: AccountRef,
  entries: readonly string[],
): Promise<boolean> {
  if (entries.length === 0) return false; // the handler refuses a send with no recipient
  const found = await findNewRecipients(ctx, a, entries);
  if (found.length === 0) return false;
  newOnes.set(args, found);
  return true;
}

/** What the approval summary adds when a send was held for new recipients. */
const heldNote = (args: object): Record<string, unknown> => {
  const found = newOnes.get(args);
  return found ? { newRecipients: found, heldBecause: heldBecause(found) } : {};
};

const sendCap = (ctx: ToolContext): number => config(ctx.env).maxSendAttachmentBytes;

/**
 * What a send checks before it is queued for approval (`approval.when`; only when
 * `SEND_APPROVAL_MODE` holds it): the caller's own recipients and files, the send switches
 * (SEND_ENABLED, the owner switch) and the mail.send component, with nothing from Google. A send
 * that could never go out (files over `MAX_SEND_ATTACHMENT_BYTES`, a malformed address, no
 * recipient, sending off) is refused at once, audited like the handler's refusals, and nothing is
 * queued for the owner. The handler repeats the checks when the approved send runs.
 * `needRecipient`: the message has only the recipients the caller gave (no reply defaults).
 */
async function checkBeforeHold(
  ctx: ToolContext,
  tool: string,
  selector: string | undefined,
  ref: string | undefined,
  subject: string | undefined,
  args: Parameters<typeof checkRecipients>[1] & {
    attachments?: Parameters<typeof checkAttachments>[1];
  },
  needRecipient: boolean,
): Promise<void> {
  const a = await accountFor(ctx, selector, ref ? idOf(ctx, ref).shortId : undefined);
  const given = await givenRecipients(ctx, a, tool, subject, args);
  await givenAttachments(ctx, a, tool, subject, args.attachments);
  await refusing(ctx, a, tool, subject, async () => {
    if (needRecipient && everyone(given).length === 0) {
      throw new ToolError(
        "invalid_argument",
        "A message needs at least one recipient in to, cc or bcc.",
      );
    }
    await ctx.limits.assertSendEnabled(a);
    ctx.use(SEND, a);
  });
}

/** Recipients taken from the original message are third-party text. */
function withRecipients(
  ctx: ToolContext,
  a: AccountRef,
  out: Record<string, unknown>,
  subject: string,
  r: Recipients,
): Record<string, unknown> {
  const wrap = (text: string) =>
    ctx.untrusted.wrap(text, { source: "email", account: accountKey(a.shortId) });
  return {
    ...out,
    subject: wrap(subject),
    ...(r.to.length ? { to: wrap(r.to.join(", ")) } : {}),
    ...(r.cc.length ? { cc: wrap(r.cc.join(", ")) } : {}),
  };
}

const ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/** The approval summary the owner sees: who, from where, what subject. Never a body. */
async function preview(
  ctx: ToolContext,
  selector: string | undefined,
  id: string | undefined,
  rest: Record<string, unknown>,
): Promise<unknown> {
  const a = await accountFor(ctx, selector, id ? idOf(ctx, id).shortId : undefined);
  return { account: a.label, address: a.address, ...rest };
}

/** A draft's own recipients and subject for the approval summary; empty when it cannot be read. */
async function draftSummary(
  ctx: ToolContext,
  selector: string | undefined,
  draftId: string,
): Promise<Record<string, unknown>> {
  try {
    const id = idOf(ctx, draftId);
    const a = await accountFor(ctx, selector, id.shortId);
    const d = await ctx.use(SEND, a).readDraft(a, id.providerId, sendCap(ctx));
    return { to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject };
  } catch {
    return {};
  }
}

/** The recipients a reply will really have, for the approval summary; empty when unreadable. */
async function replySummary(
  ctx: ToolContext,
  args: {
    account?: string | undefined;
    messageId: string;
    replyAll?: boolean | undefined;
    to?: readonly string[] | undefined;
    cc?: readonly string[] | undefined;
    bcc?: readonly string[] | undefined;
  },
): Promise<Record<string, unknown>> {
  try {
    const id = idOf(ctx, args.messageId);
    const a = await accountFor(ctx, args.account, id.shortId);
    const self = (await ctx.sendAs.list(a)).map((x) => x.email);
    const p = await ctx.use(SEND, a).prepare(a, {
      kind: "reply",
      messageId: id.providerId,
      replyAll: args.replyAll === true,
      to: nonEmpty(args.to),
      cc: nonEmpty(args.cc),
      bcc: nonEmpty(args.bcc),
      selfAddresses: self,
    });
    return { to: p.to, cc: p.cc, bcc: p.bcc, subject: p.subject };
  } catch {
    return {};
  }
}

/** The strings of a preview field that holds a list of addresses. */
const previewList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * The `pending` audit row of a held send, written from `approval.onHeld` with the pending action
 * id: account, tool, recipients and subject, never a body. The same shape as the calendar and
 * Drive holds; the approved run's own row then follows as the outcome.
 */
async function auditHeld(
  ctx: ToolContext,
  tool: string,
  held: HeldAction,
  subjectOverride?: string,
): Promise<void> {
  const p = (held.preview ?? {}) as Record<string, unknown>;
  await ctx.audit.write({
    tool,
    account: held.account,
    from: typeof p.from === "string" ? p.from : null,
    to: previewList(p.to).map(bare),
    cc: previewList(p.cc).map(bare),
    bcc: previewList(p.bcc).map(bare),
    subject: typeof p.subject === "string" ? p.subject : (subjectOverride ?? null),
    providerRef: null,
    result: "pending",
    detail: `pending action ${held.pendingActionId}: approval requested`,
  });
}

// ---- send_message --------------------------------------------------------------------------------

const sendMessage = defineTool({
  name: "send_message",
  title: "Send an email",
  description:
    "Sends an email now from the account (or one of its verified send-as addresses via `from`). Give recipients in `to`, `cc` or `bcc`, a `subject`, and `body` (plain text) and/or `htmlBody`. Or give `draftId` to send an existing draft as it is (the other fields are then ignored). `replyThreadId` or `replyToMessageId` threads the message under an existing conversation. Sending can be switched off, is rate limited, and may wait for the owner's approval, in which case nothing is sent and the answer carries an approval link. `attachments` adds files (base64 `content`, optional `filename` and `mimeType`; all files together within the server's send size limit, refused before anything is sent). A draft sent by `draftId` keeps the files it has.",
  component: "mail",
  scopes: ["mail.send"],
  endpoints: ["full"],
  annotations: ANNOTATIONS,
  input: z.object({
    account: accountParam,
    to: toParam,
    cc: ccParam,
    bcc: bccParam,
    subject: subjectParam,
    body: bodyParam,
    htmlBody: htmlBodyParam,
    from: fromParam,
    draftId: idParam("The draft to send, from create_draft or list_drafts.").optional(),
    replyThreadId: idParam("The thread to send the message in.").optional(),
    replyToMessageId: idParam(
      "The message this one answers: it is threaded under it (In-Reply-To, References).",
    ).optional(),
    includeSignature: includeSignatureParam,
    attachments: attachmentsParam,
    checkedRecipients: z
      .array(z.string())
      .optional()
      .describe("Set by the server for a draft send; any value given here is replaced."),
  }),
  approval: {
    async when(args, ctx) {
      // The server's field, never the caller's: cleared first, whatever the mode.
      args.checkedRecipients = undefined;
      if (mode(ctx) === "off") return false;
      assertSingleLine("subject", args.subject);
      const ref = args.draftId ?? args.replyToMessageId ?? args.replyThreadId;
      // A draft's recipients as seen now are stored with the call: the send, now or once approved,
      // refuses a draft that gained a recipient since, and sends only the bytes it read and checked.
      if (mode(ctx) === "all") {
        if (args.draftId) {
          const a = await accountFor(ctx, args.account, idOf(ctx, args.draftId).shortId);
          const draft = await ctx
            .use(SEND, a)
            .readDraft(a, idOf(ctx, args.draftId).providerId, sendCap(ctx));
          args.checkedRecipients = normalizeRecipients(entriesOf(draft));
        } else {
          await checkBeforeHold(ctx, "send_message", args.account, ref, args.subject, args, true);
        }
        return true;
      }
      const a = await accountFor(ctx, args.account, ref ? idOf(ctx, ref).shortId : undefined);
      let entries: string[];
      if (args.draftId) {
        // The draft's real To, Cc and Bcc; a failing read is the caller's error, never a free pass.
        const draft = await ctx
          .use(SEND, a)
          .readDraft(a, idOf(ctx, args.draftId).providerId, sendCap(ctx));
        entries = entriesOf(draft);
        args.checkedRecipients = normalizeRecipients(entries);
      } else {
        try {
          entries = entriesOf(checkRecipients(ctx.env, args));
        } catch {
          return false; // the handler repeats this check and refuses
        }
      }
      if (!(await holdsForNew(ctx, args, a, entries))) return false;
      // Held: refuse at once what could never go out.
      if (args.draftId) {
        await refusing(ctx, a, "send_message", undefined, async () => {
          await ctx.limits.assertSendEnabled(a);
        });
      } else {
        await checkBeforeHold(ctx, "send_message", args.account, ref, args.subject, args, true);
      }
      return true;
    },
    preview: async (args, ctx) =>
      preview(ctx, args.account, args.draftId ?? args.replyToMessageId ?? args.replyThreadId, {
        from: args.from ?? null,
        ...heldNote(args),
        ...(args.draftId
          ? { draftId: args.draftId, ...(await draftSummary(ctx, args.account, args.draftId)) }
          : {
              to: nonEmpty(args.to),
              cc: nonEmpty(args.cc),
              bcc: nonEmpty(args.bcc),
              subject: args.subject ?? "",
              attachments: attachmentsPreview(args.attachments),
            }),
      }),
    // After the pending action exists, so a failed hold leaves no row, and with its id.
    onHeld: (_args, ctx, held) => auditHeld(ctx, "send_message", held),
  },
  async handler(args, ctx) {
    assertSingleLine("subject", args.subject);
    const ref = args.draftId ?? args.replyToMessageId ?? args.replyThreadId;
    const a = await accountFor(ctx, args.account, ref ? idOf(ctx, ref).shortId : undefined);
    const sender = ctx.use(SEND, a);

    if (args.draftId) {
      const draftId = idOf(ctx, args.draftId).providerId;
      const draft = await sender.readDraft(a, draftId, sendCap(ctx));
      const fromHeader = draft.from ? parseAddresses(draft.from)[0] : undefined;
      const { sent } = await guardedSend(
        ctx,
        a,
        {
          tool: "send_message",
          from: fromHeader,
          subject: draft.subject,
          recipients: () => {
            // The recipients the hold check (or the owner's approval) was based on: if the draft
            // gained one since, nothing is sent (the caller can try again and be held).
            const before = args.checkedRecipients;
            if (before && normalizeRecipients(entriesOf(draft)).some((x) => !before.includes(x))) {
              throw new ToolError(
                "invalid_argument",
                "The draft's recipients changed after they were checked. Nothing was sent; try again.",
              );
            }
            return checkRecipients(ctx.env, draft);
          },
          attachments: draft.attachmentTotals,
        },
        () => sender.sendDraft(a, draftId, draft),
      );
      return answer(ctx, a, sent, draft.attachmentTotals);
    }

    // The caller's own lists and files are checked before any Google call.
    const given = await givenRecipients(ctx, a, "send_message", args.subject, args);
    const attached = await givenAttachments(ctx, a, "send_message", args.subject, args.attachments);
    const prepared = await sender.prepare(a, {
      kind: "send",
      ...given,
      ...(attached.files.length ? { attachments: attached.files } : {}),
      ...(args.subject === undefined ? {} : { subject: args.subject }),
      ...(args.body === undefined ? {} : { body: args.body }),
      ...(args.htmlBody === undefined ? {} : { htmlBody: args.htmlBody }),
      ...(args.replyThreadId ? { replyThreadId: idOf(ctx, args.replyThreadId).providerId } : {}),
      ...(args.replyToMessageId
        ? { replyToMessageId: idOf(ctx, args.replyToMessageId).providerId }
        : {}),
    });
    const { sent } = await guardedSend(
      ctx,
      a,
      {
        tool: "send_message",
        from: args.from,
        subject: prepared.subject,
        recipients: () => given,
        attachments: prepared.attachmentTotals,
      },
      (from) =>
        sender.deliver(a, prepared, {
          from,
          includeSignature: args.includeSignature === true,
          maxAttachmentBytes: sendCap(ctx),
        }),
    );
    return answer(ctx, a, sent, prepared.attachmentTotals);
  },
});

// ---- reply ---------------------------------------------------------------------------------------

const reply = defineTool({
  name: "reply",
  title: "Reply to an email",
  description:
    "Replies to a message now. The reply is threaded under it (thread, In-Reply-To, References), the subject is `Re: ...` without doubling, and the original is quoted below your text. By default it goes to the original's Reply-To or sender; `replyAll` adds everyone else on the original (the account's own addresses are always left out). `to` replaces the default recipients and `cc` the default Cc when given and not empty. `body` and/or `htmlBody` is required. Sending can be switched off, is rate limited, and may wait for the owner's approval. `attachments` adds files (base64 `content`, optional `filename` and `mimeType`; all files together within the server's send size limit, refused before anything is sent).",
  component: "mail",
  scopes: ["mail.send"],
  endpoints: ["full"],
  annotations: ANNOTATIONS,
  untrusted: true,
  input: z.object({
    account: accountParam,
    messageId: idParam("The message to reply to, from get_thread or search_threads."),
    replyAll: z.boolean().optional().describe("Reply to all recipients. Defaults to false."),
    to: toParam,
    cc: ccParam,
    bcc: bccParam,
    body: bodyParam,
    htmlBody: htmlBodyParam,
    from: fromParam,
    includeSignature: includeSignatureParam,
    attachments: attachmentsParam,
  }),
  approval: {
    async when(args, ctx) {
      if (mode(ctx) === "off") return false;
      if (!args.body && !args.htmlBody) {
        throw new ToolError("invalid_argument", "A reply needs `body` or `htmlBody`.");
      }
      if (mode(ctx) === "all") {
        await checkBeforeHold(ctx, "reply", args.account, args.messageId, undefined, args, false);
        return true;
      }
      try {
        checkRecipients(ctx.env, args);
      } catch {
        return false; // the handler repeats this check and refuses
      }
      // The recipients the reply will really have (the original's Reply-To or sender, and with
      // replyAll the rest): a stranger who wrote in is new. A failing read is an error, not a pass.
      const id = idOf(ctx, args.messageId);
      const a = await accountFor(ctx, args.account, id.shortId);
      const self = (await ctx.sendAs.list(a)).map((x) => x.email);
      const p = await ctx.use(SEND, a).prepare(a, {
        kind: "reply",
        messageId: id.providerId,
        replyAll: args.replyAll === true,
        to: nonEmpty(args.to),
        cc: nonEmpty(args.cc),
        bcc: nonEmpty(args.bcc),
        selfAddresses: self,
      });
      if (!(await holdsForNew(ctx, args, a, entriesOf(p)))) return false;
      await checkBeforeHold(ctx, "reply", args.account, args.messageId, undefined, args, false);
      return true;
    },
    preview: async (args, ctx) =>
      preview(ctx, args.account, args.messageId, {
        action: "reply",
        ...heldNote(args),
        messageId: args.messageId,
        replyAll: args.replyAll === true,
        from: args.from ?? null,
        to: nonEmpty(args.to),
        cc: nonEmpty(args.cc),
        bcc: nonEmpty(args.bcc),
        attachments: attachmentsPreview(args.attachments),
        ...(await replySummary(ctx, args)),
      }),
    onHeld: (_args, ctx, held) => auditHeld(ctx, "reply", held),
  },
  async handler(args, ctx) {
    if (!args.body && !args.htmlBody) {
      throw new ToolError("invalid_argument", "A reply needs `body` or `htmlBody`.");
    }
    const id = idOf(ctx, args.messageId);
    const a = await accountFor(ctx, args.account, id.shortId);
    const sender = ctx.use(SEND, a);
    const given = await givenRecipients(ctx, a, "reply", undefined, args);
    const attached = await givenAttachments(ctx, a, "reply", undefined, args.attachments);
    const self = (await ctx.sendAs.list(a)).map((s) => s.email);
    const prepared = await sender.prepare(a, {
      kind: "reply",
      messageId: id.providerId,
      replyAll: args.replyAll === true,
      ...given,
      ...(attached.files.length ? { attachments: attached.files } : {}),
      ...(args.body === undefined ? {} : { body: args.body }),
      ...(args.htmlBody === undefined ? {} : { htmlBody: args.htmlBody }),
      selfAddresses: self,
    });
    const { sent, recipients } = await guardedSend(
      ctx,
      a,
      {
        tool: "reply",
        from: args.from,
        subject: prepared.subject,
        recipients: () => checkRecipients(ctx.env, prepared),
        attachments: prepared.attachmentTotals,
      },
      (from) =>
        sender.deliver(a, prepared, {
          from,
          includeSignature: args.includeSignature === true,
          maxAttachmentBytes: sendCap(ctx),
        }),
    );
    return withRecipients(
      ctx,
      a,
      answer(ctx, a, sent, prepared.attachmentTotals),
      prepared.subject,
      recipients,
    );
  },
});

// ---- forward -------------------------------------------------------------------------------------

const forward = defineTool({
  name: "forward",
  title: "Forward an email",
  description:
    "Forwards a message now: your comments (`forwardText` and/or `htmlBody`) come first, then the original under a `---------- Forwarded message ---------` header block, with the subject `Fwd: ...`. At least one recipient is needed in `to`, `cc` or `bcc`. The original's attachments are carried along (set `includeAttachments` false to leave them out); together with any extra `attachments` they must fit the server's send size limit, otherwise the forward is refused and nothing is sent. Sending can be switched off, is rate limited, and may wait for the owner's approval.",
  component: "mail",
  scopes: ["mail.send"],
  endpoints: ["full"],
  annotations: ANNOTATIONS,
  untrusted: true,
  input: z.object({
    account: accountParam,
    messageId: idParam("The message to forward, from get_thread or search_threads."),
    to: toParam,
    cc: ccParam,
    bcc: bccParam,
    forwardText: z
      .string()
      .max(50_000)
      .optional()
      .describe("Plain text comments placed before the forwarded message."),
    htmlBody: htmlBodyParam,
    from: fromParam,
    includeSignature: includeSignatureParam,
    includeAttachments: z
      .boolean()
      .optional()
      .describe("Carry the original's attachments along (default true)."),
    attachments: attachmentsParam,
  }),
  approval: {
    async when(args, ctx) {
      if (mode(ctx) === "off") return false;
      if (mode(ctx) === "all") {
        await checkBeforeHold(ctx, "forward", args.account, args.messageId, undefined, args, true);
        return true;
      }
      let entries: string[];
      try {
        entries = entriesOf(checkRecipients(ctx.env, args));
      } catch {
        return false; // the handler repeats this check and refuses
      }
      const a = await accountFor(ctx, args.account, idOf(ctx, args.messageId).shortId);
      if (!(await holdsForNew(ctx, args, a, entries))) return false;
      await checkBeforeHold(ctx, "forward", args.account, args.messageId, undefined, args, true);
      return true;
    },
    preview: (args, ctx) =>
      preview(ctx, args.account, args.messageId, {
        action: "forward",
        ...heldNote(args),
        messageId: args.messageId,
        from: args.from ?? null,
        to: nonEmpty(args.to),
        cc: nonEmpty(args.cc),
        bcc: nonEmpty(args.bcc),
        includeOriginalAttachments: args.includeAttachments !== false,
        attachments: attachmentsPreview(args.attachments),
      }),
    onHeld: async (args, ctx, held) => {
      // A forward's preview has no subject; read the original's for the row, best effort.
      let subject: string | undefined;
      try {
        const id = idOf(ctx, args.messageId);
        const a = await accountFor(ctx, args.account, id.shortId);
        const p = await ctx.use(SEND, a).prepare(a, {
          kind: "forward",
          messageId: id.providerId,
          to: nonEmpty(args.to),
          cc: nonEmpty(args.cc),
          bcc: nonEmpty(args.bcc),
          includeOriginalAttachments: false,
          maxAttachmentBytes: sendCap(ctx),
        });
        subject = p.subject;
      } catch {
        // the row is still written, without a subject
      }
      await auditHeld(ctx, "forward", held, subject);
    },
  },
  async handler(args, ctx) {
    const id = idOf(ctx, args.messageId);
    const a = await accountFor(ctx, args.account, id.shortId);
    const sender = ctx.use(SEND, a);
    const given = await givenRecipients(ctx, a, "forward", undefined, args);
    if (everyone(given).length === 0) {
      throw new ToolError(
        "invalid_argument",
        "A forward needs at least one recipient in to, cc or bcc.",
      );
    }
    const attached = await givenAttachments(ctx, a, "forward", undefined, args.attachments);
    const cap = sendCap(ctx);
    const prepared = await sender.prepare(a, {
      kind: "forward",
      messageId: id.providerId,
      ...given,
      ...(args.forwardText === undefined ? {} : { forwardText: args.forwardText }),
      ...(args.htmlBody === undefined ? {} : { htmlBody: args.htmlBody }),
      ...(attached.files.length ? { attachments: attached.files } : {}),
      includeOriginalAttachments: args.includeAttachments !== false,
      maxAttachmentBytes: cap,
    });
    const { sent } = await guardedSend(
      ctx,
      a,
      {
        tool: "forward",
        from: args.from,
        subject: prepared.subject,
        recipients: () => given,
        attachments: prepared.attachmentTotals,
      },
      (from) =>
        sender.deliver(a, prepared, {
          from,
          includeSignature: args.includeSignature === true,
          maxAttachmentBytes: cap,
        }),
    );
    return withRecipients(
      ctx,
      a,
      answer(ctx, a, sent, prepared.attachmentTotals),
      prepared.subject,
      { to: [], cc: [], bcc: [] },
    );
  },
});

export const mailSend: Family = {
  id: "mail.send",
  tools: [sendMessage, reply, forward],
  bindings: { google: [googleSend] },
  parityPending: [],
};
