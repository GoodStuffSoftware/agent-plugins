// Gmail binding of the mail.labels capability.

import { ToolError } from "../../core/errors";
import type { Label, LabelInput, LabelService } from "../../services/mail-labels";
import { gjson } from "./http";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const LABEL_FIELDS = "id,name,type,labelListVisibility,messageListVisibility,color";

interface GLabel {
  id: string;
  name: string;
  type?: string;
  labelListVisibility?: string;
  messageListVisibility?: string;
  color?: { backgroundColor?: string; textColor?: string };
}

// Gmail REST spells visibility in camelCase; the tools use the official upper-case names.
const LIST_TO_GMAIL: Record<string, string> = {
  LABEL_SHOW: "labelShow",
  LABEL_SHOW_IF_UNREAD: "labelShowIfUnread",
  LABEL_HIDE: "labelHide",
};
const MSG_TO_GMAIL: Record<string, string> = { SHOW: "show", HIDE: "hide" };
const invert = (m: Record<string, string>) =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [v, k]));
const LIST_FROM_GMAIL = invert(LIST_TO_GMAIL);
const MSG_FROM_GMAIL = invert(MSG_TO_GMAIL);

function toLabel(l: GLabel): Label {
  const out: Label = { id: l.id, name: l.name, type: l.type === "system" ? "system" : "user" };
  if (l.labelListVisibility)
    out.labelListVisibility = LIST_FROM_GMAIL[l.labelListVisibility] ?? l.labelListVisibility;
  if (l.messageListVisibility)
    out.messageListVisibility = MSG_FROM_GMAIL[l.messageListVisibility] ?? l.messageListVisibility;
  if (l.color?.backgroundColor && l.color.textColor) {
    out.color = { backgroundColor: l.color.backgroundColor, textColor: l.color.textColor };
  }
  return out;
}

/** Google answers 409 for a label name already in use; show that as an argument problem. */
function mapConflict(e: unknown): never {
  if (e instanceof ToolError && e.details?.status === 409) {
    throw new ToolError("invalid_argument", "A label with that name already exists.");
  }
  throw e;
}

function body(l: LabelInput): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  if (l.name !== undefined) b.name = l.name;
  if (l.labelListVisibility !== undefined) {
    b.labelListVisibility = LIST_TO_GMAIL[l.labelListVisibility] ?? l.labelListVisibility;
  }
  if (l.messageListVisibility !== undefined) {
    b.messageListVisibility = MSG_TO_GMAIL[l.messageListVisibility] ?? l.messageListVisibility;
  }
  if (l.color !== undefined) b.color = l.color;
  return b;
}

function need(r: GLabel | undefined): GLabel {
  if (!r) throw new ToolError("upstream_error", "Google answered without a label.");
  return r;
}

export const googleLabels: LabelService = {
  async list(a) {
    const r = await gjson<{ labels?: GLabel[] }>(
      a,
      `${BASE}/labels`,
      {},
      { fields: `labels(${LABEL_FIELDS})` },
    );
    return (r?.labels ?? []).map(toLabel);
  },
  async create(a, l) {
    try {
      const r = await gjson<GLabel>(
        a,
        `${BASE}/labels`,
        { method: "POST", json: body(l) },
        { fields: LABEL_FIELDS },
      );
      return toLabel(need(r));
    } catch (e) {
      return mapConflict(e);
    }
  },
  async update(a, id, l) {
    try {
      const r = await gjson<GLabel>(
        a,
        `${BASE}/labels/${encodeURIComponent(id)}`,
        { method: "PATCH", json: body(l) },
        { fields: LABEL_FIELDS },
      );
      return toLabel(need(r));
    } catch (e) {
      return mapConflict(e);
    }
  },
  async remove(a, id) {
    await gjson(a, `${BASE}/labels/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  async modify(a, t, change) {
    const path = t.kind === "message" ? "messages" : "threads";
    await gjson(
      a,
      `${BASE}/${path}/${encodeURIComponent(t.id)}/modify`,
      {
        method: "POST",
        json: {
          ...(change.add?.length ? { addLabelIds: change.add } : {}),
          ...(change.remove?.length ? { removeLabelIds: change.remove } : {}),
        },
      },
      { fields: "id", retry: true },
    );
  },
};
