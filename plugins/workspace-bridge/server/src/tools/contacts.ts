// The contacts family (ARCHITECTURE s.2, s.5). Empty until M21, which adds its tools and bindings and
// removes each built name from `parityPending`.

import type { Family } from "../registry/types";

export const contacts: Family = {
  id: "contacts",
  tools: [],
  bindings: {},
  parityPending: [],
};
