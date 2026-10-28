// Tool errors and the result shape every tool call returns (ARCHITECTURE s.3.3).

import type { CallToolResult } from "@modelcontextprotocol/server";

/** Codes a tool error may carry. HTTP-level outcomes (401, 403, InvalidParams) are not here. */
export const ERROR_CODES = [
  "invalid_argument",
  "account_not_found",
  "ambiguous_account",
  "component_disabled",
  "not_supported_by_provider",
  "needs_relink",
  "rate_limited",
  "send_disabled",
  "sender_not_allowed",
  "too_many_recipients",
  "too_large",
  "not_found",
  "upstream_error",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** What the client reads for any exception that is not a `ToolError`. */
export const INTERNAL_MESSAGE = "Internal error. The request was not completed.";

/**
 * The one error a handler throws on purpose. `message` and `details` reach the client as they
 * are, so they must never carry a Google response body, a token or a stack trace.
 */
export class ToolError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.details = details;
  }
}

/**
 * `{ isError: true, content: [{ type: "text", text: '{"error":{"code","message",...details}}' }] }`.
 * Anything other than a `ToolError` becomes `internal` with a fixed message: the raw message is
 * dropped, so Google error bodies and stack traces never reach the client.
 */
export function toToolResult(e: unknown): CallToolResult {
  const err = e instanceof ToolError ? e : new ToolError("internal", INTERNAL_MESSAGE);
  const error: Record<string, unknown> = { code: err.code, message: err.message, ...err.details };
  // `details` never overrides the code or the message.
  error.code = err.code;
  error.message = err.message;
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error }) }] };
}

/** A successful call: one text block of compact JSON, no `structuredContent` in v1. */
export function okResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value ?? null) ?? "null" }] };
}
