// Builds the ToolContext per call (ARCHITECTURE s.3.2): accounts, `ctx.use`, ids, cursors, the
// untrusted wrapper and the guardrails (M9 stubs, M14 bodies), and holds the wrapper hooks for
// the per-grant rate check and the approval gate.

import type { AuthInfo } from "@modelcontextprotocol/server";
import { endpointScopes, type Kind } from "../auth/endpoints";
import { accountState, createAccountResolver, loadAccountsWithState } from "../core/accounts";
import { createAuditLog } from "../core/audit";
import { cursors } from "../core/cursor";
import { ToolError } from "../core/errors";
import { accountKey, ids } from "../core/ids";
import { createPendingActions } from "../core/pending";
import { createRateLimiter } from "../core/ratelimit";
import { createSendAsCache } from "../core/send-as";
import { createUntrusted } from "../core/untrusted";
import { config, type Env } from "../env";
import type { AccountComponent } from "../providers/google/base";
import type { ProviderRegistry } from "../providers/registry";
import type { Capability } from "../services/capability";
import type { AccountRef } from "../services/types";
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

/**
 * The account component a capability needs (s.3.6): `mail.send` for the `mail.send` capability,
 * `mail` for the other mail capabilities, `calendar`, `files` and `contacts` as they are; null for
 * a capability without a component. `admin` is no account component, so it is never on: admin
 * capabilities stay refused until their milestone defines the check.
 */
export function componentFor(cap: Capability<unknown>): AccountComponent | "admin" | null {
  if (cap.component === null) return null;
  if (cap.component === "mail") return cap.id === "mail.send" ? "mail.send" : "mail";
  return cap.component;
}

/** A fresh context for one tool call. */
export function toolContext(scope: RequestScope, providers: ProviderRegistry): ToolContext {
  const { env, ownerId, grant } = scope;
  const publicUrl = config(env).issuer;
  const accountsUrl = `${publicUrl}/accounts`;
  const now = Date.now;
  return {
    kind: scope.kind,
    ownerId,
    grant,
    publicUrl,
    env,
    now,
    untrusted: createUntrusted(),
    accounts: createAccountResolver({
      db: env.DB,
      ownerId,
      publicUrl,
      load: () => loadAccountsWithState(env, ownerId),
    }),
    use<T>(cap: Capability<T>, a: AccountRef): T {
      const state = accountState(a);
      // A programming error, not the caller's: `internal`, logged with the tool name.
      if (!state || state.row.owner_id !== ownerId || state.env !== env) {
        throw new Error("ctx.use: the account was not resolved through ctx.accounts in this call");
      }
      const component = componentFor(cap);
      if (component !== null && !(state.components as readonly string[]).includes(component)) {
        throw new ToolError(
          "component_disabled",
          `The ${component} component is off for account ${accountKey(a.shortId)} (${a.label}). ` +
            `Switch it on at ${accountsUrl}.`,
          { component, accountsUrl },
        );
      }
      const impl = providers.get(state.row.provider).get(cap);
      if (impl === undefined) {
        throw new ToolError(
          "not_supported_by_provider",
          `Account ${accountKey(a.shortId)} (${a.label}) is a ${state.row.provider} account, ` +
            `which does not support ${cap.id}.`,
          { capability: cap.id, provider: state.row.provider },
        );
      }
      return impl;
    },
    ids,
    cursors,
    sendAs: createSendAsCache({ env, now }),
    audit: createAuditLog({ env, ownerId, grant, now }),
    limits: createRateLimiter({ env, grant, now }),
    pending: createPendingActions({ env, ownerId, grant, publicUrl, now }),
    waitUntil: (p) => scope.exec.waitUntil(p),
  };
}

/** Per-grant call limit (`ctx.limits.call`): throws `rate_limited` when over. The M9 stub never trips. */
export async function checkRate(def: ToolDef, ctx: ToolContext): Promise<void> {
  await ctx.limits.call(def.name);
}

/**
 * Approval gate. Returns the value to answer with instead of running the handler (the pending
 * action from `ctx.pending.create`), or `undefined` to run it. Until M14 stores pending actions,
 * `create` throws, so a call that needs approval fails closed rather than running unapproved.
 */
export async function gateApproval(
  def: ToolDef,
  args: unknown,
  ctx: ToolContext,
): Promise<unknown> {
  if (!def.approval) return undefined;
  if (!(await def.approval.when(args as never, ctx))) return undefined;
  const preview = await def.approval.preview(args as never, ctx);
  return ctx.pending.create({ tool: def.name, params: args, preview });
}
