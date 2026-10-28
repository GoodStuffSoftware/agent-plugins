// Gmail batch requests (plan s.3.4): one `multipart/mixed` POST carries up to 100 GET
// sub-requests, which costs one subrequest against the Worker's cap instead of one per item.
// The request and the response are built and parsed with `indexOf` scans, so the work is linear.

import { hex, randomBytes } from "../../core/crypto";
import { ToolError } from "../../core/errors";
import type { AccountRef } from "../../services/types";
import { gfetch, googleError } from "./http";

export const GMAIL_BATCH_URL = "https://gmail.googleapis.com/batch/gmail/v1";
/** Gmail accepts at most 100 calls per batch. */
export const MAX_BATCH_ITEMS = 100;

/** One GET to send in a batch; `path` starts with `/gmail/v1/` and may carry a query. */
export interface BatchRequest {
  id: string;
  path: string;
}

/** One answer of a batch: the HTTP status of its sub-request and its raw body. */
export interface BatchPart {
  id: string;
  status: number;
  headers: Headers;
  body: string;
}

/** The `multipart/mixed` body for `requests`, with parts `Content-ID: <id>`. */
export function buildBatchBody(requests: readonly BatchRequest[], boundary: string): string {
  if (requests.length > MAX_BATCH_ITEMS) {
    throw new Error(`gmail batch: more than ${MAX_BATCH_ITEMS} items`);
  }
  let body = "";
  for (const r of requests) {
    if (
      !/^[A-Za-z0-9._-]+$/.test(r.id) ||
      !r.path.startsWith("/gmail/v1/") ||
      /[\r\n]/.test(r.path)
    ) {
      throw new Error("gmail batch: bad request");
    }
    body +=
      `--${boundary}\r\n` +
      "Content-Type: application/http\r\n" +
      `Content-ID: <${r.id}>\r\n\r\n` +
      `GET ${r.path}\r\n\r\n`;
  }
  return `${body}--${boundary}--\r\n`;
}

/** The `boundary` parameter of a `multipart/mixed` Content-Type header, or null. */
export function boundaryOf(contentType: string | null): string | null {
  const m = /boundary=(?:"([^"]{1,200})"|([^\s;]{1,200}))/i.exec(contentType ?? "");
  return m ? ((m[1] ?? m[2]) as string) : null;
}

/** Splits `head` (header lines) into a Headers object; lines without a colon are ignored. */
function parseHeaders(head: string): Headers {
  const headers = new Headers();
  for (const line of head.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    try {
      headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    } catch {
      // A header name or value Headers rejects is of no use to us.
    }
  }
  return headers;
}

/** The index just after the first blank line at or after `from`, and where that blank line starts. */
function blankLine(text: string, from: number): { start: number; after: number } | null {
  const crlf = text.indexOf("\r\n\r\n", from);
  const lf = text.indexOf("\n\n", from);
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) return { start: crlf, after: crlf + 4 };
  if (lf >= 0) return { start: lf, after: lf + 2 };
  return null;
}

/**
 * Parses a batch response body. A part is `application/http`: part headers (with `Content-ID:
 * <response-ID>`), a blank line, then the sub-response (status line, headers, blank line, body).
 * Parts that cannot be read are dropped, so the caller sees them as missing.
 */
export function parseBatchResponse(text: string, boundary: string): BatchPart[] {
  const parts: BatchPart[] = [];
  const delim = `--${boundary}`;
  let at = text.indexOf(delim);
  while (at >= 0) {
    const afterDelim = at + delim.length;
    if (text.startsWith("--", afterDelim)) break; // closing delimiter
    const next = text.indexOf(delim, afterDelim);
    const chunk = text.slice(afterDelim, next < 0 ? text.length : next);
    at = next;
    const split = blankLine(chunk, 0);
    if (!split) continue;
    const partHeaders = parseHeaders(chunk.slice(0, split.start));
    const rawId = /^<(?:response-)?(.{1,200})>$/.exec(partHeaders.get("content-id") ?? "")?.[1];
    if (!rawId) continue;
    const inner = chunk.slice(split.after);
    const statusEnd = inner.search(/\r?\n/);
    const status = /^HTTP\/[0-9.]+ (\d{3})/.exec(statusEnd < 0 ? inner : inner.slice(0, statusEnd));
    if (!status || statusEnd < 0) continue;
    const rest = inner.slice(statusEnd).replace(/^\r?\n/, "");
    const body = blankLine(rest, 0);
    const headers = parseHeaders(body ? rest.slice(0, body.start) : rest);
    // The part ends where the next delimiter's preceding line break begins.
    const payload = body ? rest.slice(body.after).replace(/\r?\n$/, "") : "";
    parts.push({ id: rawId, status: Number(status[1]), headers, body: payload });
  }
  return parts;
}

/**
 * Sends up to 100 GET sub-requests in one batch and returns the parts in request order. A
 * request with no readable answer is missing from the result. Sub-request statuses are not
 * checked here: see `batchError`.
 */
export async function gmailBatch(
  account: AccountRef,
  requests: readonly BatchRequest[],
): Promise<BatchPart[]> {
  if (requests.length === 0) return [];
  const boundary = `batch_${hex(randomBytes(12))}`;
  const res = await gfetch(
    account,
    GMAIL_BATCH_URL,
    {
      method: "POST",
      headers: { "Content-Type": `multipart/mixed; boundary=${boundary}` },
      body: buildBatchBody(requests, boundary),
    },
    // A batch of GETs changes nothing, so a 5xx may be retried.
    { retry: true, component: "mail" },
  );
  const responseBoundary = boundaryOf(res.headers.get("Content-Type"));
  if (!responseBoundary)
    throw new ToolError("upstream_error", "Google sent an unreadable batch reply.");
  let text: string;
  try {
    text = new TextDecoder().decode(await res.arrayBuffer());
  } catch {
    throw new ToolError("upstream_error", "Google's reply did not arrive in time.");
  }
  const byId = new Map(parseBatchResponse(text, responseBoundary).map((p) => [p.id, p]));
  return requests.flatMap((r) => {
    const part = byId.get(r.id);
    return part ? [part] : [];
  });
}

/** The tool error for a part that did not answer 2xx (the same mapping as a plain call). */
export function batchError(account: AccountRef, part: BatchPart): ToolError {
  return googleError(account, part.status, part.headers, part.body, { component: "mail" });
}

/** The JSON of a 2xx part; a body that is not JSON is `upstream_error`. */
export function batchJson<T>(account: AccountRef, part: BatchPart): T {
  if (part.status < 200 || part.status > 299) throw batchError(account, part);
  try {
    return JSON.parse(part.body) as T;
  } catch {
    throw new ToolError("upstream_error", "Google sent a reply that is not valid JSON.", {
      status: part.status,
    });
  }
}
