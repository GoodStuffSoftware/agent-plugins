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
  let text: string;
  try {
    text = JSON.stringify({ error });
  } catch {
    text = JSON.stringify({ error: { code: "internal", message: INTERNAL_MESSAGE } });
  }
  return { isError: true, content: [{ type: "text", text }] };
}

/** Longest message an internal-error log line keeps. */
const LOG_MESSAGE_MAX = 200;
const MAX_ARG_VALUES = 200;

/** The string (and long number) values in the call's arguments, longest first. */
function argValues(args: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number): void => {
    if (out.size >= MAX_ARG_VALUES || depth > 8) return;
    if (typeof v === "string") {
      if (v.length >= 3) out.add(v);
    } else if (typeof v === "number" || typeof v === "bigint") {
      const s = String(v);
      if (s.length >= 4) out.add(s);
    } else if (v && typeof v === "object") {
      for (const x of Object.values(v)) walk(x, depth + 1);
    }
  };
  walk(args, 0);
  return [...out].sort((a, b) => b.length - a.length);
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * An error message with nothing of the caller's or Google's left in it: every argument value,
 * then braces and brackets (JSON bodies), quoted text, email addresses and long token-like runs
 * are cut out, whitespace is collapsed and the result is cut at 200 characters.
 */
export function redactMessage(message: string, args?: unknown): string {
  let m = message;
  for (const v of argValues(args)) m = m.replace(new RegExp(escapeRegExp(v), "gi"), "[arg]");
  m = m
    .replace(/\{[\s\S]*\}/g, "{...}")
    .replace(/\[(?!arg\])[\s\S]*\]/g, "[...]")
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '"..."')
    .replace(/[^\s@<>()"',;:]+@[^\s@<>()"',;:]+/g, "[email]")
    .replace(/[A-Za-z0-9._~+/=-]{16,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return m.length > LOG_MESSAGE_MAX ? `${m.slice(0, LOG_MESSAGE_MAX)}...` : m;
}

/**
 * The one structured log line for an error that is not a `ToolError` (s.3.3): the tool name, the
 * error class and the redacted message. No arguments, no response bodies, no tokens, no stack.
 */
export function internalErrorLine(tool: string, e: unknown, args?: unknown): string {
  const name = e instanceof Error ? e.name : typeof e;
  const errorClass = /^[A-Za-z0-9_$.]{1,64}$/.test(name) ? name : "Error";
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return JSON.stringify({
    event: "tool_internal_error",
    tool,
    errorClass,
    message: redactMessage(String(raw), args),
  });
}

/** A successful call: one text block of compact JSON, no `structuredContent` in v1. */
export function okResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value ?? null) ?? "null" }] };
}
