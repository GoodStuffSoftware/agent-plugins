// The calendar family (ARCHITECTURE s.2, s.5). Empty until M18, which adds its tools and bindings and
// removes each built name from `parityPending`.

import type { Family } from "../registry/types";

export const calendar: Family = {
  id: "calendar",
  tools: [],
  bindings: {},
  parityPending: [
    "create_event",
    "delete_event",
    "get_event",
    "list_calendars",
    "list_events",
    "respond_to_event",
    "search_events",
    "suggest_time",
    "update_event",
  ],
};
