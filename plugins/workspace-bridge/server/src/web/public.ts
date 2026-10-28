// Public pages: `/`, `/privacy` and `/health` (ARCHITECTURE s.2). Generic text: every
// deployment serves the same pages, with its own contact from var `OWNER_CONTACT`.

import { Hono } from "hono";
import { config, type Env } from "../env";
import { VERSION } from "../version";
import { html, htmlResponse, page, type SafeHtml } from "./html";

export const publicRoutes = new Hono<{ Bindings: Env }>();

function contactLine(contact: string): SafeHtml | null {
  return contact === "" ? null : html`<p>Contact: ${contact}</p>`;
}

publicRoutes.get("/", (c) => {
  const body = html`<h1>workspace-bridge</h1>
<p>A private MCP server that lets its owner's AI assistant work with the owner's Google mail,
calendar, files and contacts. Only the owner can sign in.</p>
<p><a href="/privacy">Privacy policy</a></p>
${contactLine(config(c.env).ownerContact)}`;
  return htmlResponse(page("workspace-bridge", body));
});

publicRoutes.get("/privacy", (c) => {
  const body = html`<h1>Privacy policy</h1>
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
${contactLine(config(c.env).ownerContact)}`;
  return htmlResponse(page("Privacy policy - workspace-bridge", body));
});

publicRoutes.get("/health", (c) =>
  c.json({ ok: true, name: "workspace-bridge", version: VERSION }),
);
