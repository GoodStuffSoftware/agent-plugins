---
description: Manually push or pull Claude conversations to/from the remote. Use when the user wants to sync now, is about to switch machines, or asks to back up or restore their conversations.
---

# Sync now

Hooks normally handle this (pull on session start, push on session end). Use this skill when the user wants an explicit sync — most often right before moving to another machine.

## Push — this machine's work goes up

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" push
```

Safe while Claude is open: it only reads local files. Use before switching machines, or when the user is about to shut down.

**There is always a tail.** Anything said *after* the push isn't in it. If they're leaving for good, mention that the last few minutes of the current conversation won't be included until the next sync (the session-end hook will catch it).

## Pull — bring down what another machine did

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" pull
```

Safe to run with Claude open: only flat files are synced (`.jsonl` transcripts and `local_<uuid>.json` session records), never the live databases. A brand-new chat may need an app restart to show in the sidebar.

`--update` means a newer local file always wins, so a pull cannot clobber work just done here.

## Pull only if another machine pushed

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" auto-pull
```

Reads one small marker file and exits if nothing changed. Cheap enough to run often — this is what the session-start hook uses. It's also the answer to *"how do I switch machines without closing Claude?"*, since a start hook never fires if the app never restarts.

## Reading the result

Both commands log to `~/.claude/session-sync/sync.log` and raise a desktop notification. If something failed:

1. `node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" status` — is the machine still configured?
2. Tail the log for the actual rclone error.
3. `rateLimitExceeded` on Google Drive means the shared client_id quota — see the setup skill.

Report honestly: a sync that reports success while transferring nothing is the failure mode worth catching. If the log shows `skip (missing)` or zero transfers, say so rather than calling it done.


## After a pull: tell the affected conversations, in-app

A desktop toast is easy to miss and disappears. When a pull brings in changes
that concern a specific conversation, deliver the notice **into that conversation**
where it will still be there tomorrow.

The plugin's hooks cannot do this — hooks are shell commands and cannot call MCP
tools. This skill runs in your context, so you can.

**When a pull reports conflicts**, for each one:

1. Read the conflict lines from the output or `~/.claude/session-sync/sync.log`:
   `CONFLICT (diverged): <relative path> — N message(s) only in the displaced copy, kept at <path>`
2. The path contains the session id — `.../<session-uuid>.jsonl`.
3. Find that session with `list_sessions` (match the `sessionId`).
4. If it exists, `send_message` to it with something like:

   > **Sync notice** — this conversation also continued on another machine. Both
   > versions were kept; N message(s) exist only in the copy saved at `<path>`.
   > Nothing was deleted. Open that file to see what the other machine recorded.

Deliver it to the conversation the conflict is *about* — not to whichever session
happens to be running. If `list_sessions` has no match, say so in your reply
rather than sending it somewhere arbitrary.

**When a pull brings in new conversations from another machine**, a short note in
the current conversation is enough — no need to message each one:

> Pulled N conversation(s) from `<machine>`. If they are not in the sidebar yet,
> restart Claude — the app builds its session index at startup.

Do not send these notices on a routine no-change sync. A notification that fires
when nothing happened is one people learn to ignore, which is exactly the failure
we are trying to avoid.
