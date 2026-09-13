---
description: Build out the channel and category structure for a Discord server using discord-mcp's primitive tools — create categories and channels, apply permission overwrites, and verify the result. Use when setting up a new Discord server, laying out its channels, creating the channel structure, or asked to "set up my Discord server".
---

# Build the server structure

One server, three audiences: a public front door, public project channels, and a private space. This table is the target — treat it as the source of truth for every step below.

| Category | Channel | Visibility |
|---|---|---|
| START HERE | `#welcome` | public |
| START HERE | `#announcements` | public, read-only |
| PRODUCTS | `#best-sudoku` | public |
| PRODUCTS | `#star-rupture-planner` | public |
| PRODUCTS | `#simple-tile` | public |
| PRODUCTS | `#support` | public |
| BUILD | `#agent-templates` | public |
| BUILD | `#agent-plugins` | public |
| BUILD | `#contributing` | public |
| BUILD | `#dev-log` | public, read-only |
| STUDIO | `#notes` | private |

That's 4 categories and 11 channels.

## Use the primitive tools, not `guild_blueprint_plan`

`discord-mcp` also ships `guild_blueprint_plan` — a tool that turns a single natural-language request ("build a professional gaming server") into a complete guild build by mapping it onto a bundled template catalog. **Don't use it for this.** Two concrete reasons, not a stylistic preference:

1. It only accepts a natural-language `request` string and resolves it against pre-built templates (`professional_gaming` and others). This is a specific, already-designed 11-channel layout, not a request to have one designed.
2. Its schema (`GuildBlueprintSchema`) enforces `channels: min 12, max 32`. This layout has 11 channels. A blueprint plan for it would fail validation before it ever reached Discord — it isn't a matter of the tool being more or less capable, the shape of this layout is outside what that tool accepts.

Build it channel-by-channel with the primitive tools instead: `channels_list`, `channels_create_guild_channel`, `channels_modify_permissions`.

## Rules

- **`#announcements` and `#dev-log` are read-only for `@everyone`**: deny `SEND_MESSAGES`, leave `VIEW_CHANNEL` allowed (don't touch it — an overwrite you don't create simply doesn't exist, which is what "allowed" means here).
- **`#dev-log` is deliberately public.** This looks like a mistake if you don't know why: it's what stops a brand-new server from looking empty to a first visitor. Don't make it private.
- **STUDIO is private**: deny `VIEW_CHANNEL` to `@everyone` on the *category itself*, not per-channel — a channel with no overwrite of its own inherits its category's.
- **The `@everyone` role id equals the guild id.** There's no separate lookup for it — wherever a step below needs `@everyone`'s role id as `overwrite_id`, use the guild id.
- **`channels_modify_permissions` takes numeric bitfields, not permission names.** Its `allow`/`deny` fields are stringified integers — `"2048"` for `SEND_MESSAGES`, `"1024"` for `VIEW_CHANNEL` — not the string `"SEND_MESSAGES"`. (See the `setup` skill for where those bit values come from.)
- **It's a PUT, not a merge.** Each `channels_modify_permissions` call replaces that overwrite wholesale. If a target ever needs more than one denied (or allowed) permission, sum the bits and pass them together in one call — a second call overwrites the first rather than adding to it.

## Procedure

### 0. Check what already exists

```
channels_list  {guild_id}
```

Creating a channel that already exists produces a **duplicate**, not an error — Discord doesn't deduplicate by name. Compare the result against the table above and skip anything already there. This check is what makes the rest of this skill safe to re-run.

Also note: Discord lowercases channel names and turns spaces into hyphens itself, so `#star-rupture-planner` is what comes back even if the name you pass in isn't already in that exact form.

### 1. Create categories

`channels_create_guild_channel` with `type: 4` (`GUILD_CATEGORY`):

```
channels_create_guild_channel  {guild_id, name: "START HERE", type: 4}
channels_create_guild_channel  {guild_id, name: "PRODUCTS", type: 4}
channels_create_guild_channel  {guild_id, name: "BUILD", type: 4}
channels_create_guild_channel  {guild_id, name: "STUDIO", type: 4}
```

Capture each returned category `id` — the next step needs it as `parent_id`.

### 2. Create channels under each category

Omit `type` for a normal text channel (`GUILD_TEXT` is the default):

```
channels_create_guild_channel  {guild_id, name: "welcome", parent_id: "<START HERE id>"}
channels_create_guild_channel  {guild_id, name: "announcements", parent_id: "<START HERE id>"}
channels_create_guild_channel  {guild_id, name: "best-sudoku", parent_id: "<PRODUCTS id>"}
channels_create_guild_channel  {guild_id, name: "star-rupture-planner", parent_id: "<PRODUCTS id>"}
channels_create_guild_channel  {guild_id, name: "simple-tile", parent_id: "<PRODUCTS id>"}
channels_create_guild_channel  {guild_id, name: "support", parent_id: "<PRODUCTS id>"}
channels_create_guild_channel  {guild_id, name: "agent-templates", parent_id: "<BUILD id>"}
channels_create_guild_channel  {guild_id, name: "agent-plugins", parent_id: "<BUILD id>"}
channels_create_guild_channel  {guild_id, name: "contributing", parent_id: "<BUILD id>"}
channels_create_guild_channel  {guild_id, name: "dev-log", parent_id: "<BUILD id>"}
channels_create_guild_channel  {guild_id, name: "notes", parent_id: "<STUDIO id>"}
```

### 3. Apply the permission overwrites

Read-only channels — deny `SEND_MESSAGES` (`2048`) for `@everyone` (`overwrite_id` = the guild id, `type: 0` for a role):

```
channels_modify_permissions  {channel_id: "<#announcements id>", overwrite_id: "<guild_id>", type: 0, deny: "2048"}
channels_modify_permissions  {channel_id: "<#dev-log id>", overwrite_id: "<guild_id>", type: 0, deny: "2048"}
```

Private category — deny `VIEW_CHANNEL` (`1024`) for `@everyone` on the category:

```
channels_modify_permissions  {channel_id: "<STUDIO category id>", overwrite_id: "<guild_id>", type: 0, deny: "1024"}
```

### 4. Verify and report back

```
channels_list  {guild_id}
```

Compare the result against the table at the top and report the tree back — categories, their channels, and which ones ended up read-only or private — so it's clear what was actually built versus what was already there and skipped.
