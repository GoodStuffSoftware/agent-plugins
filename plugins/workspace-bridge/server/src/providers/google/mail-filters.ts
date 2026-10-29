// Gmail binding of the mail.filters capability: `users.settings.filters` (scope
// gmail.settings.basic). Gmail has no way to edit a filter, so there is no update here.

import { ToolError } from "../../core/errors";
import type {
  FilterAction,
  FilterCriteria,
  FilterInfo,
  FilterService,
} from "../../services/mail-filters";
import { gfetch, gjson } from "./http";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me/settings/filters";
const FIELDS = "id,criteria,action";

interface GmailFilter {
  id?: string;
  criteria?: Record<string, unknown>;
  action?: Record<string, unknown>;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const flag = (v: unknown): true | undefined => (v === true ? true : undefined);
const strings = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string" && x !== "");
  return out.length > 0 ? out : undefined;
};

/** Drops absent fields, so a filter reads the same whether Gmail left a field out or empty. */
function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function toInfo(f: GmailFilter): FilterInfo {
  const c = f.criteria ?? {};
  const a = f.action ?? {};
  const cmp = str(c.sizeComparison);
  return {
    id: String(f.id ?? ""),
    criteria: clean<FilterCriteria>({
      from: str(c.from),
      to: str(c.to),
      subject: str(c.subject),
      query: str(c.query),
      negatedQuery: str(c.negatedQuery),
      hasAttachment: flag(c.hasAttachment),
      excludeChats: flag(c.excludeChats),
      size: typeof c.size === "number" && c.size > 0 ? c.size : undefined,
      sizeComparison: cmp === "larger" || cmp === "smaller" ? cmp : undefined,
    }),
    action: clean<FilterAction>({
      addLabelIds: strings(a.addLabelIds),
      removeLabelIds: strings(a.removeLabelIds),
      forward: str(a.forward),
    }),
  };
}

export const googleFilters: FilterService = {
  async list(a) {
    const r = await gjson<{ filter?: GmailFilter[] } | undefined>(
      a,
      BASE,
      {},
      { fields: `filter(${FIELDS})` },
    );
    return (r?.filter ?? []).filter((f) => f.id).map(toInfo);
  },

  async create(a, { criteria, action }) {
    try {
      const r = await gjson<GmailFilter | undefined>(
        a,
        BASE,
        { method: "POST", json: { criteria, action } },
        { fields: FIELDS },
      );
      return toInfo(r ?? {});
    } catch (e) {
      // Gmail answers 400 when the forwarding address is not one of the account's verified
      // forwarding addresses. This tool never adds addresses (Gmail asks the address's owner to
      // confirm), so say what to do instead of passing the bare refusal on.
      if (action.forward && e instanceof ToolError && e.code === "invalid_argument") {
        throw new ToolError(
          "invalid_argument",
          "Google refused the filter. If it forwards mail, the address must already be a verified forwarding address of this account: add and confirm it in Gmail settings (Forwarding and POP/IMAP), then try again. Otherwise check the criteria and the label ids.",
          { ...e.details, forwardingAddress: "unverified_or_invalid" },
        );
      }
      throw e;
    }
  },

  async isForwardingVerified(a, address) {
    const r = await gjson<
      | { forwardingAddresses?: { forwardingEmail?: string; verificationStatus?: string }[] }
      | undefined
    >(
      a,
      "https://gmail.googleapis.com/gmail/v1/users/me/settings/forwardingAddresses",
      {},
      { fields: "forwardingAddresses(forwardingEmail,verificationStatus)" },
    );
    const want = address.trim().toLowerCase();
    return (r?.forwardingAddresses ?? []).some(
      (f) =>
        f.verificationStatus === "accepted" && f.forwardingEmail?.trim().toLowerCase() === want,
    );
  },

  async remove(a, id) {
    const res = await gfetch(a, `${BASE}/${encodeURIComponent(id)}`, { method: "DELETE" });
    await res.body?.cancel();
  },
};
