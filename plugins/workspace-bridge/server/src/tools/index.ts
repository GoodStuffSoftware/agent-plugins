// Every tool family, one import line each (ARCHITECTURE s.7, family rule). A family added later
// adds one import here and one entry in FAMILIES; nothing else in this file changes.

import type { Family } from "../registry/types";
import { account } from "./account";
import { calendar } from "./calendar";
import { contacts } from "./contacts";
import { driveRead } from "./drive-read";
import { driveWrite } from "./drive-write";
import { guardrails } from "./guardrails";
import { mailAttachments } from "./mail-attachments";
import { mailDrafts } from "./mail-drafts";
import { mailFilters } from "./mail-filters";
import { mailLabels } from "./mail-labels";
import { mailRead } from "./mail-read";
import { mailSend } from "./mail-send";
import { mailState } from "./mail-state";
import { meta } from "./meta";

export const FAMILIES: readonly Family[] = [
  meta,
  account,
  guardrails,
  mailRead,
  mailLabels,
  mailState,
  mailDrafts,
  mailSend,
  mailAttachments,
  mailFilters,
  calendar,
  driveRead,
  driveWrite,
  contacts,
];
