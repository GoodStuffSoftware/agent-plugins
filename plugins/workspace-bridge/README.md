# workspace-bridge

Gmail, Calendar, Drive and Contacts for several Google accounts at once, from Claude, through an MCP server you host yourself.

The server is one Cloudflare Worker (source in [`server/`](server)). It runs on your Cloudflare account, your domain and your Google Cloud project, so nobody else holds your tokens. Each tool takes an `account` selector, and search tools accept `account: "all"` to look across every linked mailbox.

> **This plugin does nothing without your own deployed server.** It points Claude at a URL you control. Deploy the server first: **[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)**.

## Install

```
/plugin marketplace add GoodStuffSoftware/agent-plugins
/plugin install workspace-bridge@goodstuff
```

Claude Code asks for one setting, `server_url`: the base URL of your server, which must not end in a slash and must not include `/mcp`, for example `https://mcp.example.com`. It has no default. The plugin registers the HTTP MCP server at `<server_url>/mcp` and adds a skill that teaches agents how to use it. Sign in through the OAuth prompt with an address your server allows.

If you already added the server by hand (`claude mcp add --transport http ...`) or as a claude.ai connector, you do not need the plugin's server entry. Use one or the other, or you will see the tools twice.

## Tools

Every account-scoped tool takes `account` (label, address or short id; the default account when omitted). Ids come back prefixed with the account, such as `a1:18c2f...`.

**Mail read.** `search_threads`, `get_thread`, `get_message`. Mail text comes back inside `<untrusted-...>` blocks.

**Labels.** `list_labels`, `create_label`, `update_label`, `delete_label`, `label_message`, `unlabel_message`, `label_thread`, `unlabel_thread`, `update_message_labels`.

**State.** `update_thread_state`, `update_message_state` (archive, read, star), `mark_message_spam`, `unmark_message_spam`, `mark_thread_spam`, `unmark_thread_spam`, `trash_message`, `untrash_message`, `trash_thread`, `untrash_thread`, `apply_sensitive_message_label`, `apply_sensitive_thread_label`.

**Drafts.** `create_draft`, `get_draft`, `list_drafts`, `update_draft`, `delete_draft`.

**Send, reply, forward.** `send_message`, `reply`, `forward`, `list_send_as`. Sending goes through Gmail itself, from the account address or a verified send-as alias, so it lands in Sent and is signed by Google. Sending is off until the owner turns it on, and is rate limited per account.

**Attachments.** `get_attachment` reads an attachment up to a byte cap. Drafts, `send_message` and `reply` accept `attachments` (base64 bytes or a Drive file shared as a link), and `forward` can include the original attachments.

**Filters.** `list_filters`, `create_filter`, `delete_filter`. A filter that forwards mail is held for owner approval.

**Calendar.** `list_calendars`, `list_events`, `search_events`, `get_event`, `create_event`, `update_event`, `delete_event`, `respond_to_event`, `suggest_time`.

**Drive, read.** `search_files`, `list_recent_files`, `get_file_metadata`, `read_file_content`, `download_file_content`, `get_file_permissions`.

**Drive, write.** `create_file`, `update_file`, `copy_file`, `share_file`, `trash_file`. Sharing with anyone, a domain or an outside address is held for owner approval.

**Contacts.** `search_contacts`, `get_contact`. Read only.

**Accounts and meta.** `list_accounts`, `link_account_url`, `whoami`, `get_pending_action`.

Plain reads and draft create and update are also on `/mcp/ro`, a separate read-only endpoint for routines. Send, forward, share, filter and trash tools are not registered there.

## Security model

- **Owner allowlist.** Only the addresses in the server's `OWNER_EMAILS` secret can sign in or link accounts. An empty list admits nobody.
- **OAuth, no static bearer.** MCP clients authorize with OAuth 2.1 and PKCE. Tokens are bound to one endpoint and carry only the capabilities you ticked. There is no shared secret to leak.
- **Encrypted tokens.** Google refresh tokens are encrypted at rest (AES-256-GCM, key held as a Worker secret) and never reach a client.
- **Approvals.** Risky actions are stored, not run. The owner approves them on the server's own page, which an agent cannot do. `get_pending_action` reports the outcome.
- **Audit log.** Sends, filter changes and shares are logged without message bodies. A kill switch disables all sending at once.
- **Untrusted content.** Mail, event and file text is wrapped in per-response tagged blocks, and the skill tells agents to treat it as data.
- **No permanent delete of mail or files.** Messages, threads and Drive files go to the trash only, and the server never asks Google for full-mailbox scope. Only drafts (`delete_draft`), labels, filters and calendar events are removed outright.

## Credits

The MIME building code in `server/src/core/mime.ts` is adapted from [mkpoli/gmail-mcp](https://github.com/mkpoli/gmail-mcp) (MIT). See [THIRD-PARTY.md](THIRD-PARTY.md).

## License

MIT, see [../../LICENSE](../../LICENSE).
