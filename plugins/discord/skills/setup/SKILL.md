---
description: Install and configure the Discord MCP connector (cappyeo/discord-mcp) — create the bot, set DISCORD_TOKEN, run discord-mcp setup, invite it to a server, and verify access. Use when installing the discord plugin, connecting Claude to a Discord server, diagnosing a bad or missing bot token, the bot not seeing a channel, or a 401/403 error.
---

# Set up the Discord connector

Work through these in order.

## 1. Create the application and bot

1. Go to <https://discord.com/developers/applications> and create a new application.
2. Open the **Bot** tab.
3. Click **Reset Token**, then copy it immediately.

The token is shown **once**. It is a password for the bot — anyone who has it can act as the bot in every server it's in. If you lose it, reset it again; that invalidates the old one.

**One application note:** a single Discord application can carry both the bot and Rich Presence (if you use that elsewhere). You only need to create one application here, not a second one for Rich Presence.

## 2. Check Node, then set the token

`@discord-mcp/cli` requires **Node.js 22.12 or later**. This is a real gotcha — an older Node install fails in ways that don't obviously point at the Node version. Check with `node --version` before going further.

Set `DISCORD_TOKEN` in the environment **before** starting Claude Code — the MCP server reads it once, at launch, not on demand. The upstream project's documented form includes the literal `Bot ` prefix:

```bash
export DISCORD_TOKEN="Bot YOUR_DISCORD_BOT_TOKEN"
```

```powershell
$env:DISCORD_TOKEN = "Bot YOUR_DISCORD_BOT_TOKEN"
```

(The server also accepts the bare token with no `Bot ` prefix and normalizes it — but matching the documented form avoids ambiguity.)

**Never put the token in a file.** This plugin's `.mcp.json` deliberately has no place for it — the server reads `DISCORD_TOKEN` from whatever environment launched Claude Code.

## 3. Run guided setup

```bash
discord-mcp setup --profile devbot --client claude-code
```

(If you don't have the CLI installed globally, `npx @discord-mcp/cli setup --profile devbot --client claude-code` works the same way — this plugin's `.mcp.json` already invokes it through `npx` for the actual running server, so this manual run is only for the guided setup step itself.)

This step:

1. Calls `GET /users/@me` with your token to verify it's a real bot credential and confirm which bot it is.
2. Enumerates the guilds that bot is currently in.
3. Writes a local profile named `devbot` containing the bot's id and username, the allowlisted guild(s), the client (`claude-code`), and the tool surface — **and nothing secret**. The token itself is never written to that profile; it's referenced only as "read from the `DISCORD_TOKEN` environment variable."

If it's not run interactively (e.g. scripted), pass `--profile devbot` explicitly — `setup` refuses to invent a profile name non-interactively.

### Do not use `discord-mcp init --token <value>`

`discord-mcp` has an older, lower-level `init` command that also generates client configuration. It accepts a `--token` flag — **do not use it.** Whatever you pass to `--token` is written verbatim into the generated config snippet, unredacted, as plain text. That defeats the entire point of keeping the credential out of files. Use the environment variable and `discord-mcp setup` (which never accepts a token argument at all) instead.

## 4. Invite the bot to your server

Build the invite URL:

```
https://discord.com/api/oauth2/authorize?client_id=<APP_ID>&scope=bot&permissions=<BITS>
```

`<APP_ID>` is the application id from the developer portal's **General Information** tab. Scope is `bot`.

The permissions integer needs to cover exactly what the connector's tools do — no more. Compute it from the named Discord permission bits rather than trusting a number pasted from somewhere else, so you can verify it yourself:

| Permission | Why it's needed | Bit | Value |
|---|---|---|---|
| `VIEW_CHANNEL` | see channels at all | `1<<10` | 1,024 |
| `SEND_MESSAGES` | `messages_send` | `1<<11` | 2,048 |
| `MANAGE_CHANNELS` | `channels_create_guild_channel` (categories and channels) | `1<<4` | 16 |
| `MANAGE_ROLES` | `channels_modify_permissions` (permission overwrites), `roles_create`/`roles_modify` | `1<<28` | 268,435,456 |
| `MANAGE_WEBHOOKS` | `webhooks_create`, `webhooks_list_channel`, `webhooks_list_guild` | `1<<29` | 536,870,912 |
| `READ_MESSAGE_HISTORY` | `messages_read` | `1<<16` | 65,536 |

Adding them up:

```
        1,024   VIEW_CHANNEL
        2,048   SEND_MESSAGES
           16   MANAGE_CHANNELS
  268,435,456   MANAGE_ROLES
  536,870,912   MANAGE_WEBHOOKS
       65,536   READ_MESSAGE_HISTORY
-----------
  805,374,992
```

So the full invite URL is:

```
https://discord.com/api/oauth2/authorize?client_id=<APP_ID>&scope=bot&permissions=805374992
```

Open it, pick your server from the dropdown, and authorize.

## 5. Verify

Ask Claude to list guilds and channels — under the hood that's:

```
users_list_current_user_guilds
channels_list  {guild_id: "<your guild id>"}
```

If both return cleanly, the connector is working end to end. You can also run `discord-mcp doctor --profile devbot --online` from a terminal for the same check outside a Claude session.

## 6. Troubleshooting

| Symptom | Cause |
|---|---|
| `401` | Token is wrong, or was regenerated in the developer portal after you set it. Reset it in step 1 and re-export the new value. |
| `403` on a specific action | Role position: a bot can't manage a role positioned higher than its own highest role in the server's role list — reorder the bot's role above whatever it needs to touch. Also check for a channel-level permission overwrite that denies what the guild-level role grants; an overwrite wins over the role default. |
| A guild is missing from `users_list_current_user_guilds` | The bot was never invited to it. Repeat step 4 for that server. |
