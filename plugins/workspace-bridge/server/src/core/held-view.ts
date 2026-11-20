// What the approval page needs to show a held email as it will arrive (the "view" of a hold): the
// resolved From, every recipient, the body in both forms, the quoted original of a reply or a
// forward and the file names. It is stored inside the pending action's `preview` JSON under
// `VIEW_KEY` (no schema change), is never returned to the MCP client (the client already knows
// what it sent, and a quoted original is third-party text), and is read back only by the owner's
// approval page. Stored sizes are capped; a clipped part is named in `truncated`.

/** The reserved key of the view inside the stored preview JSON. */
export const VIEW_KEY = "_view";

/** Characters kept of the plain text body, of the HTML body and of each part of a quote. */
export const MAX_VIEW_TEXT = 50_000;
export const MAX_VIEW_HTML = 100_000;
export const MAX_VIEW_QUOTE_TEXT = 20_000;
export const MAX_VIEW_QUOTE_HTML = 60_000;
/** A view larger than this (serialized) is dropped whole; the page then falls back to the preview. */
export const MAX_VIEW_JSON = 400_000;

export type HeldMailAction = "send" | "reply" | "forward";

export interface HeldMailFile {
  name: string;
  type: string;
  bytes: number;
  /** A file of the original message that a forward carries along. */
  carried?: boolean;
}

/** Which stored part was clipped. */
export type HeldClip = "body" | "html" | "quote";

export interface HeldMailView {
  v: 1;
  kind: "mail";
  action: HeldMailAction;
  /** The send-as address the message will go out from, as `Name <address>` or the bare address. */
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  /** The plain text part. */
  body: string;
  /** The HTML part as the caller wrote it; sanitized only when the page renders it. */
  html?: string;
  /** The quoted or forwarded original of a reply or forward. */
  quote?: { plain: string; html: string };
  /** The files, with names; a held draft only has `fileCount` and `fileBytes`. */
  files: HeldMailFile[];
  fileCount?: number;
  fileBytes?: number;
  /** A held draft's body is read from Gmail; true when that failed and no text is shown. */
  bodyUnavailable?: boolean;
  /** The original of a reply or forward could not be read, so no quote is shown. */
  quoteUnavailable?: boolean;
  truncated: HeldClip[];
}

const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** `text` cut to `max` characters (no split surrogate pair), and whether it was cut. */
export function clip(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), cut: true };
}

/** As `clip`, for markup: an unfinished tag at the cut is dropped too. */
export function clipHtml(text: string, max: number): { text: string; cut: boolean } {
  const c = clip(text, max);
  return c.cut ? { text: c.text.replace(/<[^>]*$/, ""), cut: true } : c;
}

/** The view of a stored preview JSON, or undefined (an old row, or a hold with no view). */
export function parseHeldView(previewJson: string): HeldMailView | undefined {
  let v: unknown;
  try {
    v = (JSON.parse(previewJson) as Record<string, unknown> | null)?.[VIEW_KEY];
  } catch {
    return undefined;
  }
  if (v === null || typeof v !== "object") return undefined;
  const m = v as Record<string, unknown>;
  if (m.v !== 1 || m.kind !== "mail") return undefined;
  if (typeof m.from !== "string" || typeof m.subject !== "string" || typeof m.body !== "string") {
    return undefined;
  }
  if (!isStrings(m.to) || !isStrings(m.cc) || !isStrings(m.bcc)) return undefined;
  const action = m.action === "reply" || m.action === "forward" ? m.action : "send";
  const files = Array.isArray(m.files)
    ? m.files.flatMap((f): HeldMailFile[] => {
        const o = f as Record<string, unknown> | null;
        if (o === null || typeof o !== "object" || typeof o.name !== "string") return [];
        return [
          {
            name: o.name,
            type: typeof o.type === "string" ? o.type : "",
            bytes: typeof o.bytes === "number" ? o.bytes : 0,
            ...(o.carried === true ? { carried: true } : {}),
          },
        ];
      })
    : [];
  const q = m.quote as Record<string, unknown> | null | undefined;
  const quote =
    q && typeof q === "object" && typeof q.plain === "string" && typeof q.html === "string"
      ? { plain: q.plain, html: q.html }
      : undefined;
  const clips = Array.isArray(m.truncated)
    ? m.truncated.filter((x): x is HeldClip => x === "body" || x === "html" || x === "quote")
    : [];
  return {
    v: 1,
    kind: "mail",
    action,
    from: m.from,
    to: m.to,
    cc: m.cc,
    bcc: m.bcc,
    subject: m.subject,
    body: m.body,
    ...(typeof m.html === "string" ? { html: m.html } : {}),
    ...(quote ? { quote } : {}),
    files,
    ...(typeof m.fileCount === "number" ? { fileCount: m.fileCount } : {}),
    ...(typeof m.fileBytes === "number" ? { fileBytes: m.fileBytes } : {}),
    ...(m.bodyUnavailable === true ? { bodyUnavailable: true } : {}),
    ...(m.quoteUnavailable === true ? { quoteUnavailable: true } : {}),
    truncated: clips,
  };
}

/** The stored preview with the view removed: what the MCP client and `get_pending_action` see. */
export function withoutView(preview: unknown): unknown {
  if (preview === null || typeof preview !== "object" || Array.isArray(preview)) return preview;
  if (!Object.hasOwn(preview, VIEW_KEY)) return preview;
  const { [VIEW_KEY]: _view, ...rest } = preview as Record<string, unknown>;
  return rest;
}

/** The preview as stored: the client-visible summary plus the page's view. */
export function withView(preview: unknown, view: unknown): unknown {
  if (view === undefined || view === null) return preview;
  if (preview === null || typeof preview !== "object" || Array.isArray(preview)) return preview;
  let size: number;
  try {
    size = JSON.stringify(view)?.length ?? 0;
  } catch {
    return preview;
  }
  if (size > MAX_VIEW_JSON) return preview;
  return { ...(preview as Record<string, unknown>), [VIEW_KEY]: view };
}

/** What a tool knows about the message it holds, uncut. */
export interface HeldMailInput {
  action: HeldMailAction;
  from: string;
  to: readonly string[];
  cc: readonly string[];
  bcc: readonly string[];
  subject: string;
  body: string;
  html?: string | undefined;
  quote?: { plain: string; html: string } | undefined;
  files?: readonly HeldMailFile[] | undefined;
  fileCount?: number | undefined;
  fileBytes?: number | undefined;
  bodyUnavailable?: boolean | undefined;
  quoteUnavailable?: boolean | undefined;
}

/** The stored view of a held email: sizes capped, each cut part named in `truncated`. */
export function buildHeldMailView(m: HeldMailInput): HeldMailView {
  const truncated: HeldClip[] = [];
  const body = clip(m.body, MAX_VIEW_TEXT);
  if (body.cut) truncated.push("body");
  const htmlPart = m.html === undefined ? undefined : clipHtml(m.html, MAX_VIEW_HTML);
  if (htmlPart?.cut) truncated.push("html");
  let quote: HeldMailView["quote"];
  if (m.quote) {
    const plain = clip(m.quote.plain, MAX_VIEW_QUOTE_TEXT);
    const markup = clipHtml(m.quote.html, MAX_VIEW_QUOTE_HTML);
    quote = { plain: plain.text, html: markup.text };
    if (plain.cut || markup.cut) truncated.push("quote");
  }
  return {
    v: 1,
    kind: "mail",
    action: m.action,
    from: m.from,
    to: [...m.to],
    cc: [...m.cc],
    bcc: [...m.bcc],
    subject: m.subject,
    body: body.text,
    ...(htmlPart ? { html: htmlPart.text } : {}),
    ...(quote ? { quote } : {}),
    files: [...(m.files ?? [])],
    ...(m.fileCount === undefined ? {} : { fileCount: m.fileCount }),
    ...(m.fileBytes === undefined ? {} : { fileBytes: m.fileBytes }),
    ...(m.bodyUnavailable ? { bodyUnavailable: true } : {}),
    ...(m.quoteUnavailable ? { quoteUnavailable: true } : {}),
    truncated,
  };
}
