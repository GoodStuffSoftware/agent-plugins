// Gmail's send-as list (`users.settings.sendAs.list`, scope gmail.settings.basic) for the
// `mail.sendas` capability.

import { provide } from "../../services/capability";
import { SENDAS, type SendAsEntry, type SendAsService } from "../../services/mail-sendas";
import { gjson } from "./http";

const SEND_AS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs";
const FIELDS =
  "sendAs(sendAsEmail,displayName,replyToAddress,isPrimary,isDefault,verificationStatus)";
const ADDRESS = /^[^\s@]+@[^\s@]+$/;
const MAX_ENTRIES = 200;

const text = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null;

/** The well-formed entries, lowercased and de-duplicated; anything else is dropped. */
export function parseSendAs(body: unknown): SendAsEntry[] {
  const list = (body as { sendAs?: unknown } | null)?.sendAs;
  if (!Array.isArray(list)) return [];
  const out = new Map<string, SendAsEntry>();
  for (const item of list.slice(0, MAX_ENTRIES)) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    const email = typeof e.sendAsEmail === "string" ? e.sendAsEmail.trim().toLowerCase() : "";
    if (!ADDRESS.test(email) || email.length > 320 || out.has(email)) continue;
    out.set(email, {
      email,
      displayName: text(e.displayName, 200),
      replyTo: text(e.replyToAddress, 320),
      isPrimary: e.isPrimary === true,
      isDefault: e.isDefault === true,
      verificationStatus: text(e.verificationStatus, 32),
    });
  }
  return [...out.values()];
}

export const gmailSendAs: SendAsService = {
  async list(a) {
    return parseSendAs(await gjson<unknown>(a, SEND_AS_URL, {}, { fields: FIELDS }));
  },
};

export const gmailSendAsBinding = provide(SENDAS, gmailSendAs);
