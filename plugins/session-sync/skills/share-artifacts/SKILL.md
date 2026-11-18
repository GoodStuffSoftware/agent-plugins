---
description: Share artifacts between the two linked claude.ai accounts: send an Editor invite from a browser signed in as the owner and accept it in a browser signed in as the receiver, both driven by an agent (the desktop app's browser pane, and Claude in Chrome when it is set up). Use when a session-sync notice says artifacts are waiting to be shared, or the user asks to share, invite or give the other account access to their artifacts.
---

# Share artifacts between the two linked accounts

An artifact belongs to the account whose session published it. The other account gets in only through a share invite with **Editor** access: it is SENT from a browser signed in to claude.ai as the owner, and ACCEPTED from a browser signed in as the receiver. session-sync queues every new artifact (a hook on the `Artifact` tool) and, when a browser reachable from the session's account can make progress, asks one session to run this procedure. This is an agent procedure: you drive the UI, send, accept when you can, and record the outcome. The user taps a link only for what no browser of ours could accept.

## Rules (read first)

- **Drive the UI only.** Never call claude.ai APIs (fetch, curl, scripts) with the user's cookies or tokens. Reading the page's own network log is fine.
- **No windows, and never launch Chrome.** No script or agent opens a browser window on the desktop. Browsers you may drive: the Claude desktop app's built-in pane (`mcp__Claude_Browser__*`), and Claude in Chrome (`mcp__claude-in-chrome__*`) **only when it is already connected**. If Chrome is not connected, record it (step 2) and carry on without it; do not start Chrome, open a Chrome window or install anything. Reuse one tab per browser and close the tabs you opened when done.
- **Who runs what.** The browser steps (2 to 7) run in ONE background browser subagent (`agent-companion:ac-browser` when it exists; otherwise any subagent that has the browser tools). The main session (the one that was told to run this skill) does steps 1 and 8: it reads the queue, hands the subagent the work, verifies, and reports. Do not start a second subagent.
- **Accepting is authorised.** The user asked for fully automatic sharing, so clicking **Accept** on an invitation in the receiver's browser is part of the job. Nothing else about visibility changes: never make an artifact public or change who can see it beyond the one invite.
- Never print credentials or tokens, and never touch the Claude app's config files.

Every command below uses this prefix (`--json` prints an object):

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" artifacts <command>
```

## Which browser can do what

Two browsers exist, and the account the session runs as decides what it can reach:

| Browser | Signed in as | Reachable from |
|---|---|---|
| `pane` (desktop app) | the account of the app's pane | a session of either account |
| `chrome` (Claude in Chrome) | the other account, once the operator has set it up | only sessions of the account its extension is connected to (`list_connected_browsers` lists only that account's extension instances), and only while Chrome is running |

So an overflow-account session can send and accept in both browsers; a session of the other account reaches only the pane. The queue records each browser's email and account (`artifacts pending --json` shows `browsers`, and `reachable` for the account this session runs as).

## 1. Read the queue (main session)

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" artifacts pending --json --with-invited
```

Each entry has `status` (`pending` = to send, `invited` = sent, to accept), `id`, `url`, `title`, `ownerAccount`, `ownerEmail`, `receiverEmail`, `inviteLink` (when invited) and `driveable`. Also read `browsers`, `reachable`, `emails`, `activeAccount`.

- Nothing pending or invited: tell the user in one line and stop.
- `ownerEmail` or `receiverEmail` missing for an entry whose `ownerAccount` is set: the account emails are not configured. Stop and tell the user to run `node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" config artifactShare.email <account id> <email>` once for each of the two accounts.
- `ownerAccount` null (the account could not be told when the artifact was made): handled in step 3.

Give the subagent the list (status, id, url, title, ownerEmail, receiverEmail, inviteLink), the email the pane is expected to hold, and steps 2 to 7.

## 2. Check which browsers are reachable and who they are signed in as (subagent)

**Pane.** Open `https://claude.ai` in the pane. The account menu is at the **bottom-left** (your name or avatar); open it and read the email. One browser holds one account (claude.ai has no in-page switcher). Record it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" artifacts pane <email>
```

**Chrome** (skip when `browsers` has no `chrome` entry and the pane covers the work; try it whenever there are entries only Chrome can handle, or invited entries to accept in it). Load the `mcp__claude-in-chrome__*` tools, call `list_connected_browsers`, then `select_browser` for the connected one.

- Not connected (empty list, the tools missing, or the call errors): do **not** open or launch Chrome. Record it and carry on with the pane:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" artifacts chrome-unavailable
  ```

  (A failure of this command because no `chrome` browser is registered is fine.) The wake then leaves Chrome work alone for 30 minutes.
- Connected: open `https://claude.ai` in a tab of that browser (`tabs_context_mcp`, `tabs_create_mcp`, `navigate`; reuse one tab), read the email from the account menu, and record it. Add `--account <the account id this session runs as>` the first time (a connected Chrome seen from this session belongs to this session's account); later runs keep it:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" artifacts pane <email> --browser chrome --account <account id>
  ```

Recording a browser clears its "unavailable" mark. From here on a browser that is signed in as the wrong email (for example Chrome signed in as the same account as the pane) is not used for the other account's work.

## 3. Decide what each browser sends and accepts

For each entry, compare `ownerEmail` and `receiverEmail` with the emails of the reachable browsers (case does not matter):

- `pending`, a reachable browser signed in as `ownerEmail`: send from it (steps 4 to 6). The receiver is `receiverEmail`; if null (the owner was unknown), the other configured email.
- `pending`, no reachable browser holds `ownerEmail`: leave it pending and say so in the report ("no reachable browser is signed in as <ownerEmail>"). A later session or browser takes it; do not touch it.
- `pending`, `ownerEmail` null: open it in a reachable browser. If the page offers **Share**, that browser's account owns it, so send to the other configured email; with no Share control, leave it pending.
- `invited`: accept it (step 7) when a reachable browser is signed in as `receiverEmail`; otherwise leave it for the links (step 8).

## 4. Open the artifact and check it is private (subagent)

Open the entry's `url` in the owner's browser. Open **Share**. If general access says **Anyone with the link** (the artifact is public), do not change anything:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" artifacts mark <id> skipped --reason public
```

A public artifact shows the receiver no Accept button, so it needs no invite. Leave public artifacts alone.

## 5. Send the Editor invite (subagent)

In the Share dialog: type the receiver email, pick the suggestion that appears, set **Their access** to **Editor**, then **Send**. Two timing traps:

- Wait about 1 second after picking the suggestion and about 1 second after opening the access dropdown.
- The picker sometimes stays on **Commenter**. Read the role shown before you press Send, and fix it if it is not Editor.

Confirm with `read_network_requests`: the page's own `POST /api/frame/invite/<artifactUuid>?org=<org>` must return **200** with role `editor`. If it does not (or the dialog shows an error), record the failure and go on to the next entry:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" artifacts mark <id> failed --reason "<what you saw>"
```

## 6. Get the invitation link and record it (subagent)

Invite emails are unreliable, so get the link itself. Patch the clipboard with `javascript_tool`, click **Copy invitation link**, and read what was copied:

```js
window.__copied=[]; navigator.clipboard.writeText=(t)=>{window.__copied.push(String(t)); return Promise.resolve();}; 'patched'
```

Then evaluate `window.__copied`. The first click sometimes captures nothing: patch again and click again. The link looks like `https://claude.ai/artifacts/invite/<inviteId>` (`https://claude.ai/invitation/<inviteId>` also works). Record it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" artifacts mark <id> invited --link <link>
```

## 7. Accept in the receiver's browser (subagent)

For every `invited` entry (just sent, or from an earlier run) whose receiver's browser is reachable and signed in as `receiverEmail`: open its `inviteLink` in THAT browser (not the owner's), click **Accept**, and confirm the artifact page then loads for that account (the page opens, with edit access). Then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" artifacts mark <id> accepted
```

If the invite no longer works, there is no Accept button, or the page does not load for the receiver, record `failed --reason "<what you saw>"` (a failed entry is not retried by itself; `mark <id> pending` retries it). If the receiver's browser is not reachable, leave the entry `invited`: step 8 hands the link to the user.

When every entry is handled, close the tabs you opened (one per browser) and return a table to the main session: id, title, status (accepted, invited, skipped-public, failed, or left pending), the invitation link for anything still `invited`, and the reason for anything not accepted.

## 8. Verify and report (main session)

For each entry the subagent marked `accepted`, check receiver-side access where this session can: if this session runs as the receiving account, call the `Artifact` tool with `action: "read"`, the artifact `url`, and a `prompt` such as "Only report the access level header (writer or not) and the title". **(writer)** confirms it (an overflow-receiver entry read from an overflow session should say writer):

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" artifacts mark <id> done
```

If it does not say writer, leave it `accepted` and say so. A session of the other account cannot read as the receiver: leave `accepted` entries as they are; the in-browser confirmation stands.

Then report in one or two lines: what was shared and accepted. Only for entries still `invited` (the receiver's browser was not reachable) give the invitation link and ask the user to open it while signed in as the receiver and click **Accept**; do not open it yourself and do not open any browser window. List anything left pending or failed with its reason. Then carry on with what the user asked for.

## 9. Housekeeping

- `artifacts list` shows every entry with its status; `artifacts forget <id>` drops one the user does not want shared; `artifacts mark <id> pending` retries a failed one.
- The notice is rate-limited (entries older than about 2 minutes, once per 30 minutes per account); it does not wait for an account switch. If a run died, the entries stay pending or invited and the next notice retries them; running this skill by hand retries at once.
- `config artifactShare.enabled false` turns the whole feature off (nothing is queued and nothing is triggered).
- Say plainly what is not done: pending, failed, and invited-but-not-accepted entries.
