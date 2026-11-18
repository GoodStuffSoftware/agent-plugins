---
description: Share Code-tab conversations, local scheduled tasks and app settings between several claude.ai accounts signed into the Claude desktop app on one machine. Use when the user wants to share conversations between accounts, has a second claude.ai account, switched accounts and lost their sessions, or asks what link, unlink, rollback or the accountLink setting do. Also use it when a Remote Control session shows a random name (for example old-guy-2-lovely-thimble) while its Claude process is running, or the user says the RC name is wrong.
---

# Link conversations across claude.ai accounts

The desktop app keeps Code-tab conversations **per account**. After you switch to a second claude.ai account the sidebar shows only that account's conversations, and the old ones are still on disk, invisible. This skill links the accounts on this machine so every conversation shows in all of them.

Work through the steps in order. **Stop and tell the user** at the first command that fails or is refused. Never print credentials, tokens or `rclone.conf`, and never edit the plugin's `state.json` or the app's folders by hand.

All commands below use this prefix; `--json` on any of them prints the same facts as an object:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" accounts <command>
```

Exit codes: `0` ok, `1` failed, `2` bad arguments, `3` refused (the app is running, nothing is linked, nothing to roll back).

## 1. See what is on this machine

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" accounts status
```

Read it back to the user in plain words:

- **Accounts** - the 8-character ids, `*` marks the one signed in now. Fewer than two accounts means there is nothing to link; say so and stop.
- **Pairs** - `pending` means nobody has answered yet.
- **Linked / Conversations** - how many conversations, how many are `split` (two accounts saved different copies since the last pass; the next pass fixes it) or `missing` a name.
- **App** - `running` or `stopped`. The first link needs it stopped.
- **Owed / Waiter** - work waiting for the app to stop, and whether a background waiter is armed for it.
- **Account switch / conversations** - once linked, a switch between accounts needs nothing from the user. `Account switch` says who is signed in and, for a few seconds after a switch, which folder is being left alone. A line `Conversation <id> was continued from an older copy` is a case the plugin already resolved (the newest version is kept everywhere, the older one is in `rectify-backups`); report it, do not ask the user to do anything. A line `Conversation <id> is still running in <account>` means a direct switch with a conversation open: it keeps working in the account it started in and shows as an idle copy in the other; suggest finishing it before switching straight between accounts, nothing more.
- **Tasks due a catch-up** - local scheduled tasks that will run once when the app next loads. Warn the user before the first link: linking can make tasks the other account had missed run once.
- **Connectors, artifacts, plugins missing** - the claude.ai-only list for step 6.

## 2. Explain what is shared and what is not

Say this before asking for a yes:

**Shared across the linked accounts** (each account keeps working from its own folder; the plugin keeps the folders in step):
- every Code-tab conversation, so any of them can be continued from either account;
- local scheduled tasks, with run history kept in step so nothing runs twice;
- per-account settings: the task backlog, presets, UI and permission preferences, tool toggles, Remote Control folder preferences;
- Cowork memory.

**Stays with each account** (the plugin cannot move it):
- the app's sign-in and this device's identity;
- cloud sessions, cloud routines, projects, chats, artifacts and connectors: claude.ai keeps these with the account that made them;
- server-side bridge and Remote Control state, and plugins installed from the server.

Two honest limits: a conversation continued from the second account exists as two copies until the next pass (every SessionStart, before every push, after every pull), then the newest wins and the older copy is kept in a backup folder. Nothing is ever erased; displaced files are copied aside first.

## 3. Link

Ask the user plainly whether to share conversations between these accounts. On yes:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" accounts answer yes
```

- **Claude is stopped**: the link runs now (a verified backup first, then the link).
- **Claude is running**: the link is armed and runs when the app exits. Lead with this one line: **Restart Claude to sync your accounts: quit Claude from the tray icon or app menu and the sync starts right away; open Claude again when the notice says it is done.** (Windows: tray icon; macOS: Cmd+Q.) Then the details: closing the window only hides it; the app keeps running. The link starts about 10 to 40 seconds after the last Claude process ends (a full quit can take over a minute) and a notification says when it is done, unless notifications are turned off.

Then, once the user has relaunched Claude:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" accounts rectify
node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" accounts status
```

Expect `Linked: yes`, `0 split`, `0 missing`, and a last pass of `link ok`. The old conversations should now be in the sidebar; suggest the user open one and send a message to confirm.

Related commands: `accounts link` arms the same waiter without answering again; `accounts link --now` runs immediately and is refused (exit 3) while Claude is running.

`accounts answer no` records that the user does not want this; nothing is touched. To stop the question and all automatic action, use the setting:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" config accountLink off    # ask (default), auto, or off
```

`ask` asks once per account pair, `auto` links without asking, `off` never asks and never touches the per-account folders. The environment variable `CLAUDE_PLUGIN_OPTION_ACCOUNTLINK` overrides the file.

### The whole go-live in one command

This is the route when the user wants the link done end to end. Run it yourself, in this order:

1. Run `accounts status` and tell the user in plain words what will be linked. Ask for a clear yes. Do not run the next command without it.
2. Run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" accounts go-live --yes --quit-app
   ```

   Add `--no-relaunch` only if the user wants to start Claude themselves. The command records the answer, starts ONE hidden background runner that survives the quit, and returns at once.
3. Tell the user, leading with this one line: **Restart Claude to sync your accounts: quit Claude from the tray icon or app menu, the sync starts right away and Claude reopens by itself when it is done.** Then the details: a small tray icon (Windows; a notification on macOS and Linux) shows the step while it works and says when it is done, and `config progressIcon false` turns that off; there is no time limit and nothing needs to be run again, **this session stops when Claude closes**, and the result is shown at the start of their next session. Mention the log path the command printed.

What the runner does after you are gone: a few seconds later it asks Claude to quit (macOS), waits for it to stop with no time limit (a runner that dies, for example at a reboot, is started again by the next session start; running the command again swaps a waiting runner of an older plugin version for the current one), takes the backup, links, verifies that every folder holds every conversation (0 split, 0 missing), starts Claude again (right after the link is verified or rolled back, and also when the go-live ends in failure after Claude was quit; not with `--no-relaunch`), waits for every copy of session-sync (the app's own and the one terminal sessions run) to be able to link, runs a rectify pass and checks the remote for duplicates. A link or verify failure rolls back by itself. If a copy cannot filter mirrored records yet, push is paused and switched back on once every copy can. The app refreshes its own copies when it starts; a terminal copy needs `claude plugin update session-sync@<marketplace> --scope user`.

Asking Claude to quit works on macOS. On Windows and Linux it is not available (on Windows an outside quit ends the app before its own shutdown has saved everything, so it is not offered). The command then says so: ask the user to quit Claude from the tray icon (Windows) or the app menu. Closing the window only hides it. The runner waits for that.

When the user's next session starts, the plugin adds the result to your context once (status, counts, anything that needs them, the log path). If the runner is still busy it says so. Tell the user the result in one or two plain lines. To follow it yourself: `accounts status` (the `Go-live:` line), or `go-live-result.json` and `go-live.log` in the accounts folder. Running the command again resumes an unfinished go-live.

### After the go-live: the checklist

The link moves what is on this machine. Work through this yourself where you can, and give the user only what needs their hands. Start from `accounts status --all`.

1. **Connectors the other account had.** If the mcp-registry search and suggest tools are available, use them for each connector listed under "Connectors missing" so the user gets Connect buttons. Otherwise name each one and say where to add it (claude.ai, Settings, Connectors).
2. **Custom connectors.** The registry cannot offer these. List each URL for the user to add themselves.
3. **Artifact shares.** List the artifacts under "Artifacts from other accounts" so the user can share them with this account or republish them.
4. **Chat memory, profile and custom instructions.** The user copies these by hand from the other account's settings. Say so once, briefly.
5. **The other account from the terminal.** Run `claude auth status`. If the terminal CLI is signed in as the other account, you can read that account's sessions and routines without switching anything: `claude -p --resume <session id> --allowedTools "Read,Grep,Glob" "<question>"`. Keep the allow-list read-only: never let it edit files or run commands.

Step 6 below covers the rest of the claude.ai-only list.

## 4. Undo: unlink

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" accounts unlink                    # Claude stopped
node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" accounts unlink --when-app-exits   # Claude running: quit it from the tray
```

Unlink keeps the newest content of every conversation, leaves each one in the account that first had it, removes the mirrored copies and splits tasks and backlog back by origin. The accounts stop being linked and the pair answers reset to "no". It is the gentle undo.

To link again later after an unlink or a rollback, run `accounts answer yes`: an explicit yes also re-answers pairs set to "no" and links with a fresh backup. The SessionStart hook never asks about a "no" again by itself. Do not edit `state.json`.

## 5. Undo: rollback

Use this when something looks wrong and the user wants the folders as they were before the first link. The app must be stopped.

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" accounts rollback --dry-run   # what it would do
node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" accounts rollback
```

It restores the backup taken before the link, keeping task run times at their newest so nothing fires twice (add `--exact` to restore the task files byte for byte instead), puts any conversation created since the backup back in its home folder as a single file, and resets the pairs to "no". It always uses the backup taken before the first link (a safety copy taken when another account joins later is never the target). It holds `accounts.lock` while it runs: exit 3 can also mean a pass is running right now, so wait a minute and run it again. If it stops part way (exit 1), no pass or unlink runs until a rollback has finished: fix the cause and run it again. Exit 3 also means there is no backup to roll back to.

Rollback also brings back what was deleted after the link: a conversation or scheduled task that existed when the backup was taken and was deleted since returns (the tombstones that came later are removed), and a restored task keeps the backup's last run time, so its catch-up can run once. Edits made after the link are reverted too; the newer copies stay in a `pre-rollback-<stamp>` folder in `~/.claude/session-sync/accounts/`.

**If the plugin itself is broken**, the backup folder carries its own copy of the rollback that needs no plugin, only Node. The folder is `~/.claude/session-sync/accounts/backup/<stamp>/` (on Windows `%USERPROFILE%\.claude\session-sync\accounts\backup\<stamp>\`); `accounts status --json` shows the stamp as `backupId`.

```bash
node "<backup folder>/rollback.mjs" --dry-run
node "<backup folder>/rollback.mjs"
```

Before downgrading the plugin to 0.3.0, always unlink or roll back first. 0.3.0 has no push filter and would upload every mirrored copy.

## 6. The claude.ai-only checklist

A link moves what is on this machine. What claude.ai holds server-side needs hand work, and the user is the only one who can do it. Rerun `accounts status --all` and go through the lists it prints (it never shows credentials, ids or query strings):

1. **Connectors** - each one listed under "Connectors missing": add it at claude.ai, Settings, Connectors, while signed into the new account.
2. **Artifacts** - each one listed under "Artifacts from other accounts": share it with this account on claude.ai, or republish it from this account. Do this too for the artifacts that scheduled tasks and routines write to.
3. **Shared data stores** that routines write to (an artifact or data store used as a log or inbox): share them with the second account, or point the routines at one both can reach.
4. **Cloud routines** - they stay with the account that made them; recreate the ones wanted under the new account.
5. **Chat memory** - copy it by hand (claude.ai Settings, memory) from the old account to the new one.
6. **Profile and custom instructions** - copy them by hand.
7. **Project knowledge** - re-upload what the new account needs.
8. **Plugins** - install the ones listed under "Plugins missing".

Mention that the artifact list is capped at the newest 20 unless `--all` is given.

## Switching accounts once linked

Never tell the user to restart or quit Claude because of an account switch. After the link, a watcher (the waiter process, started with the first Code session) keeps every folder the app has not loaded current within about 2 seconds of a save and adds new names to the loaded one, so signing out, signing in to the other account, switching back or signing out with sessions running all show every conversation at once. The only restart prompt left is the one-time "Restart Claude to sync your accounts" for an account that was never linked (it joined later); say it once, with the quit-from-the-tray instruction, and not again. Whatever the watcher had to hold back (a copy the app has loaded, a conversation still running in the account that was left) finishes by itself after the user's next normal quit.

## Sharing new artifacts across accounts

Artifacts belong to the account whose session published them; linking does not move them. Once the accounts are linked, session-sync queues each new artifact and, once a browser the session's account can reach can make progress (no account switch needed; entries 2+ minutes old, once per 30 minutes per account), one session gets a notice to run the `session-sync:share-artifacts` skill: a background browser subagent sends an Editor invite from the owner's browser and clicks Accept in the receiver's browser when it is reachable. Two agent-driven browsers exist: the Claude desktop browser pane (any account's session) and, if the operator set it up, Claude in Chrome (only sessions of the account its extension is connected to, and only while Chrome runs; never launched by an agent). Anything no browser could accept comes back as an invitation link for the user to open and Accept. Follow that notice; do not do it by hand, and never open a browser window, launch Chrome or call claude.ai APIs. Public artifacts are skipped, artifacts whose owner no reachable browser holds stay pending, and `Artifact` `read` showing "(writer)" confirms an accepted invite. Needs the two account emails once: `node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" config artifactShare.email <account id> <email>` for each account. Chrome setup: a separate Chrome profile signed in as the other account with the Claude extension connected to it, left running, then `artifacts pane <email> --browser chrome --account <account id>` once. `config artifactShare.enabled false` turns it off; `artifacts list` shows the queue.

## Remote Control after a restart (0.5.4, Windows)

Restarting the Claude app turns Remote Control off for every Code session, and an account switch can leave sessions attached to fallback links with random names. session-sync repairs this on its own; do not run steps by hand. When the user asks what it does or how to change it:

- **Relink and free restore** happen at the quit, announced by a tray balloon with counts, and cost nothing: stale saved links of the last `rcRestore.days` days are cleared (after a backup) and up to 4 recent distinct sessions that had Remote Control on (the switch on first, then old link history; never one switched off) are marked so the app reconnects them when it starts. The watcher logs the app's own outcome in the sync log afterwards; the server decides whether the app's launch restore runs.
- **Wake** (only with `rcRestore.wake` on): the first real prompt of an interactive session after a restart carries a one-time instruction. Follow it: tell the user in one line that Remote Control is being reconnected, list the sessions, send the no-op message to each non-archived, interactive, non-scheduled session active in the window with `remoteControlActive` false (at most the number the instruction names, most recently active first), list again, and report one line "Remote Control: N sessions reconnected, M still off". Skip a session whose send is refused and count it as still off. Say plainly that every wake-up is one model turn in the session that is woken (the reply is short, but the turn re-reads that conversation).
- **Windows restart or shutdown:** the app quits with the OS, so the quit-time relink cannot run. A hidden per-user logon task, "session-sync RC restore", runs `accounts rc-restore --if-app-stopped` before Claude starts and does the relink then (nothing owed exits quietly; this step writes nothing while the app runs). It installs itself at a session start; by hand: `node "<plugin>/lib/cli.mjs" accounts rc-restore install-logon-task` or `uninstall-logon-task` (each saves `rcRestore.logonTask` so a removal sticks). Do not run `--if-app-stopped` yourself while Claude runs: it refuses.
- **Live relink (0.5.7, while the app runs):** a stale or random-name link of a session whose CLI is not running (quiet 2 minutes, not mid-turn, never your own session) is cleared in place after a backup, so its next connect gets a titled link. It runs from the wake prompt, from the watcher every `rcRestore.liveEveryMs`, and as a sweep at an account switch; one `sync.log` line per pass. By hand: `node "<plugin>/lib/cli.mjs" accounts rc-restore --live [--all] [--dry-run] [--json]` (`--dry-run` lists what it would clear and why; it changes nothing). It never stops a process.
- **Settings** (`node "<plugin>/lib/cli.mjs" config rcRestore.<key> <value>`): `rcRestore.liveRelink` (default `idle-only`; `off` = no live relink), `rcRestore.liveMax` (default 10, 1 to 100), `rcRestore.liveEveryMs` (default 600000), `rcRestore.enabled` (default true), `rcRestore.days` (default 3, 1 to 90), `rcRestore.wake` (default true; false = relink and free restore only), `rcRestore.wakeMax` (default 4, 1 to 50: sessions woken per restart), `rcRestore.logonTask` (default true; false = no logon task, and removes it).

## Random Remote Control name on a running session

A session whose Claude process runs can show a random Remote Control name on claude.ai (the CLI holds a `noHistoryBackfill` link in memory, so clearing the transcript while it runs does nothing). The fix needs the CLI stopped while the clear line is written, so it is a manual procedure. **Mike approved stopping that session's CLI for this repair (2026-11-18).** That covers an idle session only: never one that is mid-turn. Do **one session at a time**. `<id>` is the local session id (`local_<uuid>`) or the CLI session id; `<session>` below is the app tool's session argument.

1. App tool `set_remote_control(<session>, false)`.
2. Look first: `node "<plugin>/lib/cli.mjs" accounts rc-repair <id> --stop-cli --dry-run --json` lists the pids it would stop and what it would clear. It refuses a mid-turn session, a link that is already cleared or healthy (`--force` overrides), a live CLI without `--stop-cli`, and an unreadable process list.
3. Run it for real: `node "<plugin>/lib/cli.mjs" accounts rc-repair <id> --stop-cli [--json]`. It stops only the `claude.exe` whose command line holds that exact `--resume <cliSessionId>` (hidden), confirms it is gone, backs the transcript up under `~/.claude/session-sync/accounts/rc-restore/backup/<stamp>/`, and appends the CLI's own clear line (a newline first if the file lacks one). It works whatever `rcRestore.enabled` is. It never prints command lines.
4. Wake the session: send it the message `Remote Control relink check from session-sync: no action needed. Reply "ok" in one word and do nothing else.` `set_remote_control(true)` is refused until the session is active.
5. App tool `set_remote_control(<session>, true)`.
6. Verify: `node "<plugin>/lib/cli.mjs" accounts rc-repair <id> --verify` prints the last link id, whether it has `noHistoryBackfill`, and PASS or FAIL. PASS means a new `cse_` id without `noHistoryBackfill`.
7. Tell the user to archive the old random-name entry on claude.ai, signed in as the account that shows it. Archiving before step 6 passes makes the next connect mint another random name.

## Don't overstate

Report what `accounts status` actually shows. "Linked" is true only when it says `Linked: yes` and the last pass is ok; a waiter armed for a quit that has not happened is not a link. If a pass says it is owed, say it will finish when the app next stops, not that it is done.
