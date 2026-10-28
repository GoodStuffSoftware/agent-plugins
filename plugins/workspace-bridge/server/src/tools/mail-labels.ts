// The mail.labels family (ARCHITECTURE s.2, s.5). Empty until M11, which adds its tools and bindings and
// removes each built name from `parityPending`.

import type { Family } from "../registry/types";

export const mailLabels: Family = {
  id: "mail.labels",
  tools: [],
  bindings: {},
  parityPending: [
    "list_labels",
    "create_label",
    "update_label",
    "delete_label",
    "label_message",
    "unlabel_message",
    "label_thread",
    "unlabel_thread",
    "update_message_labels",
  ],
};
