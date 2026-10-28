// The mail.read family (ARCHITECTURE s.2, s.5). Empty until M10, which adds its tools and bindings and
// removes each built name from `parityPending`.

import type { Family } from "../registry/types";

export const mailRead: Family = {
  id: "mail.read",
  tools: [],
  bindings: {},
  parityPending: ["search_threads", "get_thread", "get_message"],
};
