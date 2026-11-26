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

A hook-triggered sync hands off to a detached background process and returns immediately —
a real push has taken over four hours on a large, rarely-synced `~/.claude`, which is well past
both hook timeouts and the lifetime of the conversation that triggered it. A manual
`push`/`pull`/`auto-pull` (typed by hand, or run by the `sync` skill) always runs synchronously
instead, so its result is real when the command returns.

```bash
# manual, any time
node lib/cli.mjs status      # what's configured, what would sync
node lib/cli.mjs push        # local  -> remote
node lib/cli.mjs pull        # remote -> local
node lib/cli.mjs auto-pull   # pull only if another machine is ahead
node lib/cli.mjs config      # current settings
```

**Pushing while Claude runs.** A push never needs Claude closed. A file that changes or vanishes while rclone copies it (a live transcript, `.claude.json`, a file Windows holds open) does not fail the push and does not trigger a whole-run retry. Each such file is copied to a private snapshot and uploaded once; a transcript sent that way is cut at its last complete line and its remote mtime is 5 seconds older than the local file, so a later pull never overwrites a longer local transcript with the shorter prefix. A file that still cannot be settled is deferred to the next push (the manifest does not advance past it). Deferred files are listed in `~/.claude/session-sync/deferred-files.json`, in `status` (`deferredFiles`), in `sync.log` (`deferred N file(s) ...`) and in the manual `push` output; the file is removed after a push that deferred nothing. Real failures (network, quota, auth) still fail the push and retry.

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
| `notifications false` | silence EVERYTHING, including failures — a full opt-out |
| `notifyMode` | how chatty routine (non-failure) toasts are: `first-run` (default — one toast ever, to confirm it's alive, then quiet), `all` (a toast every time), `failures` (never, only failures/conflicts show) |
| `debounceMinutes` | hook-triggered pushes only: **defer** (never discard) if the last one succeeded within this many minutes (default `5`; `0` disables the wait). Several conversations ending together coalesce into one background push that runs when the window lapses — the request is recorded on disk, so even a machine shut down mid-wait retries it next session. Never applies to a manual `push`/`pull` — the sync skill's "push before switching machines" always runs immediately. |
| `rcRestore.enabled` | Remote Control restore after a restart of Claude (Windows; default `true`): relinks stale links and marks recent sessions so the app reconnects them at its next start. See "Remote Control after a restart" below |
| `rcRestore.days` | only conversations active within this many days are looked at (default `3`, 1 to 90) |
| `rcRestore.wake` | after the restart, the first prompt of one session wakes the rest, costing one model turn in each (default `true`; `false` keeps the relink and the free restore only) |
| `rcRestore.wakeMax` | the most sessions one restart wakes, most recently active first (default `4`, 1 to 50) |
| `rcRestore.liveRelink` | Windows: clear a stale Remote Control link in place for sessions whose CLI is not running, while Claude runs: `idle-only` (default) or `off`. See "Live relink" below |
| `rcRestore.liveMax` | the most sessions one live relink pass clears (default `10`, 1 to 100) |
| `rcRestore.liveEveryMs` | how often the watcher runs the live relink while Claude runs, in milliseconds (default `600000`, 60000 to 86400000) |
| `rcRestore.spawnFix` | repair, at a quit or an account switch, the Remote Control spawn record of a session that was started from claude.ai under the account you switched away from: `auto` (default) or `off`. Independent of `rcRestore.enabled`. See "Sessions started from claude.ai under another account" below |
| `rcRestore.logonTask` | Windows: a hidden "At log on" task runs the relink after a Windows restart (default `true`; `false` opts out and removes the task). See "When Windows restarts or shuts down" below |
| `progressIcon false` | no progress indicator during the account go-live (default on: a tray icon with the current step plus a start and an end balloon on Windows, a start and an end notification on macOS and Linux). The go-live itself is unchanged |

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

## Multiple accounts on one machine

The desktop app keeps Code-tab conversations per account and organization, in `claude-code-sessions/<account>/<org>/`. Sign into a second claude.ai account and the sidebar shows only that account's conversations; the others are still on disk, out of sight. session-sync can link the accounts on one machine so every conversation, local scheduled task and per-account setting shows in all of them.

**What is shared:** Code-tab conversations (continue any of them from either account), local scheduled tasks (run history stays in step, so nothing runs twice), per-account settings (backlog, presets, UI and permission preferences, tool toggles, Remote Control folder preferences) and Cowork memory.

**What stays with each account:** the app's sign-in, and everything claude.ai keeps server-side: cloud sessions, cloud routines, projects, chats, artifacts and connectors. `/session-sync:accounts` walks the checklist for those (connectors to add, artifacts to share or republish, chat memory to copy by hand).

**How it works.** Each conversation appears in every linked folder as a hard link to one file, so the app in either account reads the same bytes. The app's own save replaces a file, which breaks that link; a rectify pass then keeps the newest copy, copies the older one to a backup folder and links the name again. Tasks, backlog and settings are kept in step by a three-way merge against the state at the last full pass.

**Switching accounts.** Once the accounts are linked you can sign out, sign in to the other account, switch back, sign out with conversations running, or sign in with an account for the first time, and the account you just signed in to shows every conversation, current and resumable, with no restart and no quit. The app reads an account's folder only at sign-in and then keeps it in memory, so a watcher (the waiter process the session hooks start with Claude's first Code session, through the same hidden launcher) keeps every folder the app has not loaded current, about 2 seconds after each save, and only adds new names to the folder the app has loaded. The account you just left is left alone for 15 seconds, because the app may still flush a last save into it. If a conversation was saved at the very moment of a switch and then continued from the older copy, the newest version is kept everywhere, the displaced one goes to `rectify-backups`, and `accounts status` lists the case (a notification only when the older copy pointed at a different transcript). A conversation that is still running in the account you left (a direct switch with a conversation open) is never re-linked or deleted there; `accounts status` says so. Anything the watcher had to hold back is finished by the full pass after your next normal quit. Push stays home-folder only, so nothing uploads twice.

**Restart Claude to sync your accounts.** (Only for an account that is not linked yet.) Quit Claude from the tray icon or app menu (macOS: Cmd+Q; closing the window only hides it). The sync starts right away. With `go-live` Claude reopens by itself when it is done; a plain `answer yes` or `link` waits for you to quit, tells you when it is done, and you open Claude again.

**How it triggers.** Nothing runs until you say so. When a SessionStart finds two or more accounts it asks once per pair (at most three times, a week apart). Answer yes and, if Claude is running, the link waits for you to quit it from the tray icon (Windows) or Cmd+Q (macOS), because closing the window only hides it. The `accountLink` setting controls the question:

| `accountLink` | Effect |
|---|---|
| `ask` (default) | ask once per account pair |
| `auto` | link without asking |
| `off` | never ask, never touch the per-account folders |

```bash
node lib/cli.mjs config accountLink off     # ask | auto | off
```

`CLAUDE_PLUGIN_OPTION_ACCOUNTLINK` overrides the file when set to a valid value.

### Commands

`node lib/cli.mjs accounts <command>`; every command takes `--json`.

| Command | What it does |
|---|---|
| `status [--all] [--remote]` | accounts, pairs, link health, app state, tasks due a catch-up, and the claude.ai-only lists; `--remote` checks Drive for duplicates, `--all` lifts the list caps |
| `answer yes\|no` | answer every pending pair (`yes` also re-answers pairs set to "no", so it links again after an unlink or rollback); yes links now when Claude is stopped, otherwise arms the link for when it exits |
| `go-live [--yes] [--no-relaunch] [--quit-app]` | the whole go-live in one command: records your yes, then a hidden background runner waits for Claude to stop (no time limit: it starts as soon as you quit Claude, and a reboot or a dead runner is picked up again at the next session start), backs up, links, verifies every folder, starts Claude again (right after the link or the rollback, and after a failure too; `--no-relaunch` opts out), runs a pass and checks the remote for duplicates. A failed check rolls back by itself. `--quit-app` has the runner ask Claude to quit a few seconds in (macOS only; on Windows and Linux you quit from the tray icon or the app menu and the runner waits). While it works, a tray icon on Windows (a notification on macOS and Linux) shows the step and says when it is done; `config progressIcon false` turns that off. The next session start reports the result once. Running it again resumes an unfinished go-live, and replaces a runner that is still waiting for Claude to stop with one from the current plugin version |
| `link [--now]` | link; `--now` is refused while Claude is running |
| `rectify` | one pass by app state (a live pass while Claude runs, a full pass when stopped) plus the remote check |
| `unlink [--when-app-exits]` | keep the newest content, remove the mirrored copies, end the link |
| `rollback [--exact] [--dry-run]` | restore the backup taken before the link |

Exit codes: `0` ok, `1` failed, `2` bad arguments, `3` refused (the app is running, nothing linked, no backup).

### Safety

- **The app must be closed for the full pass.** While Claude runs, only the targeted pass happens: folders the app has not loaded are kept fully current, the loaded folder only gains new names, and anything else waits. A background waiter finishes the work after your next normal quit, and it tells you when it does: whatever runs while Claude is closing or closed shows the same tray icon and balloons as the go-live (a balloon when the pass starts and one when it ends; a notification on macOS and Linux). `config progressIcon false` turns that off. While Claude is closed and nothing is owed the waiter is idle: it does not keep asking the system about Claude (the lock file waking it is enough). Once the accounts are linked nothing asks you to restart or quit Claude again; the only "Restart Claude to sync your accounts" prompt is for an account that is not linked yet (a new account that signs in later gets it once). Beyond the quit-time balloons, a notice is only for a real problem (a failed link or rollback, remote duplicates).
- **A verified backup comes first.** Before the first link (and again before linking after an unlink or rollback) the plugin copies the affected files to `~/.claude/session-sync/accounts/backup/<stamp>/` and checks them. If verification fails, the link does not start.
- **Nothing is erased.** A displaced or deleted conversation, task or memory file is copied to `accounts/rectify-backups/` first.
- **Rollback** (`accounts rollback`) restores that backup. The backup folder also holds a standalone `rollback.mjs` that needs only Node, so it works even if the plugin is broken: `node "<backup folder>/rollback.mjs"`. Rollback also brings back conversations and scheduled tasks deleted after the link (a restored task keeps the backup's last run time, so its catch-up can run once) and reverts edits made after the link; the newer copies stay in a `pre-rollback-<stamp>` folder in `~/.claude/session-sync/accounts/`.
- **Drive uploads each conversation once.** Push sends only the copy in the folder where a conversation first appeared; mirrored names never upload, so the remote has no duplicates. `status --remote` checks that.
- **Never downgrade to 0.3.0 while linked.** 0.3.0 has no push filter and would upload every mirrored copy. Run `accounts unlink` (or `accounts rollback`) first.

Windows needs no administrator rights and the plugin opens no windows. The macOS and Linux paths follow the app's standard data folders and are untested.

## Sharing new artifacts across accounts

Artifacts live on claude.ai, not on disk, so linking accounts does not share them: an artifact belongs to the account whose session published it. The other account gets access only through a share invite with Editor access, which has to be sent from a browser signed in as the owner and accepted as the receiver. session-sync automates the part an agent can do. It needs linked accounts; `config artifactShare.enabled false` turns it off.

Editor access lets the other account open and edit an artifact, but gives it no live comment watch. The two accounts are in different claude.ai organizations, so after an account switch, watches on the other account's artifacts stay off until the app switches back to the owner. Re-sharing does not fix it. agent-companion (0.31.69 and later) detects and reports this; see `/session-sync:accounts`.

1. **Capture.** A `PostToolUse` hook on the `Artifact` tool queues every newly published artifact (a publish with no `url`, including one made from a `type_url`; updates, uploads, reads, lists and deletes are ignored) in `~/.claude/session-sync/artifact-queue/`, with the account the app runs as at that moment as its owner. It prints nothing.
2. **Trigger.** A `UserPromptSubmit` hook (its own small command, so a prompt with nothing to do costs a directory listing and a few small reads) tells one interactive session to run the `share-artifacts` skill in a single background browser subagent when a browser that session's account can reach can make progress: the owner's browser for a queued artifact, or the receiver's browser for a sent invite. It does not wait for an account switch. It acts only on entries older than about 2 minutes, at most once per 30 minutes per account (an exclusive file create; a terminal, headless or scheduled session never takes it), and leaves Chrome work alone for 30 minutes after a run reports Chrome unavailable. It stays silent until the emails of both accounts are set (below). Any error exits 0 with no output.
3. **Share.** The skill drives agent-driven browsers: the Claude desktop app's browser pane (reachable from a session of either account) and, when set up, Claude in Chrome (reachable only from sessions of the account its extension is connected to, and only while Chrome runs). It sends an Editor invite from a browser signed in as the owner, then clicks Accept in a browser signed in as the receiver. When the receiver's browser is not reachable it records the invitation link and the session hands it to you to open and Accept, as before. Nothing opens a browser window by itself (Chrome is never launched), and nothing calls claude.ai's APIs. Public ("Anyone with the link") artifacts are skipped and left as they are. Artifacts owned by an account no reachable browser holds stay pending. Where it can, the session then checks with the `Artifact` tool's `read` (the header says "(writer)") and marks them done.

**Claude in Chrome setup (optional, for fully automatic sharing).** The pane is signed in as one account; a second browser signed in as the other account lets one session do both halves. Once, on the machine: use a separate Chrome profile signed in to claude.ai as the other account, install the Claude extension in it and connect the extension to that account, then register it (the account id is the one the extension is connected to):

```bash
node lib/cli.mjs artifacts pane <that account's email> --browser chrome --account <that account's id>
```

Chrome has to be running for sharing to happen: agents never start it, and when it is closed the work waits. Because the extension is listed only to sessions of its own account, everything an agent can do happens from a session of that account: the other account's artifacts are sent from the pane and accepted in Chrome, its own artifacts are sent from Chrome and accepted in the pane. A session of the other account can still send its own artifacts from the pane, but cannot reach Chrome to accept them.

One setting is needed once, because the plugin never reads the app's account fields: the email of each linked account.

```bash
node lib/cli.mjs config artifactShare.email <account id or its first 8 characters> <email>   # once per account
node lib/cli.mjs config artifactShare.enabled true                                            # default; false turns it off
node lib/cli.mjs artifacts pending|list [--json] [--with-invited]                              # the queue (pending also lists sent-not-accepted with the flag)
node lib/cli.mjs artifacts mark <id> pending|invited|accepted|done|failed|skipped [--link L] [--reason R]
node lib/cli.mjs artifacts pane <email> [--browser chrome] [--account <id>]                   # record a browser and the account that can reach it
node lib/cli.mjs artifacts chrome-unavailable                                                  # a run found Chrome not connected: back off 30 minutes
node lib/cli.mjs artifacts forget <id>
```

## Remote Control after a restart

After any restart of the Claude desktop app, Remote Control is off for every Code session, and after an account switch the CLI can reattach to a link that was made in a cross-account fallback (a random name that a rename never reaches). From 0.5.4 (Windows; macOS and Linux do nothing) the plugin repairs both, with the same background watcher that follows account switches. It also runs with one account that was never linked, and the relink and the restore in steps 1 and 2 never write while Claude runs (the live relink below writes only to a transcript whose CLI is not running).

1. **Relink, when you quit Claude.** For the current account's conversations active in the last `rcRestore.days` days, a saved link whose last `bridge-session` entry is a fallback link (`noHistoryBackfill`) or was minted while another account was signed in is cleared with the CLI's own clearing line, after a backup under `accounts/rc-restore/backup/`. The next connect makes a fresh link named after the session. Idempotent. "Minted under another account" comes from a ledger (`accounts/rc-links.json`: the account that was signed in when a link was first seen) and the account switch history (`accounts/switch-history.json`, seeded from the app's `remote-control.log`), never from the `ownerAccountUuid` stamp in the link: that stamp is the CLI's cached identity, not the signed-in account, and carried the same value on healthy links. A link that cannot be dated is left alone. To date a link the plugin reads the `bridge-session` lines of a transcript and the `"timestamp"` value of the nearest line before the first one that names the link (a bridge-session line has no timestamp of its own); with none, the transcript's last-write time stands in.
2. **Free restore, while Claude is closed.** Up to 4 of the most recent distinct local, non-archived, non-scheduled conversations that had Remote Control on get the two markers the app's own launch pass reads (`remoteControlLiveAtUpdateQuit` and `remoteControlAutoEligible`). "Had Remote Control on" means the session still has its Remote Control switch on, or has an old Remote Control link in its history; sessions with the switch on come first, and a session whose switch was turned off is never touched. With linked accounts a conversation lives in each org folder of the group, and it counts once. When Claude starts, the app reconnects them with no model turn and no cost. The marker is refreshed every 20 minutes while Claude stays closed (the app ignores one older than an hour), records are edited in place so linked-account hard links survive, and `interruptedByQuitAt` is never set. Whether the app's launch restore runs is decided by flags on Anthropic's servers; after the next start the watcher logs the app's own outcome (`ran`, `gate_off`, `flags_not_fetched`) in `sync.log`.
3. **Wake the rest, once Claude runs.** The first real prompt of an interactive session after a restart (a `UserPromptSubmit` hook; one session per restart, claimed with an exclusive file create; scheduled and unattended sessions never take it) gets a one-time instruction: say one line to you, list the sessions, send each non-archived interactive session active in the last `rcRestore.days` days that is still off (at most `rcRestore.wakeMax`, default 4, the most recently active first) the message "Remote Control reconnect after the Claude app restart. No action needed: reply with the single word ok. Do not run any tools or resume any work.", then say "Remote Control: N sessions reconnected, M still off". **Cost: each wake-up is one model turn in the session that is woken.** The reply is one word, but the turn re-reads that conversation (after a restart the prompt cache is usually cold), so a long conversation costs more than a short one; that is why one restart wakes at most `rcRestore.wakeMax` sessions. A send the session tool refuses is skipped and counted as still off. `config rcRestore.wake false` drops this step and keeps the first two.

**When Windows restarts or shuts down.** The app then quits with the OS and there is no time for step 1 (new processes cannot start while the session ends), so a relink stays owed and the session reconnects on its old random-name link. The first wake prompt after that restart checks, once per app run, whether sessions are still owed a relink and no restore pass ran for the last stop; if so it records that in `accounts/rc-relink-owed.json` (dropped when the next quit-time relink settles it) and the agent says one more line: "Your Remote Control session names were not restored after that restart: quit Claude once from the tray icon (not a Windows restart) and reopen it to get them back." It rides on the wake instruction, so `rcRestore.wake false` silences it too.

**The logon task (relink after a Windows restart).** So that a Windows restart or shutdown does not leave the relink owed, session-sync installs a hidden per-user scheduled task, **"session-sync RC restore"**, trigger "At log on". It runs `accounts rc-restore --if-app-stopped` before Claude starts (on the machine this was measured on, the app starts about 85 s after logon): if the app is stopped and a relink is owed, it runs the same relink as the quit step, after a backup, checking the app's lock marker before every write; if the app is running or starts mid-way it writes nothing more and the relink stays owed; with nothing owed it exits quietly. One line goes to `sync.log` when it did something. No window appears: the task runs `wscript.exe //B` on a shim in `~/.claude/session-sync/` that starts node with window style 0, and a launcher beside it picks the newest installed session-sync copy (plugin cache, then the marketplace clone), so plugin updates do not break the task. It is installed by itself at a session start while `rcRestore.enabled` and `rcRestore.logonTask` are on (Windows only; elsewhere nothing happens). By hand: `node lib/cli.mjs accounts rc-restore install-logon-task` and `... uninstall-logon-task` (both safe to repeat; each also saves `rcRestore.logonTask`, so a removal is not undone at the next session start). Uninstall the task before you remove the plugin, or its launcher logs "no installed session-sync copy" at every logon. Check it with `schtasks /Query /TN "session-sync RC restore" /V /FO LIST` (Task To Run is `wscript.exe //B //Nologo ...rc-restore-logon.vbs`). `config rcRestore.logonTask false` removes it too. The task is visible in Task Scheduler; "hidden" here means it never opens a window.

Two copies of the plugin can run on one machine (your plugin cache, and the Claude app's own copy, which can lag behind). The singleton watcher is only ever replaced by a newer version (compared as semver) or by the same version with different code; an older copy leaves a newer watcher running.

**Live relink (0.5.7, while Claude runs).** A random-name link no longer has to wait for a restart. For a session whose Claude Code CLI is not running, the plugin clears the stale link in place (the same clearing line, after the same backup), so the next time that session connects, the app makes a fresh titled link. It never stops a process and it never touches a session that is, or might be, in use. A session is cleared only when all of these hold, checked again right before the write:

* its CLI is not running (a hidden PowerShell process listing; if the listing fails or any command line cannot be read, nothing is cleared);
* its transcript has not been written to for 120 seconds and the session is not in the middle of a turn (0.5.12: the sweep at an account switch does not ask this of a link minted before the switch, because the app's own CLI teardown at the switch touches every transcript; the live-CLI check still applies, and a transcript written after the pass first saw it is left for the next pass);
* it is not the session the hook itself runs in;
* its link is a `noHistoryBackfill` gone-bounce, was minted under another account (see above), or was minted before the current sign-in began, whatever account minted it (0.5.10, see "Relink after a round trip" below).

After the write it lists the processes once more; a CLI that appeared in between is logged as `raced`. At most `rcRestore.liveMax` sessions (default 10, most recently active first) are cleared per pass. It runs from three places: the wake hook, before the first prompt after a restart gets its instruction (so the hook's timeout is now 30 seconds, not 10; every other prompt still exits at once); the background watcher, every `rcRestore.liveEveryMs` (default 10 minutes) while Claude runs; and a sweep of every non-archived session at the moment you switch accounts. A pass that finds candidates logs one line to `sync.log`, such as `rc-live: cleared 2 (ab12cd34, ...), skipped live 5, quiet 1, raced 0`. With `rcRestore.wake false` the wake hook does no relink; the watcher still does. If the accounts lock is busy when the wake prompt arrives (the watcher is mid-pass), the hook skips its relink, logs it, and the watcher's next pass does it. A link that cannot be dated from the ledger, the switch history or a timestamp near it is judged by the transcript's modified time: stale when nothing was written to the transcript since the sign-in began, otherwise left alone.

`accounts rc-restore --live [--all] [--dry-run] [--json]` runs one pass by hand. `--all` covers every non-archived session instead of the last `rcRestore.days` days. `--dry-run` writes nothing, prints one line per session it would clear with the reason (`noHistoryBackfill` or `link minted under another account`) and the counts of sessions skipped because their CLI is live, because they were written to a moment ago, or because the process list is unknown; it runs even when the live relink is off. A real run honours `rcRestore.enabled` and `rcRestore.liveRelink`. `config rcRestore.liveRelink off` (or `idle-only`, the default) switches only this part; `rcRestore.enabled false` switches everything.

`accounts rc-repair <localSessionId|cliSessionId> [--stop-cli | --at-turn-end] [--dry-run] [--force] [--verify] [--json]` is the file-side half of the standing fix for a session that shows a random Remote Control name while its Claude process runs (the app-side steps are in the accounts skill, section "Random Remote Control name on a running session"). It refuses a mid-turn session, a link that is already cleared or healthy (without `--force`), a live CLI without `--stop-cli`, and an unreadable process list. With `--stop-cli` it stops only the `claude.exe` whose command line holds that exact `--resume <id>` (hidden), re-checks that it is gone, backs the transcript up under `~/.claude/session-sync/accounts/rc-restore/backup/<stamp>/`, and appends the CLI's own clear line. `--verify` prints the last link id, whether it has `noHistoryBackfill`, and PASS or FAIL. It works whatever `rcRestore.enabled` is and never prints a command line.

**Sessions started from claude.ai under another account (0.5.9).** A session you started from claude.ai or the phone while another account was signed in keeps a live `remoteControlSpawn` in its record, and its `bridgeSessionIds` hold that account's `cse_` ids. After a switch the app attaches every resume to the old account's org and stops the session, and the record keeps the old id until the app's own detach (which does not fire for this case). With Claude stopped, session-sync fixes the record: it backs it up byte for byte under `accounts/rc-restore/backup/<stamp>/`, then edits it in place (open, write, truncate: one inode, so every hard link in every account folder shows the change). The spawn gets `detachedAt` exactly as the app writes it, and the foreign `cse_` ids leave `bridgeSessionIds`. Nothing else in the record changes, key order and formatting included; a record whose unedited round trip is not byte-identical is left alone and reported as skipped (`format`). "Minted under another account" uses the ledger, then the transcript (dated against the switch history), then for the spawn id the account that was signed in when the record was created; a session that cannot be dated is skipped (`undated`), never touched, and so is one started under the current account or already detached. It runs at the account pass (the switch and the link), the quit step, the logon step and the watcher's stop step. While Claude runs it only reports (the wake hook, at most every 10 minutes, and the watcher), with "fixed at the next quit of Claude or account switch" in `sync.log`; the app would overwrite an edit made while it runs. `accounts status` shows the sessions flagged now and the ones fixed earlier; `sync.log` gets one `rc-spawn: found N, fixed M (ids), pending P, skipped S` line. `config rcRestore.spawnFix off` turns the automatic runs off. `accounts rc-spawn-fix [--dry-run] [--json]` runs it by hand: `--dry-run` writes nothing and works while Claude runs; a real run needs Claude stopped and works even with the setting off.

**Relink after a round trip (0.5.10).** The app retires an account's Remote Control instance at every switch. After an A to B to A round trip, a session whose last link was minted under A before the round trip points at a dead instance: when Remote Control reconnects, the CLI reattaches to it, fails, and mints a fresh link with a default `<hostname>-<adjective>-<noun>` name instead of the session title. So a link counts as stale when it was minted before the current sign-in began, whatever account minted it and whatever its `ownerAccountUuid` says (that stamp is the CLI's cached identity and unreliable). A link is dated by the ledger or by the first transcript line that names it, against the switch history. The same rule runs in the account-switch sweep, the quit-time and logon relink and the live pass. The sweep and the live pass write only when no CLI runs (a process listing, read again right before the write), after a backup, with the CLI's own clear line, and never while the process list is unreadable. The quit-time and logon relink run with the app stopped, so no CLI of its sessions can be running; they have no process listing of their own. "Minted before the sign-in" is judged by an upper bound: a link counts as stale only when the first transcript line after it, or the transcript's modified time when no line follows, is older than the sign-in start (a link whose neighbouring timestamps straddle the start is left alone). The sign-in start is the time the plugin saw the switch, so a switch noticed late (the machine was asleep) can start a little after the real sign-in.

The switch sweep is patient. The app tears its CLIs down while it switches, so the process list can fail to read for a while. The sweep then writes nothing and retries with back-off for about 3 minutes, has a very high cap (1000 sessions) instead of the periodic pass's 10, and a watcher that starts within 15 minutes of a switch (or the first time it sees the app running) sweeps at once. A `noHistoryBackfill` link is cleared by an automatic pass only when it is a gone-bounce, that is when the entry before it is a different non-empty link. After a clear line, as a first link, or in a transcript with a `history-suppression` line (the CLI's own safety record: every resume mints a `noHistoryBackfill` link there) it is left alone, because clearing it only makes the next resume mint the same flag again and orphan another remote session.

`accounts rc-sweep [--before <iso>] [--dry-run] [--json]` runs that sweep once by hand. The cutoff is the start of the current sign-in unless `--before` names another date-time. It skips a session whose CLI runs, writes nothing while the process list cannot be read (three tries), backs each transcript up under `~/.claude/session-sync/accounts/rc-restore/backup/<stamp>/` and appends the CLI's own clear line. It exits non-zero when it could not read the process list or a write failed. It prints one line per session (`cleared`, `would-clear`, `live`, `quiet`, `mid-turn`, `unknown`, ...) and a summary. Run `--dry-run` first. It works whatever `rcRestore.enabled` and `rcRestore.liveRelink` are.

### Connector check after an account switch (0.5.14, background run in 0.5.15)

A scheduled task can use a connector (Gmail, Grocery Run, Drive) that is connected on one claude.ai account and not on the other. After a switch the task then runs without it and fails silently. session-sync notes each switch in a small marker (`accounts/connector-check.json`: switch time, from and to account) and, from the SessionStart hook, compares each enabled scheduled task's last run before the switch with its first run after it. The app keeps no connector list, so the check reads each run's own transcript (tool names only; no line is kept or printed). The connectors that matter are the ones the earlier run called plus any connector id written in the task's prompt file. A connector counts as missing when none of its tools is available in the later run. When the same tools are available under another id (ids differ between accounts), it is reported as "available under a different id; the prompt hardcodes <id>" when the prompt names the old id, and not reported otherwise.

The SessionStart hook never scans: it reads the marker and, at most once per 15 minutes per switch, starts the check as a hidden background process (`accounts connector-check --background`, one at a time through a claim file) and returns at once. The background run does the full check; before it writes flags, the notice or a toast it re-reads the marker and drops its result when a newer switch was recorded meanwhile. A task with no run since the switch stays pending and is rechecked at the next session start. The marker retires when every enabled task is checked, or after 8 days. The alert is local only: a tray toast (respects `notifications`), `CONNECTORS-MISSING.md` in the session-sync folder with the fix per task ("connect <name> on <account>, or switch back"), and one line in the next session's start context. Each is told once per switch and task. No Discord and nothing is sent outward.

`accounts connector-check [--since <iso>] [--json] [--dry-run]` runs the check by hand. Without `--since` it checks the pending marker; `--dry-run` writes no state and sends no toast. With `--since` and no `--dry-run` it adopts that switch time as the pending marker (replacing the current one) and keeps its findings.

`accounts rc-repair <id> --at-turn-end` is for the session you are talking in: its own CLI holds the link and cannot be stopped from inside. The command only records a request (`accounts/rc-turn-end/<cliSessionId>.json`). A `Stop` hook of that session sees the request when its turn ends and starts one hidden, detached helper; the hook returns at once and never blocks or fails a turn, and a turn with no request costs one file check. The helper waits about 2 seconds, runs the `--stop-cli` repair for that session (stop its CLI, back up, append the clear line) and deletes the request. The session comes back on your next message (the app resumes it), and Remote Control reconnects then with a fresh link named after the session title. A refusal that can be retried (a lock held, the process list unreadable) keeps the request for the next turn, up to three launches, and a request older than 6 hours is dropped. No scheduled task or daemon is added.

A tray balloon says when the quit-time relink and restore start and end, with counts (`config progressIcon false` silences it). `config rcRestore.enabled false` turns the whole feature off.

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
