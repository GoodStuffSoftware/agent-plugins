# discord

**Standing up a Discord server and connecting an agent to it means picking an MCP implementation, and most of the ones you'll find are unmaintained, undertyped, or ask for a user token — which is against Discord's Terms of Service and can get an account banned.**

This plugin doesn't add another one. It packages and configures [`cappyeo/discord-mcp`](https://github.com/cappyeo/discord-mcp) — an existing, actively maintained, Apache-2.0 MCP server with 209 typed tools against the Discord API — and adds the skills that were still missing: guided setup, building out a specific server layout, and posting release notes safely. **We did not write the MCP server.** All credit for the tool surface, the bot-identity verification, and the safety controls below belongs to that project.

## Why this server, and not a hand-rolled one

We looked at building a small hand-rolled server first. It turned out to be redundant — `discord-mcp` already covers the ground more carefully than a first pass would, and it ships with real supply-chain hygiene:

- **Bot-token only.** No user-account automation path exists in the tool surface.
- **209 typed tools**, each with a Zod input/output schema, generated docs, and annotations (`readOnlyHint`, `destructiveHint`, etc.) that a client can use to reason about risk before calling.
- **Verified npm provenance.** Releases publish with `--provenance` from GitHub Actions, so the npm tarball carries a signed Sigstore/SLSA attestation tying it back to a specific commit and workflow run — checkable with `npm audit signatures`.
- **No install-time scripts.** Neither the CLI package nor its workspace has a `postinstall`/`preinstall` hook — `npm install` (or `npx`) runs no code beyond unpacking the tarball.
- **No background phone-home.** In normal operation the only outbound calls are to `discord.com`. The two exceptions are both deliberate and non-automatic: `discord-mcp update` checks `registry.npmjs.org` for a newer version, and it only runs when you type it; and an OpenTelemetry OTLP exporter exists but is off unless you set `OTEL_ENABLED=true` and point it at your own collector. (One tool, `inspiration_*` in the emoji category, does call `emoji.gg` — but only when you explicitly invoke it, never as background traffic.)
- **Pinned, not floating.** This plugin launches an exact version (`0.26.1`) via `npx`, not `@latest` — see the version pin note below.

We're packaging this because building and maintaining an equivalent server from scratch would mean re-solving problems this project already solved, for no benefit to you.

## Install

```
/plugin marketplace add GoodStuffSoftware/agent-plugins
/plugin install discord@goodstuff
/discord:setup
```

`/discord:setup` walks you through creating the Discord application, getting a bot token, and inviting the bot to your server.

## Configure

Set these in the environment **before** starting Claude Code:

| Variable | Required | What it does |
|---|---|---|
| `DISCORD_TOKEN` | yes | The bot's credential, read once at launch by the MCP server. Never put this in a committed file — see below. |
| `MCP_TOOL_SURFACE` | set by this plugin's `.mcp.json` | `progressive` — see "Why `progressive` matters" below. You don't need to set this yourself. |
| `OTEL_ENABLED` | leave unset | Telemetry is off by default. Only set this if you're deliberately running your own OTLP collector. |

**`DISCORD_TOKEN` is never written into this plugin's `.mcp.json`.** Putting a bot token in a file that gets committed to a repo is exactly the failure mode we're avoiding — the server reads the token from whatever environment Claude Code was launched in, once, at startup. See the `setup` skill for how to set it and how `discord-mcp setup` builds a *non-secret* local profile around it (bot id + allowlisted guild, no token value) so you don't have to re-paste it into every client config.

### Why `progressive` matters

`discord-mcp` ships 209 tools. Without `MCP_TOOL_SURFACE=progressive`, all of them load into every session's context before you've asked for any of them. `progressive` mode instead loads a small front door plus a search/dispatch mechanism, and pulls in a tool's full schema only when something actually needs it. This plugin's `.mcp.json` sets it for you.

### Version pin

The `.mcp.json` in this plugin pins `@discord-mcp/cli@0.26.1` exactly, rather than `@latest`. That's deliberate: it means an update to the upstream package can't silently change what runs in your Claude Code session — bumping the pin is a reviewable diff in this repo, not something that happens invisibly on your next `npx` call.

## Skills

| Skill | Use it for |
|---|---|
| [`setup`](skills/setup/SKILL.md) | Creating the bot application, setting `DISCORD_TOKEN`, inviting it to a server, running `discord-mcp setup`, troubleshooting 401/403 |
| [`server-setup`](skills/server-setup/SKILL.md) | Building out this project's specific category/channel structure using the primitive tools |
| [`release-notes`](skills/release-notes/SKILL.md) | Posting a GitHub release's notes to a channel — gated to a cutoff, never a history backfill |

## What this deliberately does not do

- **No user-account automation.** Every tool in `discord-mcp` operates as the bot, never as a logged-in user account — automating a real user account is against Discord's Terms of Service and risks the account being banned. There's no self-bot path here, and we're not adding one.
- **No custom-status endpoint.** Setting a bot's "custom status" text the way a human user can from their client isn't a bot-API capability — the only route to it is `PATCH /users/@me/settings`, an undocumented user-account endpoint. The only way to drive it is a self-bot, which carries the same account-ban risk as any other user-token automation. Not implemented, not planned.
- **No bulk history backfill of anything.** See the `release-notes` skill for why this matters concretely right now: there's a known future backfill of ~100 historical releases, and this skill is built to refuse to mass-post them.

## License

This plugin (the skills, the `.mcp.json` configuration, this README) is MIT — see [LICENSE](../../LICENSE). The MCP server it configures, `cappyeo/discord-mcp`, is a separate project licensed Apache-2.0 — see [its repository](https://github.com/cappyeo/discord-mcp) for that license's terms.
