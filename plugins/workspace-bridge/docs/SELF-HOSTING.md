# Self-hosting workspace-bridge

workspace-bridge is one Cloudflare Worker that gives Claude access to several Google accounts at once: Gmail, Calendar, Drive and Contacts. You run it yourself, on your own Cloudflare account, your own domain and your own Google Cloud project. Nobody else holds your tokens.

This guide uses these placeholder values. Replace them with your own.

- Host: `mcp.example.com`
- Your Google account: `you@example.com`
- Cloudflare account id: `<your-account-id>`

Sections 8 and 9 (connectors and plugin install) and the account-linking details in section 10 are finalized at release 0.1.0. Everything else matches the code on the main branch today.

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

## 8. Connect Claude (finalized at release 0.1.0)

claude.ai: Settings, Connectors, Add custom connector, URL `https://mcp.example.com/mcp`. Sign in with an address from `OWNER_EMAILS` and approve the consent page. The consent page lists one checkbox per capability. Untick what you do not want this client to have.

Claude Code:

```sh
claude mcp add --transport http workspace-bridge https://mcp.example.com/mcp
```

Claude desktop: connectors added in claude.ai show up in the desktop app when you sign in with the same account.

For routines, add a second connector at `https://mcp.example.com/mcp/ro`. It cannot send, share or delete, whatever the routine is told to do.

## 9. Install the plugin (finalized at release 0.1.0)

The plugin adds a skill that teaches agents how to address accounts, search all accounts, treat mail text as untrusted and confirm before sending.

```sh
claude plugin marketplace add GoodStuffSoftware/agent-plugins
```

```sh
claude plugin install workspace-bridge@goodstuff --config server_url=https://mcp.example.com
```

`server_url` is your server's base URL, with no trailing slash and no `/mcp`. Inside Claude Code, `/plugin install workspace-bridge@goodstuff` opens a dialog that asks for it instead, and `/plugin configure` changes it later. The setting is required and has no default. The plugin registers the HTTP MCP server at `<server_url>/mcp` for you, so skip the `claude mcp add` command in section 8 when you use the plugin. If you already added that connector, you will see the tools twice: remove one of the two.

## 10. Link accounts and choose components (details finalized at release 0.1.0)

1. Open `https://mcp.example.com/accounts` and sign in with an address from `OWNER_EMAILS`. With setup mode on, this pins your `sub`.
2. Link each Google account you want Claude to use. Pick the components for it: mail, calendar, files, contacts. Each component asks Google for only its own scopes.
3. Google shows "Google hasn't verified this app". Click Advanced, then Go to workspace-bridge (unsafe), then Allow. This is expected for a private app.
4. Turn `SETUP_MODE` off (section 7).
5. Ask Claude to run `list_accounts` to confirm every account appears.

Sending stays off until you set `SEND_ENABLED` to `"true"` and redeploy. Set `SEND_REQUIRES_CONFIRM` to `"true"` if you want to approve every send on `/accounts`. `/accounts` also has a switch that disables all sending at once.

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

Then confirm the new version. Call the `whoami` tool, which returns the server version, and compare with the release you deployed. `npx wrangler deployments list` should show a new deployment. Compare your `wrangler.jsonc` with the new `wrangler.example.jsonc` for added vars.

## 13. Troubleshooting

**"Google hasn't verified this app".** Expected. The app is in Production but unverified, by design (section 5). Click Advanced, then Go to workspace-bridge (unsafe). Do not submit for verification unless you plan to serve many users.

**`invalid_grant`, or an account marked `needs_relink`.** Google rejected the stored refresh token. Common causes: you revoked access at https://myaccount.google.com/permissions, you changed the account password, the token went unused for six months, or the app is still in Testing status (section 5). Open `/accounts` and relink the account. If it keeps coming back every 7 days, the consent screen is in Testing; publish it to Production.

**Error 1102, "CPU limit exceeded".** A request used more than 10 ms of CPU on the Free plan. Large threads, big attachments and wide searches are the usual cause. Lower the `MAX_*` vars or switch to Workers Paid (section 2). No code change.

**Sign-in refused (403).** Check, in order:

1. The address you used is in `OWNER_EMAILS`, in lowercase, exactly.
2. `SETUP_MODE` was `"true"` the first time you signed in. If you turned it off before the first sign-in, nothing is pinned and the address is refused. Turn it on, sign in once, turn it off.
3. The Google account is the same one you pinned. A different Google account using the same address, or one already pinned to another address, is refused.
4. The secrets exist. When sign-in is not configured, `/authorize` returns 503 while `/health` still returns 200.

**Custom domain does not answer, or the certificate is not ready.** Cloudflare creates the DNS record and issues the certificate on the first deploy. This can take a few minutes. Check that the zone is on Cloudflare, that no other DNS record already uses the host, and that `routes[0].pattern` matches the host without `https://`. Retry after a few minutes before changing anything.

**Workspace admin blocks the app.** Do the Trusted step in section 5.
