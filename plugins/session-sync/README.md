# session-sync

**Your Claude Code conversations sync to another machine — and the sidebar is still empty.**

If you've moved `~/.claude` to a new computer and found your chat history nowhere in the Claude Desktop app, this plugin explains why and fixes it.

---

## The problem

Claude Code keeps conversation data in **two** places:

| # | Location | What it does |
|---|---|---|
| 1 | `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` | The transcript — the actual conversation |
| 2 | `<desktop-app-data>/claude-code-sessions/<user>/<workspace>/local_<uuid>.json` | The desktop app's **session index** — what puts a chat in the sidebar |

Every session-sync tool we could find copies **only #1**. That's enough for `claude --resume` in a terminal, which is why they all tell you to use it.

It is *not* enough for the desktop app. The app builds its session index on first run and **does not rebuild it** when it finds an already-populated `~/.claude` — so a machine restored from transcripts alone shows an empty sidebar while every conversation sits intact on disk. That's [anthropics/claude-code#69585](https://github.com/anthropics/claude-code/issues/69585), and it's the difference between "my history is technically recoverable" and "my history is *there*".

**session-sync copies both.** Open Claude on the other machine and your conversations are in the sidebar, where you expect them.

## Install

```
/plugin marketplace add GoodStuffSoftware/agent-plugins
/plugin install session-sync@goodstuff
/session-sync:setup
```

The setup skill checks for [rclone](https://rclone.org), helps you point it at a remote, and verifies the desktop session store was actually found.

## How it works

```
SessionStart ──▶ auto-pull   (only if another machine pushed — reads one small marker)
SessionEnd   ──▶ push
```

No timers, no daemon. Storage is any of rclone's 40+ backends — Google Drive, S3, R2, Dropbox, WebDAV, a NAS over SFTP. Default remote is `gdrive:Claude/live`; override with `CLAUDE_SESSION_SYNC_REMOTE`.

```bash
# manual, any time
node lib/cli.mjs status      # what's configured, what would sync
node lib/cli.mjs push        # local  -> remote
node lib/cli.mjs pull        # remote -> local
node lib/cli.mjs auto-pull   # pull only if another machine is ahead
node lib/cli.mjs config      # current settings
```

### Choosing where backups go

The default is `gdrive:Claude/live` — a `Claude/live` folder on an rclone remote named
`gdrive`. It is only a default. Any rclone backend, any path:

```bash
node lib/cli.mjs config remote s3:my-bucket/claude
node lib/cli.mjs config remote gdrive:Backups/ClaudeHistory
node lib/cli.mjs config remote nas:/volume1/backups/claude
```

Or just ask Claude — `/session-sync:setup` walks it. Settings live in
`~/.claude/session-sync/config.json`, so they persist for hooks and scheduled runs; no
environment variables to keep in sync across shells. Malformed values are refused rather than
saved, and pointing at a remote root warns instead of quietly mixing the backup in with
everything else.

| Setting | Effect |
|---|---|
| `remote` | where backups are stored |
| `enabled false` | pause syncing on this machine without uninstalling |
| `notifications false` | silence the start/finish toasts (failures still notify) |

`CLAUDE_SESSION_SYNC_REMOTE` overrides the file when set — handy for CI, and `config` reports
`source: "env"` so an edit that appears to do nothing is explainable.

### Only what changed gets sent

After the first sync, a local manifest (`path → size:mtime`) is compared on disk — about a
second for ~9,600 files — and only changed paths go to rclone via `--files-from`. An idle
session transfers nothing at all rather than paying for a full remote comparison to discover
that. The manifest is a cache: delete it, or point at a different remote, and the next sync is
simply a full one.

Deletions are reported, never propagated. Push only ever copies — a stale remote file costs
storage, a wrongly-deleted one costs the data.

### Switching machines without closing Claude

A start hook never fires if the app never restarts. `auto-pull` reads a `MACHINE|timestamp` marker on the remote, so a machine that stays open still notices when another one pushed. Run it on a timer if you like — it exits in well under a second when nothing changed.

## What syncs, and what deliberately doesn't

**Synced** — `~/.claude` (transcripts, memory, `CLAUDE.md`, agents, skills, settings), `claude-code-sessions/`, `local-agent-mode-sessions/`.

**Never synced** — `.credentials.json`, `.claude.json`, `mcp.json`, machine-bound tokens, caches, shell snapshots. A copied auth token fails on the far side rather than helping, and live tokens don't belong in cloud storage. Sign in normally on each machine.

## The one rule

**Use Claude on one machine at a time.** This is single-writer roaming: newest file wins per file, there is no merge.

In practice this matters less than it sounds — transcripts and session records are keyed by session UUID, so two machines write disjoint files and don't collide. The genuinely shared files are small: `CLAUDE.md`, `memory/*.md`, `settings.json`. Edit those on two machines between syncs and one edit can be lost. Nothing corrupts; an edit goes missing.

## Notes from actually running this on Windows

These cost real debugging time. If you're building something similar, they'll save you a day:

- **The MSIX-packaged desktop app redirects `%APPDATA%`** for processes it launches, to `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming`. Anything resolving `%APPDATA%\Claude\...` from a hook silently points somewhere that may not exist — the sync logs "skip (missing)" and reports success while copying nothing. This plugin probes candidate roots instead of trusting the environment.
- **rclone finds its config through `%APPDATA%` too**, so the same redirection makes scheduled syncs die instantly with `didn't find section in config file` while the identical command works by hand. `--config` is always passed explicitly.
- **winget installs rclone to a versioned directory** that isn't on a hook's `PATH`. A plain lookup reports "not installed" on a machine where it's installed and working.
- **Transcripts are appended while you sync them.** Without `--local-no-check-updated --ignore-checksum`, rclone aborts with `source file is being updated` / `corrupted on transfer: md5 hashes differ`. A slightly-short copy is harmless; the next sync corrects it. Never syncing is the real failure.
- **rclone's built-in Google client_id is shared globally** and rate-limited. ~9,500 transcript files hit `rateLimitExceeded` and failed every sync for a day. Requests are paced to stay under it; the real fix is [your own client_id](https://rclone.org/drive/#making-your-own-client-id).

Every one of those first surfaced as a sync that reported success and transferred nothing. If you take one thing from this repo, take that: **check bytes moved, not exit codes.**

## Requirements, and the rclone dependency

Node 18+ (Claude Code already requires it), **rclone**, and a configured rclone remote.

rclone is a separate install, and that is a deliberate trade. `/session-sync:setup` can run the
install for you (`winget` / `brew` / `apt`) with your approval, but `rclone config` is yours to
run — it is a browser sign-in to your own cloud account.

**What the dependency buys:** rclone holds the credentials, so this plugin never sees, stores or
transmits a token. It also brings 40+ storage backends, resumable transfers, retry and rate
limiting — all things a hand-rolled uploader gets wrong. Bundling a ~50 MB binary per platform or
vendoring cloud SDKs would mean *we* handle your OAuth tokens; using git as the transport (what
most alternatives do) breaks down past a few gigabytes and is against GitHub's acceptable use
policy for bulk storage.

**Until setup is done the plugin is inert** — it notifies you once, logs, and exits cleanly. A
missing or broken rclone can never fail a Claude session: every hook path exits 0 unless you pass
`--strict`. Windows / macOS / Linux — Windows paths are verified on real machines; macOS and Linux use Electron's standard userData locations and are probed rather than assumed.

## License

MIT — see [LICENSE](../../LICENSE).
