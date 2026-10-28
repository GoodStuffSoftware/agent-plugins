// The account family (ARCHITECTURE s.2, s.5). Empty until M9: list_accounts, link_account_url, which adds its tools and bindings and
// removes each built name from `parityPending`.

import type { Family } from "../registry/types";

export const account: Family = {
  id: "account",
  tools: [],
  bindings: {},
  parityPending: [],
};
