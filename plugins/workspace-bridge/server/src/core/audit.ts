// The audit log of sends and other guarded actions (ARCHITECTURE s.2, s.4). M9 stub: writes are
// dropped and reads are empty. M14 fills the bodies (`audit_log` rows, no bodies, 365 days)
// without changing these signatures.

import type { Env } from "../env";
import type { Grant } from "../registry/types";
import type { AccountRef } from "../services/types";
import type { AuditLogRow } from "./db";

/** One audited action. Never a body, an attachment or a token. */
export interface AuditEntry {
  tool: string;
  account?: AccountRef | null;
  from?: string | null;
  to?: readonly string[];
  cc?: readonly string[];
  bcc?: readonly string[];
  subject?: string | null;
  /** The provider's id for what was created or changed, such as a Gmail message id. */
  providerRef?: string | null;
  /** For example `ok`, `error`, `pending`. */
  result: string;
  /** A short reason, never a provider response body. */
  detail?: string | null;
}

/** What `ctx.audit` is (s.3.2): bound to the call's owner and grant. */
export interface AuditLog {
  write(entry: AuditEntry): Promise<void>;
  /** The owner's entries, newest first; `before` is Unix seconds. */
  read(opts?: { limit?: number; before?: number }): Promise<AuditLogRow[]>;
}

export interface AuditDeps {
  env: Env;
  ownerId: string;
  grant: Grant;
  /** Milliseconds. */
  now: () => number;
}

/** M9 stub: no-op write, empty read. */
export function createAuditLog(_deps: AuditDeps): AuditLog {
  return {
    async write() {},
    async read() {
      return [];
    },
  };
}
