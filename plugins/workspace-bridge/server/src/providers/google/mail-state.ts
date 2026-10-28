// Gmail binding of the mail.state capability.

import type { StateService, StateTarget } from "../../services/mail-state";
import { gjson } from "./http";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

const url = (t: StateTarget, action: string) =>
  `${BASE}/${t.kind === "message" ? "messages" : "threads"}/${encodeURIComponent(t.id)}/${action}`;

export const googleState: StateService = {
  async modify(a, t, change) {
    await gjson(
      a,
      url(t, "modify"),
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
  async trash(a, t) {
    await gjson(a, url(t, "trash"), { method: "POST" }, { fields: "id", retry: true });
  },
  async untrash(a, t) {
    await gjson(a, url(t, "untrash"), { method: "POST" }, { fields: "id", retry: true });
  },
};
