// Every page with generic sample data (example.com addresses only), for scripts/snapshots.mjs.
// Not imported by the Worker. Pure: no D1, no env, no request.

import type { AccountRow } from "../core/db";
import { type NavPage, page } from "./html";

export { setTheme } from "./theme";

import {
  type AccountsViewData,
  type ApprovalViewData,
  type AuditViewData,
  accountsView,
  approvalView,
  auditView,
  type ConsentViewData,
  consentView,
  homeView,
  noticeView,
  privacyView,
} from "./views";

export interface SnapshotPage {
  /** File name without extension. */
  file: string;
  /** What the page is, for the index. */
  label: string;
  title: string;
  html: string;
}

const CONTACT = "owner@example.com";
const CSRF = "sample-csrf-token";

const account = (over: Partial<AccountRow>): AccountRow => ({
  id: "ac_aaaaaaaaaaaaaaaa",
  owner_id: "ow_sample",
  short_id: 1,
  label: "Personal",
  address: "alex@example.com",
  provider: "google",
  provider_sub: "sample-sub",
  components: JSON.stringify(["mail", "mail.send", "calendar", "files", "contacts"]),
  granted_scopes: "",
  status: "ok",
  send_as_fetched_at: null,
  signature_default: 1,
  created_at: 0,
  updated_at: 0,
  ...over,
});

const accountsData = (over: Partial<AccountsViewData> = {}): AccountsViewData => ({
  email: "alex@example.com",
  csrf: CSRF,
  accounts: [
    account({}),
    account({
      id: "ac_bbbbbbbbbbbbbbbb",
      short_id: 2,
      label: "Work",
      address: "alex.work@example.com",
      components: JSON.stringify(["mail", "calendar"]),
      status: "needs_relink",
    }),
  ],
  defaultId: "ac_aaaaaaaaaaaaaaaa",
  allow: new Map([
    [
      "ac_aaaaaaaaaaaaaaaa",
      [
        { kind: "address", value: "sam@example.com", added: "2026-10-12 09:30 UTC" },
        { kind: "domain", value: "example.org", added: "2026-10-20 16:05 UTC" },
      ],
    ],
  ]),
  encryption: { version: 2, old: 1 },
  relinked: null,
  partial: [],
  labelMax: 32,
  labelRule: "Letters, digits, dot, dash and underscore, up to 32 characters.",
  ...over,
});

const approval = (over: Partial<ApprovalViewData> = {}): ApprovalViewData => ({
  id: "pa_abcdefghijklmnop",
  csrf: CSRF,
  tool: "send_message",
  status: "pending",
  clientId: "client-example",
  requested: "2026-10-29T14:03:20.000Z",
  expires: "2026-10-29T15:03:20.000Z",
  account: { label: "Personal", address: "alex@example.com" },
  preview: {
    from: "alex@example.com",
    to: ["jordan@newco.example.com"],
    subject: "Quarterly planning notes",
    heldBecause:
      "A recipient is new to this mailbox: never written to from it, not in its contacts.",
  },
  previewJson: '{\n  "from": "alex@example.com",\n  "to": ["jordan@newco.example.com"]\n}',
  args: '{"to":["jordan@newco.example.com"],"subject":"Quarterly planning notes"}',
  resultJson: null,
  held: {
    fresh: [{ address: "jordan@newco.example.com", queryable: true }],
    mailbox: "alex@example.com",
    domains: ["newco.example.com"],
  },
  ...over,
});

const audit = (): AuditViewData => ({
  csrf: CSRF,
  sendEnabled: true,
  switchedOff: false,
  older: "2026-10-01T00:00:00.000Z",
  rows: [
    {
      at: "2026-10-29 14:03:20",
      account: "Personal",
      tool: "send_message",
      result: "pending",
      from: "alex@example.com",
      recipients: "jordan@newco.example.com",
      subject: "Quarterly planning notes",
      detail: "held for approval",
      client: "client-example",
    },
    {
      at: "2026-10-29 09:12:44",
      account: "Personal",
      tool: "send_message",
      result: "sent",
      from: "alex@example.com",
      recipients: "sam@example.com",
      subject: "Lunch on Thursday?",
      detail: "",
      client: "client-example",
    },
  ],
});

const consent = (loopback: boolean): ConsentViewData => ({
  clientName: "Example Assistant",
  clientDomain: loopback ? undefined : "assistant.example.com",
  redirectHost: loopback ? "127.0.0.1" : "assistant.example.com",
  redirectUri: loopback
    ? "http://127.0.0.1:8976/callback"
    : "https://assistant.example.com/oauth/callback",
  loopback,
  path: "/mcp",
  endpointLabel: "all linked mailboxes",
  email: "alex@example.com",
  handle: "sample-handle",
  csrf: CSRF,
  choices: [
    { scope: "mail", label: "Mail: read, organize, drafts, filters" },
    { scope: "mail.send", label: "Mail: send" },
    { scope: "calendar", label: "Calendar" },
  ],
});

/** Every page, rendered with whatever theme is active. */
export function snapshotPages(): SnapshotPage[] {
  const make = (
    file: string,
    label: string,
    title: string,
    body: ReturnType<typeof noticeView>,
    nav?: NavPage | "other",
  ): SnapshotPage => ({
    file,
    label,
    title,
    html: page(title, body, nav === undefined ? {} : { nav }).value,
  });
  return [
    make("home", "Home", "workspace-bridge", homeView(CONTACT)),
    make("privacy", "Privacy policy", "Privacy policy", privacyView(CONTACT)),
    make("accounts", "Accounts", "Linked mailboxes", accountsView(accountsData()), "accounts"),
    make(
      "accounts-notices",
      "Accounts, re-linked and partial grant",
      "Linked mailboxes",
      accountsView(accountsData({ relinked: "Personal", partial: ["files", "contacts"] })),
      "accounts",
    ),
    make(
      "accounts-empty",
      "Accounts, none linked",
      "Linked mailboxes",
      accountsView(accountsData({ accounts: [], defaultId: null, encryption: null })),
      "accounts",
    ),
    make("audit", "Sending and audit log", "Sending and audit log", auditView(audit()), "audit"),
    make(
      "approval-new-recipient",
      "Approval, one new recipient (address and domain options)",
      "Approve an action",
      approvalView(approval()),
      "other",
    ),
    make(
      "approval-new-recipients",
      "Approval, several new recipients",
      "Approve an action",
      approvalView(
        approval({
          preview: {
            from: "alex@example.com",
            to: ["jordan@newco.example.com", "riley@other.example.net"],
            cc: ["sam@example.com"],
            subject: "Quarterly planning notes",
            heldBecause:
              "Two recipients are new to this mailbox: never written to from it, not in its contacts.",
          },
          held: {
            fresh: [
              { address: "jordan@newco.example.com", queryable: true },
              { address: "riley@other.example.net", queryable: true },
            ],
            mailbox: "alex@example.com",
            domains: ["newco.example.com", "other.example.net"],
          },
        }),
      ),
      "other",
    ),
    make(
      "approval-calendar",
      "Approval, calendar invite (plain approve or reject)",
      "Approve an action",
      approvalView(
        approval({
          tool: "create_event",
          preview: {
            action: "Create an event and invite guests",
            to: ["jordan@newco.example.com"],
            subject: "Team sync",
            heldBecause: "A guest is new to this calendar.",
          },
          held: null,
        }),
      ),
      "other",
    ),
    make(
      "approval-share",
      "Approval, share a Drive file",
      "Approve an action",
      approvalView(
        approval({
          tool: "share_file",
          preview: {
            action: "Share a Drive file",
            account: "Personal",
            role: "writer",
            to: "anyone",
            reason: "Anyone with the link would get access.",
          },
          held: null,
        }),
      ),
      "other",
    ),
    make(
      "approval-filter",
      "Approval, create a mail filter",
      "Approve an action",
      approvalView(
        approval({
          tool: "create_filter",
          preview: {
            summary: "Create a filter that forwards matching mail to forward@example.net.",
            action: { forward: "forward@example.net" },
          },
          held: null,
        }),
      ),
      "other",
    ),
    make(
      "approval-done",
      "Approval, already decided",
      "Approve an action",
      approvalView(approval({ status: "executed", resultJson: '{"ok":true,"id":"msg_123"}' })),
      "other",
    ),
    make(
      "approval-expired",
      "Approval, expired",
      "Approve an action",
      approvalView(approval({ status: "expired" })),
      "other",
    ),
    make("consent", "Consent", "Authorize Example Assistant", consentView(consent(false))),
    make(
      "consent-loopback",
      "Consent, local program",
      "Authorize Example Assistant",
      consentView(consent(true)),
    ),
    make(
      "notice-not-allowed",
      "Notice, not allowed",
      "Not allowed",
      noticeView("Not allowed", "This Google account is not the owner of this server."),
    ),
    make(
      "notice-not-configured",
      "Notice, sign-in not configured",
      "Sign-in not configured",
      noticeView(
        "Sign-in not configured",
        "The server owner has not finished setting up Google sign-in.",
      ),
    ),
    make(
      "notice-linked",
      "Notice, account linked",
      "Mailbox linked",
      noticeView("Mailbox linked", "alex@example.com is linked as Personal.", true),
    ),
  ];
}
