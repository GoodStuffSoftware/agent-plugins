---
description: Share Code-tab conversations, local scheduled tasks and app settings between several claude.ai accounts signed into the Claude desktop app on one machine. Use when the user wants to share conversations between accounts, has a second claude.ai account, switched accounts and lost their sessions, or asks what link, unlink, rollback or the accountLink setting do.
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
- **Claude is running**: the link is armed and runs when the app exits. Tell the user to **quit Claude from the tray icon** (Windows) or with Cmd+Q (macOS). Closing the window only hides it; the app keeps running. The link starts about 10 to 40 seconds after the last Claude process ends (a full quit can take over a minute) and a notification says when it is done, unless notifications are turned off.

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

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" accounts go-live [--yes] [--no-relaunch] [--json]
```

It asks once (`--yes` skips the question), records the answer, then starts ONE hidden background runner that survives quitting Claude and archiving or switching the session. The runner waits for Claude to be fully stopped (up to 30 minutes; quit it from the tray icon or the app menu), takes the backup, links, verifies that every folder holds every conversation (0 split, 0 missing), starts Claude again (`--no-relaunch` leaves that to the user), waits for every desktop copy of session-sync to be able to link, runs a rectify pass and checks the remote for duplicates. A link or verify failure rolls back by itself. If a desktop copy cannot filter mirrored records yet, push is paused and switched back on once every copy can. Follow it with `accounts status` (the `Go-live:` line) or read `go-live-result.json` and `go-live.log` in the accounts folder; running the command again resumes an unfinished go-live.

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

## Don't overstate

Report what `accounts status` actually shows. "Linked" is true only when it says `Linked: yes` and the last pass is ok; a waiter armed for a quit that has not happened is not a link. If a pass says it is owed, say it will finish when the app next stops, not that it is done.
