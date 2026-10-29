// Pending actions (ARCHITECTURE s.2, s.3.3, s.4; plan s.10.5, D10 option a): a call whose
// `approval.when` is true is stored with its exact arguments, endpoint, grant and account for 7 days,
// and runs only after the owner approves it on `/approvals/:id` (owner session and CSRF token, so
// an MCP token can never approve). `web/guardrails.ts` decides and runs it with these helpers.

import { KINDS, type Kind } from "../auth/endpoints";
import type { Env } from "../env";
import type { Grant } from "../registry/types";
import type { AccountRef } from "../services/types";
import { randomId } from "./crypto";
import { first, type PendingActionRow, type PendingStatus, run } from "./db";
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
  /** The endpoint the call came in on; the approved call runs with that endpoint's tools. */
  kind: Kind;
  /** The issuer, for `approvalUrl`. */
  publicUrl: string;
  /** Milliseconds. */
  now: () => number;
}

/** How long an action waits for the owner. */
export const PENDING_TTL_SECONDS = 7 * 86400;
/** Largest stored arguments, in characters (D1 rows stay well under their 2 MB cap). */
export const MAX_PENDING_PARAMS = 1_000_000;
/** Largest stored result; a bigger one is replaced by a note. */
const MAX_PENDING_RESULT = 100_000;

/** `pending_actions.params` holds the endpoint with the arguments. */
export interface StoredCall {
  kind: Kind;
  args: unknown;
}

export function parseStoredCall(params: string): StoredCall | undefined {
  try {
    const v = JSON.parse(params) as { kind?: unknown; args?: unknown } | null;
    if (!v || typeof v !== "object") return undefined;
    if (!(KINDS as readonly unknown[]).includes(v.kind)) return undefined;
    return { kind: v.kind as Kind, args: v.args ?? {} };
  } catch {
    return undefined;
  }
}

const parseJson = (text: string | null): unknown => {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** The row as a tool sees it; a pending row past its expiry reads as `expired`. */
export function pendingInfo(row: PendingActionRow, now: number): PendingActionInfo {
  return {
    pendingActionId: row.id,
    tool: row.tool,
    accountId: row.account_id,
    status: row.status === "pending" && row.expires_at <= now ? "expired" : row.status,
    preview: parseJson(row.preview),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    result: parseJson(row.result),
  };
}

export function loadPending(
  db: D1Database,
  ownerId: string,
  id: string,
): Promise<PendingActionRow | null> {
  return first<PendingActionRow>(
    db,
    "SELECT * FROM pending_actions WHERE id = ? AND owner_id = ?",
    id,
    ownerId,
  );
}

/**
 * Moves a pending, unexpired row to `approved` or `rejected` in one statement and returns it; null
 * when it is not the owner's, already decided or expired. Only one of two racing clicks wins.
 */
export function decidePending(
  db: D1Database,
  ownerId: string,
  id: string,
  decision: "approved" | "rejected",
  now: number,
): Promise<PendingActionRow | null> {
  return first<PendingActionRow>(
    db,
    `UPDATE pending_actions SET status = ?, decided_at = ?
     WHERE id = ? AND owner_id = ? AND status = 'pending' AND expires_at > ?
     RETURNING *`,
    decision,
    now,
    id,
    ownerId,
    now,
  );
}

/** Records how an approved action ended: `executed` with its result or `failed` with the error. */
/** Actions an owner can have waiting at once, so a looping client cannot fill the database. */
export const MAX_OPEN_PENDING = 50;
/** Settled and expired actions (they hold full arguments, send bodies included) are kept this long. */
export const PENDING_KEEP_SECONDS = 7 * 86400;

export async function finishPending(
  db: D1Database,
  id: string,
  status: "executed" | "failed",
  result: unknown,
): Promise<void> {
  let text = JSON.stringify(result ?? null) ?? "null";
  if (text.length > MAX_PENDING_RESULT) text = JSON.stringify({ truncated: true });
  await run(
    db,
    "UPDATE pending_actions SET status = ?, result = ? WHERE id = ? AND status = 'approved'",
    status,
    text,
    id,
  );
}

/** Marks every pending row past its expiry `expired`; returns how many. */
export async function expirePending(db: D1Database, now: number): Promise<number> {
  const res = await run(
    db,
    "UPDATE pending_actions SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?",
    now,
  );
  return res.meta.changes ?? 0;
}

export function createPendingActions(deps: PendingDeps): PendingActions {
  const { env, ownerId, grant } = deps;
  const nowS = (): number => Math.floor(deps.now() / 1000);
  return {
    async create(input) {
      const at = nowS();
      const id = randomId("pa_");
      const expiresAt = at + PENDING_TTL_SECONDS;
      const params = JSON.stringify({ kind: deps.kind, args: input.params ?? {} });
      if (params.length > MAX_PENDING_PARAMS) {
        throw new ToolError("too_large", "This action is too large to hold for approval.");
      }
      const open = await first<{ n: number }>(
        env.DB,
        "SELECT COUNT(*) AS n FROM pending_actions WHERE owner_id = ? AND status = 'pending' AND expires_at > ?",
        ownerId,
        at,
      );
      if ((open?.n ?? 0) >= MAX_OPEN_PENDING) {
        throw new ToolError(
          "rate_limited",
          `${MAX_OPEN_PENDING} actions are already waiting for approval. Ask the owner to approve or reject them first.`,
          { retryAfterSeconds: 3600 },
        );
      }
      const preview = input.preview ?? null;
      await run(
        env.DB,
        `INSERT INTO pending_actions (id, owner_id, tool, account_id, params, preview, client_id,
           grant_id, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        id,
        ownerId,
        input.tool,
        input.account?.accountId ?? null,
        params,
        JSON.stringify(preview) ?? "null",
        grant.clientId,
        grant.grantId,
        at,
        expiresAt,
      );
      return {
        status: "pending_approval",
        pendingActionId: id,
        approvalUrl: `${deps.publicUrl}/approvals/${id}`,
        preview,
        expiresAt,
      };
    },
    async get(id) {
      const row = await loadPending(env.DB, ownerId, id);
      if (!row) throw new ToolError("not_found", "No pending action has that id.");
      return pendingInfo(row, nowS());
    },
  };
}
