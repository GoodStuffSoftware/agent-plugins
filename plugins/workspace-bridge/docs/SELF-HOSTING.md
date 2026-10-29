# Self-hosting workspace-bridge

workspace-bridge is one Cloudflare Worker that gives Claude access to several Google accounts at once: Gmail, Calendar, Drive and Contacts. You run it yourself, on your own Cloudflare account, your own domain and your own Google Cloud project. Nobody else holds your tokens.

This guide uses these placeholder values. Replace them with your own.

- Host: `mcp.example.com`
- Your Google account: `you@example.com`
- Cloudflare account id: `<your-account-id>`

## 1. What you need

- A Cloudflare account.
- A domain whose DNS is managed by Cloudflare. The Worker will live on a subdomain such as `mcp.example.com`.
- A Google account. A Google Workspace account works too, and gives you the extra step in section 5.
- Node.js, current LTS, and npm.
- `git` and `openssl`.
- Claude Code, claude.ai or Claude desktop to use the server.

## 2. Free or Paid plan, and the size caps

The Worker runs on the Workers Free plan for normal use. Free limits that matter:

- 10 ms of CPU per request. Time spent waiting on network, KV or D1 does not count.
- 50 subrequests per request.
- 100,000 requests per day.

The code is built for these limits. It caps message bodies, attachment sizes and search fan-out. The defaults in `wrangler.example.jsonc` are:

| Var | Default | Meaning |
|---|---|---|
| `MAX_ATTACHMENT_BYTES` | `524288` | Largest attachment or Drive file returned inline (512 KB) |
| `MAX_SEND_ATTACHMENT_BYTES` | `524288` | Largest attachment you can send (512 KB) |
| `SEND_PER_HOUR` | `20` | Sends per account per hour |
| `SEND_PER_DAY` | `100` | Sends per account per day |
| `MAX_RECIPIENTS` | `20` | Recipients per message |

If a request fails with error 1102 (CPU limit exceeded), move to Workers Paid ($5 per month). Paid allows far more CPU per request and 10,000 subrequests. You then raise the `MAX_*` vars and, if you want, add a `limits` block with `cpu_ms`. No code change is needed.

## 3. Clone and configure

```sh
git clone https://github.com/GoodStuffSoftware/agent-plugins.git
```

```sh
cd agent-plugins/plugins/workspace-bridge/server
```

```sh
npm ci
```

```sh
cp wrangler.example.jsonc wrangler.jsonc
```

```sh
cp .dev.vars.example .dev.vars
```

`wrangler.jsonc` and `.dev.vars` are git-ignored. Never commit them. `.dev.vars` is only for local `npm run dev`.

Open `wrangler.jsonc` and change:

- `routes[0].pattern` to your host, for example `mcp.example.com`.
- `vars.PUBLIC_URL` to `https://mcp.example.com`. No trailing slash. This is the OAuth issuer.
- `vars.OWNER_CONTACT` to a contact line for the `/` and `/privacy` pages, or leave it empty to hide the line.
- `vars.NOTIFY_EMAIL` to the one address that gets the "an action is waiting for your approval" email, or leave it empty to use `OWNER_CONTACT` when that is a plain email address. With neither, no email is sent and holds still work: open `/approvals/<id>` yourself.
- `d1_databases[0].database_id` and `kv_namespaces[0].id`, after section 4.
- `ratelimits[0].namespace_id` to any integer that is unique in your account.

Keep `SETUP_MODE` at `"true"` for now. Keep `SEND_ENABLED` at `"false"` until you have tested reading.

## 4. Create D1, KV and the custom domain

Sign in to Cloudflare from the terminal.

```sh
npx wrangler login
```

Create the database.

```sh
npx wrangler d1 create workspace-bridge
```

Copy the printed `database_id` into `wrangler.jsonc`. Create the KV namespace.

```sh
npx wrangler kv namespace create OAUTH_KV
```

Copy the printed id into `wrangler.jsonc`. Apply the migrations to the remote database.

```sh
npx wrangler d1 migrations apply workspace-bridge --remote
```

The custom domain comes from the `routes` entry with `"custom_domain": true`. On the first deploy Cloudflare creates the DNS record and the certificate. Do not create a DNS record for the host yourself, and make sure none exists already for that name.

## 5. Google Cloud project

Do this in a desktop browser, signed in as the Google account that will own the project. Nothing here costs money.

1. Open https://console.cloud.google.com/projectcreate. Name the project `workspace-bridge` and click Create. Check that the project picker shows it.
2. Open https://console.cloud.google.com/apis/library and enable the Gmail API, Google Calendar API, Google Drive API and People API.
3. Open https://console.cloud.google.com/auth/overview (Google Auth Platform). Click Get started if asked.
4. Branding:
   - App name: `workspace-bridge`
   - User support email: `you@example.com`
   - App home page: `https://mcp.example.com`
   - Privacy policy link: `https://mcp.example.com/privacy` (the Worker serves it; it returns 404 until the first deploy)
   - Authorized domain: `example.com`
   - Developer contact: `you@example.com`
   - Leave the logo empty. A logo starts Google's brand review.
5. Audience: choose user type External, then click Publish app so the status reads In production. Do not submit the app for verification.
6. Data access: click Add or remove scopes, paste the scopes you need (table below) into Manually add scopes, then Add to table, Update and Save.
7. Clients: Create client, type Web application, name `workspace-bridge-worker`. Add these authorized redirect URIs:
   - `https://mcp.example.com/oauth/google/callback`
   - `http://localhost:8788/oauth/google/callback` (only if you run `npm run dev`)
8. Click Create. Google shows the client ID and client secret. Put both straight into your password manager. Google may show the secret only once.

### Why External and Production, not Testing

An app in Testing status is limited to listed test users and Google expires its refresh tokens after 7 days. Scheduled routines would then fail every week with `invalid_grant`. An External app in Production that you never submit for verification keeps refresh tokens alive. The cost is the "Google hasn't verified this app" screen when you link an account, and a cap of 100 new users over the life of the project. For a personal server that is fine. Choose Internal only if every account you will ever link belongs to your own Workspace organization; Internal blocks personal Gmail accounts.

### Scopes per component

The consent screen shows what you add here. The Worker still requests only the scopes for the components you switch on when you link an account.

| Component | Scopes | Google class |
|---|---|---|
| Sign-in | `openid`, `https://www.googleapis.com/auth/userinfo.email` | non-sensitive |
| Mail, read and write | `https://www.googleapis.com/auth/gmail.modify` | restricted |
| Mail, send | covered by `gmail.modify`; `https://www.googleapis.com/auth/gmail.send` for a send-only account | sensitive |
| Mail, labels | `https://www.googleapis.com/auth/gmail.labels` | non-sensitive |
| Mail, filters and send-as list | `https://www.googleapis.com/auth/gmail.settings.basic` | restricted |
| Calendar | `https://www.googleapis.com/auth/calendar` | check the label shown in the console |
| Files | `https://www.googleapis.com/auth/drive`, or `https://www.googleapis.com/auth/drive.file` for files the app created | restricted / non-sensitive |
| Contacts | `https://www.googleapis.com/auth/contacts.readonly`, `https://www.googleapis.com/auth/contacts.other.readonly` | sensitive |
| Admin (Workspace only) | `admin.directory.user`, `.user.alias`, `.group`, `.group.member`, `.domain` | check in the console |

Creating Gmail send-as aliases through the API needs a scope Google limits to service accounts with domain-wide delegation. Set up aliases by hand in Gmail settings. Listing them works with `gmail.settings.basic`.

### Workspace "Trusted" step

Skip this if you only link personal Gmail accounts. If you link a Google Workspace account, its admin can block unverified third-party apps from Gmail and Drive. Mark yours as Trusted so sign-in does not fail:

1. Open https://admin.google.com, signed in as a Workspace admin.
2. Go to Security, Access and data control, API controls, Manage third-party app access.
3. Click Configure new app, search for the client ID from step 8, and select `workspace-bridge`.
4. Choose the organizational unit, set access to Trusted, and finish.

## 6. Secrets and backup

Set every secret with `wrangler secret put`. It reads the value from stdin, so nothing lands in shell history or in a file in the repo. Run each command and paste the value when prompted.

| Secret | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | from section 5, step 8 |
| `GOOGLE_CLIENT_SECRET` | from section 5, step 8 |
| `TOKEN_KEK` | 32 random bytes, base64. Encrypts Google tokens at rest. |
| `COOKIE_SECRET` | 32 random bytes, base64. Signs sign-in cookies. |
| `OWNER_EMAILS` | your sign-in addresses, for example `you@example.com` |
| `LINKABLE_EMAILS` | the mailboxes you may link, for example `you@example.com` |

Generate a random value and copy it without echoing it into a file:

```sh
openssl rand -base64 32
```

Then set each secret:

```sh
npx wrangler secret put GOOGLE_CLIENT_ID
```

```sh
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

```sh
npx wrangler secret put TOKEN_KEK
```

```sh
npx wrangler secret put COOKIE_SECRET
```

```sh
npx wrangler secret put OWNER_EMAILS
```

```sh
npx wrangler secret put LINKABLE_EMAILS
```

`OWNER_EMAILS` and `LINKABLE_EMAILS` are comma-separated lists of plain addresses (no wildcards). They are trimmed and lowercased. They are not cryptographic, but keep them private.

Back up every secret in a password manager or secrets manager (any product). Losing `TOKEN_KEK` makes every stored Google token unreadable, and you would have to relink all accounts. You can also read none of these back from Cloudflare later, so the backup is the only copy.

## 7. Deploy and verify

```sh
npx wrangler deploy
```

Then check:

```sh
curl -i https://mcp.example.com/health
```

Expect 200.

```sh
curl -i https://mcp.example.com/.well-known/oauth-protected-resource/mcp
```

Expect 200 with JSON.

```sh
curl -i https://mcp.example.com/mcp
```

Expect 401 with a `WWW-Authenticate` header. A 401 without a token is correct.

```sh
npx wrangler deployments list
```

Expect a new deployment id after each deploy.

The first certificate can take a few minutes. See section 13 if the host does not answer.

These are the endpoints the Worker serves:

| Path | Purpose |
|---|---|
| `/mcp` | Full toolset |
| `/mcp/ro` | Read tools plus draft create and update. No send, share, filter or trash. Use it for routines. |
| `/mcp/admin` | Workspace admin tools (Workspace account only) |
| `/accounts` | Owner page: linked accounts, audit log, approvals |
| `/authorize` | Sign-in and consent for MCP clients |
| `/oauth/google/callback` | Google redirect target |
| `/privacy` | Privacy page |
| `/health` | Liveness check |

### Setup mode

`SETUP_MODE` is `"true"` in the example config. While it is on, the first time an address in `OWNER_EMAILS` signs in, the Worker pins that address to your Google account's permanent id (the `sub` claim). After that, the address must come back with the same `sub`, so a later takeover of the address does not get in.

Do your first sign-ins (section 10), then turn it off. Set `"SETUP_MODE": "false"` in `wrangler.jsonc` and deploy again. With it off, an unpinned address is refused.

## 8. Connect Claude

The server has two MCP endpoints. Pick by what the client does.

| Endpoint | Use it for | What it holds |
|---|---|---|
| `https://mcp.example.com/mcp` | Your own interactive sessions | Every tool, including send, share, filter and trash, subject to the guards in section 10 |
| `https://mcp.example.com/mcp/ro` | Routines and any unattended run | Reads, plus draft create and update. No send, forward, share, filter or trash tool exists there |

Do not confuse the path `/mcp` with Claude Code's `/mcp` command. The command only manages connections.

claude.ai: Settings, Connectors, Add custom connector. Use the URL of the endpoint you want. Sign in with an address from `OWNER_EMAILS` and approve the consent page. It lists one checkbox per capability that endpoint offers. Untick what you do not want this client to have. A client can never hold more than its endpoint allows, so `/mcp/ro` never offers mail send.

Claude Code:

```sh
claude mcp add --transport http workspace-bridge https://mcp.example.com/mcp
```

Then run `/mcp` inside Claude Code, choose `workspace-bridge` and authenticate. The browser opens the same consent page.

Claude desktop: connectors added in claude.ai show up in the desktop app when you sign in with the same account.

For routines, add a second connector at the `/mcp/ro` URL and give the routine only that one. Name it differently:

```sh
claude mcp add --transport http workspace-bridge-ro https://mcp.example.com/mcp/ro
```

A prompt injection in a mail body cannot make a routine send mail, because the tool is not there.

## 9. Install the plugin

The plugin adds a skill that teaches agents how to address accounts, search all accounts, treat mail text as untrusted and confirm before sending. It also registers the server for you.

```sh
claude plugin marketplace add GoodStuffSoftware/agent-plugins
```

```sh
claude plugin install workspace-bridge@goodstuff --config server_url=https://mcp.example.com
```

`server_url` is your server's base URL. It must not end in a slash and must not include `/mcp`. The plugin appends `/mcp` itself, so `https://mcp.example.com/` would produce `https://mcp.example.com//mcp`. Inside Claude Code, `/plugin install workspace-bridge@goodstuff` opens a dialog that asks for it instead, and `/plugin configure` changes it later. The setting is required and has no default. Skip the `claude mcp add` command in section 8 when you use the plugin. If you already added that connector, you will see the tools twice: remove one of the two. The plugin does not add the `/mcp/ro` endpoint; add that one by hand for routines.

## 10. First sign-in, linking accounts, sending and approvals

### First sign-in and setup mode

1. Check that `SETUP_MODE` is `"true"` in `wrangler.jsonc` and that you deployed it (section 7).
2. Open `https://mcp.example.com/accounts` in a browser, or connect from Claude (section 8). Either asks you to sign in with Google. Use an address from `OWNER_EMAILS`.
3. The first successful sign-in pins that address to your Google account id (`sub`).
4. Set `"SETUP_MODE": "false"` in `wrangler.jsonc` and run `npx wrangler deploy`. From then on an address that was never pinned, or that returns with a different Google account, is refused. To add another owner address later, turn setup mode on for its first sign-in, then off again.

### Link accounts

Signing in proves you are the owner. Linking connects a Google mailbox to the server.

1. On `/accounts`, find the Link a mailbox form.
2. Label: any name up to 64 characters, such as `Personal` or `Mike's Workspace` (not `all`, in any case). Labels are unique per owner ignoring case. Tools refer to an account by label (matched ignoring case), address or short id. Change a label later with the Rename button on the mailbox's row; a re-link keeps the existing label.
3. Google address (optional): preselects the account in Google's picker.
4. Components, all ticked by default: Mail (read, organize, drafts, filters), Mail send, Calendar, Drive files, Contacts. Each asks Google only for its own scopes. Untick Mail send to make a mailbox unable to send whatever else is set.
5. Click Link with Google. Google shows "Google hasn't verified this app". Click Advanced, then Go to workspace-bridge (unsafe), then Allow. This is expected for a private app (section 5).
6. The address Google returns must be in `LINKABLE_EMAILS`. If it is not, the server shows "Not allowed", stores nothing and revokes the new grant.
7. Repeat for each account. The page lists every account with its components, status and actions: Turn on or Turn off per component, Re-link, Re-link minimal, Unlink, and a Default mailbox selector for tools that name no account.
8. Ask Claude to run `list_accounts` to confirm every account appears.

Turning a component on later asks Google for only the added scopes. Turning one off stops it working at once, but Google keeps the old access until you press Re-link minimal, which revokes the grant and asks again for only what is on.

### Sending and approvals

Sending is off by default. `SEND_ENABLED` in `wrangler.jsonc` is `"false"` in the example config, and while it is not `"true"` every `send_message`, `reply` and `forward` is refused with `send_disabled`, and so is a filter that forwards mail. A send also needs the owner's sending switch on. That switch is one setting for the whole owner, not per account. You find it on `/accounts`, link Sending switch and audit log (`/accounts/audit`), which shows both settings, a button to switch sending off or on, and the audit log. Switching off blocks every send at once without a deploy. The switch starts on, so `SEND_ENABLED` is the setting that actually opens sending.

A message goes out only when all of these allow it:

- `SEND_ENABLED` is `"true"` (change it, then `npx wrangler deploy`).
- The owner switch on `/accounts/audit` is on.
- The account has the Mail send component on.
- The client's grant includes mail send and it connected through `/mcp`, not `/mcp/ro`.
- The limits hold: `SEND_PER_HOUR` and `SEND_PER_DAY` per account, `MAX_RECIPIENTS` per message.

`SEND_APPROVAL_MODE` decides which sends wait for you. `new_recipients` (the default) holds a send, or a calendar change that mails guests, when any recipient (To, Cc or Bcc) is new to that account, and sends the rest straight out. A recipient is known when it is one of your own addresses or send-as aliases, is on the account's allow list, was sent to from this server before, is in the account's contacts or other contacts, or appears in the account's Gmail Sent folder. Mail someone sent you never makes them known, so a reply to a stranger is held. `all` holds every send, `off` holds none. If the variable is unset, `SEND_REQUIRES_CONFIRM` set to `"true"` means `all`. The caps, rate limits, `SEND_ENABLED` and the owner switch apply in every mode.

A held send does not send. It answers `pending_approval` with a preview, the new recipients and an `approvalUrl` such as `https://mcp.example.com/approvals/<id>`. Open that URL in the browser where you are signed in as owner. The page shows the preview and the exact stored arguments, with buttons. For a send held for new recipients they are Approve once, Approve and always allow the address (with several new recipients, tick the addresses to allow and use Approve and always allow the checked addresses), Approve and always allow @domain (offered only for a company domain: public mail providers such as gmail.com, yahoo.com or outlook.com are refused by the page and by the server), and Reject. Any other held action has Approve and Reject. Every button needs your sign-in and the page's form token. An allow entry is written to the mailbox that holds the send, then the action runs once, and the send switches, caps and send-as checks run again at that moment. The new-recipient check does not: your approval is the decision. A draft send is the exception that stays safe: it refuses if the draft gained a recipient after the hold. An agent cannot approve: no tool does it, and an MCP token is refused on that page. The agent reads the outcome with `get_pending_action`. An open approval expires after 7 days, and at most 50 can be open at once.

**The notice email.** As soon as a send is held, the server emails one short notice from that mailbox's own primary address to `NOTIFY_EMAIL` (else `OWNER_CONTACT` when it is an address): the tool, the mailbox, the new recipients, a clipped subject, the link `<PUBLIC_URL>/approvals/<id>` and the expiry. It never contains the message text or attachments, and it says that approving needs your sign-in on the bridge, so a forwarded copy or an assistant that reads it cannot approve. It is a system send: it skips the new-recipient rule (it goes to you) but obeys `SEND_ENABLED` and the owner's sending switch, is written to the audit log as `system_notice`, is sent once per held action, and at most 20 a day per mailbox. Past that, or if Gmail refuses it, the hold stands and only the email is skipped.

**The allow list.** `/accounts` lists, for each linked mailbox, the addresses and domains it may send to without approval, with the time each was added and a Remove button. Add an address or a whole domain there by hand. A domain entry covers exactly that domain, not its subdomains, and a public mail provider's domain is refused (allow single addresses instead). Entries are per mailbox: allowing someone on `work` does nothing for `personal`.

Some actions are held for approval whatever `SEND_APPROVAL_MODE` says: a filter that forwards mail or that trashes or spams it, and sharing a Drive file with anyone, a domain or an outside address.

Every send, filter change and share is written to the audit log on `/accounts/audit`, without message bodies. The daily cleanup deletes rows older than `AUDIT_RETENTION_DAYS` (default 365).

## 11. Routines: read-only grant

Point routines at `https://mcp.example.com/mcp/ro`. That endpoint registers no send, forward, share, filter or trash tool, and its tokens cannot hold those scopes. A prompt injection in a mail body cannot make a routine send mail, because the tool does not exist there.

## 12. Upgrading

```sh
git pull
```

Or check out the release tag you want:

```sh
git checkout <release-tag>
```

```sh
cd plugins/workspace-bridge/server && npm ci
```

```sh
npx wrangler d1 migrations apply workspace-bridge --remote
```

```sh
npx wrangler deploy
```

Migrations are additive and safe to run again: wrangler applies only the ones not yet applied. Run them before the deploy so the new code finds its tables.

Then confirm. `npx wrangler deployments list` should show a new deployment, and `curl https://mcp.example.com/health` should return 200. The `version` field in `/health` and in the `whoami` tool is a fixed `0.0.0` in release 0.1.0, so it does not tell you which release is live; use the git tag you checked out and the deployment list. Compare your `wrangler.jsonc` with the new `wrangler.example.jsonc` for added vars.

### Rotating the token encryption key

Google tokens are sealed with `TOKEN_KEK`, which is key version 1. To move to a new key without relinking anything:

1. Generate a value with `openssl rand -base64 32` and store it in your password manager.
2. Set it as a new secret named `TOKEN_KEK_v2`. Leave `TOKEN_KEK` in place, because existing tokens still need it.

```sh
npx wrangler secret put TOKEN_KEK_v2
```

3. Set `"CURRENT_KEY_VERSION": "2"` in `wrangler.jsonc` and run `npx wrangler deploy`. New seals use version 2. A token moves to version 2 the next time it refreshes.
4. To move them all now, open `/accounts` and press Re-encrypt all tokens in the Token encryption section. It reports how many stored tokens still use another version.
5. Keep `TOKEN_KEK` and its backup until that count is 0. Version N reads the secret `TOKEN_KEK_vN`; a version whose secret is missing cannot be opened.

The next rotation uses `TOKEN_KEK_v3` and `"CURRENT_KEY_VERSION": "3"`.

## 13. Troubleshooting

**"Google hasn't verified this app".** Expected. The app is in Production but unverified, by design (section 5). Click Advanced, then Go to workspace-bridge (unsafe). Do not submit for verification unless you plan to serve many users.

**`invalid_grant`, or an account marked `needs_relink`.** Google rejected the stored refresh token. Common causes: you revoked access at https://myaccount.google.com/permissions, you changed the account password, the token went unused for six months, or the app is still in Testing status (section 5). Open `/accounts` and relink the account. If it keeps coming back every 7 days, the consent screen is in Testing; publish it to Production.

**Error 1102, "CPU limit exceeded".** A request used more than 10 ms of CPU on the Free plan. Large threads, big attachments and wide searches are the usual cause. Lower the `MAX_*` vars or switch to Workers Paid (section 2). No code change.

**Sign-in refused (403).** Check, in order:

1. The address you used is in `OWNER_EMAILS`, in lowercase, exactly.
2. `SETUP_MODE` was `"true"` the first time you signed in. If you turned it off before the first sign-in, nothing is pinned and the address is refused. Turn it on, sign in once, turn it off.
3. The Google account is the same one you pinned. A different Google account using the same address, or one already pinned to another address, is refused.
4. The secrets exist. When sign-in is not configured, `/authorize` returns 503 while `/health` still returns 200.

**An account refused when linking ("Not allowed").** The Google address you chose is not in `LINKABLE_EMAILS`, which is separate from `OWNER_EMAILS`. Nothing is stored and the new grant is revoked. Add the address to the secret (comma-separated, lowercase, no wildcards), run `npx wrangler secret put LINKABLE_EMAILS` with the full list, and link again. "Wrong Google account" means you picked a different Google account while relinking; relink with the account whose address is listed.

**429 or `rate_limited`.** Four different limits give this, and each says which in its message.

- Too many tool calls on one connection: 120 a minute per grant. Wait the `retryAfterSeconds` it reports.
- Too many sends: `SEND_PER_HOUR` or `SEND_PER_DAY` per account. Raise the var and deploy, or wait.
- HTTP 429 with `temporarily_unavailable` on `/oauth/register`: more than 10 client registrations a minute from one IP. Retry after 60 seconds.
- Google itself is limiting the account. Wait the `retryAfterSeconds` it reports.

**Custom domain does not answer, or the certificate is not ready.** Cloudflare creates the DNS record and issues the certificate on the first deploy. This can take a few minutes. Check that the zone is on Cloudflare, that no other DNS record already uses the host, and that `routes[0].pattern` matches the host without `https://`. Retry after a few minutes before changing anything.

**Workspace admin blocks the app.** Do the Trusted step in section 5.

## Theming

Every owner and public page (`/`, `/privacy`, `/accounts`, the audit log, approvals, consent, notices) uses one layout and one stylesheet, driven by CSS custom properties. The default is a neutral light and dark look. To restyle it you add files; you do not fork code.

### A theme is a directory

```
theme/
  theme.css        optional. CSS appended after the base sheet.
  name.txt         optional. Product name in the header, one line, at most 40 characters.
  assets/
    logo.svg       optional. Header logo.
    logo-dark.svg  optional. Logo shown instead of logo.svg in dark mode.
    *.svg          optional. Backgrounds or other images.
    *.woff2        optional. Fonts.
```

The repository ships `plugins/workspace-bridge/server/theme/` with a `theme.css` that changes nothing. A deploy swaps that directory, or points `WB_THEME_DIR` at another one.

### Build step

`npm run build:theme` (also run by `wrangler deploy` through `build.command` in `wrangler.example.jsonc`) reads the directory and writes `server/src/web/theme.generated.ts`, which the Worker bundles. Use another directory with:

```sh
WB_THEME_DIR=/path/to/my-theme npx wrangler deploy
```

Building with another directory overwrites `server/src/web/theme.generated.ts`, a tracked file. If that checkout is a clone of the public repository, do not commit it; restore it with `git checkout src/web/theme.generated.ts` after the deploy.

If your own `wrangler.jsonc` replaces the `build` block, keep a `build.command` that runs `node scripts/build-theme.mjs` from the `server` directory. `npm test` checks that the generated file matches `theme/`, so unset `WB_THEME_DIR` when you run tests, or run `npm run build:theme` first.

### What CSS may change

Override custom properties on `:root` in `theme.css`. Colours also have dark values: the base sheet sets them inside `@media (prefers-color-scheme: dark)`, and a plain `:root` rule in your theme beats them in both modes. So set a colour's dark value inside the same media query:

```css
:root { --wb-accent: #7a3cff; --wb-radius: .25rem; }
@media (prefers-color-scheme: dark) { :root { --wb-accent: #b79bff; --wb-accent-text: #14002e; } }
```

| Group | Properties |
|---|---|
| Fonts | `--wb-font-body`, `--wb-font-heading`, `--wb-font-mono`, `--wb-font-size`, `--wb-line-height` |
| Page | `--wb-bg`, `--wb-page-bg` (any CSS background: colour, gradient, `url(/theme/assets/bg.svg) center / cover fixed`), `--wb-surface`, `--wb-surface-2`, `--wb-text`, `--wb-text-muted`, `--wb-border`, `--wb-border-strong`, `--wb-code-bg` |
| Accent and links | `--wb-accent`, `--wb-accent-text`, `--wb-accent-soft`, `--wb-link`, `--wb-focus` |
| Approve and reject | `--wb-approve`, `--wb-approve-text`, `--wb-approve-soft`, `--wb-reject`, `--wb-reject-text`, `--wb-reject-soft` |
| Warnings | `--wb-warn`, `--wb-warn-soft`, `--wb-warn-border` |
| Header | `--wb-header-bg`, `--wb-header-text`, `--wb-header-border`, `--wb-logo-height` |
| Shape | `--wb-radius-sm`, `--wb-radius`, `--wb-radius-lg`, `--wb-radius-button` |
| Spacing | `--wb-space-xs`, `--wb-space-s`, `--wb-space-m`, `--wb-space-l`, `--wb-space-xl`, `--wb-content-width`, `--wb-tap` |
| Shadows | `--wb-shadow-card`, `--wb-shadow-button` |

Keep Approve and Reject clearly different, and `--wb-tap` at 2.75rem or more. The defaults are in `server/src/web/style.ts`. You can also add your own rules to `theme.css`.

### Fonts, logo and images

Put files in `assets/` and refer to them as `/theme/assets/<file>`:

```css
@font-face { font-family: "My Font"; src: url(/theme/assets/my-font.woff2) format("woff2"); font-display: swap; }
:root { --wb-font-body: "My Font", system-ui, sans-serif; }
```

The Worker serves them itself, so the Content Security Policy stays `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'`. Nothing can load from another origin. It works on the Workers Free plan; the theme counts toward the script size cap in section 2.

### Limits

The checks below are a lint that catches mistakes; they are not a security boundary and clever escapes can slip past them. The boundary is the Content Security Policy above plus the sandboxed asset responses, which stop any page from loading another origin. A saved snapshot opened from disk has no such policy, so its preview can load more than the live site would. `build:theme` fails, naming the file, on any of these: `theme.css` over 64 KB, an SVG over 128 KB, a woff2 over 300 KB, the whole theme over 1.5 MB, `name.txt` over 40 characters or more than one line, `@import` or a `url()` to another origin in the CSS, `</style` in the CSS, scripts, event handlers, `foreignObject` or links to other origins in an SVG, a file that is not `.svg` or a real woff2, asset names other than lowercase letters, digits, `.`, `_` and `-`, and any other file or directory at the top.

### Preview without a server

```sh
cd plugins/workspace-bridge/server
npm run snapshots -- ./out                  # the theme in ./theme
npm run snapshots -- ./out /path/to/my-theme
```

This writes every page with example.com sample data to `out/*.html` plus `out/index.html`, and copies the theme's assets to `out/theme/assets/`. Open `index.html` from disk: no sign-in and no Worker. Forms are inert.
