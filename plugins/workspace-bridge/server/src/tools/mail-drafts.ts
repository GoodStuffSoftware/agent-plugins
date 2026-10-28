// The mail.drafts family (ARCHITECTURE s.2, s.5). Empty until M13, which adds its tools and bindings and
// removes each built name from `parityPending`.

import type { Family } from "../registry/types";

export const mailDrafts: Family = {
  id: "mail.drafts",
  tools: [],
  bindings: {},
  parityPending: ["create_draft", "get_draft", "list_drafts", "update_draft", "delete_draft"],
};
