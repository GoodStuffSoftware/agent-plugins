// Builds the ToolContext per call (ARCHITECTURE s.3.2): accounts, `ctx.use`, ids, cursors, the
// untrusted wrapper and the guardrails (M14), and holds the wrapper hooks for
// the per-grant rate check and the approval gate.

import type { AuthInfo } from "@modelcontextprotocol/server";
import { endpointScopes, type Kind } from "../auth/endpoints";
import {
  type AccountResolver,
  accountState,
  createAccountResolver,
  loadAccountsWithState,
} from "../core/accounts";
import { createAuditLog } from "../core/audit";
import { cursors } from "../core/cursor";
import { internalErrorLine, ToolError } from "../core/errors";
import { sendHeldNotice } from "../core/held-notice";
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
  const ctx: ToolContext = {
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
    sendAs: createSendAsCache({ env, now, use: (cap, a) => ctx.use(cap, a) }),
    audit: createAuditLog({ env, ownerId, grant, now }),
    limits: createRateLimiter({ env, grant, now }),
    pending: createPendingActions({ env, ownerId, grant, kind: scope.kind, publicUrl, now }),
    waitUntil: (p) => scope.exec.waitUntil(p),
  };
  return ctx;
}

/** Per-grant call limit (`ctx.limits.call`): throws `rate_limited` when over. */
export async function checkRate(def: ToolDef, ctx: ToolContext): Promise<void> {
  await ctx.limits.call(def.name);
}

/**
 * Approval gate. Returns the value to answer with instead of running the handler (the pending
 * action from `ctx.pending.create`), or `undefined` to run it. `when` and `preview` see a resolver
 * that records the accounts they resolve; the action is bound to that account, and the approved
 * run sees only it. An action that resolves no account, or more than one, cannot be held (`internal`).
 */
export async function gateApproval(
  def: ToolDef,
  args: unknown,
  ctx: ToolContext,
): Promise<unknown> {
  if (!def.approval) return undefined;
  const seen = new Map<string, AccountRef>();
  const accounts: AccountResolver = {
    async resolve(selector, idPrefix, opts) {
      const found = await ctx.accounts.resolve(selector, idPrefix, opts);
      for (const a of found) seen.set(a.accountId, a);
      return found;
    },
  };
  const gated: ToolContext = { ...ctx, accounts };
  if (!(await def.approval.when(args as never, gated))) return undefined;
  const preview = await def.approval.preview(args as never, gated);
  const [account] = seen.values();
  if (seen.size !== 1 || !account) {
    throw new Error(`${def.name}: an action held for approval must address exactly one account`);
  }
  const held = await ctx.pending.create({ tool: def.name, account, params: args, preview });
  if (def.approval.onHeld) {
    // The action is queued and the caller must learn its id, so a failing hook is logged only.
    try {
      await def.approval.onHeld(args as never, ctx, {
        pendingActionId: held.pendingActionId,
        account,
        preview: held.preview,
      });
    } catch (e) {
      console.error(internalErrorLine(`${def.name} onHeld`, e, args));
    }
  }
  // The fast notice to the owner: after the row exists and the hold's own hook ran, and never
  // able to fail the hold.
  try {
    await sendHeldNotice(
      ctx,
      {
        tool: def.name,
        account,
        preview: held.preview,
        approvalUrl: held.approvalUrl,
        expiresAt: held.expiresAt,
      },
      held.pendingActionId,
    );
  } catch (e) {
    console.error(internalErrorLine(`${def.name} held notice`, e, {}));
  }
  return held;
}
