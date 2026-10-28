// The mail.send family (ARCHITECTURE s.2, s.5). Empty until M15, which adds its tools and bindings and
// removes each built name from `parityPending`.

import type { Family } from "../registry/types";

export const mailSend: Family = {
  id: "mail.send",
  tools: [],
  bindings: {},
  parityPending: ["send_message", "reply", "forward"],
};
