---
description: Show sync health — what is configured, what would sync, when the last sync ran, and whether another machine has newer data. Use when the user asks if their conversations are backed up or whether sync is working.
---

# Sync status

## Gather

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" status
```

```bash
tail -20 ~/.claude/session-sync/sync.log
```

## Report on

**Is it ready?** — `ready: true` means rclone, its config, the remote, and `~/.claude` are all present.

**Will the sidebar restore?** — this is the question users actually care about. Check `sessionStores`:
- Both `claude-code-sessions` and `local-agent-mode-sessions` present → conversations come back **in the desktop sidebar**.
- `missing` non-empty → only `~/.claude` syncs, so chats are resumable via `claude --resume` but **won't appear in the sidebar**. Say this plainly; it's the difference the plugin exists for.

**When did it last run?** — from the log, `~/.claude/session-sync/last-pull.txt`, and `last-push.txt`. A last sync many hours old on a machine in daily use suggests hooks aren't firing: check the plugin is enabled and look for hook errors. A gap of a few minutes is normal and expected — hook-triggered syncs are debounced (`config.debounceMinutes`, default 5) so that several conversations ending close together don't each trigger their own sync; a manual `push`/`pull` always runs immediately regardless.

**Did a hook-triggered sync actually finish, or just start?** — hook-triggered runs hand off to a detached background process and the hook itself returns almost instantly (this is what lets a multi-hour push survive the hook's own timeout). The log line to look for is `push -> ... (handed off to background pid N)` followed, once the background process finishes, by its own `push ok`/`push FAILED` line — if only the hand-off line appears, the background process may still be running or may have been killed itself; check for a lingering `sync.lock`.

**What is deliberately not synced** — credentials and machine tokens (`excludes`). Mention this if the user wonders why they had to sign in again on a new machine; it's intentional, not a bug.

## Don't overstate

Report what the log actually shows. "Last sync ok" is only true if the log says so — a task that exited 0 after skipping everything is not a successful backup. If the evidence is ambiguous, say what you checked and what you couldn't confirm.
