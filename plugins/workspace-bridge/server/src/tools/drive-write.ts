// The drive.write family (ARCHITECTURE s.2, s.5). Empty until M20, which adds its tools and bindings and
// removes each built name from `parityPending`.

import type { Family } from "../registry/types";

export const driveWrite: Family = {
  id: "drive.write",
  tools: [],
  bindings: {},
  parityPending: ["create_file", "update_file", "copy_file", "share_file", "trash_file"],
};
