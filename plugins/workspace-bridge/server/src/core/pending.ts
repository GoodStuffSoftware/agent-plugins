// Pending actions: a call that needs approval is stored and decided on `/approvals/:id`
// (ARCHITECTURE s.2, s.3.3, s.4). M9 stub: create and get fail closed with `internal`, so a call
// that needs approval never runs unapproved. M14 fills the bodies (and decide, expire, execute)
// without changing these signatures.

import type { Env } from "../env";
import type { Grant } from "../registry/types";
import type { AccountRef } from "../services/types";
import type { PendingStatus } from "./db";
import { ToolError } from "./errors";

/** What a tool answers instead of running, without `isError` (s.3.3). */
export interface PendingApproval {
  status: "pending_approval";
  pendingActionId: string;
  approvalUrl: string;
  preview: unknown;
  /** Unix seconds. */
  expiresAt: number;
}

export interface PendingActionInput {
  tool: string;
  account?: AccountRef | null;
  /** The validated arguments, run as they are once approved. */
  params: unknown;
  preview: unknown;
}

export interface PendingActionInfo {
  pendingActionId: string;
  tool: string;
  accountId: string | null;
  status: PendingStatus;
  preview: unknown;
  /** Unix seconds. */
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
  result: unknown;
}

/** What `ctx.pending` is (s.3.2): bound to the call's owner and grant. */
export interface PendingActions {
  create(input: PendingActionInput): Promise<PendingApproval>;
  /** One of the owner's pending actions; `not_found` for any other id. */
  get(id: string): Promise<PendingActionInfo>;
}

export interface PendingDeps {
  env: Env;
  ownerId: string;
  grant: Grant;
  /** The issuer, for `approvalUrl`. */
  publicUrl: string;
  /** Milliseconds. */
  now: () => number;
}

/** M9 stub: approvals do not exist yet, so both fail closed. */
export function createPendingActions(_deps: PendingDeps): PendingActions {
  return {
    async create() {
      throw new ToolError("internal", "This action needs approval, which is not available yet.");
    },
    async get() {
      throw new ToolError("internal", "Pending actions are not available yet.");
    },
  };
}
