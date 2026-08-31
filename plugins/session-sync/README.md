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
/plugin marketplace add GoodStuffSoftware/claude-plugins
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
```

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

## Requirements

Node 18+ (Claude Code already requires it), rclone, and a configured rclone remote. Windows / macOS / Linux — Windows paths are verified on real machines; macOS and Linux use Electron's standard userData locations and are probed rather than assumed.

## License

MIT — see [LICENSE](../../LICENSE).
