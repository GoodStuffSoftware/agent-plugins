// The one HTTP client for Google APIs (ARCHITECTURE s.3.3, s.3.6): the bearer token from the
// broker, `fields=` and query parameters, the 401 refresh-and-retry contract, one retry on 5xx,
// and the mapping of Google's answers to tool errors. Google response bodies are read only to
// classify a 403 or 429; no body text, token or mail content ever reaches an error message.

import { accountState } from "../../core/accounts";
import { ToolError } from "../../core/errors";
import { accountKey } from "../../core/ids";
import { createTokenBroker } from "../../core/token-broker";
import { config } from "../../env";
import type { AccountRef } from "../../services/types";
import { type AccountComponent, grantedComponents, parseScopes } from "./base";

/** Per attempt, until the response headers arrive (and the body, when read in time). */
export const GOOGLE_TIMEOUT_MS = 10_000;
/** Pause before the one retry after a 5xx. */
export const RETRY_DELAY_MS = 250;
/** `retryAfterSeconds` when Google sends no usable `Retry-After`. */
export const DEFAULT_RETRY_AFTER_SECONDS = 30;
const MAX_RETRY_AFTER_SECONDS = 3600;

export interface GoogleInit {
  /** `GET` by default. */
  method?: string;
  headers?: Record<string, string>;
  /** Sent as JSON, with `Content-Type: application/json`. */
  json?: unknown;
  /**
   * A raw body, such as a `multipart/mixed` batch or an upload; set its `Content-Type` in
   * `headers`. It is sent again on a retry, so streams are not accepted.
   */
  body?: string | ArrayBuffer | ArrayBufferView | Blob | URLSearchParams | FormData;
}

export type QueryValue = string | number | boolean | readonly string[] | null | undefined;

export interface GoogleFetchOptions {
  /** Partial response: sent as `fields=`. */
  fields?: string;
  /** Query parameters; `null` and `undefined` are skipped, an array adds one per item. */
  query?: Readonly<Record<string, QueryValue>>;
  /**
   * The account component the request needs, which decides whether a Google 403 "insufficient
   * permissions" is `component_disabled` (never granted) or `needs_relink`. Taken from the URL
   * when omitted: Gmail is `mail` (`.../messages/send` and `.../drafts/send` are `mail.send`),
   * Calendar `calendar`, Drive `files`, People `contacts`.
   */
  component?: AccountComponent;
  /**
   * Retry once after a 5xx. On by default for every method except POST: a POST that creates or
   * sends could take effect twice, so an idempotent POST (Gmail `modify`, `batchModify`, a
   * read-only batch) opts in with `retry: true`.
   */
  retry?: boolean;
}

/**
 * Calls a Google API for an account resolved through `ctx.accounts` in this call, and returns the
 * 2xx response for the caller to read (`gjson` for JSON). Throws a `ToolError` otherwise:
 * - 401: invalidates the token, gets a fresh one from the broker and retries once; a second 401
 *   is `needs_relink`. Broker errors (`needs_relink`, `upstream_error`, ...) pass through.
 * - 403 insufficient permissions: `component_disabled` when the account's stored scopes never
 *   covered the component, else `needs_relink`. 403 rate limit and 429: `rate_limited` with
 *   `retryAfterSeconds`. 404: `not_found`. 400: `invalid_argument`. 5xx: one retry (see
 *   `retry`), then `upstream_error` with `status`. A timeout or network failure is
 *   `upstream_error` without `status`, never retried. Redirects are not followed.
 * Only `https://*.googleapis.com` URLs are accepted, so the token cannot be sent anywhere else.
 */
export async function gfetch(
  account: AccountRef,
  url: string | URL,
  init: GoogleInit = {},
  opts: GoogleFetchOptions = {},
): Promise<Response> {
  const state = accountState(account);
  if (!state) throw new Error("gfetch: the account was not resolved through ctx.accounts");
  if (state.row.provider !== "google") throw new Error("gfetch: not a Google account");
  const target = googleUrl(url, opts);
  // The component is checked here too, so an implementation handed one account cannot reach
  // another account's API past a switched-off component.
  const component = opts.component ?? componentOf(target);
  if (component && !state.components.includes(component)) {
    const accountsUrl = `${config(state.env).issuer}/accounts`;
    throw new ToolError(
      "component_disabled",
      `The ${component} component is off for account ${accountKey(account.shortId)}. Switch it on at ${accountsUrl}.`,
      { component, accountsUrl },
    );
  }
  const method = (init.method ?? "GET").toUpperCase();
  const retry5xx = opts.retry ?? method !== "POST";
  const broker = createTokenBroker(state.env);
  // The stored row, not the ref's fields, decides whose token is used.
  const who = { ownerId: state.row.owner_id, accountId: state.row.id };

  let token = await broker.accessToken(who);
  let refreshed = false;
  let retried = false;
  for (;;) {
    const res = await send(target, method, init, token);
    if (res.ok) return res;
    if (res.status === 401 && !refreshed) {
      await discard(res);
      broker.invalidate(who);
      refreshed = true;
      token = await broker.accessToken(who);
      continue;
    }
    if (res.status >= 500 && retry5xx && !retried) {
      await discard(res);
      retried = true;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      continue;
    }
    // Only a 403 or 429 body is read, and only for Google's reasons.
    let body = "";
    if (res.status === 403 || res.status === 429) body = await res.text().catch(() => "");
    else await discard(res);
    throw googleError(account, res.status, res.headers, body, {
      component: opts.component ?? componentOf(target),
    });
  }
}

/** `gfetch` and the parsed JSON body; `undefined` for an empty body (204). */
export async function gjson<T>(
  account: AccountRef,
  url: string | URL,
  init: GoogleInit = {},
  opts: GoogleFetchOptions = {},
): Promise<T> {
  const res = await gfetch(account, url, init, opts);
  let text: string;
  try {
    text = await res.text();
  } catch {
    throw new ToolError("upstream_error", "Google's reply did not arrive in time.");
  }
  if (text === "") return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ToolError("upstream_error", "Google sent a reply that is not valid JSON.", {
      status: res.status,
    });
  }
}

/**
 * The tool error for a non-2xx Google answer, also for the parts of a batch reply. `body` is read
 * only for the reasons Google gives (`error.errors[].reason`, `error.details[].reason`,
 * `error.status`) and never copied into the error. A 401 here is final (`needs_relink`): the
 * refresh-and-retry happens in `gfetch`.
 */
export function googleError(
  account: AccountRef,
  status: number,
  headers: Headers,
  body: string,
  opts: { component?: AccountComponent } = {},
): ToolError {
  const state = accountState(account);
  const issuer = state ? config(state.env).issuer : "";
  const accountsUrl = `${issuer}/accounts`;
  const who = `account ${accountKey(account.shortId)}`;

  if (status === 401) {
    return new ToolError(
      "needs_relink",
      `Google no longer accepts the access of ${who}. Link it again at ${accountsUrl}.`,
      { linkUrl: accountsUrl },
    );
  }
  if (status === 403 || status === 429) {
    const reasons = errorReasons(headers, body);
    const rateLimited = status === 429 || [...reasons].some((r) => RATE_REASONS.has(r));
    if (rateLimited) {
      const retryAfterSeconds = retryAfter(headers.get("Retry-After"));
      return new ToolError(
        "rate_limited",
        `Google is limiting requests for ${who}; try again in ${retryAfterSeconds} seconds.`,
        { retryAfterSeconds },
      );
    }
    if ([...reasons].some((r) => SCOPE_REASONS.has(r))) {
      const component = opts.component;
      const granted = parseScopes(state?.row.granted_scopes);
      if (component && !grantedComponents([component], granted).includes(component)) {
        return new ToolError(
          "component_disabled",
          `The ${component} component was never granted for ${who}. Switch it on at ${accountsUrl}.`,
          { component, accountsUrl },
        );
      }
      return new ToolError(
        "needs_relink",
        `Google says ${who} lacks a permission this call needs. Link it again at ${accountsUrl}.`,
        { linkUrl: accountsUrl },
      );
    }
    return new ToolError("upstream_error", `Google refused the request for ${who} (HTTP 403).`, {
      status,
    });
  }
  if (status === 404) {
    return new ToolError("not_found", `Google found no such item in ${who}.`);
  }
  if (status === 400) {
    return new ToolError("invalid_argument", "Google rejected the request as invalid.", {
      status,
    });
  }
  if (status >= 500) {
    return new ToolError("upstream_error", `Google failed to answer (HTTP ${status}).`, {
      status,
    });
  }
  return new ToolError("upstream_error", `Google answered HTTP ${status}.`, { status });
}

/** Gmail `mail` (sending `mail.send`), Calendar, Drive and People; undefined for other APIs. */
export function componentOf(url: URL): AccountComponent | undefined {
  const path = url.pathname;
  if (url.hostname === "gmail.googleapis.com" || /\/gmail\/v1(\/|$)/.test(path)) {
    return /\/(messages|drafts)\/send$/.test(path) ? "mail.send" : "mail";
  }
  if (/\/calendar\/v3(\/|$)/.test(path)) return "calendar";
  if (/\/drive\/v[23](\/|$)/.test(path)) return "files";
  if (url.hostname === "people.googleapis.com") return "contacts";
  return undefined;
}

// Reasons Google gives for a rate or quota limit (403 or 429) and for a token without the scope.
const RATE_REASONS: ReadonlySet<string> = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "sharingRateLimitExceeded",
  "quotaExceeded",
  "dailyLimitExceeded",
  "RATE_LIMIT_EXCEEDED",
  "RESOURCE_EXHAUSTED",
]);
const SCOPE_REASONS: ReadonlySet<string> = new Set([
  "insufficientPermissions",
  "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
  "insufficient_scope",
]);

function googleUrl(url: string | URL, opts: GoogleFetchOptions): URL {
  const target = new URL(url);
  const host = target.hostname;
  if (
    target.protocol !== "https:" ||
    !(host === "googleapis.com" || host.endsWith(".googleapis.com"))
  ) {
    throw new Error("gfetch: refusing a URL that is not a Google API");
  }
  for (const [name, value] of Object.entries(opts.query ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const item of value) target.searchParams.append(name, item);
    else target.searchParams.append(name, String(value));
  }
  if (opts.fields !== undefined) target.searchParams.set("fields", opts.fields);
  return target;
}

async function send(url: URL, method: string, init: GoogleInit, token: string): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  let body: GoogleInit["body"] = init.body;
  if (init.json !== undefined) {
    body = JSON.stringify(init.json);
    headers.set("Content-Type", "application/json");
  }
  try {
    return await fetch(url, {
      method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw new ToolError(
      "upstream_error",
      timedOut
        ? `Google did not answer within ${GOOGLE_TIMEOUT_MS / 1000} seconds.`
        : "Google could not be reached.",
    );
  }
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Nothing to free.
  }
}

/** The reasons in a Google error body and an `insufficient_scope` challenge header. */
function errorReasons(headers: Headers, body: string): Set<string> {
  const out = new Set<string>();
  if (/insufficient_scope/i.test(headers.get("WWW-Authenticate") ?? "")) {
    out.add("insufficient_scope");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return out;
  }
  const error = (parsed as { error?: unknown } | null)?.error;
  if (!error || typeof error !== "object") return out;
  const { status, errors, details } = error as Record<string, unknown>;
  if (typeof status === "string") out.add(status);
  for (const list of [errors, details]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const reason = (item as { reason?: unknown } | null)?.reason;
      if (typeof reason === "string") out.add(reason);
    }
  }
  return out;
}

/** `Retry-After` in seconds (delta or HTTP date), clamped to 1..3600; else the default. */
function retryAfter(header: string | null): number {
  const value = (header ?? "").trim();
  let seconds = Number.NaN;
  if (/^\d+$/.test(value)) seconds = Number(value);
  else if (value !== "") {
    const at = Date.parse(value);
    if (!Number.isNaN(at)) seconds = Math.ceil((at - Date.now()) / 1000);
  }
  if (!Number.isFinite(seconds)) return DEFAULT_RETRY_AFTER_SECONDS;
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, seconds));
}
