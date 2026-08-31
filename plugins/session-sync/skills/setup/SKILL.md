---
description: Set up conversation sync on this machine — check for rclone, configure a remote, and verify the desktop session store is found. Use when installing session-sync, when sync isn't working, or when adding a new machine.
---

# Set up session sync

Walk the user through getting this machine syncing. Work through the steps in order and **stop at the first one that fails** — later steps depend on earlier ones.

## 1. Check what's already there

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" status
```

That prints JSON. Read `ready`. If it's `true`, the machine is already set up — skip to step 4 and just verify. Otherwise use these fields to find the gap:

| Field | If missing / false |
|---|---|
| `rclone` | Step 2 |
| `rcloneConf` / `remoteConfigured` | Step 3 |
| `sessionStores` empty, `missing` non-empty | See **Troubleshooting** |

## 2. Install rclone (if `rclone` is null)

Offer the right command for the platform, then re-run status:

- **Windows** — `winget install Rclone.Rclone`
- **macOS** — `brew install rclone`
- **Linux (Debian/Ubuntu)** — `sudo apt install rclone`
- **Any** — `curl https://rclone.org/install.sh | sudo bash`

Do not attempt a silent install; tell the user what you're about to run and let them approve it.

**After installing, open a NEW terminal.** A shell started before the install won't have rclone on PATH — this plugin resolves the binary directly so it usually still works, but any manual `rclone` command the user runs will not.

## 3. Configure a remote (if `remoteConfigured` is false)

The user runs this themselves — it opens a browser for their cloud account, and it needs credentials you must never handle:

```bash
rclone config
```

Guide them: `n` (new remote) → **name it exactly `gdrive`** → pick the storage type → leave client_id/secret blank for now → accept defaults → sign in when the browser opens.

Any rclone backend works (Drive, S3, R2, Dropbox, WebDAV, …). To use a different remote or path, set the environment variable — the default is `gdrive:Claude/live`:

```
CLAUDE_SESSION_SYNC_REMOTE=myremote:some/path
```

Verify: `rclone lsd gdrive:`

### Worth mentioning if they chose Google Drive

rclone's built-in Google client_id is shared by every rclone user and has a small global quota. Syncing thousands of transcript files can hit `rateLimitExceeded`. The scripts pace requests to stay under it, but the real fix is a personal client_id (~10 minutes, one time): <https://rclone.org/drive/#making-your-own-client-id>

## 4. First sync and verify

Push this machine's data up:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" push
```

Then confirm what landed:

```bash
rclone lsf gdrive:Claude/live --dirs-only
```

You want to see **three** entries: `dot-claude/`, `claude-code-sessions/`, `local-agent-mode-sessions/`. If the last two are absent, the desktop sidebar will not restore on other machines — see Troubleshooting.

## 5. Explain the model before finishing

Tell the user plainly:

- **One machine at a time.** This is single-writer roaming: newest file wins, there is no merge. Transcripts are per-session so they rarely collide, but shared files (`CLAUDE.md`, `memory/*.md`, `settings.json`) can lose an edit if two machines write them between syncs.
- **Hooks do the work.** Session start pulls if another machine pushed; session end pushes. No timers to configure.
- **Credentials never sync.** `.credentials.json`, `.claude.json`, `mcp.json` and machine tokens are excluded by design — sign in normally on each machine.

## Troubleshooting

**`sessionStores` is empty or `missing` is non-empty** — the desktop app's data directory wasn't found. Only `~/.claude` will sync, so conversations will be resumable via `claude --resume` but **won't appear in the sidebar**. Check whether Claude Desktop is installed for this user, then run `status` again. On Windows the app may be MSIX-packaged, which puts its data under `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude` — the plugin probes that automatically.

**Sync "succeeds" but nothing transfers** — look at `~/.claude/session-sync/sync.log`. Historically this meant an environment problem, not a network one: a redirected `%APPDATA%` pointing at a nonexistent path, or rclone unable to find its config.

**Conversations synced but the sidebar is empty** — restart Claude Desktop. The app builds its session index at startup and doesn't rebuild it when it finds existing data (anthropics/claude-code#69585). The chats are not lost; `claude --resume` will list them.
