// The markup of every owner and public page, as pure functions of plain data. Route modules fetch
// the data and call these; scripts/snapshots.mjs calls them with sample data to render the pages
// to static files. No D1, no env, no request here, so it also runs under Node.
//
// Markup that tests and the forms depend on stays as it was: routes, field names, button values,
// `<td>` and `<dd>` contents. Only wrappers and CSS classes were added.

import type { AccountRow } from "../core/db";
import type { AllowKind } from "../core/send-allow";
import {
  ACCOUNT_COMPONENTS,
  type AccountComponent,
  excessScopes,
  parseScopes,
} from "../providers/google/base";
import { html, raw, type SafeHtml } from "./html";

/** `2026-10-29T14:03:20.000Z` as `2026-10-29 14:03 UTC`. */
const utc = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

// ---- notices and public pages ----

/** The body of a small result page; `back` adds a link to the accounts page. */
export function noticeView(title: string, message: string, back = false): SafeHtml {
  return html`<h1>${title}</h1><div class="card"><p>${message}</p>${back ? html`<p><a href="/accounts">Back to accounts</a></p>` : ""}</div>`;
}

const contactLine = (contact: string): SafeHtml | null =>
  contact === "" ? null : html`<p>Contact: ${contact}</p>`;

export function homeView(contact: string): SafeHtml {
  return html`<h1>workspace-bridge</h1>
<div class="card">
<p>A private MCP server that lets its owner's AI assistant work with the owner's Google mail,
calendar, files and contacts. Only the owner can sign in.</p>
<p><a href="/privacy">Privacy policy</a></p>
${contactLine(contact)}
</div>`;
}

export function privacyView(contact: string): SafeHtml {
  return html`<h1>Privacy policy</h1>
<div class="card">
<p>This server runs workspace-bridge, open-source software, for one owner. It connects the
owner's AI assistant to the Google accounts the owner links. It has no other users.</p>

<h2>What Google data it reads, and why</h2>
<ul>
<li>Sign-in: your Google account's email address and account id (<code>openid email</code>),
only to check that you are the owner.</li>
<li>Linked accounts, only for the parts the owner turns on for each account: Gmail messages,
drafts, labels, filters and send-as addresses (mail); Google Calendar calendars and events
(calendar); Google Drive files (files); Google Contacts (contacts).</li>
</ul>
<p>Data is read or changed only when the owner's AI assistant calls a tool on the owner's
behalf, and only to answer that call. Message bodies, events and file contents are passed
through to the assistant and not stored.</p>

<h2>What is stored</h2>
<p>Google access and refresh tokens are encrypted at rest with AES-256-GCM. The server also
keeps the linked addresses and the parts turned on for each, and a log of the actions it takes
(for example a sent message's recipients and subject, never its body).</p>

<h2>Sharing</h2>
<p>Nothing is shared with or sold to anyone, and nothing is used for advertising. Data goes
only to the AI assistant the owner connected. The use and transfer of information received
from Google APIs adheres to the
<a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services
User Data Policy</a>, including the Limited Use requirements.</p>

<h2>Unlinking and revoking access</h2>
<p>The owner can unlink an account on the server's accounts page, which revokes its Google
token and deletes the stored tokens. Access can also be revoked at any time at
<a href="https://myaccount.google.com/connections">myaccount.google.com/connections</a>.</p>
${contactLine(contact)}
</div>`;
}

// ---- accounts ----

export const COMPONENT_LABELS: Readonly<Record<AccountComponent, string>> = {
  mail: "Mail: read, organize, drafts, filters",
  "mail.send": "Mail: send",
  calendar: "Calendar",
  files: "Drive files",
  contacts: "Contacts",
};

export interface AllowEntryView {
  kind: AllowKind;
  value: string;
  /** ISO time. */
  added: string;
}

export interface AccountsViewData {
  email: string;
  csrf: string;
  accounts: AccountRow[];
  defaultId: string | null;
  /** Allow-list entries by account id. */
  allow: ReadonlyMap<string, readonly AllowEntryView[]>;
  /** Token key version in use and how many stored tokens use another; null hides the section. */
  encryption: { version: number; old: number } | null;
  relinked: string | null;
  /** Components Google did not grant on the last link. */
  partial: readonly AccountComponent[];
  labelMax: number;
  labelRule: string;
}

function enabledComponents(account: AccountRow): AccountComponent[] {
  try {
    const parsed: unknown = JSON.parse(account.components);
    return Array.isArray(parsed)
      ? parsed.filter((c): c is AccountComponent =>
          (ACCOUNT_COMPONENTS as readonly unknown[]).includes(c),
        )
      : [];
  } catch {
    return [];
  }
}

type ButtonKind = "" | "primary" | "danger";

function postForm(
  action: string,
  csrf: string,
  fields: [string, string][],
  button: string,
  kind: ButtonKind = "",
): SafeHtml {
  return html`<form method="post" action="${action}" class="inline-form">
<input type="hidden" name="csrf" value="${csrf}">
${fields.map(([name, value]) => html`<input type="hidden" name="${name}" value="${value}">`)}
<button type="submit"${kind === "" ? "" : raw(` class="${kind}"`)}>${button}</button>
</form>`;
}

function accountRow(
  account: AccountRow,
  isDefault: boolean,
  csrf: string,
  labelMax: number,
  labelRule: string,
): SafeHtml {
  const on = enabledComponents(account);
  const id: [string, string] = ["account", account.id];
  const excess = excessScopes(on, parseScopes(account.granted_scopes));
  return html`<tr>
<td>${account.label}
<form method="post" action="/accounts/rename" class="inline-form">
<input type="hidden" name="csrf" value="${csrf}">
<input type="hidden" name="account" value="${account.id}">
<input name="label" required maxlength="${labelMax}" value="${account.label}" title="${labelRule}" aria-label="New label for ${account.address}">
<button type="submit">Rename</button>
</form></td>
<td>${account.address}</td>
<td>${account.provider}</td>
<td><ul class="components">${ACCOUNT_COMPONENTS.map((c) => {
    const isOn = on.includes(c);
    return html`<li><span class="comp-name">${COMPONENT_LABELS[c]}</span><span class="comp-state${isOn ? " is-on" : ""}">${isOn ? "on" : "off"}</span>${postForm(
      "/accounts/component",
      csrf,
      [id, ["component", c], ["on", isOn ? "0" : "1"]],
      isOn ? "Turn off" : "Turn on",
    )}</li>`;
  })}</ul></td>
<td>${account.status === "ok" ? "ok" : "needs re-link"}</td>
<td>${isDefault ? "default" : ""}</td>
<td>${postForm("/accounts/unlink", csrf, [id], "Unlink", "danger")}
${account.status === "ok" ? "" : postForm("/accounts/relink", csrf, [id], "Re-link", "primary")}
${excess.length > 0 ? postForm("/accounts/relink-minimal", csrf, [id], "Re-link minimal") : ""}</td>
</tr>`;
}

function accountsTable(d: AccountsViewData): SafeHtml {
  if (d.accounts.length === 0) {
    return html`<div class="card"><p>No mailbox is linked yet.</p></div>`;
  }
  return html`<div class="table-wrap"><table class="cards-table accounts-table">
<thead><tr><th>Label</th><th>Address</th><th>Provider</th><th>Components</th><th>Status</th><th>Default</th><th></th></tr></thead>
<tbody>${d.accounts.map((a) => accountRow(a, a.id === d.defaultId, d.csrf, d.labelMax, d.labelRule))}</tbody>
</table></div>
<p class="muted">A component switched off stops working at once. Google keeps the old access until you press "Re-link minimal", which revokes it and asks again for only the components that are on.</p>`;
}

function allowLists(d: AccountsViewData): SafeHtml {
  if (d.accounts.length === 0) return html``;
  const sections = d.accounts.map((a) => {
    const entries = d.allow.get(a.id) ?? [];
    return html`<h3>${a.label} (${a.address})</h3>
${
  entries.length === 0
    ? html`<p>Nothing is allowed yet.</p>`
    : html`<div class="table-wrap"><table class="cards-table allow-table">
<thead><tr><th>Type</th><th>Allowed</th><th>Added (UTC)</th><th></th></tr></thead>
<tbody>${entries.map(
        (e) =>
          html`<tr><td>${e.kind}</td><td>${e.kind === "domain" ? `@${e.value}` : e.value}</td><td>${e.added}</td><td>${postForm(
            "/accounts/allow/remove",
            d.csrf,
            [
              ["account", a.id],
              ["kind", e.kind],
              ["value", e.value],
            ],
            "Remove",
            "danger",
          )}</td></tr>`,
      )}</tbody>
</table></div>`
}
<form method="post" action="/accounts/allow">
<input type="hidden" name="csrf" value="${d.csrf}">
<input type="hidden" name="account" value="${a.id}">
<div class="field-row"><label>Add <select name="kind"><option value="address">an address</option><option value="domain">a whole domain</option></select></label>
<input name="value" required maxlength="254" placeholder="name@example.com or example.com" aria-label="Address or domain to allow for ${a.address}">
<button type="submit">Add</button></div>
</form>`;
  });
  return html`<section class="card"><h2>Allowed recipients</h2>
<p>A send to anyone who is not yours, not on a mailbox's list, never sent to and not in its contacts waits for your approval. Addresses and domains listed here go out without approval. A domain covers only that exact domain, not its subdomains, and public mail providers such as gmail.com cannot be allowed as a whole domain.</p>
${sections}</section>`;
}

function signatureSettings(d: AccountsViewData): SafeHtml {
  if (d.accounts.length === 0) return html``;
  return html`<section class="card"><h2>Gmail signature</h2>
<p>With "Add my Gmail signature" on, send_message, reply and forward add the mailbox's Gmail signature whenever the caller does not say otherwise. A send-as address with no signature of its own uses the mailbox's main one. A picture stored inside the signature (not a web address) is left out, because some mail clients show it as a broken attachment. Host the logo at a web address and insert it by that address in Gmail's signature editor.</p>
${d.accounts.map((a) => {
  const isOn = a.signature_default !== 0;
  return html`<div class="field-row"><span>${a.label} (${a.address}): <strong>${isOn ? "on" : "off"}</strong></span>
${postForm(
  "/accounts/signature",
  d.csrf,
  [
    ["account", a.id],
    ["on", isOn ? "0" : "1"],
  ],
  isOn ? "Turn off" : "Turn on",
)}</div>`;
})}</section>`;
}

function defaultForm(d: AccountsViewData): SafeHtml {
  if (d.accounts.length === 0) return html``;
  return html`<section class="card"><h2>Default mailbox</h2>
<form method="post" action="/accounts/default">
<input type="hidden" name="csrf" value="${d.csrf}">
<div class="field-row"><label>Used when a tool names no mailbox
<select name="account">
<option value=""${d.defaultId === null ? " selected" : ""}>none</option>
${d.accounts.map(
  (a) =>
    html`<option value="${a.id}"${a.id === d.defaultId ? " selected" : ""}>${a.label} (${a.address})</option>`,
)}
</select></label>
<button type="submit">Save</button></div>
</form></section>`;
}

function encryptionSection(d: AccountsViewData): SafeHtml {
  if (d.encryption === null) return html``;
  return html`<section class="card"><h2>Token encryption</h2>
<p>New tokens are sealed under key version ${d.encryption.version}. ${d.encryption.old} stored token(s) use another version; they move on their next refresh, or all at once here.</p>
${postForm("/accounts/reencrypt", d.csrf, [], "Re-encrypt all tokens")}</section>`;
}

function linkForm(d: AccountsViewData): SafeHtml {
  return html`<section class="card"><h2>Link a mailbox</h2>
<form method="post" action="/accounts/link">
<input type="hidden" name="csrf" value="${d.csrf}">
<p><label>Label <input name="label" required maxlength="${d.labelMax}" title="${d.labelRule}" placeholder="Personal" aria-describedby="label-help"></label><br>
<small id="label-help">${d.labelRule} Capitals and spaces are fine; two mailboxes cannot differ only by case.</small></p>
<p><label>Google address (optional) <input type="email" name="login_hint" maxlength="254"></label></p>
<fieldset><legend>Components</legend>
<ul>${ACCOUNT_COMPONENTS.map(
    (c) =>
      html`<li><label><input type="checkbox" name="components" value="${c}" checked> ${COMPONENT_LABELS[c]}</label></li>`,
  )}</ul>
</fieldset>
<button type="submit" class="primary">Link with Google</button>
</form></section>`;
}

export function accountsView(d: AccountsViewData): SafeHtml {
  return html`<h1>Linked mailboxes</h1>
${d.relinked ? html`<p class="callout callout-info"><strong>Re-linked ${d.relinked}.</strong> A linked mailbox keeps its label; use Rename to change its name.</p>` : ""}
<p>Signed in as ${d.email}. <a href="/accounts/audit">Sending switch and audit log</a></p>
${
  d.partial.length > 0
    ? html`<p class="callout"><strong>Google did not grant everything asked for.</strong> These stay off: ${d.partial.map((p) => COMPONENT_LABELS[p]).join(", ")}.</p>`
    : ""
}
${accountsTable(d)}
${allowLists(d)}
${signatureSettings(d)}
${defaultForm(d)}
${linkForm(d)}
${encryptionSection(d)}`;
}

// ---- approvals ----

export interface ApprovalViewData {
  id: string;
  csrf: string;
  tool: string;
  /** `pending`, `approved`, `rejected`, `expired`, `executed` or `failed`. */
  status: string;
  clientId: string;
  /** ISO times. */
  requested: string;
  expires: string;
  account: { label: string; address: string } | null;
  /** The tool's own approval summary. Every field is optional and untrusted. */
  preview: unknown;
  previewJson: string;
  /** The stored call's arguments, clipped. */
  args: string;
  resultJson: string | null;
  /**
   * Set when the send was held for new recipients: the new addresses (`queryable` ones can be
   * allowed one by one), the mailbox address, and the domains that may be allowed whole.
   */
  held: {
    fresh: { address: string; queryable: boolean }[];
    mailbox: string;
    domains: string[];
  } | null;
}

const field = (preview: unknown, key: string): unknown =>
  preview !== null && typeof preview === "object"
    ? (preview as Record<string, unknown>)[key]
    : undefined;

/** A preview field as lines of text: a string, a list of strings, or an object's scalar entries. */
function texts(v: unknown): string[] {
  if (typeof v === "string") return v === "" ? [] : [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x !== "");
  if (v !== null && typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => ["string", "number", "boolean"].includes(typeof x) && x !== "")
      .map(([k, x]) => `${k}: ${String(x)}`);
  }
  return [];
}

/** Rows for the facts a tool put in its approval preview: what, to whom, how, why. */
function previewRows(preview: unknown): SafeHtml {
  const row = (label: string, key: string): SafeHtml => {
    const found = texts(field(preview, key));
    if (found.length === 0) return html``;
    return found.length === 1
      ? html`<dt>${label}</dt><dd>${found[0]}</dd>`
      : html`<dt>${label}</dt><dd><ul>${found.map((a) => html`<li>${a}</li>`)}</ul></dd>`;
  };
  return html`${row("Action", "action")}${row("Summary", "summary")}${row("Role", "role")}${row("To", "to")}${row("Cc", "cc")}${row("Bcc", "bcc")}${row("Reason", "reason")}`;
}

function summaryCard(d: ApprovalViewData): SafeHtml {
  const subject = field(d.preview, "subject");
  const from = field(d.preview, "from");
  // From is the mail's own sender, or the mailbox for a send held for new recipients; other tools
  // (share, filter, calendar) send nothing from anywhere.
  const fromText = typeof from === "string" && from !== "" ? from : d.held ? d.held.mailbox : "";
  const why = field(d.preview, "heldBecause");
  return html`<section class="card summary">
${
  d.status === "pending"
    ? html`<p class="callout"><strong>Why it was held.</strong> ${typeof why === "string" && why !== "" ? why : "This kind of action always waits for your approval."}</p>`
    : ""
}
<dl class="facts">
${d.account ? html`<dt>Account</dt><dd>${d.account.label} (${d.account.address})</dd>` : ""}
${fromText === "" ? "" : html`<dt>From</dt><dd>${fromText}</dd>`}
${previewRows(d.preview)}
${typeof subject === "string" ? html`<dt>Subject</dt><dd class="subject">${subject === "" ? "(no subject)" : subject}</dd>` : ""}
<dt>Expires</dt><dd><time datetime="${d.expires}">${utc(d.expires)}</time></dd>
<dt>Status</dt><dd>${d.status}</dd>
</dl>
</section>`;
}

function newRecipientForm(d: ApprovalViewData, held: NonNullable<ApprovalViewData["held"]>) {
  const plain = held.fresh.filter((f) => f.queryable).map((f) => f.address);
  const only = plain.length === 1 ? plain[0] : undefined;
  const hidden = html`<input type="hidden" name="csrf" value="${d.csrf}">`;
  return html`<section class="card decision">
<h2>New recipients</h2>
<p>${held.fresh.length === 1 ? "This recipient is" : "These recipients are"} new to ${held.mailbox}: never written to from it, not in its contacts and not on its allow list. The send waits until you decide.</p>
<form method="post" action="/approvals/${d.id}">
${hidden}
<ul class="checks">${held.fresh.map((f) =>
    f.queryable && only === undefined
      ? html`<li><label><input type="checkbox" name="allow" value="${f.address}"> ${f.address}</label></li>`
      : html`<li><strong>${f.address}</strong></li>`,
  )}</ul>
${only === undefined ? "" : html`<input type="hidden" name="allow" value="${only}">`}
<div class="decision-group">
<p><button class="btn-approve" name="decision" value="approve">Approve once</button></p>
${
  only === undefined
    ? plain.length > 1
      ? html`<p><button class="btn-approve-alt" name="decision" value="approve_allow">Approve and always allow the checked addresses</button></p>`
      : ""
    : html`<p><button class="btn-approve-alt" name="decision" value="approve_allow">Approve and always allow ${only}</button></p>`
}
${held.domains.map(
  (dom) =>
    html`<p><button class="btn-approve-domain" name="decision" value="approve_domain:${dom}">Approve and always allow @${dom}</button></p>`,
)}
</div>
<div class="decision-reject"><button class="btn-reject" name="decision" value="reject">Reject</button></div>
</form>
<p class="decision-note">"Always allow" adds to the allow list of ${held.mailbox} only; you can remove entries on <a href="/accounts">Accounts</a>. Approving once adds nothing, but the recipients count as known after the send goes out.</p>
</section>`;
}

function simpleDecision(d: ApprovalViewData): SafeHtml {
  return html`<section class="card decision">
<h2>Your decision</h2>
<form method="post" action="/approvals/${d.id}">
<input type="hidden" name="csrf" value="${d.csrf}">
<div class="decision-group"><button class="btn-approve" name="decision" value="approve">Approve</button></div>
<div class="decision-reject"><button class="btn-reject" name="decision" value="reject">Reject</button></div>
</form>
</section>`;
}

export function approvalView(d: ApprovalViewData): SafeHtml {
  const decide =
    d.status !== "pending" ? "" : d.held ? newRecipientForm(d, d.held) : simpleDecision(d);
  return html`<h1>Approve an action</h1>
<p>An MCP client asked to run <strong>${d.tool}</strong>${d.account ? html` on <strong>${d.account.label}</strong> (${d.account.address})` : ""}. Nothing happens unless you approve it here.</p>
${summaryCard(d)}
${decide}
${d.resultJson === null ? "" : html`<section class="card"><h2>Result</h2><pre>${d.resultJson}</pre></section>`}
<details class="card" open>
<summary>Technical details: client, preview, exact arguments</summary>
<dl class="facts facts-small">
<dt>Tool</dt><dd>${d.tool}</dd>
<dt>Requested</dt><dd>${d.requested}</dd>
<dt>Client</dt><dd>${d.clientId}</dd>
</dl>
<h3>Preview</h3>
<pre>${d.previewJson}</pre>
<h3>Exact arguments</h3>
<p>This is what runs if you approve, whatever the preview says.</p>
<pre>${d.args}</pre>
</details>
<p><a href="/accounts">Accounts</a></p>`;
}

// ---- audit log ----

export interface AuditRowView {
  /** ISO time. */
  at: string;
  account: string;
  tool: string;
  result: string;
  from: string;
  recipients: string;
  subject: string;
  detail: string;
  client: string;
}

export interface AuditViewData {
  csrf: string;
  sendEnabled: boolean;
  switchedOff: boolean;
  rows: readonly AuditRowView[];
  /** The `before` cursor of the next page, or null. */
  older: string | null;
}

export function auditView(d: AuditViewData): SafeHtml {
  return html`<h1>Sending and audit log</h1>
<section class="card">
<p>Server setting SEND_ENABLED: <strong>${d.sendEnabled ? "true" : "false"}</strong>. Owner switch: <strong>${d.switchedOff ? "sending off" : "sending on"}</strong>. Mail is sent only when both allow it.</p>
<form method="post" action="/accounts/send-switch">
<input type="hidden" name="csrf" value="${d.csrf}">
<input type="hidden" name="sending" value="${d.switchedOff ? "on" : "off"}">
<button class="${d.switchedOff ? "primary" : "danger"}">${d.switchedOff ? "Switch sending on" : "Switch sending off"}</button>
</form>
</section>
<h2>Audit log</h2>
<div class="table-wrap"><table class="cards-table audit-table">
<thead><tr><th>Time (UTC)</th><th>Account</th><th>Tool</th><th>Result</th><th>From</th><th>To, cc, bcc</th><th>Subject</th><th>Detail</th><th>Client</th></tr></thead>
<tbody>
${d.rows.map(
  (
    r,
  ) => html`<tr><td>${r.at}</td><td>${r.account}</td><td>${r.tool}</td><td>${r.result}</td><td>${r.from}</td><td>${r.recipients}</td><td>${r.subject}</td><td>${r.detail}</td><td>${r.client}</td></tr>
`,
)}
</tbody>
</table></div>
${d.older === null ? "" : html`<p><a href="/accounts/audit?before=${d.older}">Older entries</a></p>`}
<p><a href="/accounts">Accounts</a></p>`;
}

// ---- consent ----

export interface ConsentViewData {
  clientName: string;
  clientDomain: string | undefined;
  redirectHost: string;
  redirectUri: string;
  loopback: boolean;
  path: string;
  endpointLabel: string;
  email: string;
  handle: string;
  csrf: string;
  choices: { scope: string; label: string }[];
}

export function consentView(d: ConsentViewData): SafeHtml {
  return html`<h1>Authorize ${d.clientName}</h1>
<section class="card">
<p>${
    d.clientDomain
      ? html`Client domain: <strong>${d.clientDomain}</strong>`
      : html`This client named itself; the name is not verified.`
  }</p>
<p>Tokens go to <strong>${d.redirectHost}</strong> (<code>${d.redirectUri}</code>).</p>
${
  d.loopback &&
  html`<p class="callout"><strong>Warning:</strong> the tokens go to a program on this computer. Any local program could be listening, whatever name the client gives.</p>`
}
<p>Endpoint: <code>${d.path}</code> (${d.endpointLabel}). Signed in as ${d.email}.</p>
</section>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${d.handle}">
<input type="hidden" name="csrf" value="${d.csrf}">
<section class="card"><h2>Allow access to</h2>
<ul class="checks">${d.choices.map(
    (c) =>
      html`<li><label><input type="checkbox" name="scope" value="${c.scope}" checked> ${c.label}</label></li>`,
  )}</ul></section>
<div class="decision-group">
<button type="submit" class="btn-approve" name="decision" value="approve">Approve</button>
</div>
<div class="decision-reject"><button type="submit" class="btn-reject" name="decision" value="deny">Deny</button></div>
</form>`;
}
