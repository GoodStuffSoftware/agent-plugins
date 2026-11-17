---
description: Invite artifacts that were created in one linked claude.ai account to the other linked account, using the claude.ai Share dialog in a browser that is signed in as the owner. Use when a session-sync notice says new artifacts are waiting to be shared, or the user asks to share, invite or give the other account access to their artifacts.
---

# Share new artifacts with the other linked account

An artifact belongs to the account whose session published it. The other account gets in only through a share invite with **Editor** access: it is SENT from a browser signed in to claude.ai as the owner, and ACCEPTED from a browser or app signed in as the receiver. session-sync queues every new artifact (a hook on the `Artifact` tool) and, after the user switches accounts, asks one session to run this procedure. This is an agent procedure: you drive the UI and record the outcome; the user clicks the links.

## Rules (read first)

- **Drive the UI only.** Never call claude.ai APIs (fetch, curl, scripts) with the user's cookies or tokens. Reading the page's own network log is fine.
- **No windows.** No script or agent opens a browser window on the desktop. Use the Claude desktop app's built-in browser pane (tools `mcp__Claude_Browser__*`), and reuse one tab (open the artifact in it, close tabs you opened when done).
- **Who runs what.** The browser steps (2 to 6) run in ONE background browser subagent (`agent-companion:ac-browser` when it exists; otherwise any subagent that has the `mcp__Claude_Browser__*` tools). The main session (the one that was told to run this skill) does steps 1 and 7 to 9: it reads the queue, hands the subagent the work, gives the user the links, and verifies. Do not start a second subagent.
- **Visibility is the user's call.** Never make an artifact public or change who can see it beyond the one invite.
- Never print credentials or tokens, and never touch the Claude app's config files.

Every command below uses this prefix (`--json` prints an object):

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" artifacts <command>
```

## 1. Read the queue (main session)

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" artifacts pending --json
```

Each entry has `id`, `url`, `title`, `ownerAccount`, `ownerEmail`, `receiverEmail` and `driveable`. Also read `browsers` (the accounts the browsers we can drive were last seen signed in to) and `emails`.

- Nothing pending: tell the user in one line and stop.
- `ownerEmail` or `receiverEmail` missing for an entry whose `ownerAccount` is set: the account emails are not configured. Stop and tell the user to run `node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" config artifactShare.email <account id> <email>` once for each of the two accounts (the app's config file is never read, so the emails cannot be found automatically).
- `ownerAccount` null (the account could not be told when the artifact was made): it is handled in step 3.

Give the subagent the list (id, url, title, ownerEmail, receiverEmail) and steps 2 to 6.

## 2. Find out which account the browser is signed in as (subagent)

Open `https://claude.ai` in the pane. The account menu is at the **bottom-left** (your name or avatar); open it and read the email shown. claude.ai has no in-page account switcher: one browser holds one account. Record it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" artifacts pane <email>
```

(The name defaults to `pane`. For another driveable browser, for example Claude in Chrome signed in as the other account, repeat this whole procedure in that browser with `--browser chrome`: the queue, the hook and the commands already take any number of browsers; only steps 3 to 6 are browser-specific and are the same.)

## 3. Decide what this browser can send

For each entry, compare its `ownerEmail` with the email from step 2 (case does not matter):

- Same: this browser owns it; send (steps 4 to 6). The receiver is `receiverEmail`; if it is null (the owner was unknown), the receiver is the other configured email.
- Different: leave it pending and say so in the report ("no driveable browser is signed in as <ownerEmail>"). Another browser can take it later; do not touch it.
- `ownerEmail` null (owner unknown): open it (step 4). If the page offers **Share**, this browser's account owns it, so send to the other configured email; if there is no Share control, leave it pending and say so.

## 4. Open the artifact and check it is private (subagent)

Open the entry's `url` in the pane. Open **Share**. If general access says **Anyone with the link** (the artifact is public), do not change anything:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" artifacts mark <id> skipped --reason public
```

A public artifact shows the receiver no Accept button, so it needs no invite.

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

When every entry is handled, close any tab you opened and return a table to the main session: id, title, status (invited, skipped-public, failed, or left pending), the invitation link, and the reason for anything not invited.

## 7. Give the user the links (main session)

In one short message: the invitation link for each invited artifact (title and link), a note that the user opens each link while signed in as the receiver and clicks **Accept**, and a list of anything left pending or failed with its reason (for example "no browser I can drive is signed in as <email>"). Do not open the links yourself, and do not open any browser window. Then carry on with what the user asked for; the verification below waits for them.

## 8. Verify after they accept (main session)

When the user says they accepted, from this session (which runs as the receiving account) call the `Artifact` tool with `action: "read"`, the artifact `url`, and a `prompt` such as "Only report the access level header (writer or not) and the title". The header says **(writer)** once the invite was accepted:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/cli.mjs" artifacts mark <id> done
```

If it does not say writer, leave the entry `invited` and tell the user the invite is still not accepted (the link may have been opened in the wrong account).

## 9. Housekeeping

- `artifacts list` shows every entry with its status; `artifacts forget <id>` drops one the user does not want shared; `artifacts mark <id> pending` retries a failed one.
- The notice is given once per account switch (it is not repeated while you work through the queue). If a run died, the entries stay pending: running this skill again by hand retries them.
- `config artifactShare.enabled false` turns the whole feature off (nothing is queued and nothing is triggered).
- Say plainly what is not done: pending, failed and invited-but-not-accepted entries.
