// The contract every tool is written against (ARCHITECTURE s.3.1, s.3.2).

import type { ToolAnnotations } from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { Kind, Scope } from "../auth/endpoints";
import type { AccountResolver } from "../core/accounts";
import type { AuditLog } from "../core/audit";
import type { CursorCodec } from "../core/cursor";
import type { IdCodec } from "../core/ids";
import type { PendingActions } from "../core/pending";
import type { RateLimiter } from "../core/ratelimit";
import type { SendAsCache } from "../core/send-as";
import type { Untrusted } from "../core/untrusted";
import type { Env } from "../env";
import type { Binding, Capability } from "../services/capability";
import type { AccountRef, ProviderId } from "../services/types";

export type { Kind, Scope } from "../auth/endpoints";

export type Component = "mail" | "calendar" | "files" | "contacts" | "admin";

/** The OAuth grant behind the request. `scopes` holds only this endpoint's scopes. */
export interface Grant {
  readonly clientId: string;
  readonly grantId: string;
  readonly scopes: readonly Scope[];
}

/** A call held for approval, as `approval.onHeld` sees it once the pending action exists. */
export interface HeldAction {
  readonly pendingActionId: string;
  /** The one account the action is bound to. */
  readonly account: AccountRef;
  readonly preview: unknown;
}

/** What a handler gets besides its arguments (s.3.2). A new one per tool call. */
export interface ToolContext {
  readonly kind: Kind;
  /** From the token's props, never from arguments. */
  readonly ownerId: string;
  readonly grant: Grant;
  /** The issuer, for approval and link URLs. */
  readonly publicUrl: string;
  readonly env: Env;
  /** Milliseconds; tests inject a clock. */
  readonly now: () => number;
  /** One nonce per tool call (s.3.7). */
  readonly untrusted: Untrusted;
  /** The owner's accounts, read once per call (s.3.4). Pass the refs it returns as they are. */
  readonly accounts: AccountResolver;
  /**
   * The account's implementation of `cap`. Throws `component_disabled` (`{ component,
   * accountsUrl }`) when the capability's component is off for the account, then
   * `not_supported_by_provider` (`{ capability, provider }`) when its provider has no binding.
   * `a` must come from `accounts.resolve` in this call.
   */
  use<T>(cap: Capability<T>, a: AccountRef): T;
  readonly ids: IdCodec;
  readonly cursors: CursorCodec;
  readonly sendAs: SendAsCache;
  readonly audit: AuditLog;
  readonly limits: RateLimiter;
  readonly pending: PendingActions;
  waitUntil(p: Promise<unknown>): void;
}

export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  /** snake_case; the official name where one exists. */
  name: string;
  title?: string;
  /** `UNTRUSTED_NOTE` is appended when `untrusted` is true. */
  description: string;
  /** `null`: account and meta tools, no component check. */
  component: Component | null;
  /** All required; `[]` means any valid grant. */
  scopes: readonly Scope[];
  /** Registered only on these endpoints. */
  endpoints: readonly Kind[];
  annotations: ToolAnnotations;
  /** zod v4 object with camelCase keys. Its JSON Schema is computed once per isolate. */
  input: S;
  /** The output carries third-party text. */
  untrusted?: boolean;
  approval?: {
    /**
     * Whether this call is held. It also runs the cheap checks that need no Google call, before
     * anything is queued: an error it throws refuses the call and nothing is queued or audited as held.
     */
    when(args: z.output<S>, ctx: ToolContext): boolean | Promise<boolean>;
    preview(args: z.output<S>, ctx: ToolContext): unknown;
    /**
     * Runs once the pending action exists, never when creating it failed (the 50-open cap, a
     * rate limit, too large): the place for a "held" audit row that names `pendingActionId`. The
     * hold stands whatever it does; an error it throws is logged, not returned to the caller.
     */
    onHeld?(args: z.output<S>, ctx: ToolContext, held: HeldAction): void | Promise<void>;
  };
  /** Returns a JSON-serialisable value; throws `ToolError` for an expected failure. */
  handler(args: z.output<S>, ctx: ToolContext): Promise<unknown>;
}

export interface Family {
  /** For example `mail.labels`. */
  id: string;
  tools: readonly ToolDef[];
  /** Capability implementations per provider (s.3.6). */
  bindings: Readonly<Partial<Record<ProviderId, readonly Binding[]>>>;
  /** Official tool names not built yet (s.5). Only shrinks. */
  parityPending: readonly string[];
}

/** Identity helper that infers a tool's argument type from its `input` schema. */
export function defineTool<S extends z.ZodObject>(def: ToolDef<S>): ToolDef<S> {
  return def;
}
