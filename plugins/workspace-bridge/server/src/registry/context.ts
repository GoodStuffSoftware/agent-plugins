// Builds the ToolContext per call (ARCHITECTURE s.3.2) and holds the wrapper hooks that later
// milestones fill: the per-grant rate check (M9 stub, M14 body) and the approval gate (M14).

import type { AuthInfo } from "@modelcontextprotocol/server";
import { endpointScopes, type Kind } from "../auth/endpoints";
import { ToolError } from "../core/errors";
import { config, type Env } from "../env";
import type { Grant, ToolContext, ToolDef } from "./types";

/** Per-request facts, read once when the server is built. */
export interface RequestScope {
  readonly kind: Kind;
  readonly ownerId: string;
  readonly grant: Grant;
  readonly env: Env;
  readonly exec: ExecutionContext;
}

/**
 * The grant id is the middle segment of an access token `{userId}:{grantId}:{secret}`
 * (OP:1686). Throws on any other shape; `unwrapToken()` is the fallback if the format changes.
 */
export function grantIdOf(token: string): string {
  const parts = token.split(":");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error("unexpected access token format");
  }
  return parts[1];
}

/** Reads the owner, client, grant and this endpoint's scopes from the validated token. */
export function requestScope(
  kind: Kind,
  authInfo: AuthInfo,
  env: Env,
  exec: ExecutionContext,
): RequestScope {
  const props = authInfo.extra?.props as { ownerId?: unknown } | undefined;
  const ownerId = props?.ownerId;
  if (typeof ownerId !== "string" || ownerId === "") throw new Error("token has no ownerId");
  return {
    kind,
    ownerId,
    grant: Object.freeze({
      clientId: authInfo.clientId,
      grantId: grantIdOf(authInfo.token),
      scopes: Object.freeze(endpointScopes(kind, authInfo.scopes)),
    }),
    env,
    exec,
  };
}

/** A fresh context for one tool call. */
export function toolContext(scope: RequestScope): ToolContext {
  return {
    kind: scope.kind,
    ownerId: scope.ownerId,
    grant: scope.grant,
    publicUrl: config(scope.env).issuer,
    env: scope.env,
    now: Date.now,
    waitUntil: (p) => scope.exec.waitUntil(p),
  };
}

/** Per-grant call limit. No-op until M9 and M14; throws `ToolError("rate_limited")` then. */
export async function checkRate(_def: ToolDef, _ctx: ToolContext): Promise<void> {}

/**
 * Approval gate. Returns the value to answer with instead of running the handler (the pending
 * action's preview), or `undefined` to run it. Until M14 stores pending actions, a call that
 * needs approval fails closed rather than running unapproved.
 */
export async function gateApproval(
  def: ToolDef,
  args: unknown,
  ctx: ToolContext,
): Promise<unknown> {
  if (!def.approval) return undefined;
  if (!(await def.approval.when(args as never, ctx))) return undefined;
  throw new ToolError("internal", "This action needs approval, which is not available yet.");
}
