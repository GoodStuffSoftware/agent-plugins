# Changelog

## Unreleased (0.5.3)

### Added

* **session-sync:** switching accounts in the Claude desktop app after the link is seamless. Sign out, sign in to the other account, switch back, sign out with conversations running, or sign in with a never-linked account: the account you just signed in to shows every conversation, current and resumable, with no restart and no quit prompt. The waiter process is now also a watcher (`accounts wait`, started by the session hooks with Claude's first Code session through the hidden launcher): it follows the app's config (which account is signed in) and the folders, and about 2 seconds after a save every folder the app has not loaded is current. The folder the app has loaded only gains new names; the account you just left is left alone for 15 seconds after a switch; a conversation a parked session still writes in the account you left is never re-linked or deleted there. Events are only hints: a 30-second poll does the same work.
* **session-sync:** a conversation saved at the very moment of a switch and then continued from the older copy is resolved without a prompt: the newest version wins everywhere, the displaced one is copied to `rectify-backups`, and `accounts status` lists the case. A notification appears only when the older copy pointed at a different transcript. A conversation still running in the account that was left is listed in `accounts status` (an idle copy in the signed-in account is reported, not prompted).
* **session-sync:** the loaded folder is never rewritten, and every re-link or delete re-checks its target right before acting (changed inode or modified time, or a `.tmp` sibling, leaves it for the next pass).
* **session-sync:** test coverage for the switch cases (fixtures, a seeded random sweep of switch/save/delete/quit sequences, the watcher loop with injected events, and the session-start hook), and a rehearsal in `scripts/verify-accounts-scratch.mjs` that runs every switch case over a scratch copy of a store.

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
