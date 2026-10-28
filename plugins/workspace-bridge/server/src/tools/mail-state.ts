// The mail.state family (ARCHITECTURE s.2, s.5). Empty until M12, which adds its tools and bindings and
// removes each built name from `parityPending`.

import type { Family } from "../registry/types";

export const mailState: Family = {
  id: "mail.state",
  tools: [],
  bindings: {},
  parityPending: [
    "mark_message_spam",
    "unmark_message_spam",
    "mark_thread_spam",
    "unmark_thread_spam",
    "trash_message",
    "untrash_message",
    "trash_thread",
    "untrash_thread",
    "apply_sensitive_message_label",
    "apply_sensitive_thread_label",
  ],
};
