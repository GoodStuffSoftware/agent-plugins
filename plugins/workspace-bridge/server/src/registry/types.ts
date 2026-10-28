// The contract every tool is written against (ARCHITECTURE s.3.1, s.3.2).

import type { ToolAnnotations } from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { Kind, Scope } from "../auth/endpoints";
import type { Env } from "../env";

export type { Kind, Scope } from "../auth/endpoints";

export type Component = "mail" | "calendar" | "files" | "contacts" | "admin";

/** The OAuth grant behind the request. `scopes` holds only this endpoint's scopes. */
export interface Grant {
  readonly clientId: string;
  readonly grantId: string;
  readonly scopes: readonly Scope[];
}

/**
 * What a handler gets besides its arguments. M5 fields only; M9 adds `untrusted`, `accounts`,
 * `use`, `ids`, `cursors`, `sendAs`, `audit`, `limits` and `pending` (s.3.2).
 */
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
    when(args: z.output<S>, ctx: ToolContext): boolean | Promise<boolean>;
    preview(args: z.output<S>, ctx: ToolContext): unknown;
  };
  /** Returns a JSON-serialisable value; throws `ToolError` for an expected failure. */
  handler(args: z.output<S>, ctx: ToolContext): Promise<unknown>;
}

export interface Family {
  /** For example `mail.labels`. */
  id: string;
  tools: readonly ToolDef[];
  /**
   * Capability implementations per provider (s.3.6). Typed loosely until M9 adds
   * `services/{capability,types}.ts` and narrows it to `Partial<Record<ProviderId, readonly Binding[]>>`.
   */
  bindings: Readonly<Record<string, readonly unknown[]>>;
  /** Official tool names not built yet (s.5). Only shrinks. */
  parityPending: readonly string[];
}

/** Identity helper that infers a tool's argument type from its `input` schema. */
export function defineTool<S extends z.ZodObject>(def: ToolDef<S>): ToolDef<S> {
  return def;
}
