// The guardrails family (ARCHITECTURE s.2, s.5). Empty until M14: list_send_as, get_pending_action, which adds its tools and bindings and
// removes each built name from `parityPending`.

import type { Family } from "../registry/types";

export const guardrails: Family = {
  id: "guardrails",
  tools: [],
  bindings: {},
  parityPending: [],
};
