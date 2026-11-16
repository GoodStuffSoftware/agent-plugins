# Changelog

## 0.5.0 (unreleased)

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
