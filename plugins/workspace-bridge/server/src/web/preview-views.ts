// The preview half of the approval page, as pure functions of plain data (like views.ts): a held
// email drawn the way it will arrive, and the key facts of every other kind of held action. The
// HTML of an email is sanitized by the route (`sanitize-html.ts`, which needs HTMLRewriter) and
// handed in as a string; it is shown only in a sandboxed iframe whose document carries its own
// Content-Security-Policy, so a miss in the sanitizer still cannot run a script or load anything.

import type { HeldMailView } from "../core/held-view";
import { html, type SafeHtml } from "./html";

/** The CSP the approval page sets on itself: the base policy, plus the one local frame it embeds. */
export const APPROVAL_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; base-uri 'none'; frame-src about:; frame-ancestors 'none'";

/** The CSP inside the iframe's own document (a srcdoc frame also inherits the page's): no loads. */
export const PREVIEW_FRAME_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

const FRAME_STYLE = [
  "html{background:#fff;color:#1b1f24;color-scheme:light}",
  "body{margin:0;padding:14px 16px;font:15px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;overflow-wrap:anywhere}",
  "img,table{max-width:100%}",
  "a{color:#1a56c4}",
  "blockquote{margin:.8em 0;padding-left:.9em;border-left:3px solid #c5ccd6;color:#4a5361}",
  ".blocked-image{display:inline-block;padding:0 .4em;border:1px dashed #8a94a3;border-radius:4px;color:#4a5361;font-size:.85em}",
  ".quoted{margin-top:1.2em;padding-top:.8em;border-top:1px solid #d5dae1}",
].join("");

/** The whole document of the preview frame around an already sanitized fragment. */
export function previewDocument(safeHtml: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PREVIEW_FRAME_CSP}"><meta name="color-scheme" content="light"><style>${FRAME_STYLE}</style></head><body>${safeHtml}</body></html>`;
}

export interface MailPreviewData {
  view: HeldMailView;
  /** The sanitized HTML part, if the message has one. */
  safeHtml: string | undefined;
  /** The sanitized HTML of the quoted original, if any. */
  safeQuoteHtml: string | undefined;
}

const bytesText = (n: number): string =>
  n < 1024
    ? `${n} B`
    : n < 1_048_576
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1_048_576).toFixed(1)} MB`;

const people = (label: string, list: readonly string[]): SafeHtml =>
  list.length === 0
    ? html``
    : html`<dt>${label}</dt><dd>${list.length === 1 ? list[0] : html`<ul>${list.map((x) => html`<li>${x}</li>`)}</ul>`}</dd>`;

function files(v: HeldMailView): SafeHtml {
  if (v.files.length === 0 && !v.fileCount) return html``;
  if (v.files.length === 0) {
    return html`<dt>Attachments</dt><dd>${v.fileCount} file${v.fileCount === 1 ? "" : "s"}${typeof v.fileBytes === "number" ? `, about ${bytesText(v.fileBytes)}` : ""}</dd>`;
  }
  return html`<dt>Attachments</dt><dd><ul class="mail-files">${v.files.map(
    (f) =>
      html`<li>${f.name === "" ? "(unnamed)" : f.name} <span class="muted">(${f.type === "" ? "file" : f.type}, about ${bytesText(f.bytes)}${f.carried ? ", from the original message" : ""})</span></li>`,
  )}</ul></dd>`;
}

function mailBody(m: MailPreviewData): SafeHtml {
  const v = m.view;
  if (v.bodyUnavailable && v.body === "" && m.safeHtml === undefined) {
    return html`<p class="muted">The text of this draft could not be read here. It is sent exactly as it is in Gmail.</p>`;
  }
  if (m.safeHtml !== undefined) {
    const inner = `${m.safeHtml}${m.safeQuoteHtml ? `<div class="quoted">${m.safeQuoteHtml}</div>` : ""}`;
    return html`<iframe class="mail-frame" sandbox="" referrerpolicy="no-referrer" title="The message body" srcdoc="${previewDocument(inner)}"></iframe>`;
  }
  return html`<div class="mail-text">${v.body === "" ? html`<span class="muted">(no text)</span>` : v.body}</div>${
    v.quote && v.quote.plain !== ""
      ? html`<div class="mail-text mail-quote">${v.quote.plain}</div>`
      : ""
  }`;
}

/** The held email as it will arrive: header block, files, then the body. */
export function mailPreviewView(m: MailPreviewData): SafeHtml {
  const v = m.view;
  const what = v.action === "reply" ? "reply" : v.action === "forward" ? "forward" : "email";
  return html`<section class="card mail-preview">
<h2>The ${what} as it will arrive</h2>
<dl class="facts mail-head">
<dt>From</dt><dd>${v.from}</dd>
${people("To", v.to)}${people("Cc", v.cc)}${people("Bcc", v.bcc)}
<dt>Subject</dt><dd class="subject">${v.subject === "" ? "(no subject)" : v.subject}</dd>
${files(v)}
</dl>
${v.bcc.length > 0 ? html`<p class="muted mail-note">Bcc recipients are hidden from the others.</p>` : ""}
${mailBody(m)}
${v.truncated.length > 0 ? html`<p class="callout callout-info"><strong>Shortened here.</strong> Only the start of the ${v.truncated.map((t) => (t === "html" ? "HTML" : t === "body" ? "text" : "quoted original")).join(" and ")} is kept for this preview. The full message is what is sent (see Details).</p>` : ""}
${v.quoteUnavailable ? html`<p class="muted mail-note">The ${v.action === "forward" ? "forwarded" : "quoted"} original could not be read for this preview. It is added when the message is sent.</p>` : ""}
</section>`;
}

// ---- other kinds of held action ----

export interface FactRow {
  label: string;
  values: string[];
}

const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/** A preview field as lines of text: a string, a number, yes or no, a list of those, or an object's entries. */
export function valuesOf(v: unknown): string[] {
  if (typeof v === "string") return v === "" ? [] : [v];
  if (typeof v === "number") return [String(v)];
  if (typeof v === "boolean") return [v ? "yes" : "no"];
  if (Array.isArray(v)) return v.flatMap((x) => valuesOf(x).slice(0, 1));
  const o = record(v);
  if (o) {
    return Object.entries(o).flatMap(([k, x]) => {
      const inner = valuesOf(x);
      return inner.length === 0 ? [] : [`${k}: ${inner.join(", ")}`];
    });
  }
  return [];
}

type FieldMap = readonly (readonly [label: string, key: string])[];

const CALENDAR_TOOLS: Readonly<Record<string, string>> = {
  create_event: "Create an event",
  update_event: "Update an event",
  delete_event: "Delete an event",
  respond_to_event: "Respond to an event invitation",
};

const FIELDS: Readonly<Record<string, FieldMap>> = {
  share_file: [
    ["What", "action"],
    ["File", "fileId"],
    ["Who gets access", "to"],
    ["Role", "role"],
  ],
  share_calendar: [
    ["What", "action"],
    ["Calendar", "calendarId"],
    ["Who gets access", "to"],
    ["Role", "role"],
    ["Google emails them", "notify"],
  ],
  create_filter: [["What", "summary"]],
};

const CALENDAR_FIELDS: FieldMap = [
  ["What", "action"],
  ["Calendar", "calendarId"],
  ["Event", "eventId"],
  ["Google emails", "to"],
  ["Notification level", "notify"],
  ["Includes your comment", "withComment"],
];

function filterRows(preview: Record<string, unknown>): FactRow[] {
  const rows: FactRow[] = [];
  const criteria = valuesOf(preview.criteria);
  if (criteria.length > 0) rows.push({ label: "Mail that matches", values: criteria });
  const action = record(preview.action);
  if (action) {
    const forward = valuesOf(action.forward);
    if (forward.length > 0) rows.push({ label: "Forwards it to", values: forward });
    const labels: [string, string][] = [
      ["Adds labels", "addLabelIds"],
      ["Removes labels", "removeLabelIds"],
    ];
    for (const [label, key] of labels) {
      const v = valuesOf(action[key]);
      if (v.length > 0) rows.push({ label, values: v });
    }
    const rest = Object.fromEntries(
      Object.entries(action).filter(
        ([k]) => !["forward", "addLabelIds", "removeLabelIds"].includes(k),
      ),
    );
    const other = valuesOf(rest);
    if (other.length > 0) rows.push({ label: "Also", values: other });
  }
  return rows;
}

/**
 * The key facts of a held action that is not an email, as labelled rows: who gets access, which
 * item, what role, what a filter forwards and where. Works from the preview the tool stored, and
 * for a tool or shape it does not know it lists the preview's own fields.
 */
export function previewFactRows(tool: string, preview: unknown): FactRow[] {
  const p = record(preview);
  if (!p) return [];
  const map = Object.hasOwn(FIELDS, tool)
    ? FIELDS[tool]
    : Object.hasOwn(CALENDAR_TOOLS, tool)
      ? CALENDAR_FIELDS
      : undefined;
  if (!map) return [];
  const rows: FactRow[] = [];
  for (const [label, key] of map) {
    const values = valuesOf(p[key]);
    if (values.length > 0 && !(key === "withComment" && p[key] === false)) {
      rows.push({ label, values });
    }
  }
  if (tool === "create_filter") rows.push(...filterRows(p));
  if (Object.hasOwn(CALENDAR_TOOLS, tool) && !rows.some((r) => r.label === "What")) {
    rows.unshift({ label: "What", values: [CALENDAR_TOOLS[tool] ?? tool] });
  }
  return rows;
}

export function factRowsView(rows: readonly FactRow[]): SafeHtml {
  return html`${rows.map((r) =>
    r.values.length === 1
      ? html`<dt>${r.label}</dt><dd>${r.values[0]}</dd>`
      : html`<dt>${r.label}</dt><dd><ul>${r.values.map((x) => html`<li>${x}</li>`)}</ul></dd>`,
  )}`;
}
