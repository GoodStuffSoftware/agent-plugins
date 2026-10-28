// The drive.read family (ARCHITECTURE s.2, s.5). Empty until M19, which adds its tools and bindings and
// removes each built name from `parityPending`.

import type { Family } from "../registry/types";

export const driveRead: Family = {
  id: "drive.read",
  tools: [],
  bindings: {},
  parityPending: [
    "search_files",
    "list_recent_files",
    "get_file_metadata",
    "read_file_content",
    "download_file_content",
    "get_file_permissions",
  ],
};
