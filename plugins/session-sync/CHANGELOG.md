# Changelog

## 0.5.7 - 2026-11-18

### Added

* **session-sync:** the live relink. While Claude runs, a stale Remote Control link (a `noHistoryBackfill` random-name link, or one minted while another account was signed in) is cleared in place for a session whose CLI is not running, so its next connect makes a titled link. Gates: no live `claude.exe` for that conversation (an unreadable process list clears nothing), transcript quiet for 120 s, not mid-turn, never the hook's own session, everything re-checked right before the write, a backup first, the CLI's own clearing line, a second process check afterwards (logged as `raced`), at most `rcRestore.liveMax` per pass, no process is ever stopped. It runs in the wake hook before the first prompt after a restart gets its instruction, in the background watcher every `rcRestore.liveEveryMs` while the app runs, and as a sweep of every session at an account switch. One `sync.log` line per pass that found candidates.
* **session-sync:** `accounts rc-restore --live [--all] [--dry-run] [--json]` for one pass by hand; `--dry-run` lists what it would clear with the reason and the skipped counts. Settings `rcRestore.liveRelink` (`idle-only` default, or `off`; also `config rcRestore.liveRelink`), `rcRestore.liveMax` (10) and `rcRestore.liveEveryMs` (600000).
* **session-sync:** a link ledger (`accounts/rc-links.json`) and an account switch history (`accounts/switch-history.json`, seeded from the app's `remote-control.log`) record which account a link was first seen under.

### Fixed

* **session-sync:** the relink no longer treats a link as foreign because its `ownerAccountUuid` differs from the signed-in account. That stamp is the CLI's cached identity and was the same on healthy links, so 0.5.6 would have relinked 29 sessions where 3 needed it. Foreign now means first seen before the last account switch (per the ledger and the switch history); a link that cannot be dated is left alone.

### Changed

* **session-sync:** the `rc-wake` hook timeout is 30 s (was 10): the prompt that claims the restart runs the live relink, which may list processes up to three times.

## 0.5.6 (2026-11-17)

### Added

* **session-sync:** the Remote Control relink now also runs when you shut Windows down or restart it instead of quitting Claude from the tray. On a Windows power-off the app dies with the session and the waiter cannot start a process, so the relink stayed owed. A hidden per-user "At log on" task, "session-sync RC restore", now runs the new `accounts rc-restore --if-app-stopped` before Claude starts (it starts about 85 s after logon). If the app is stopped and a relink is owed it runs the same relink as the quit step (after a backup, each write checked against the app's lock marker); if the app is running, or starts mid-way, it writes nothing more and the relink stays owed; with nothing owed it exits quietly. It logs one line to `sync.log`.
* **session-sync:** `accounts rc-restore install-logon-task` and `uninstall-logon-task` (both idempotent; Windows only, a no-op elsewhere) and a setting `rcRestore.logonTask` (default true; false opts out and removes the task; the two commands save it too, so a removal is not undone at the next session start). The task is installed automatically at a session start while `rcRestore.enabled` is on. It runs `wscript.exe //B` on a small shim in `~/.claude/session-sync/` that starts node with window style 0 (no console flash); a launcher next to it resolves the newest installed session-sync copy (the plugin cache, then the marketplace clone), so the task survives plugin updates.
* **session-sync:** artifact sharing works both ways with Claude in Chrome as a second agent-driven browser. Register it once (`artifacts pane <email> --browser chrome --account <id>`; a separate Chrome profile signed in as the other account, the Claude extension connected to it, Chrome left running). An overflow-account session then sends its own artifacts from Chrome and the other account's from the pane, and the subagent clicks Accept in the receiver's browser, so no link needs tapping when both browsers are reachable. Chrome is reachable only from sessions of the account its extension is connected to and is never launched by an agent: when it is not connected the work waits. New `artifacts chrome-unavailable` and `pending --with-invited`, an `accepted` status, and `reachable` in `artifacts pending`.

### Fixed

* **session-sync:** an older plugin copy no longer replaces a newer running waiter (versions are compared as semver; the same version is replaced only when the code hash differs), so a lagging app copy cannot kill the waiter that runs the quit step.
* **session-sync:** after a Windows restart that left the Remote Control relink owed, the first prompt of the next app run records `accounts/rc-relink-owed.json` and tells you once to quit Claude from the tray and reopen it.

### Changed

* **session-sync:** the artifact-share trigger no longer waits for an account switch. A session is asked to share when a browser its account can reach can send a pending entry or accept an invited one, for entries older than about 2 minutes, at most once per 30 minutes per account (the claim is time-based, which also fixes a claim that stayed stuck when entries of both accounts stayed pending across A to B to A to B), and with a 30-minute back-off after a run reports Chrome unavailable.

## 0.5.5 (2026-11-17)

### Added

* **session-sync:** a custom tray icon: an original sync glyph (two circular arrows on a blue disc with a navy edge), 16 to 256 px, generated by `scripts/make-icon.mjs`. One icon for all tray states.
* **session-sync:** new artifacts are invited to the other linked claude.ai account when you switch accounts. A `PostToolUse` hook on the `Artifact` tool queues every newly published artifact (a publish with no `url`, including a create from a `type_url`) with the account the app runs as; after you switch to the other account, a `UserPromptSubmit` hook tells one session (exclusive claim, nothing otherwise) to run the new `share-artifacts` skill in one background browser subagent. The subagent sends an Editor invite from the desktop app's browser pane (signed in as the owner) and records the invitation links; the session gives you the links to Accept, then checks `Artifact` `read` for "(writer)". Public artifacts are skipped, artifacts owned by an account no driveable browser holds stay pending. Drive the UI only: no browser window is opened by a script and claude.ai's APIs are never called.
* **session-sync:** `artifacts pending|list|mark|forget|pane` commands for the queue, and settings `artifactShare.enabled` (default on once accounts are linked) and `artifactShare.email <account id> <email>` (the two account emails, set once: the plugin never reads the app's account fields).

## 0.5.4 (2026-11-17)

### Added

* **session-sync:** Remote Control comes back by itself after you restart the Claude desktop app (Windows; macOS and Linux do nothing). After any restart, Remote Control is off for every Code session, and after an account switch the CLI can reattach to links that were minted in a cross-account fallback (random names, and renames never reach them). Three steps now run on their own:
  * **Relink** (Claude closed): for the current account's conversations active in the last 3 days, a saved link whose last `bridge-session` entry is a fallback link (`noHistoryBackfill`) or belongs to another account is cleared with the CLI's own clearing line, after a backup, once. The next connect makes a fresh link named after the session. Only `bridge-session` lines of a transcript are read.
  * **Free restore** (Claude closed): up to 4 of the most recent distinct conversations that had Remote Control on (a conversation that a linked account keeps in several org folders counts once; sessions with the Remote Control switch on come before ones that only have an old link in their history; one the user switched off is never touched) get the markers the app's own launch pass reads (`remoteControlLiveAtUpdateQuit` and `remoteControlAutoEligible`), so the app reconnects them when it starts, with no model turn. The marker is kept fresh while Claude stays closed (it must be younger than an hour when the app starts). `interruptedByQuitAt` is never written. Records are edited in place, so linked-account hard links survive. After the next start the watcher logs what the app did (its `outcome`: ran, gate_off, flags_not_fetched), because the server decides whether the launch restore runs.
  * **Wake the rest** (Claude running): the first real prompt of an interactive session after a restart (a `UserPromptSubmit` hook, claimed once per restart so exactly one session acts) tells that session's agent to list the sessions and send each active one that is still off (at most 4, the most recently active first) a one-line no-op message, then report "Remote Control: N sessions reconnected, M still off". Scheduled and unattended sessions never take that role.
* **session-sync:** you are told: a tray balloon at the start and at the end of the quit-time relink and restore, with counts.
* **session-sync:** new settings `rcRestore.enabled` (default on), `rcRestore.days` (default 3, 1 to 90), `rcRestore.wake` (default on; off keeps relink and the free restore and drops the wake step) and `rcRestore.wakeMax` (default 4, 1 to 50: the most sessions one restart wakes). Cost, stated plainly: every wake-up is one model turn in the session that is woken. The reply is one word, but the turn re-reads that conversation, and after a restart the prompt cache is usually cold, so a long conversation costs more than a short one. The relink and the free restore cost nothing.
* **session-sync:** the watcher now also runs for a single, never-linked account when `rcRestore.enabled` is on, so the restore works without linking accounts.

## 0.5.3 (2026-11-17)

### Added

* **session-sync:** switching accounts in the Claude desktop app after the link is seamless. Sign out, sign in to the other account, switch back, sign out with conversations running, or sign in with a never-linked account: the account you just signed in to shows every conversation, current and resumable, with no restart and no quit prompt. The waiter process is now also a watcher (`accounts wait`, started by the session hooks with Claude's first Code session through the hidden launcher): it follows the app's config (which account is signed in) and the folders, and about 2 seconds after a save every folder the app has not loaded is current. The folder the app has loaded only gains new names; the account you just left is left alone for 15 seconds after a switch; a conversation a parked session still writes in the account you left is never re-linked or deleted there. Events are only hints: a 30-second poll does the same work.
* **session-sync:** a conversation saved at the very moment of a switch and then continued from the older copy is resolved without a prompt: the newest version wins everywhere, the displaced one is copied to `rectify-backups`, and `accounts status` lists the case. A notification appears only when the older copy pointed at a different transcript. A conversation still running in the account that was left is listed in `accounts status` (an idle copy in the signed-in account is reported, not prompted).
* **session-sync:** the loaded folder is never rewritten, and every re-link or delete re-checks its target right before acting (changed inode or modified time, or a `.tmp` sibling, leaves it for the next pass).
* **session-sync:** test coverage for the switch cases (fixtures, a seeded random sweep of switch/save/delete/quit sequences, the watcher loop with injected events, and the session-start hook), and a rehearsal in `scripts/verify-accounts-scratch.mjs` that runs every switch case over a scratch copy of a store.

### Fixed (review round)

* **session-sync:** a write the app made after the last time a folder was unloaded is only "held" (kept, never overwritten) when the unload time is known. With no known unload (an upgrade from 0.5.2, a switch before the first Code session, a watcher that was not running) the copies that drifted apart in the live store now converge on the newest write, and the quit pass no longer overwrites it. A held name is recorded when it is seen, so a later link to it from another folder does not release it.
* **session-sync:** a conversation that saves every turn no longer fills `rectify-backups`: the previous version of the same lineage, which the app itself replaced, is not backed up each time. A version from another history, and every displaced copy of a conflict, is still backed up.
* **session-sync:** a pass reads and parses only the records that changed since the last one (a cache keyed by file, inode, modified time and size); an idle pass parses none.
* **session-sync:** whatever the waiter runs while Claude is closing or closed (the link, an unlink, the full pass at the quit) is announced with the progress icon and balloons (a notification on macOS and Linux; `config progressIcon false` turns it off), and a settled, closed watcher asks the system about Claude only every 10 minutes instead of every 30 seconds.
* **session-sync:** a waiter left by another build is replaced: the waiter claim records a hash of the plugin code, and `accounts rectify`, push and pull end (never mid-pass, only when proven to be a waiter) a watcher whose version or code differs. The SessionStart hook still only joins a waiter.
* **session-sync:** a rewrite of `config.json` that does not change the signed-in account no longer triggers an immediate pass, and a watcher that cannot read its claim once (an antivirus scan) looks again before it gives up.

### Changed

* **session-sync:** once the accounts are linked nothing asks you to restart or quit Claude, including `accounts status` (its first line no longer reads "Restart Claude to sync your accounts"). The only such prompt is the one-time notice for an account that is not linked yet; it is shown once per account.
* **session-sync:** the waiter no longer exits after the link or a full pass while Claude runs: it stays as the watcher and runs one full pass per quit, only when one is owed.

## 0.5.2 (2026-11-16)

### Fixed

* **session-sync:** `accounts go-live` (and the waiter) now notice that you quit Claude on Windows. The process probe used to exit with code 1 when no `claude` process existed, which was read as "unknown", so the link never started after a real quit. The probe now prints an end marker and exits 0; an empty list means "not running", and only a missing marker means "unknown". The link starts about 1 to 1.5 seconds after the last Claude process ends, with the lock-file check held as before.
* **session-sync:** a restart of Claude is noticed by the lock file's creation time (a latch), so a quit followed by a quick reopen is logged and does not corrupt anything: a reopen after the link has begun is caught by the existing guard, which aborts safely and lets the runner retry.
* **session-sync:** when the process probe stays unknown for 10 seconds while the lock marker is gone, the go-live log and the waiter log say so, with the probe's exit status and error text.

* **session-sync:** replacing a waiting runner (running `accounts go-live` again) now ends a process only when it is proven to be that runner: its command line holds `golive-run` and it started no later than the claim. A claim whose pid belongs to some other program (a pid reused after a crash or reboot) is dropped as stale and the other program is left alone. If the operating system cannot be asked, nothing is ended. The phase is read again right before the end, so a runner that has already begun the link is never ended.
* **session-sync:** a runner that lost its claim to another runner ends by itself instead of carrying on beside it, and a claim file that vanished is taken back.
* **session-sync:** `accounts go-live` and `accounts answer yes` replace a waiter left by an older version of session-sync (same identity check, never while it holds the accounts lock), so the old waiter's blind spot for a quit on Windows cannot keep a link waiting. The SessionStart hook still only joins a waiter and never asks the system about it.
* **session-sync:** a rollback that did not finish, or whose files do not match the backup, no longer starts Claude again: the first saves of the app could rewrite the files you are told to look at. The message says so.
* **session-sync:** while the process check cannot answer, the runner looks every 30 seconds instead of twice a second (after 20 quick tries) and says why in `accounts status`.
* **session-sync:** the progress icon is started outside the runner, so it outlives it and the closing balloon is shown. If Claude is reopened while the link is under way the icon is taken away and a new one is shown for the next link. The question the agent asks about a restart now starts with the question.

### Added

* **session-sync:** a progress indicator while the go-live runs with Claude closed. On Windows a tray icon (a hidden PowerShell helper, no console window, no focus steal) shows the step ("Syncing accounts: backing up and linking", "checking", "reopening Claude", "finishing"), a balloon when the sync starts and one with the result (done, rolled back, needs attention) when it ends, then removes itself. Double-clicking the icon opens the go-live log. The helper reads the result file and exits by itself if the runner dies. macOS shows a notification at the start and at the end, Linux does the same with `notify-send` when it is installed. `config progressIcon false` turns it off; the go-live itself is unchanged.


## 0.5.1 (2026-11-16)

### Fixed

* **session-sync:** `accounts go-live` no longer gives up after 30 minutes. The wait for you to quit Claude has no time limit (the later check and rollback waits have none either, so a linked but unchecked store is never left for you to sort out). The link starts as soon as the app stops: the runner looks twice a second and calls the app stopped on two readings half a second apart, so it begins about 2 seconds after the quit instead of up to 40.
* **session-sync:** the runner survives a reboot or a crash while it waits. A session start restarts the runner of a go-live that is waiting (dead process or stale heartbeat), once, through the hidden launcher, never beside a live runner, never for a failed or finished go-live, and never more than five times without a runner coming up.
* **session-sync:** running `accounts go-live` again while a runner waits for the app to stop replaces it with one from the current plugin version and keeps the go-live id and state (the wait holds no lock and changes nothing). In any other phase it leaves the runner alone.
* **session-sync:** Claude is started again in every end state reached after it was quit: right after the verified link, right after a rollback, and also when the go-live fails or the runner stops on an error. `--no-relaunch` still opts out.

### Changed

* **session-sync:** the link prompt leads with one line: "Restart Claude to sync your accounts: quit Claude from the tray icon or app menu, the sync starts right away and Claude reopens by itself when it is done." It is shown only for an account that is not linked yet (the SessionStart question, `go-live`, `accounts status`), once per new account. After the link nothing asks you to restart or quit: owed work waits for your next normal quit and finishes silently, and a routine full pass sends no notification. A notice is only for a real problem.

## 0.5.0 (2026-11-16)

### Features

* **session-sync:** `accounts go-live` does the whole link in one command. It records your yes and starts one hidden background runner that survives quitting Claude. The runner waits for the app to stop, takes the backup, links, verifies that every folder holds every conversation, starts Claude again, waits for every copy of session-sync (the app's and the terminal install) to be able to link, runs a rectify pass and checks the remote for duplicates. A failed link or check rolls back by itself. Running the command again resumes an unfinished go-live.
* **session-sync:** `--quit-app` has the runner ask Claude to quit a few seconds after it starts (macOS). On Windows and Linux the command says to quit from the tray icon or the app menu, and the runner waits. A synthetic Windows session-end message was tested on a throwaway Electron app: it ends the process about 100 ms after the event, before the app's own asynchronous shutdown can finish, so it is not used.
* **session-sync:** the next SessionStart reports a finished go-live once (status, counts, anything that needs you, the log path), and says so while the runner is still working after the restart.
* **session-sync:** `/session-sync:accounts` has the go-live steps for an agent and an after-go-live checklist (connectors, custom connector URLs, artifact shares, what to copy by hand, reading the other account from the terminal).

### Fixed

* go-live checks the link only with the app stopped and after one full pass, so a good link is never rolled back because the app was reopened. The automatic rollback is exact when the app has not run since the link, is not retried once a finished rollback reports files that do not match, and then names those files and the snapshot.
* go-live also judges the copy of session-sync that terminal sessions run (the install in ~/.claude/plugins). A stale one pauses push, and the report says how to update it.
* The runner keeps its claim fresh with a timer, so a long step no longer lets a second runner start. A go-live that failed with push paused says so in the session report and in accounts status.
* The SessionStart hook starts the waiter and a resumed runner through a small detached helper, so the hook itself never runs PowerShell.
* The remote duplicate check treats a remote that was never pushed as 0 records and 0 duplicates, with a note. Only a real rclone error is reported as needing attention.

## 0.4.0 (2026-11-16)

### Features

* **session-sync:** link conversations across claude.ai accounts. Every Code-tab conversation appears in each linked account's folder as a hard link to one file; a rectify pass repairs what the app's atomic save breaks (newest copy wins, the older one is backed up first) and propagates new conversations and deletes.
* **session-sync:** scheduled tasks, the backlog, per-account settings and Cowork memory are kept in step across the linked accounts by three-way merges against the last full pass. Task run times merge by newest, so a switch never double-fires a catch-up.
* **session-sync:** `/session-sync:accounts`, a guided setup: what is shared, link, unlink, rollback, and the claude.ai-only checklist.
* **session-sync:** `accounts` commands (`status`, `answer`, `link`, `rectify`, `unlink`, `rollback`) and the `accountLink` setting (`ask`, `auto`, `off`; env `CLAUDE_PLUGIN_OPTION_ACCOUNTLINK`).
* **session-sync:** `accounts status` lists connectors, published artifacts and plugins the signed-in account lacks, and the local tasks that will catch up once on the next load.

### Changed

* Push uploads each conversation once, from its home folder; mirrored names never upload. Push and pull run a rectify pass first and after.
* The SessionStart hook asks once per account pair before anything is linked. Nothing runs until the user answers yes or sets `accountLink` to `auto`.

### Safety

* A verified backup and a standalone `rollback.mjs` (Node only) come before the first link. Displaced and deleted files are copied to a backup folder, never erased.
* The full pass needs the desktop app stopped; while it runs only a live pass adds new names. A hidden waiter finishes the work after the app exits.
* Do not downgrade to 0.3.0 while linked: it has no push filter. Run `accounts unlink` or `accounts rollback` first.

## [0.3.0](https://github.com/GoodStuffSoftware/agent-plugins/compare/session-sync@v0.2.1...session-sync@v0.3.0) (2026-09-24)


### Features

* session-sync plugin — roam Claude conversations, sidebar included ([bf1560f](https://github.com/GoodStuffSoftware/agent-plugins/commit/bf1560f2620bc7f5e655c125eead2c8d891217b6))
* **session-sync:** configurable backup location, not an env var ([655db2d](https://github.com/GoodStuffSoftware/agent-plugins/commit/655db2de9f26e6ce342b4dce7f5d9bb2ec87a886))
* **session-sync:** incremental push from a local manifest, and real setup instructions ([d3f94b7](https://github.com/GoodStuffSoftware/agent-plugins/commit/d3f94b79fd89259764baa64217d923993b675fdc))
* **session-sync:** never silently lose a conversation on pull ([c74da51](https://github.com/GoodStuffSoftware/agent-plugins/commit/c74da5124e301987f2bd1d6ace83a6cfa556b055))
* **session-sync:** support a local remote, and stop pacing it like a cloud one ([8730912](https://github.com/GoodStuffSoftware/agent-plugins/commit/8730912bd82081edc33cf2e425af3f4a24c6a39d))


### Bug Fixes

* **session-sync:** --files-from cannot be combined with --exclude ([f5a86a3](https://github.com/GoodStuffSoftware/agent-plugins/commit/f5a86a3a0436c3b547b0301f06ee6ad0ae094d1d))
* **session-sync:** anchor the session-sync exclusion to the sync root ([68c867f](https://github.com/GoodStuffSoftware/agent-plugins/commit/68c867f4099d74e5b42ad52a9cbdeec9861d9fde))
* **session-sync:** bound the toast-registration PowerShell call; v0.2.1 ([8787dd3](https://github.com/GoodStuffSoftware/agent-plugins/commit/8787dd35222dedd875f282c956b860615e5cbf2c))
* **session-sync:** hooks fire per conversation — scope them, and lock the sync ([2349fd7](https://github.com/GoodStuffSoftware/agent-plugins/commit/2349fd77e0c964802c348fb46f5ad3ce249b3211))
* **session-sync:** restore resume on SessionEnd; debounce now coalesces, never drops ([f1fa342](https://github.com/GoodStuffSoftware/agent-plugins/commit/f1fa3429a632f3a1abe942de427ab3e087efc72f))
* **session-sync:** run SessionStart/SessionEnd hooks in exec form ([b36a767](https://github.com/GoodStuffSoftware/agent-plugins/commit/b36a767e284f2fd17c339a51ef652760747981c8))
* **session-sync:** run SessionStart/SessionEnd hooks in exec form ([#2](https://github.com/GoodStuffSoftware/agent-plugins/issues/2)) ([35813b1](https://github.com/GoodStuffSoftware/agent-plugins/commit/35813b12298c654a9581cf3dda61817ab41a2b2a))
* **session-sync:** stop the self-sustaining sync loop, survive long pushes, and cut notification noise ([67da58b](https://github.com/GoodStuffSoftware/agent-plugins/commit/67da58be07746183adfdf0da584ea8e5858029e5))
* **session-sync:** tell the user once when sync is not configured ([1b1286a](https://github.com/GoodStuffSoftware/agent-plugins/commit/1b1286a303e4fb8ceaa7d43c11efd6e0a0dfb886))
* **session-sync:** toasts no longer flash a console window on Windows ([c663ba1](https://github.com/GoodStuffSoftware/agent-plugins/commit/c663ba1ffbfeed23211de25ae157b7ef792db2f8))
