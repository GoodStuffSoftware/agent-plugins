#!/usr/bin/env node
/**
 * cli.mjs — entry point for hooks and manual runs.
 *
 *   node lib/cli.mjs status         what would sync, and is the machine ready
 *   node lib/cli.mjs push           local -> remote
 *   node lib/cli.mjs pull           remote -> local
 *   node lib/cli.mjs auto-pull      pull ONLY if another machine pushed since ours
 *   node lib/cli.mjs config          print settings
 *   node lib/cli.mjs config remote <remote:path>   change where backups go
 *
 * Remote resolves as: CLAUDE_SESSION_SYNC_REMOTE > config.json > "gdrive:Claude/live".
 *
 * Hooks call this. Exit code 0 always for hook-invoked paths unless --strict:
 * a sync problem should surface as a notification, never as a blocked session.
 */

import { push, pull, preflight, remoteNewer } from './sync.mjs';
import { notify } from './notify.mjs';
import { loadConfig, saveConfig, validateRemote, describeConfig, CONFIG_FILE } from './config.mjs';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';

const CFG = loadConfig();
const REMOTE = CFG.remote;
const STATE_DIR = join(homedir(), '.claude', 'session-sync');
const LOG = join(STATE_DIR, 'sync.log');
const LAST_PULL = join(STATE_DIR, 'last-pull.txt');
const SETUP_NAGGED = join(STATE_DIR, 'setup-reminded.txt');

function ensureState() { try { mkdirSync(STATE_DIR, { recursive: true }); } catch {} }
function log(line) {
  ensureState();
  const s = `${new Date().toISOString()}  ${line}\n`;
  try { appendFileSync(LOG, s); } catch {}
  if (process.env.CLAUDE_SESSION_SYNC_VERBOSE) process.stderr.write(s);
}

const cmd = process.argv[2] || 'status';
const strict = process.argv.includes('--strict');
const quiet = process.argv.includes('--quiet') || CFG.notifications === false;

/**
 * An unconfigured plugin is INERT, and silence is how it stays that way: the
 * hook runs, finds no rclone, logs, exits 0, and the user never learns their
 * conversations aren't syncing. Tell them — once. Nagging every session for a
 * setup step they may have deliberately deferred is its own failure.
 */
function remindSetupOnce(reason, missing) {
  log(`not configured: ${reason}`);
  if (quiet || existsSync(SETUP_NAGGED)) return;
  try {
    ensureState();
    writeFileSync(SETUP_NAGGED, new Date().toISOString());
    // A toast is ~2 lines. Put the ACTUAL commands somewhere they persist and
    // can be copy-pasted, and point the toast at it. "Run the setup skill" is
    // not instructions if the user is not in a Claude session when they see it.
    const instructionsPath = join(STATE_DIR, 'SETUP-REQUIRED.md');
    writeFileSync(instructionsPath, setupInstructions(reason, missing));
    notify(
      'Claude conversations are NOT syncing',
      `${reason} Steps to fix: ${instructionsPath} — or run /session-sync:setup in Claude.`,
      { persist: true, tag: 'session-sync-setup' },
    );
    log(`wrote setup instructions to ${instructionsPath}`);
  } catch {}
}

function setupInstructions(reason, missing) {
  const p = platform();
  const install = p === 'win32' ? 'winget install Rclone.Rclone'
    : p === 'darwin' ? 'brew install rclone'
    : 'sudo apt install rclone      # or: curl https://rclone.org/install.sh | sudo bash';
  const home = p === 'win32' ? '%USERPROFILE%' : '~';

  return `# session-sync needs setup

**${reason}**
Until this is fixed your Claude conversations are **not** being backed up or synced.

The fastest route is to ask Claude: \`/session-sync:setup\` — it will walk these
same steps and check the result. Otherwise, by hand:

${missing === 'rclone' ? `## 1. Install rclone

    ${install}

Then open a NEW terminal so it is on your PATH.

## 2. Configure a remote` : `## Configure a remote`}

    rclone config

- \`n\` for a new remote
- **Name it exactly \`gdrive\`** (or set CLAUDE_SESSION_SYNC_REMOTE to point elsewhere)
- Choose your storage type — Google Drive, S3, R2, Dropbox, WebDAV and 40+ others work
- Leave client_id / client_secret blank unless you have your own
- A browser opens: sign in and approve

Verify it worked:

    rclone lsd gdrive:

## 3. First sync

    node "${join(process.env.CLAUDE_PLUGIN_ROOT || '<plugin dir>', 'lib', 'cli.mjs')}" push

Check three folders arrived — \`dot-claude/\`, \`claude-code-sessions/\`,
\`local-agent-mode-sessions/\`. Without the last two, conversations restore for
\`claude --resume\` but will **not** appear in the Claude Desktop sidebar.

## Notes

- Nothing syncs until the above is done; the plugin stays inert and will not
  interfere with Claude in the meantime.
- Credentials are never synced — you sign in normally on each machine.
- Using Google Drive? rclone's built-in client_id is shared and rate-limited.
  If you see \`rateLimitExceeded\`, make your own (10 min, one time):
  https://rclone.org/drive/#making-your-own-client-id

Log: ${join(STATE_DIR, 'sync.log')}
State: ${home}${p === 'win32' ? '\\.claude\\session-sync' : '/.claude/session-sync'}
`;
}

// ---- config: read, or set a key ------------------------------------------
// `config`                      -> print current settings as JSON
// `config remote gdrive:X/Y`    -> set where backups go
// `config enabled false`        -> pause syncing on this machine
if (cmd === 'config') {
  const key = process.argv[3];
  const value = process.argv.slice(4).join(' ');
  if (!key) { console.log(JSON.stringify(describeConfig(), null, 2)); process.exit(0); }

  if (key === 'remote') {
    const v = validateRemote(value);
    if (!v.ok) { console.error(v.error); process.exit(2); }
    saveConfig({ remote: v.value });
    log(`config: remote -> ${v.value}`);
    console.log(JSON.stringify({ ok: true, remote: v.value, warning: v.warning || null, configFile: CONFIG_FILE }, null, 2));
    process.exit(0);
  }
  if (key === 'enabled' || key === 'notifications') {
    const on = /^(true|1|yes|on)$/i.test(value);
    saveConfig({ [key]: on });
    log(`config: ${key} -> ${on}`);
    console.log(JSON.stringify({ ok: true, [key]: on, configFile: CONFIG_FILE }, null, 2));
    process.exit(0);
  }
  console.error(`unknown setting "${key}". Valid: remote, enabled, notifications`);
  process.exit(2);
}

// Paused on this machine? Do nothing, quietly — this is a deliberate choice,
// not a fault, so it must not notify or warn.
if (CFG.enabled === false && (cmd === 'push' || cmd === 'pull' || cmd === 'auto-pull')) {
  log(`${cmd}: skipped — syncing is disabled on this machine (config.enabled=false)`);
  process.exit(0);
}

// Sync commands are pointless without a working rclone + remote. Check once,
// up front, so the failure is a clear message rather than a stack trace.
if (cmd === 'push' || cmd === 'pull' || cmd === 'auto-pull') {
  const p = preflight(REMOTE);
  if (!p.rclone) { remindSetupOnce('rclone is not installed.', 'rclone'); process.exit(0); }
  if (!p.remoteConfigured) { remindSetupOnce(`No rclone remote matching "${REMOTE}".`, 'remote'); process.exit(0); }
  // Configured again after a lapse — allow a future reminder.
  try { if (existsSync(SETUP_NAGGED)) unlinkSync(SETUP_NAGGED); } catch {}
}

try {
  if (cmd === 'status') {
    const p = preflight(REMOTE);
    console.log(JSON.stringify(p, null, 2));
    process.exit(p.ready ? 0 : 1);
  }

  if (cmd === 'push') {
    log(`push -> ${REMOTE}`);
    const r = await push(REMOTE, { quiet, onLog: log });
    log(`push ${r.ok ? 'ok' : 'FAILED'} (${r.mins} min)`);
    process.exit(r.ok || !strict ? 0 : 1);
  }

  if (cmd === 'pull') {
    log(`pull <- ${REMOTE}`);
    const r = await pull(REMOTE, { quiet, onLog: log });
    if (r.ok) { ensureState(); writeFileSync(LAST_PULL, new Date().toISOString()); }
    log(`pull ${r.ok ? 'ok' : 'FAILED'} (${r.secs}s)`);
    process.exit(r.ok || !strict ? 0 : 1);
  }

  if (cmd === 'auto-pull') {
    // Cheap: reads one tiny marker file. Safe to call often.
    const since = existsSync(LAST_PULL) ? readFileSync(LAST_PULL, 'utf8').trim() : null;
    const hit = await remoteNewer(REMOTE, since);
    if (!hit) { log('auto-pull: nothing newer'); process.exit(0); }
    log(`auto-pull: ${hit.machine} pushed at ${hit.ts} — pulling`);
    const r = await pull(REMOTE, { quiet, onLog: log });
    if (r.ok) { ensureState(); writeFileSync(LAST_PULL, new Date().toISOString()); }
    process.exit(0);
  }

  console.error(`unknown command: ${cmd}`);
  process.exit(2);
} catch (err) {
  log(`fatal: ${err?.message || err}`);
  // Never block a Claude session because a backup had a bad day.
  process.exit(strict ? 1 : 0);
}
