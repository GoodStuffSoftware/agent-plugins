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
 *
 * Flags:
 *   --from-hook   Set by hooks.json, never by a human or the skills. Applies
 *                 the debounce window (config.debounceMinutes) and hands the
 *                 real work off to a detached background process instead of
 *                 running it synchronously — see spawnDetachedSelf() below.
 *                 A manual `push`/`pull`/`auto-pull` always runs synchronously
 *                 and immediately, with no debounce, so the sync skill's
 *                 "push before switching machines" promise still holds.
 *   --strict      Non-zero exit on a real sync failure (still exit 0 for
 *                 "paused"/"not configured", which are not failures).
 *   --quiet       Suppress ALL notifications for this run, hook or not.
 */

import { push, pull, preflight, remoteNewer } from './sync.mjs';
import { notify, registerWindowsSender } from './notify.mjs';
import { loadConfig, saveConfig, validateRemote, describeConfig, CONFIG_FILE } from './config.mjs';
import { acquireLock } from './lock.mjs';
import { requestDeferred, refreshDeferred, settleDeferred, readDeferred } from './defer.mjs';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';

const CFG = loadConfig();
const REMOTE = CFG.remote;
const STATE_DIR = join(homedir(), '.claude', 'session-sync');
const LOG = join(STATE_DIR, 'sync.log');
const LAST_PULL = join(STATE_DIR, 'last-pull.txt');
const LAST_PUSH = join(STATE_DIR, 'last-push.txt');
const SETUP_NAGGED = join(STATE_DIR, 'setup-reminded.txt');
const SENDER_REGISTERED = join(STATE_DIR, 'sender-registered.txt');
const LOCK_FILE = join(STATE_DIR, 'sync.lock');
const DEFER_FILE = join(STATE_DIR, 'deferred-push.json');
const DEBOUNCE_MS = Math.max(0, Number(CFG.debounceMinutes) || 0) * 60000;

// How long a deferred worker waits before re-attempting a push that could not
// take the sync lock, or that failed. Env-overridable so tests can exercise
// the retry path in seconds instead of minutes; never set in production.
const DEFER_RETRY_MS = Math.max(50, Number(process.env.CLAUDE_SESSION_SYNC_DEFER_RETRY_MS) || 30000);
const DEFER_MAX_ATTEMPTS = Math.max(1, Number(process.env.CLAUDE_SESSION_SYNC_DEFER_MAX_ATTEMPTS) || 40);

// A hook invocation carries this; a manual run (the sync/status skills, or a
// user typing the command themselves) never does. It gates two things that
// must NEVER apply to an explicit "push now, I'm switching machines" request:
// the debounce window, and running detached in the background (see
// spawnDetachedSelf below) instead of returning a real result synchronously.
const fromHook = process.argv.includes('--from-hook');

// Set ONLY by spawnDetachedSelf() when cli.mjs re-invokes itself as the
// background worker that owns a deferred push. Never by a hook, never by a
// human. See deferredPushWorker().
const isDeferredWorker = process.argv.includes('--deferred');

function ensureState() { try { mkdirSync(STATE_DIR, { recursive: true }); } catch {} }
function log(line) {
  ensureState();
  const s = `${new Date().toISOString()}  ${line}\n`;
  try { appendFileSync(LOG, s); } catch {}
  if (process.env.CLAUDE_SESSION_SYNC_VERBOSE) process.stderr.write(s);
}

/**
 * Has less than `debounceMs` elapsed since the timestamp in `markerFile`?
 * The sync LOCK only stops two syncs running AT ONCE — a hook firing a few
 * seconds after the last one finished gets a fresh lock instantly and syncs
 * again. This is the actual throttle for "N conversations in an hour = N
 * syncs," and it only ever applies to hook-triggered runs (see `fromHook`).
 *
 * NOTE: only `auto-pull` still uses this as a plain skip, and deliberately —
 * a skipped pull costs freshness, never data (the remote keeps everything, and
 * the next SessionStart pulls it). A skipped PUSH costs the conversation, so
 * push goes through the coalescing deferral in defer.mjs instead.
 */
function tooSoonSince(markerFile, debounceMs) {
  if (debounceMs <= 0) return false;
  const last = readStamp(markerFile);
  if (last === null) return false;
  return Date.now() - last < debounceMs;
}

/** An ISO timestamp file as epoch ms, or null when absent/unparseable. */
function readStamp(file) {
  try {
    const t = new Date(readFileSync(file, 'utf8').trim()).getTime();
    return Number.isNaN(t) ? null : t;
  } catch { return null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/**
 * THE DEFERRED PUSH WORKER — a detached background process that owns one
 * outstanding "a push is owed" record and does not exit until it has either
 * pushed successfully or exhausted its attempts (leaving the record behind for
 * the next session to pick up). It is the reason a debounced or lock-blocked
 * push is DEFERRED rather than DROPPED. See defer.mjs for the record's rules.
 */
async function deferredPushWorker() {
  const start = readDeferred(DEFER_FILE);
  const runAt = Number.isFinite(start?.runAt) ? start.runAt : Date.now();
  const waitMs = runAt - Date.now();
  if (waitMs > 0) log(`deferred push: waiting ${Math.round(waitMs / 1000)}s for the debounce window to lapse`);
  await sleep(waitMs);

  for (let attempt = 1; attempt <= DEFER_MAX_ATTEMPTS; attempt++) {
    if (!readDeferred(DEFER_FILE)) {
      log('deferred push: nothing owed any more (another push already covered it)');
      return;
    }

    // Captured BEFORE push() scans the tree, so a request arriving mid-push is
    // correctly judged NOT covered by this run. See settleDeferred().
    const claimedAt = Date.now();
    const lock = acquireLock(LOCK_FILE);
    if (!lock.acquired) {
      // The old behaviour here was to exit — which silently discarded the
      // request. Keep it, re-stamp so later requests coalesce onto us, retry.
      log(`deferred push: ${lock.reason} — retrying in ${Math.round(DEFER_RETRY_MS / 1000)}s (request kept)`);
      refreshDeferred(DEFER_FILE, { runAt: Date.now() + DEFER_RETRY_MS, pid: process.pid });
      await sleep(DEFER_RETRY_MS);
      continue;
    }

    log(`deferred push -> ${REMOTE} (attempt ${attempt})`);
    let r;
    try {
      r = await push(REMOTE, { quiet, onLog: log, notifyMode: CFG.notifyMode });
    } finally {
      lock.release();
    }

    if (r.ok) {
      ensureState();
      writeFileSync(LAST_PUSH, new Date().toISOString());
      const settled = settleDeferred(DEFER_FILE, claimedAt);
      log(`deferred push ok (${r.mins} min)${settled ? '' : ' — a newer request arrived mid-push, running again for it'}`);
      if (settled) return;
      continue;
    }

    log(`deferred push FAILED (${r.mins} min) — retrying in ${Math.round(DEFER_RETRY_MS / 1000)}s (request kept)`);
    refreshDeferred(DEFER_FILE, { runAt: Date.now() + DEFER_RETRY_MS, pid: process.pid });
    await sleep(DEFER_RETRY_MS);
  }

  // Deliberately leaves the record on disk: still owed, just not by us. The
  // next hook-triggered push sees a dead worker pid and schedules a fresh one.
  log(`deferred push: gave up after ${DEFER_MAX_ATTEMPTS} attempts — the request is still recorded and will be retried by the next session`);
}

/**
 * Re-invoke this same CLI as a fully background process and return
 * immediately, so a long push/pull cannot be killed by the hook's own
 * timeout (SessionEnd's 600s) or by the hook's process tree tearing down
 * when the conversation that spawned it exits — a real push was measured
 * at 262 minutes. `detached: true` + `.unref()` is Node's own documented
 * mechanism for exactly this; `windowsHide` keeps it from flashing a console
 * the way a detached powershell.exe does (see notify.mjs's `detach()` — that
 * finding was specifically about powershell.exe, not a plain node.exe child,
 * which does not allocate its own console the same way).
 *
 * CAVEAT, stated rather than hidden: if Claude Code's hook runner wraps the
 * hook process in a Windows Job Object with kill-on-close and no breakaway
 * allowed, the OS can still tear this child down with the job — that would
 * be a Claude Code platform behaviour outside this plugin's control, and it
 * is not something that can be verified from inside the plugin's own source.
 * `detached` is the correct, standard fix on session-sync's side regardless.
 */
function spawnDetachedSelf(args) {
  const child = spawn(process.execPath, [process.argv[1], ...args], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => {});
  child.unref();
  return child.pid;
}

/**
 * "Claude Session Sync" toasts instead of "Windows PowerShell" — HKCU only,
 * no admin, idempotent (checked-and-skipped after the first successful run).
 * Best-effort: a failure here must never block or fail a sync.
 */
function ensureWindowsSenderRegistered() {
  if (platform() !== 'win32' || existsSync(SENDER_REGISTERED)) return;
  try {
    const icon = join(dirname(process.argv[1]), '..', 'assets', 'icon.ico');
    const ok = registerWindowsSender('Claude Session Sync', existsSync(icon) ? icon : null);
    // Only remember "done" when it actually succeeded (registerWindowsSender
    // is synchronous now specifically so this is trustworthy) — otherwise a
    // one-time failure (locked-down HKCU, no powershell on PATH, whatever)
    // would silently disable branding forever instead of retrying next time.
    if (ok) { ensureState(); writeFileSync(SENDER_REGISTERED, new Date().toISOString()); }
  } catch { /* toasts still work, just unbranded — never worth failing a sync over */ }
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
  if (key === 'notifyMode') {
    if (!['all', 'first-run', 'failures'].includes(value)) {
      console.error(`"${value}" is not a valid notifyMode. Use: all, first-run, failures.`);
      process.exit(2);
    }
    saveConfig({ notifyMode: value });
    log(`config: notifyMode -> ${value}`);
    console.log(JSON.stringify({ ok: true, notifyMode: value, configFile: CONFIG_FILE }, null, 2));
    process.exit(0);
  }
  if (key === 'debounceMinutes') {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      console.error(`"${value}" is not a valid debounceMinutes — use a number of minutes >= 0 (0 disables it).`);
      process.exit(2);
    }
    saveConfig({ debounceMinutes: n });
    log(`config: debounceMinutes -> ${n}`);
    console.log(JSON.stringify({ ok: true, debounceMinutes: n, configFile: CONFIG_FILE }, null, 2));
    process.exit(0);
  }
  console.error(`unknown setting "${key}". Valid: remote, enabled, notifications, notifyMode, debounceMinutes`);
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
  ensureWindowsSenderRegistered();
}

try {
  if (cmd === 'status') {
    const p = preflight(REMOTE);
    console.log(JSON.stringify(p, null, 2));
    process.exit(p.ready ? 0 : 1);
  }

  if (cmd === 'push') {
    // The background worker for an already-recorded request. Runs the real
    // push after the debounce window lapses, retrying on lock contention.
    if (isDeferredWorker) {
      await deferredPushWorker();
      process.exit(0);
    }

    // A hook-triggered push RECORDS a request and hands off to a detached
    // background worker, so it survives the hook's own timeout and the
    // conversation process tree tearing down (see spawnDetachedSelf's doc
    // comment). The debounce shifts WHEN that worker runs; it never cancels
    // the request. Rapid repeat requests coalesce onto the one live worker,
    // so N conversations ending together still cost exactly one push — and
    // the last of them is still the one that gets pushed. See defer.mjs.
    //
    // A manual run keeps running synchronously so its caller gets a real
    // result — the sync skill and `--strict` both depend on that.
    if (fromHook) {
      const last = readStamp(LAST_PUSH);
      const runAt = Math.max(Date.now(), (last ?? 0) + DEBOUNCE_MS);
      const r = requestDeferred(DEFER_FILE, {
        runAt,
        spawnWorker: () => spawnDetachedSelf(['push', '--deferred']),
      });
      const inS = Math.max(0, Math.round((r.runAt - Date.now()) / 1000));
      log(`push -> ${REMOTE} (${r.action}: deferred worker pid ${r.pid} runs in ~${inS}s${
        inS > 0 ? ` — debounce ${CFG.debounceMinutes} min` : ''})`);
      process.exit(0);
    }
    // Hooks fire per conversation; several ending together would otherwise race.
    const lock = acquireLock(LOCK_FILE);
    if (!lock.acquired) { log(`push skipped — ${lock.reason}`); process.exit(0); }
    // NOT try/finally: process.exit() does not run finally blocks, which leaked
    // the lock file on every run. 'exit' fires on explicit exit too.
    process.on('exit', () => lock.release());
    log(`push -> ${REMOTE}`);
    const r = await push(REMOTE, { quiet, onLog: log, notifyMode: CFG.notifyMode });
    if (r.ok) { ensureState(); writeFileSync(LAST_PUSH, new Date().toISOString()); }
    log(`push ${r.ok ? 'ok' : 'FAILED'} (${r.mins} min)`);
    process.exit(r.ok || !strict ? 0 : 1);
  }

  if (cmd === 'pull') {
    const lock = acquireLock(LOCK_FILE);
    if (!lock.acquired) { log(`pull skipped — ${lock.reason}`); process.exit(0); }
    process.on('exit', () => lock.release());
    log(`pull <- ${REMOTE}`);
    const r = await pull(REMOTE, { quiet, onLog: log, notifyMode: CFG.notifyMode });
    if (r.ok) { ensureState(); writeFileSync(LAST_PULL, new Date().toISOString()); }
    log(`pull ${r.ok ? 'ok' : 'FAILED'} (${r.secs}s)`);
    process.exit(r.ok || !strict ? 0 : 1);
  }

  if (cmd === 'auto-pull') {
    if (fromHook) {
      // The cheap check (one tiny remote marker file) never needs the lock
      // and never gets debounced — it's the actual pull that's expensive and
      // worth throttling. No lock is held between here and the hand-off, so
      // this never blocks a concurrent push from proceeding.
      const since = existsSync(LAST_PULL) ? readFileSync(LAST_PULL, 'utf8').trim() : null;
      const hit = await remoteNewer(REMOTE, since);
      if (!hit) { log('auto-pull: nothing newer'); process.exit(0); }
      if (tooSoonSince(LAST_PULL, DEBOUNCE_MS)) {
        log(`auto-pull: ${hit.machine} pushed at ${hit.ts} — deferred, pulled within the last ${CFG.debounceMinutes} min (debounce)`);
        process.exit(0);
      }
      const pid = spawnDetachedSelf(['auto-pull']);
      log(`auto-pull: ${hit.machine} pushed at ${hit.ts} — handed off to background pid ${pid}`);
      process.exit(0);
    }
    const lock = acquireLock(LOCK_FILE);
    if (!lock.acquired) { log(`auto-pull skipped — ${lock.reason}`); process.exit(0); }
    process.on('exit', () => lock.release());
    // Cheap: reads one tiny marker file. Safe to call often. Re-checked here
    // (already checked once by the hook-invoked parent, if any) because a
    // manual run of `auto-pull` never went through that parent at all.
    const since = existsSync(LAST_PULL) ? readFileSync(LAST_PULL, 'utf8').trim() : null;
    const hit = await remoteNewer(REMOTE, since);
    if (!hit) { log('auto-pull: nothing newer'); process.exit(0); }
    log(`auto-pull: ${hit.machine} pushed at ${hit.ts} — pulling`);
    const r = await pull(REMOTE, { quiet, onLog: log, notifyMode: CFG.notifyMode });
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
