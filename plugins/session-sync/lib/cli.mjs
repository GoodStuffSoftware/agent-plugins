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

import { push, pull, preflight, remoteNewer, remoteRecordList } from './sync.mjs';
import { notify, registerWindowsSender } from './notify.mjs';
import { loadConfig, saveConfig, validateRemote, describeConfig, CONFIG_FILE, ACCOUNT_LINK_MODES, LIVE_RELINK_MODES, SPAWN_FIX_MODES } from './config.mjs';
import { acquireLock } from './lock.mjs';
import { requestDeferred, refreshDeferred, settleDeferred, readDeferred } from './defer.mjs';
import { makeCtx, loadState, saveState, accPath, readJson, writeJsonAtomic, rollbackActive, rollbackMarkerFile } from './accounts/state.mjs';
import { listFolders, groupOf, accountsOf, pendingPairs, answerPairs } from './accounts/folders.mjs';
import { appState, lockfilePresent } from './accounts/appstate.mjs';
import { fullPass, livePass, link, unlink } from './accounts/pass.mjs';
import { ensureWaiter, runWaiter, replaceOldWaiter } from './accounts/waiter.mjs';
import { rcSettings, wakeWithRelink, rcLogonStep, liveRelinkPass, rcSweep } from './accounts/rcrestore.mjs';
import { rcRepair, turnEndHook, runTurnEnd } from './accounts/rcrepair.mjs';
import { spawnPlan, spawnFixStep, spawnLook, spawnLine } from './accounts/rcspawn.mjs';
import { installLogonTask, uninstallLogonTask, ensureLogonTask } from './accounts/logontask.mjs';
import { createProgressUi } from './accounts/progress.mjs';
import { launchDetached, launchViaHelper } from './accounts/launcher.mjs';
import { planGoLive, beginGoLive, runGoLive, goLiveInProgress, resumeIfDead, replaceWaitingRunner, PLUGIN_VERSION, copyWords, takeGoLiveReport, runnerAlive, goLiveLogFile, goLiveResultFile } from './accounts/golive.mjs';
import { quitSupport } from './accounts/appquit.mjs';
import { collectStatus, summarizePass, formatPass, formatStatus, RESTART_LEAD, RESTART_LEAD_WAITER, WAIT_NOTE } from './accounts/report.mjs';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, openSync, closeSync, writeSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

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
      await accountsSync('push');
      r = await push(REMOTE, { quiet, onLog: log, notifyMode: CFG.notifyMode });
    } finally {
      lock.release();
    }

    if (r.ok) {
      ensureState();
      writeFileSync(LAST_PUSH, new Date().toISOString());
      await accountsDailyRemoteCheck();
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

// ---- several claude.ai accounts: hook step, passes and commands ------------
// The engine lives in lib/accounts/*; this is only the wiring (plan sections 5.12, 6).
// Account commands never depend on rclone or `enabled`. Hook-path functions never
// throw and never write to stdout except the one SessionStart context object.

const jsonOut = process.argv.includes('--json');
const HOOK_DEBOUNCE_MS = 30 * 1000;

/** Synchronous stdout write (a process.exit right after must not drop it). */
function writeStdout(text) {
  try { writeSync(1, text); } catch { try { process.stdout.write(text); } catch { /* no stdout */ } }
}

// The waiter must outlive the app quit AND an archive or account switch of the launching session: the one launcher (accounts/launcher.mjs).
// The hook step calls this, and the hook must stay fast and free of PowerShell: launchViaHelper only spawns a tiny
// detached node (`accounts launch-detached`) that makes the real launch (CIM on Windows) and exits.
const spawnWaiter = (reason) => {
  const r = launchViaHelper(['accounts', 'wait', '--reason', reason], { ctx: makeCtx() });
  if (!r.ok) throw new Error(r.error ?? 'could not start the waiter');
  return r.pid;
};
let waiterArmedHere = false;   // this process already armed (or joined) the waiter: a second arm right behind it would race the first one's start
const armWaiter = (ctx, reason) => { waiterArmedHere = true; return ensureWaiter(ctx, reason, spawnWaiter); };

/** The Remote Control restore settings (config rcRestore.*), read afresh. Windows only: elsewhere the whole feature is off. */
const rcRestoreNow = () => (platform() === 'win32' ? rcSettings(loadConfig()) : { enabled: false, days: 3, wake: false, wakeMax: 4, liveRelink: 'off' });

/** The watcher also prepares Remote Control at the quit, with one account or several: a session start with the app running makes sure it is there. */
function rcHookArm() {
  if (waiterArmedHere || !rcRestoreNow().enabled) return;
  const ctx = makeCtx();
  if (ctx.store && lockfilePresent(ctx)) armWaiter(ctx, 'watch');
}

/**
 * The setup of the "session-sync RC restore" logon task, next to the waiter's setup (a session start): installed while rcRestore is enabled and
 * rcRestore.logonTask is on, removed when either is off. Windows only. A stamp keeps the usual run free of any process start.
 * A sandboxed test run (the app-state seam) skips it unless the scheduler seam (SESSION_SYNC_TEST_SCHTASKS) stands in for schtasks.
 */
function rcLogonTaskSetup() {
  if (platform() !== 'win32') return;
  if (process.env.SESSION_SYNC_TEST_APP_STATE && !process.env.SESSION_SYNC_TEST_SCHTASKS) return;
  if (!makeCtx().store) return;
  const r = ensureLogonTask({ settings: rcRestoreNow() });
  if (r.action === 'installed' || r.action === 'removed') log(`rc-restore: logon task ${r.action} ("session-sync RC restore")`);
  else if (r.ok === false) log(`rc-restore: logon task setup failed: ${r.error}`);
}

/**
 * For the interactive commands (go-live, answer yes), never the hook: end a waiter left by an older copy of the plugin, so the
 * next one (armWaiter, or the runner) comes from this copy. Never throws.
 */
function replaceStaleWaiter(ctx) {
  try {
    const r = replaceOldWaiter(ctx);
    if (r.replaced) log(`accounts: waiter (pid ${r.pid}, version ${r.version ?? 'older'}${r.version === PLUGIN_VERSION ? `, code ${r.hash}` : ''}) ${r.stale ? 'was stale and was dropped' : 'ended'} for the version ${PLUGIN_VERSION}`);
    else if (r.reason === 'unverified' || r.reason === 'busy') log(`accounts: an older waiter (pid ${r.pid}) was left alone (${r.reason})`);
    return r;
  } catch (e) { log(`accounts: replacing the old waiter failed: ${e?.message ?? e}`); return { replaced: false, reason: 'error' }; }
}

/** A "done" toast, honouring `notifications` and `notifyMode: failures`. */
function accountsToast(title, body) {
  if (CFG.notifications === false || CFG.notifyMode === 'failures') return;
  notify(title, body, { tag: 'accounts' });
}

function stampRecent(file, ms, now = Date.now()) {
  const t = Number(readFileSyncSafe(file));
  return Number.isFinite(t) && t > 0 && now - t < ms;
}
function readFileSyncSafe(file) { try { return readFileSync(file, 'utf8').trim(); } catch { return ''; } }
function writeStamp(file, now = Date.now()) { try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, String(now)); } catch { /* best effort */ } }

/** One `accounts` run's output: `--json` prints the facts object, otherwise the text lines. */
function emit(facts, lines) {
  if (jsonOut) console.log(JSON.stringify(facts, null, 2));
  else console.log(lines.join('\n'));
}

/**
 * Check the remote once for a record under more than one folder (reported, never
 * deleted) and save the listing to remote-list.json (it also feeds `homeOf`).
 */
async function accountsRemoteCheck(ctx) {
  const p = preflight(REMOTE);
  if (!p.rclone || !p.remoteConfigured) return { checked: false, notConfigured: true, reason: 'rclone or the remote is not configured' };
  const r = await remoteRecordList(REMOTE);
  if (!r.ok) return { checked: false, reason: 'the remote could not be listed' };
  const at = new Date().toISOString();
  writeJsonAtomic(accPath(ctx, 'remote-list.json'), { at, ids: r.ids });
  const state = loadState(ctx);
  state.lastRemoteCheck = at;
  saveState(ctx, state);
  return { checked: true, at, ids: r.count, duplicates: Object.keys(r.duplicates).length, ...(r.neverPushed ? { neverPushed: true } : {}) };
}

/**
 * Rectify and merge for a linked group, by app state: a full pass when the app is
 * stopped, else a live pass. Arms the waiter when work is owed. Never throws.
 * `sync()` below is what push and pull call.
 */
async function accountsPass(ctx, reason) {
  const state = loadState(ctx);
  if (!state.linked) return { ok: false, kind: 'pass', skipped: 'not-linked' };
  // S5: a watcher still running the code of an older copy (another version, or the same version with other code) is ended and
  // replaced below by armWaiter. Never from the SessionStart hook (the hook only arms): this runs in the detached rectify and in
  // push and pull, and the OS is asked only when the claim already differs from this copy.
  replaceStaleWaiter(ctx);
  const app = appState({ ctx, probeProcesses: true });
  const remoteList = readJson(accPath(ctx, 'remote-list.json'), null);
  const res = app.fullAllowed
    ? await fullPass(ctx, { app, remoteList, reasons: [reason], log })
    : await livePass(ctx, { app, remoteList });
  if (res.armWaiter || res.aborted || loadState(ctx).fullPassOwed) armWaiter(ctx, 'deferred');
  // the singleton watcher follows account switches while the app runs (go-live's last pass, every push and pull)
  else if (app.running) armWaiter(ctx, 'watch');
  return res;
}

async function accountsSync(reason) {
  try {
    const ctx = makeCtx();
    if (!ctx.store) return;
    if (!loadState(ctx).linked) return;
    const res = await accountsPass(ctx, reason);
    const s = summarizePass(res);
    log(`accounts ${reason}: ${s.ok ? 'ok' : (s.skipped ?? s.reason ?? 'not run')} (linked ${s.linked}, re-linked ${s.relinked}, deleted ${s.deleted}, owed ${s.owed})`);
  } catch (e) { log(`accounts ${reason} failed: ${e?.message || e}`); }
}

/** After a push: the remote duplicate check, at most daily. */
async function accountsDailyRemoteCheck() {
  try {
    const ctx = makeCtx();
    if (!ctx.store) return;
    const state = loadState(ctx);
    if (!state.linked) return;
    if (state.lastRemoteCheck && Date.now() - Date.parse(state.lastRemoteCheck) < 24 * 3600 * 1000) return;
    const r = await accountsRemoteCheck(ctx);
    log(`accounts remote check: ${r.checked ? `${r.ids} record(s), ${r.duplicates} duplicate(s)` : r.reason}`);
  } catch (e) { log(`accounts remote check failed: ${e?.message || e}`); }
}

// The restart line comes AFTER the question: a restart without a yes does nothing, so it is not the first thing the user reads.
const askText = (n, ids) => 'session-sync: '
  + `The Claude desktop app on this machine has been signed into ${n} claude.ai accounts (${ids.join(', ')}). `
  + 'session-sync can show every Code-tab conversation, local scheduled task and app setting in all of them. '
  + 'If you are talking with the user, ask them once whether to share these across the accounts, and point them to /session-sync:accounts for details. '
  + `Record the answer with: node "${resolve(process.argv[1])}" accounts answer yes   (or: no). `
  + `Only after a yes, tell them: ${RESTART_LEAD_WAITER} `
  + 'If this session runs unattended (no user to ask), do nothing.';

/** `ask-claim-<pairhash>-<YYYYMMDD>`: created with `wx`, so two sessions starting together ask once. */
function claimAsk(ctx, pend) {
  const hash = createHash('sha1').update(pend.join(',')).digest('hex').slice(0, 10);
  const day = new Date(ctx.now()).toISOString().slice(0, 10).replace(/-/g, '');
  const file = accPath(ctx, `ask-claim-${hash}-${day}`);
  try { mkdirSync(dirname(file), { recursive: true }); closeSync(openSync(file, 'wx')); return true; } catch { return false; }
}

/**
 * The one-time "Restart Claude to sync your accounts" for an account that joins a group that is already linked while the app runs
 * (its folder is loaded, so it gets its conversations only at the next load; the full pass at the quit links it). One notice per
 * account: the marker is created with `wx`. Returns the account ids that have not been told yet.
 */
function claimRestartNotice(ctx, state, group) {
  const out = [];
  const known = new Set((state.group ?? []).map((k) => String(k).split('/')[0]));   // a new org of an account that is already linked needs no notice
  for (const a of new Set(group.filter((f) => !known.has(f.acct)).map((f) => f.acct))) {
    const file = accPath(ctx, `restart-notice-${a.slice(0, 8)}`);
    try { mkdirSync(dirname(file), { recursive: true }); closeSync(openSync(file, 'wx')); out.push(a); } catch { /* told already */ }
  }
  return out;
}

/**
 * The SessionStart step (plan 6). Runs first on `auto-pull --from-hook`, before the
 * `enabled` and rclone checks, and must stay fast: no PowerShell, no store walk
 * beyond one directory listing. It writes at most ONE JSON object to stdout.
 */
async function accountsHookStep() {
  const parts = [];
  try {
    // a go-live result no session has been told about yet (once), or a mid-run notice
    try { const ctx = makeCtx(); if (ctx.store) { const t = takeGoLiveReport(ctx); if (t) parts.push(t); } } catch { /* never block a session */ }
    await accountsHookStepInner(parts);
    try { rcHookArm(); } catch { /* never block a session */ }   // after the account step: that one may have armed the waiter with a reason of its own
    try { rcLogonTaskSetup(); } catch { /* never block a session */ }
  } finally {
    if (parts.length) writeStdout(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n') } })}\n`);
  }
}

async function accountsHookStepInner(parts) {
  if (CFG.accountLink === 'off') return;
  const ctx = makeCtx();
  if (!ctx.store) return;
  const folders = listFolders(ctx.store);
  const accts = accountsOf(folders);
  if (accts.length < 2) return;
  const state = loadState(ctx);
  // an unfinished go-live whose runner died (reboot, kill) is picked up again here
  try { resumeIfDead(ctx, (a) => launchViaHelper(a, { ctx })); } catch { /* never block a session */ }
  const pend = pendingPairs(state, accts);
  if (pend.length) {
    if (CFG.accountLink === 'auto') {
      answerPairs(state, pend, 'yes', 'auto', ctx.now());
      saveState(ctx, state);
      log(`accounts: accountLink=auto, ${pend.length} pair(s) answered yes`);
    } else {
      const now = ctx.now();
      const due = pend.some((k) => {
        const p = state.pairs?.[k];
        return (p?.askCount ?? 0) < 3 && (!p?.askedAt || now - Date.parse(p.askedAt) > 7 * 24 * 3600 * 1000);
      });
      if (due && claimAsk(ctx, pend)) {
        state.pairs ||= {};
        for (const k of pend) { const p = (state.pairs[k] ||= {}); p.askedAt = new Date(now).toISOString(); p.askCount = (p.askCount ?? 0) + 1; }
        saveState(ctx, state);
        parts.push(askText(accts.length, accts.map((a) => a.slice(0, 8))));
        log(`accounts: asked about ${pend.length} pending pair(s)`);
        return;
      }
    }
  }
  const group = groupOf(state, folders);
  if (group.length < 2) return;
  const stamp = accPath(ctx, state.linked ? 'hook-rectify.stamp' : 'hook-link.stamp');
  if (state.linked && lockfilePresent(ctx)) {
    armWaiter(ctx, 'watch');
    const told = claimRestartNotice(ctx, state, group);
    if (told.length) {
      parts.push(`session-sync: ${told.length === 1 ? 'A Claude account' : 'Some Claude accounts'} (${told.map((a) => a.slice(0, 8)).join(', ')}) joined the linked accounts. ${RESTART_LEAD_WAITER}`);
      accountsToast('Restart Claude to sync your accounts', 'A newly signed-in account gets its conversations after one restart of Claude.');
      log(`accounts: restart notice for ${told.length} new account(s)`);
    }
  }
  if (!state.linked) {
    if (lockfilePresent(ctx)) { armWaiter(ctx, 'link'); log('accounts: app running, waiter armed for the link'); }
    else if (!stampRecent(stamp, HOOK_DEBOUNCE_MS)) { writeStamp(stamp); spawnDetachedSelf(['accounts', 'link', '--from-hook']); log('accounts: link started in the background'); }
    return;
  }
  if (!stampRecent(stamp, HOOK_DEBOUNCE_MS)) { writeStamp(stamp); spawnDetachedSelf(['accounts', 'rectify', '--from-hook']); }
  if (state.fullPassOwed) armWaiter(ctx, 'owed');
}

/** The go-live runner's side effects that live in this file (config, passes, the remote check). */
const goLiveDeps = () => ({
  getPush: () => loadConfig().enabled !== false,
  setPush: (on) => { saveConfig({ enabled: !!on }); log(`config: enabled -> ${!!on} (go-live)`); },
  rectify: async (ctx) => summarizePass(await accountsPass(ctx, 'go-live')),
  remoteCheck: accountsRemoteCheck,
  ui: createProgressUi({ enabled: loadConfig().progressIcon !== false }),   // config progressIcon (default on): the tray icon, or notifications on macOS and Linux
});

/** y/n on a terminal; null when there is no terminal to ask on. */
async function confirmYes(question) {
  if (!process.stdin.isTTY) return null;
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^(y|yes)$/i.test((await rl.question(`${question} [y/N] `)).trim()); } finally { rl.close(); }
}

/** `accounts go-live [--yes] [--no-relaunch] [--quit-app] [--json]`: confirm, record consent, start the detached runner. */
async function goLiveCommand(ctx, args) {
  const has = (f) => args.includes(f);
  const yes = has('--yes');
  const opts = { noRelaunch: has('--no-relaunch'), quitApp: has('--quit-app') };
  const deps = goLiveDeps();
  const refuse = (reason, text, code = 3) => { emit({ ok: false, command: 'go-live', reason }, [text]); return code; };
  const launchRunner = () => launchDetached(['accounts', 'golive-run'], { ctx });
  const weak = (r) => (r.method === 'spawn-fallback' ? [`Warning: the runner could not be started outside Claude (${r.note ?? 'the Windows launch failed'}). It stops if this session is archived or the account is switched; if that happens, run: accounts go-live`] : []);
  const tail = ['The rest runs by itself, with no window. Follow it with: accounts status', `Log: ${goLiveLogFile(ctx)}`, `Result: ${goLiveResultFile(ctx)}`];

  replaceStaleWaiter(ctx);   // a waiter of an older copy cannot be trusted with the stop; this copy's runner (or waiter) takes over
  const prog = goLiveInProgress(ctx);
  if (prog) {
    const where = `phase ${prog.result.phase}, ${prog.result.status}`;
    if (runnerAlive(ctx)) {
      // a runner waiting for the app to stop (no lock, no change made) is swapped for one from this copy of the plugin
      const rep = replaceWaitingRunner(ctx);
      if (!rep.replaced) {
        emit({ ok: true, command: 'go-live', alreadyRunning: true, phase: prog.result.phase, reason: rep.reason }, [`A go-live is already running (${where}).`, ...(prog.result.phase === 'wait-stop' ? [WAIT_NOTE] : []), ...(rep.reason === 'unverified' ? ['The running process could not be checked, so it was left alone. Run this again in a moment.'] : []), ...tail]);
        return 0;
      }
      const r = launchRunner();
      if (!r.ok) return refuse('launch-failed', `The old runner was ended but the new one could not start: ${r.error}. Run: accounts go-live again (the go-live state is kept).`, 1);
      emit({ ok: true, command: 'go-live', replaced: true, stale: !!rep.stale, fromVersion: rep.version, toVersion: PLUGIN_VERSION, runner: { pid: r.pid, method: r.method } },
        [WAIT_NOTE, rep.stale ? 'The earlier runner was not running any more (its record was stale), so a new one was started. It is the same go-live; nothing was changed.' : `Replaced the waiting runner (${rep.version ?? 'older version'}) with one from version ${PLUGIN_VERSION}. It is the same go-live; nothing was changed.`, ...weak(r), ...tail]);
      return 0;
    }
    if (!yes) {
      const a = await confirmYes(`A go-live is in progress (${where}). Resume it?`);
      if (a === null) return refuse('needs-yes', 'Run again with --yes to resume.', 2);
      if (!a) return refuse('declined', 'Nothing was changed.', 0);
    }
    const r = launchRunner();
    if (!r.ok) return refuse('launch-failed', `Could not start the background runner: ${r.error}. Run: accounts go-live again.`, 1);
    emit({ ok: true, command: 'go-live', resumed: true, runner: { pid: r.pid, method: r.method } }, ['Resumed the go-live.', ...weak(r), ...tail]);
    return 0;
  }

  const plan = planGoLive(ctx, deps);
  if (!plan.ok) return refuse(plan.reason, plan.text);
  const app = appState({ ctx, probeProcesses: true });
  const lead = opts.noRelaunch ? RESTART_LEAD_WAITER : RESTART_LEAD;
  const waitNote = `${lead} There is no time limit and nothing needs to be run again. Closing the window only hides it.`;
  const lines = [
    ...(app.fullAllowed ? [] : [waitNote]),
    `Accounts: ${plan.accounts}; folders: ${plan.folders}; conversations: ${plan.conversations}.`,
    `After the link every folder holds all ${plan.expected} conversations (plus any that arrive before you quit Claude).`,
    plan.copies.length
      ? (plan.stale.length ? `${copyWords(plan.stale)} of session-sync cannot filter mirrored records (${plan.copies.length} copy(ies) found). Push will be paused until every copy can.` : `All ${plan.copies.length} copy(ies) of session-sync (desktop and terminal) can link.`)
      : 'No copy of session-sync was found to check.',
    `What happens: a backup is taken and checked, the accounts are linked and every folder is verified, Claude starts again${opts.noRelaunch ? ' (not with --no-relaunch: you start it)' : ''}, then a pass and the remote duplicate check run. A failed check rolls back by itself.`,
    app.fullAllowed ? 'Claude does not look like it is running, so the link starts at once.' : 'Claude is running: finish or stop running sessions first. The link starts as soon as it is fully stopped.',
  ];
  if (!jsonOut) console.log(lines.join('\n'));
  if (!yes) {
    const a = await confirmYes('Link the accounts now?');
    if (a === null) return refuse('needs-yes', 'Run again with --yes to confirm.', 2);
    if (!a) return refuse('declined', 'Nothing was changed.', 0);
  }
  beginGoLive(ctx, plan, opts, deps);
  const r = launchRunner();
  if (!r.ok) return refuse('launch-failed', `Your answer is recorded, but the background runner could not start: ${r.error}. Run: accounts go-live again.`, 1);
  let quitNote = app.fullAllowed ? null : waitNote;
  if (opts.quitApp && !app.fullAllowed) {
    const q = quitSupport();
    quitNote = q.supported
      ? 'The background runner asks Claude to quit in a few seconds. This session ends when it does. If Claude asks about running sessions, answer it in the app.'
      : `Claude cannot be quit from here (${q.reason}).`;
  }
  emit({ ok: true, command: 'go-live', started: true, expected: plan.expected, runner: { pid: r.pid, method: r.method }, paused: plan.stale.length > 0, quit: quitNote },
    [...(jsonOut ? [] : [`Recorded: sharing. The background runner is started${r.method === 'spawn-fallback' ? '.' : ' and survives the app quit.'}`]), ...weak(r), ...(quitNote && quitNote !== waitNote ? [quitNote] : []), ...tail]);
  return 0;
}

/**
 * `accounts rc-restore --live [--all] [--dry-run] [--json]`: one live relink pass by hand (rcrestore.mjs liveRelinkPass). Without --all the window
 * is rcRestore.days; with it every non-archived session. --dry-run changes nothing (and runs even when the feature is off); a real run
 * honours rcRestore.enabled and rcRestore.liveRelink like the hooks do.
 */
async function liveRelinkCommand(ctx, args) {
  const dry = args.includes('--dry-run');
  const settings = dry ? rcSettings(loadConfig()) : rcRestoreNow();
  const r = await liveRelinkPass(ctx, { settings, dryRun: dry, all: args.includes('--all'), log });
  const facts = {
    ok: r.ran || r.reason === 'disabled', command: 'rc-restore', mode: 'live', dryRun: dry, all: args.includes('--all'), ran: r.ran, reason: r.reason ?? null, acct: r.acct,
    candidates: r.candidates, cleared: r.cleared.length, skippedLive: r.skippedLive, quiet: r.quiet, running: r.running, unknown: r.unknown, deferred: r.deferred, raced: r.raced, failed: r.failed, undated: r.undated,
    sessions: (dry ? r.wouldClear : r.cleared).map((c) => ({ id: c.id, title: c.title, why: c.why })),
  };
  const lines = [];
  if (!r.ran) lines.push(r.reason === 'disabled' ? 'The live relink is off (rcRestore.enabled or rcRestore.liveRelink). Nothing was changed. A --dry-run still shows what it would do.' : `Nothing done: ${r.reason}.`);
  else {
    for (const c of dry ? r.wouldClear : r.cleared) lines.push(`${dry ? 'would clear' : 'cleared'} ${c.id.replace(/^local_/, '').slice(0, 8)} "${c.title}" (${c.why === 'foreign' ? 'link minted under another account' : 'noHistoryBackfill link'})`);
    lines.push(`${dry ? 'Dry run: ' : ''}${dry ? r.wouldClear.length : r.cleared.length} ${dry ? 'would be cleared' : 'cleared'} of ${r.candidates} stale; skipped live ${r.skippedLive}, quiet ${r.quiet}, mid-turn ${r.running}, unknown ${r.unknown}${r.undated ? `, undated (left alone) ${r.undated}` : ''}${r.deferred ? `, ${dry ? 'beyond the limit of one pass' : 'over the limit'} ${r.deferred}` : ''}${dry ? '' : `, raced ${r.raced}`}.`);
  }
  emit(facts, lines);
  return 0;
}

/**
 * `accounts rc-sweep [--before <iso>] [--dry-run] [--json]` (0.5.10): the live relink by hand for every session of the signed-in account whose
 * last link was minted before the cutoff (default: the start of the current sign-in), whatever account minted it, plus the noHistoryBackfill and
 * foreign links. Skips a session whose CLI runs (or when the process list cannot be read), backs each transcript up first (as rc-restore does),
 * prints one line per candidate and a summary. Works whatever rcRestore.enabled is.
 */
async function rcSweepCommand(ctx, args) {
  const dry = args.includes('--dry-run');
  const bi = args.indexOf('--before');
  let before;
  if (bi >= 0) {
    before = Date.parse(args[bi + 1] ?? '');
    if (!Number.isFinite(before)) { console.error('Usage: accounts rc-sweep [--before <iso date-time>] [--dry-run] [--json]  (--before needs a date-time such as 2026-11-20T18:09:00Z)'); return 2; }
  }
  const r = await rcSweep(ctx, { before, dryRun: dry, log });
  const sessions = r.sessions ?? [];
  const facts = {
    ok: r.ran, command: 'rc-sweep', dryRun: dry, ran: r.ran, reason: r.reason ?? null, acct: r.acct,
    cutoff: Number.isFinite(r.cutoff) ? new Date(r.cutoff).toISOString() : null, records: r.records ?? 0, candidates: r.candidates,
    cleared: r.cleared.length, wouldClear: r.wouldClear.length, skippedLive: r.skippedLive, quiet: r.quiet, running: r.running, unknown: r.unknown, raced: r.raced, failed: r.failed,
    undated: r.undated, undatedStale: r.undatedStale ?? 0,
    sessions: sessions.map((s) => ({ id: s.id, title: s.title, why: s.why, outcome: s.outcome })),
  };
  const lines = [];
  if (!r.ran) lines.push(`Nothing done: ${r.reason}.`);
  else {
    const why = (w) => (w === 'foreign' ? 'link minted under another account' : w === 'stale' ? 'link minted before this sign-in' : 'noHistoryBackfill link');
    for (const s of sessions) lines.push(`${s.outcome} ${s.id.replace(/^local_/, '').slice(0, 8)} "${s.title}" (${why(s.why)})`);
    lines.push(`${dry ? 'Dry run: ' : ''}cutoff ${facts.cutoff ?? 'none known (only noHistoryBackfill and foreign links count)'}; ${dry ? r.wouldClear.length + ' would be cleared' : r.cleared.length + ' cleared'} of ${r.candidates} stale; skipped live ${r.skippedLive}, quiet ${r.quiet}, mid-turn ${r.running}, unknown ${r.unknown}${r.unknown ? ' (the process list could not be read: nothing was written for those)' : ''}, raced ${r.raced}, failed ${r.failed}${r.undatedStale ? `; ${r.undatedStale} undated link(s) judged by the transcript's modified time` : ''}.`);
    if (!dry && r.cleared.length) lines.push('Backups are under the accounts folder, rc-restore/backup/<stamp>/. Each cleared session mints a fresh link, named after its title, on its next connect.');
  }
  emit(facts, lines);
  return r.ran && r.failed === 0 ? 0 : 1;
}

/**
 * `accounts rc-spawn-fix [--dry-run] [--json]`: the sessions started from claude.ai or the phone under another account, by hand (rcspawn.mjs).
 * --dry-run only reads (and runs while Claude does); a real run needs Claude stopped, takes a backup of every record first, and runs
 * even when rcRestore.spawnFix is 'off' (that setting only turns the automatic runs off).
 */
async function spawnFixCommand(ctx, args) {
  const dry = args.includes('--dry-run');
  const base = { spawnFix: 'auto', log };
  if (dry) {
    const plan = spawnPlan(ctx, {});
    const sessions = plan.flagged.map((s) => ({ id: s.id, title: s.title, spawn: s.spawn, foreignIds: s.ids.length }));
    const lines = plan.flagged.map((s) => `would fix ${s.id.replace(/^local_/, '').slice(0, 8)} "${s.title}" (${[s.spawn ? 'spawn detached' : '', s.ids.length ? `${s.ids.length} foreign bridge id(s) removed` : ''].filter(Boolean).join(', ')})`);
    lines.push(plan.flagged.length ? `Dry run: ${plan.flagged.length} session(s) would be fixed; quit Claude and run: accounts rc-spawn-fix` : 'Nothing to fix: no session of the signed-in account carries a Remote Control spawn from another account.');
    const undated = plan.skipped.filter((s) => s.reason === 'undated').length;
    const format = plan.skipped.filter((s) => s.reason === 'format').length;
    if (undated) lines.push(`Left alone (cannot tell which account they were started under): ${undated}.`);
    if (format) lines.push(`Left alone (the record's formatting would change if it were rewritten): ${format}.`);
    emit({ ok: true, command: 'rc-spawn-fix', dryRun: true, acct: plan.acct, scanned: plan.scanned, found: plan.flagged.length, skipped: plan.skipped.length, sessions }, lines);
    return 0;
  }
  const app = appState({ ctx, probeProcesses: true });
  if (!app.fullAllowed) {
    emit({ ok: false, command: 'rc-spawn-fix', reason: app.running ? 'app-running' : 'app-unknown' }, [app.running
      ? 'Claude is running: its own saves would overwrite the edit. Quit it from the tray icon, then run: accounts rc-spawn-fix (a --dry-run works while it runs).'
      : 'The state of Claude could not be read, so nothing was changed. Try again.']);
    return 3;
  }
  const r = await spawnFixStep(ctx, { ...base, apply: true });
  if (r.reason === 'locked') { emit({ ok: false, command: 'rc-spawn-fix', reason: 'locked' }, ['Another account pass holds the accounts lock; try again in a minute.']); return 3; }
  const lines = r.fixed.map((f) => `fixed ${f.id.replace(/^local_/, '').slice(0, 8)} "${f.title}"`);
  for (const f of r.failed) lines.push(`FAILED ${f.id.replace(/^local_/, '').slice(0, 8)} "${f.title}": ${f.detail}`);
  lines.push(r.status === 'failed' ? 'The check failed; nothing was changed (see sync.log).' : r.found ? `${spawnLine(r)}${r.backupDir ? `. Backup: ${r.backupDir}` : ''}` : 'Nothing to fix: no session of the signed-in account carries a Remote Control spawn from another account.');
  emit({ ok: r.status === 'ok', command: 'rc-spawn-fix', dryRun: false, acct: r.acct, scanned: r.scanned, found: r.found, fixed: r.fixed, failed: r.failed, pending: r.pending, skipped: r.skipped.length, status: r.status, backupDir: r.backupDir }, lines);
  return r.status === 'ok' ? 0 : 3;
}

/** `accounts <sub> ...` (plan 6). Returns the exit code. */
async function accountsCommand(sub, args) {
  const ctx = makeCtx();
  const hook = args.includes('--from-hook');
  const has = (f) => args.includes(f);
  if (!ctx.store && sub !== 'wait' && sub !== 'launch-detached' && sub !== 'rc-restore') {
    emit({ ok: false, reason: 'no-store' }, ['The Claude desktop session store was not found on this machine.']);
    return 3;
  }
  const printPass = (res, kind) => {
    const sum = summarizePass(res, kind);
    if (!hook) emit({ command: sub, ...sum }, formatPass(sum));
    return sum;
  };
  const refused = (code, text, facts = {}) => { if (!hook) emit({ ok: false, command: sub, reason: code, ...facts }, [text]); return 3; };

  if (sub === 'status') {
    let remote = null;
    if (has('--remote')) remote = await accountsRemoteCheck(ctx);
    const st = collectStatus(ctx, { probe: true });
    const lines = formatStatus(st, { all: has('--all') });
    if (remote) lines.push(remote.checked ? `Remote check: ${remote.ids} record(s), ${remote.duplicates} duplicate(s)${remote.neverPushed ? ' (nothing has been pushed yet)' : ''}.` : `Remote check not run: ${remote.reason}.`);
    emit({ command: 'status', ...st, ...(remote ? { remoteCheck: remote } : {}) }, lines);
    return 0;
  }

  if (sub === 'answer') {
    const answer = args.find((a) => a === 'yes' || a === 'no');
    if (!answer) { console.error('Usage: accounts answer yes|no'); return 2; }
    const state = loadState(ctx);
    // An explicit `yes` also re-answers pairs set to "no" (after an unlink or a rollback). The SessionStart step
    // keeps asking only about undecided pairs, so a "no" is never re-asked automatically.
    const pend = pendingPairs(state, accountsOf(listFolders(ctx.store)), { includeNo: answer === 'yes' });
    // A waiter left by an older copy of the plugin is replaced even when there is nothing left to answer (a re-run of `answer yes`):
    // this copy then arms its own waiter for the link, or for what is owed.
    const rep = answer === 'yes' ? replaceStaleWaiter(ctx) : null;
    if (!pend.length) {
      if (!(rep?.replaced && !state.linked && groupOf(state, listFolders(ctx.store)).length >= 2)) {
        if (rep?.replaced && state.fullPassOwed) armWaiter(ctx, 'owed');
        emit({ ok: true, command: 'answer', answered: 0, ...(rep?.replaced ? { waiterReplaced: true } : {}) }, ['No pending account pairs.', ...(rep?.replaced ? ['A waiter left by an older version of session-sync was replaced.'] : [])]);
        return 0;
      }
    } else {
      answerPairs(state, pend, answer, 'cli', ctx.now());
      saveState(ctx, state);
    }
    if (answer === 'no') { emit({ ok: true, command: 'answer', answered: pend.length, answer }, [`Recorded: not sharing (${pend.length} pair(s)). Change your mind with: accounts answer yes, or config accountLink.`]); return 0; }
    const app = appState({ ctx, probeProcesses: true });
    if (app.fullAllowed) {
      const res = await link(ctx, { log });
      const sum = summarizePass(res, 'link');
      emit({ command: 'answer', answered: pend.length, answer, ...sum }, formatPass(sum));
      return res.ok ? 0 : 3;
    }
    const w = armWaiter(ctx, 'link');
    if (state.linked) claimRestartNotice(ctx, state, groupOf(state, listFolders(ctx.store)));   // told here, so the next session start does not say it again
    emit({ ok: true, command: 'answer', answered: pend.length, answer, waiter: w.action },
      [RESTART_LEAD_WAITER, `Recorded: sharing (${pend.length} pair(s)). Claude is running. The first link takes a backup, then links, and a notice says when it is done.`]);
    return 0;
  }

  if (sub === 'link') {
    const state = loadState(ctx);
    if (groupOf(state, listFolders(ctx.store)).length < 2) return refused('no-group', REASON('no-group'));
    const app = appState({ ctx, probeProcesses: true });
    if (!app.fullAllowed) {
      if (has('--now')) return refused('app-running', 'Quit Claude from the tray icon first (closing the window only hides it).');
      const w = armWaiter(ctx, 'link');
      // already linked: the waiter finishes what is owed after the next normal quit, and nothing asks for one
      if (!hook) emit({ ok: true, command: 'link', waiter: w.action }, state.linked ? ['The accounts are already linked. Anything still owed runs by itself after your next normal quit of Claude.'] : [RESTART_LEAD_WAITER, 'Claude is running; closing the window only hides it.']);
      return 0;
    }
    const res = await link(ctx, { app, log });
    printPass(res, 'link');
    return res.ok ? 0 : 3;
  }

  if (sub === 'rectify') {
    if (hook) {
      // a stamp written by the SessionStart step already debounces; a second guard for direct runs
      if (stampRecent(accPath(ctx, 'hook-rectify-run.stamp'), HOOK_DEBOUNCE_MS)) return 0;
      writeStamp(accPath(ctx, 'hook-rectify-run.stamp'));
    }
    const res = await accountsPass(ctx, 'rectify');
    if (res.skipped === 'not-linked') return refused('not-linked', REASON('not-linked'));
    const sum = summarizePass(res, res.kind === 'live' ? 'live' : 'full');
    if (hook) return 0;
    // a manual run includes the remote check
    const remote = await accountsRemoteCheck(ctx);
    emit({ command: 'rectify', ...sum, remoteCheck: remote },
      [...formatPass(sum), remote.checked ? `Remote: ${remote.ids} record(s), ${remote.duplicates} duplicate(s)${remote.neverPushed ? ' (nothing has been pushed yet)' : ''}.` : `Remote check not run: ${remote.reason}.`]);
    return sum.ok || sum.skipped ? 0 : 3;
  }

  if (sub === 'unlink') {
    const state = loadState(ctx);
    if (!state.linked) return refused('not-linked', REASON('not-linked'));
    const app = appState({ ctx, probeProcesses: true });
    if (!app.fullAllowed) {
      if (!has('--when-app-exits')) return refused('app-running', 'Quit Claude from the tray icon first, or run: accounts unlink --when-app-exits');
      const w = armWaiter(ctx, 'unlink');
      emit({ ok: true, command: 'unlink', waiter: w.action }, ['Claude is running. The unlink runs as soon as you quit it from the tray icon or app menu; closing the window only hides it.']);
      return 0;
    }
    const res = await unlink(ctx, { app });
    printPass(res, 'unlink');
    return res.ok ? 0 : 3;
  }

  if (sub === 'rollback') {
    const state = loadState(ctx);
    // state.backupId is always the pre-link backup (a 'gained' safety copy never replaces it, see pass.mjs)
    const script = state.backupId ? accPath(ctx, 'backup', state.backupId, 'rollback.mjs') : null;
    if (!script || !existsSync(script)) {
      // a marker with no backup: the rollback had already written its state and only the marker was left behind
      if (rollbackActive(ctx)) { try { unlinkSync(rollbackMarkerFile(ctx)); } catch { /* none */ } }
    }
    if (!script || !existsSync(script)) return refused('no-backup', 'There is no backup to roll back to (none was taken, or it was already rolled back).');
    const pass = args.filter((a) => a === '--exact' || a === '--dry-run' || a === '--json');
    const r = spawnSync(process.execPath, [script, ...pass], { windowsHide: true, stdio: 'inherit' });
    return r.status ?? 1;
  }

  if (sub === 'go-live') return goLiveCommand(ctx, args);

  // the file-side steps of the random-Remote-Control-name repair for one session (the skill drives the app-side steps)
  if (sub === 'rc-repair') {
    const idArg = args.find((a) => !a.startsWith('--'));
    if (!idArg) { console.error('Usage: accounts rc-repair <localSessionId|cliSessionId> [--stop-cli | --at-turn-end] [--dry-run] [--force] [--verify] [--json]'); return 2; }
    const r = await rcRepair(ctx, { id: idArg, stopCli: has('--stop-cli'), dryRun: has('--dry-run'), force: has('--force'), verify: has('--verify'), atTurnEnd: has('--at-turn-end') && !has('--dry-run') && !has('--verify'), platform: platform(), log });
    const { text, ...facts } = r;
    emit({ command: 'rc-repair', ...facts, text }, [text]);
    return r.ok ? 0 : (r.status === 'verify-failed' ? 1 : 3);
  }

  // 0.5.10: the live relink by hand for every stale link of the signed-in account (accounts rc-sweep [--before <iso>] [--dry-run] [--json])
  if (sub === 'rc-sweep') return rcSweepCommand(ctx, args);

  // 0.5.10: the helper the Stop hook starts (rc-turn-end): waits about 2 s, stops that session's CLI, clears its stale link, deletes the request.
  if (sub === 'rc-turn-end-run') {
    const r = await runTurnEnd(ctx, { cliSessionId: args[0], platform: platform(), log });
    return r.ran ? 0 : 1;
  }

  // sessions started from claude.ai under another account: detach their spawn record (the app must be stopped), or --dry-run to look
  if (sub === 'rc-spawn-fix') return spawnFixCommand(ctx, args);

  // Remote Control relink at Windows logon: the command the "session-sync RC restore" task runs, and its install and removal.
  if (sub === 'rc-restore') {
    const what = args.find((a) => !a.startsWith('--'));
    if (what === 'install-logon-task' || what === 'uninstall-logon-task') {
      const install = what === 'install-logon-task';
      // an explicit install or removal is the user's choice: it is kept in rcRestore.logonTask, or the next session start would undo a removal
      try { saveConfig({ rcRestore: { logonTask: install } }); } catch { /* the task itself matters more */ }
      const r = install ? installLogonTask() : uninstallLogonTask();
      log(`rc-restore: ${what}: ${r.action}${r.ok ? '' : ` FAILED ${r.error}`}`);
      emit({ command: 'rc-restore', ...r }, [r.ok ? (r.action === 'skipped' ? 'Nothing to do: the logon task is Windows only.' : `Logon task "session-sync RC restore": ${r.action}${install ? '' : ' (rcRestore.logonTask is now false, so a session start does not put it back)'}.`) : `Logon task failed: ${r.error}`]);
      return r.ok ? 0 : 1;
    }
    // a manual sweep of the live relink: every non-archived session of the signed-in account whose CLI is not running and whose link is stale
    if (!what && has('--live')) return liveRelinkCommand(ctx, args);
    if (what || !has('--if-app-stopped')) {
      console.error('Usage: accounts rc-restore --if-app-stopped | install-logon-task | uninstall-logon-task | --live [--all] [--dry-run] [--json]');
      return 2;
    }
    const r = await rcLogonStep(ctx, { settings: rcRestoreNow(), platform: platform(), log });
    if (r.ran && r.res) emit({ ok: true, command: 'rc-restore', ran: true, relinked: r.res.relinked, status: r.res.status, ...(r.spawn?.fixed?.length ? { spawnFixed: r.spawn.fixed.length } : {}) }, [`Remote Control relink: ${r.res.relinked} relinked (${r.res.status}).`]);
    else if (r.ran && r.spawn) emit({ ok: true, command: 'rc-restore', ran: true, spawnFixed: r.spawn.fixed.length }, [`Remote Control: ${r.spawn.fixed.length} session(s) started from claude.ai under another account fixed.`]);
    return 0;   // nothing owed, the app running, or an unknown state all end quietly: the task retries at the next logon
  }

  // hidden: the helper the SessionStart hook starts (detached, hidden). Only the two long-lived entries may be launched.
  if (sub === 'launch-detached') {
    const ok = args[0] === 'accounts' && (args[1] === 'wait' || args[1] === 'golive-run' || (args[1] === 'rc-turn-end-run' && /^[0-9a-f-]{36}$/i.test(args[2] ?? '')));
    const r = ok ? launchDetached(args, { ctx }) : { ok: false, method: 'none', error: 'not a launchable command' };
    log(`accounts launch-detached ${args.slice(1, 2).join('')}: ${r.method}${r.ok ? ` pid ${r.pid ?? '?'}` : ` failed (${r.error})`}`);
    return r.ok ? 0 : 1;
  }

  if (sub === 'golive-run') {
    const out = await runGoLive(ctx, goLiveDeps());
    log(`accounts go-live runner: ${out.exit}${out.status ? ` (${out.status})` : ''}`);
    return 0;
  }

  if (sub === 'wait') {
    const i = args.indexOf('--reason');
    // ui (S4): every pass that runs with Claude closed shows a tray icon and balloons (a notification on macOS and Linux); config progressIcon turns it off
    const ui = createProgressUi({ enabled: loadConfig().progressIcon !== false });
    const out = await runWaiter(ctx, { reason: i >= 0 ? args[i + 1] : 'deferred', watch: true, notify: accountsToast, log, ui, logFile: LOG, rcRestore: rcRestoreNow });
    log(`accounts waiter: ${out.exit}${out.report ? ` (${out.report.op} ${out.report.ok ? 'ok' : out.report.error ?? out.report.reason ?? 'not ok'})` : ''}`);
    return 0;
  }

  console.error('Usage: accounts status [--all] [--remote] [--json] | answer yes|no | go-live [--yes] [--no-relaunch] [--quit-app] [--json] | link [--now] | rectify | unlink [--when-app-exits] | rollback [--exact] [--dry-run] | rc-restore --if-app-stopped|install-logon-task|uninstall-logon-task | rc-sweep [--before <iso>] [--dry-run] [--json] | rc-repair <id> [--stop-cli | --at-turn-end] | rc-spawn-fix [--dry-run] [--json]');
  return 2;
}

function REASON(code) {
  return { 'no-group': 'No account pair has been answered yes. Run: accounts answer yes', 'not-linked': 'The accounts are not linked.' }[code] ?? code;
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
  if (key === 'enabled' || key === 'notifications' || key === 'progressIcon') {
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
  if (key === 'accountLink') {
    if (!ACCOUNT_LINK_MODES.includes(value)) {
      console.error(`"${value}" is not a valid accountLink. Use: ${ACCOUNT_LINK_MODES.join(', ')}.`);
      process.exit(2);
    }
    saveConfig({ accountLink: value });
    log(`config: accountLink -> ${value}`);
    console.log(JSON.stringify({ ok: true, accountLink: value, configFile: CONFIG_FILE }, null, 2));
    process.exit(0);
  }
  if (key === 'rcRestore.enabled' || key === 'rcRestore.wake' || key === 'rcRestore.logonTask') {
    const sub = key.split('.')[1];
    const on = /^(true|1|yes|on)$/i.test(value);
    saveConfig({ rcRestore: { [sub]: on } });
    log(`config: ${key} -> ${on}`);
    const facts = { ok: true, [key]: on, configFile: CONFIG_FILE };
    if (sub !== 'wake') {   // the logon task follows rcRestore.enabled and rcRestore.logonTask at once (Windows only; a no-op elsewhere)
      try {
        const t = ensureLogonTask({ settings: rcRestoreNow(), force: true });
        if (t.action !== 'skipped' && t.action !== 'none') { facts.logonTask = t.ok ? t.action : `failed: ${t.error}`; log(`config: logon task ${facts.logonTask}`); }
      } catch (e) { facts.logonTask = `failed: ${e?.message ?? e}`; }
    }
    console.log(JSON.stringify(facts, null, 2));
    process.exit(0);
  }
  if (key === 'artifactShare.enabled') {
    const on = /^(true|1|yes|on)$/i.test(value);
    saveConfig({ artifactShare: { enabled: on } });
    log(`config: ${key} -> ${on}`);
    console.log(JSON.stringify({ ok: true, [key]: on, configFile: CONFIG_FILE }, null, 2));
    process.exit(0);
  }
  if (key === 'artifactShare.email') {   // config artifactShare.email <account id or its first 8+ characters> <email>
    const [acct, mail] = value.split(/\s+/);
    if (!/^[0-9a-f-]{8,36}$/i.test(acct ?? '') || !/^[^\s@]+@[^\s@]+$/.test(mail ?? '')) {
      console.error('usage: config artifactShare.email <account id, or its first 8 or more characters> <email>');
      process.exit(2);
    }
    saveConfig({ artifactShare: { emails: { [acct.toLowerCase()]: mail } } });
    log(`config: artifactShare.email ${acct.slice(0, 8)} set`);
    console.log(JSON.stringify({ ok: true, 'artifactShare.email': { [acct.toLowerCase()]: mail }, configFile: CONFIG_FILE }, null, 2));
    process.exit(0);
  }
  if (key === 'rcRestore.liveRelink') {
    if (!LIVE_RELINK_MODES.includes(value)) {
      console.error(`"${value}" is not a valid rcRestore.liveRelink: use ${LIVE_RELINK_MODES.join(' or ')}.`);
      process.exit(2);
    }
    saveConfig({ rcRestore: { liveRelink: value } });
    log(`config: rcRestore.liveRelink -> ${value}`);
    console.log(JSON.stringify({ ok: true, 'rcRestore.liveRelink': value, configFile: CONFIG_FILE }, null, 2));
    process.exit(0);
  }
  if (key === 'rcRestore.spawnFix') {
    if (!SPAWN_FIX_MODES.includes(value)) {
      console.error(`"${value}" is not a valid rcRestore.spawnFix: use ${SPAWN_FIX_MODES.join(' or ')}.`);
      process.exit(2);
    }
    saveConfig({ rcRestore: { spawnFix: value } });
    log(`config: rcRestore.spawnFix -> ${value}`);
    console.log(JSON.stringify({ ok: true, 'rcRestore.spawnFix': value, configFile: CONFIG_FILE }, null, 2));
    process.exit(0);
  }
  if (key === 'rcRestore.wakeMax') {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 50) {
      console.error(`"${value}" is not a valid rcRestore.wakeMax: use a whole number of sessions from 1 to 50.`);
      process.exit(2);
    }
    saveConfig({ rcRestore: { wakeMax: n } });
    log(`config: rcRestore.wakeMax -> ${n}`);
    console.log(JSON.stringify({ ok: true, 'rcRestore.wakeMax': n, configFile: CONFIG_FILE }, null, 2));
    process.exit(0);
  }
  if (key === 'rcRestore.days') {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 90) {
      console.error(`"${value}" is not a valid rcRestore.days: use a whole number of days from 1 to 90.`);
      process.exit(2);
    }
    saveConfig({ rcRestore: { days: n } });
    log(`config: rcRestore.days -> ${n}`);
    console.log(JSON.stringify({ ok: true, 'rcRestore.days': n, configFile: CONFIG_FILE }, null, 2));
    process.exit(0);
  }
  console.error('unknown setting "' + key + '". Valid: remote, enabled, notifications, notifyMode, debounceMinutes, accountLink, progressIcon, rcRestore.enabled, rcRestore.days, rcRestore.wake, rcRestore.wakeMax, rcRestore.liveRelink, rcRestore.spawnFix, rcRestore.logonTask, artifactShare.enabled, artifactShare.email');
  process.exit(2);
}

// `artifacts ...`: the queue of new artifacts to invite to the other linked account (artifacts.mjs). Used by the share-artifacts skill.
// Needs neither rclone nor `enabled`; prints plain lines, or one JSON object with --json.
if (cmd === 'artifacts') {
  const withInvited = process.argv.includes('--with-invited');
  const args = process.argv.slice(3).filter((a) => a !== '--json' && a !== '--with-invited');
  const sub = args[0] || 'list';
  const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
  const out = (obj, text) => { console.log(jsonOut ? JSON.stringify(obj, null, 2) : text); };
  const idOf = (s) => { const m = /artifact\/([A-Za-z0-9_-]{6,64})/.exec(String(s ?? '')); return m ? m[1] : String(s ?? ''); };
  const line = (e) => `${e.id}  ${e.status}${e.reason ? `(${e.reason})` : ''}  owner ${e.ownerAccount ? e.ownerAccount.slice(0, 8) : 'unknown'}  ${e.title ?? '(untitled)'}  ${e.url}${e.inviteLink ? `  invite ${e.inviteLink}` : ''}`;
  try {
    const A = await import('./artifacts.mjs');
    const cfg = loadConfig();
    const emails = cfg.artifactShare.emails;
    if (sub === 'pending' || sub === 'list') {
      const entries = A.readEntries(A.QUEUE_DIR);
      const share = A.readShareState(A.QUEUE_DIR);
      const shown = (sub === 'pending' ? (withInvited ? entries.filter((e) => e.status === 'pending' || e.status === 'invited') : A.pendingOf(entries)) : entries).map((e) => ({
        ...e, ownerEmail: A.emailOf(emails, e.ownerAccount), receiverEmail: A.receiverEmail(emails, e.ownerAccount),
        driveable: A.driveableOwner(e.ownerAccount, emails, share),
      }));
      const active = sub === 'pending' ? await A.activeAccount() : null;
      // From a session running as the app's account: `reachable` is the account half only (null when the account cannot be read: unknown, probe it); `backoff` lists browsers a run reported unavailable less than 30 minutes ago, which gates the automatic trigger, not a run the user asked for.
      const reachable = active ? Object.fromEntries(Object.entries(share.browsers).map(([k, b]) => [k, A.browserReachableFrom(b, active)])) : null;
      const backoff = Object.fromEntries(Object.entries(share.browsers).filter(([, b]) => Date.now() - Date.parse(b.unavailableAt ?? '') < A.BACKOFF_MS).map(([k, b]) => [k, b.unavailableAt]));
      const head = { enabled: cfg.artifactShare.enabled, linked: A.featureOn({ artifactShare: { enabled: true } }), browsers: share.browsers, reachable, backoff, emails, activeAccount: active, activeEmail: A.emailOf(emails, active) };
      out({ ok: true, ...head, entries: shown }, shown.length ? shown.map(line).join('\n') : (sub === 'pending' ? 'nothing pending' : 'the queue is empty'));
      process.exit(0);
    }
    if (sub === 'mark') {
      const [, rawId, status] = positional;
      if (!rawId || !A.STATUSES.includes(status)) { console.error(`usage: artifacts mark <id> ${A.STATUSES.join('|')} [--link <invitation link>] [--reason <text>]`); process.exit(2); }
      const r = A.markEntry(A.QUEUE_DIR, idOf(rawId), status, { link: flag('link'), reason: flag('reason') });
      if (!r.ok) { console.error(r.reason); process.exit(1); }
      log(`artifacts: ${r.entry.id} -> ${status}`);
      out({ ok: true, entry: r.entry }, line(r.entry));
      process.exit(0);
    }
    if (sub === 'forget') {
      if (!positional[1]) { console.error('usage: artifacts forget <id>'); process.exit(2); }
      const ok = A.forgetEntry(A.QUEUE_DIR, idOf(positional[1]));
      out({ ok }, ok ? 'forgotten' : 'not in the queue');
      process.exit(ok ? 0 : 1);
    }
    if (sub === 'pane') {   // record the account a driveable browser is signed in to: artifacts pane <email> [--browser <name>] [--account <id>]
      if (!positional[1]) { console.error('usage: artifacts pane <email> [--browser <name>] [--account <account id>]'); process.exit(2); }
      const name = flag('browser') ?? 'pane';
      // Claude in Chrome (any browser but the pane) is reachable only from sessions of the account its extension is connected to; unless
      // told, that is taken to be the configured account whose email this browser is signed in as. The pane is reachable from any account.
      const account = flag('account') ?? (name === 'pane' || A.readShareState(A.QUEUE_DIR).browsers[name]?.account ? undefined : A.accountOfEmail(emails, positional[1]) ?? undefined);
      const s = A.recordBrowser(A.QUEUE_DIR, name, positional[1], { account });
      out({ ok: true, browsers: s.browsers }, `recorded ${name}: ${positional[1]}${s.browsers[name].account ? ` (reachable from sessions of account ${s.browsers[name].account.slice(0, 8)})` : ''}`);
      process.exit(0);
    }
    if (sub === 'chrome-unavailable') {   // a run found Chrome not connected: the wake leaves its work alone for 30 minutes (--browser <name> for another browser)
      const name = flag('browser') ?? 'chrome';
      // A session of the other account cannot see that Chrome at all, so an empty list there says nothing: refuse to record it.
      const reg = A.readShareState(A.QUEUE_DIR).browsers[name];
      const active = reg?.account ? await A.activeAccount() : null;
      if (reg?.account && active && !A.browserReachableFrom(reg, active)) {
        console.error(`not recorded: ${name} is reachable only from sessions of account ${reg.account.slice(0, 8)}, this session runs as ${active.slice(0, 8)}`);
        process.exit(1);
      }
      const r = A.markBrowserUnavailable(A.QUEUE_DIR, name);
      if (!r.ok) { console.error(r.reason); process.exit(1); }
      out({ ok: true, browsers: r.browsers }, `recorded: ${name} unavailable, no new trigger for its work for 30 minutes`);
      process.exit(0);
    }
    console.error('usage: artifacts pending|list [--json] [--with-invited] | mark <id> <status> [--link L] [--reason R] | forget <id> | pane <email> [--browser name] [--account id] | chrome-unavailable [--browser name]');
    process.exit(2);
  } catch (e) {
    log(`artifacts ${sub} failed: ${e?.message || e}`);
    console.error(`artifacts ${sub} failed: ${e?.message || e}`);
    process.exit(1);
  }
}

// The UserPromptSubmit hook (0.5.4): the first real prompt of an interactive session after a restart of the Claude app gets a one-time
// instruction to wake the other sessions (Remote Control). Independent of rclone and `enabled`; never throws, never blocks the prompt.
if (cmd === 'rc-wake') {
  try {
    let input = {};
    try { if (!process.stdin.isTTY) input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* no input */ }
    const settings = rcRestoreNow();
    const prompt = String(input.prompt ?? '').trim();
    let woke = false;
    if (settings.enabled && settings.wake && input.session_id && prompt && !prompt.startsWith('/')) {
      // the prompt that claims the restart also clears the stale links of the sessions that have no CLI yet (liveRelink), before the instruction goes out
      const d = await wakeWithRelink(makeCtx(), { settings, sessionId: String(input.session_id), log, cimTimeoutMs: 6000 });
      if (d.act) {
        woke = true;
        log(`rc-wake: instruction given to session ${String(input.session_id).slice(0, 8)}${d.relinkOwed ? `; relink owed for ${d.relinkOwed} session(s), the user is asked to quit Claude once from the tray icon` : ''}`);
        writeStdout(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: d.text } })}\n`);
      }
    }
    // 0.5.9: a session started from claude.ai or the phone under the other account is only reported here (the app runs; the repair waits
    // for a quit or a switch). Throttled to one pass per 10 minutes, independent of `rcRestore.enabled`, never writes a record. Not on the prompt
    // that gave the wake instruction (that one already spends most of the hook's time on the process listings).
    if (!woke && input.session_id && prompt && !prompt.startsWith('/')) spawnLook(makeCtx(), { log, settings });
  } catch (e) { log(`rc-wake failed: ${e?.message || e}`); }
  process.exit(0);
}

// The Stop hook (0.5.10): when the session that just finished its turn has a queued `accounts rc-repair <id> --at-turn-end`, start the
// helper that stops its CLI and clears the stale link (rcrepair.mjs). With no request (every turn) it is one stat and an exit. Independent of
// rclone and `enabled`; never throws, never blocks or fails a turn, prints nothing.
if (cmd === 'rc-turn-end') {
  try {
    let input = {};
    try { if (!process.stdin.isTTY) input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* no input */ }
    const ctx = makeCtx();
    if (ctx.store) turnEndHook(ctx, input, { log });
  } catch (e) { try { log(`rc-turn-end failed: ${e?.message || e}`); } catch { /* ignore */ } }
  process.exit(0);
}

// `accounts ...` never needs rclone or `enabled`, so it is dispatched before those checks.
if (cmd === 'accounts') {
  const sub = process.argv[3] || 'status';
  let code = 0;
  try {
    code = await accountsCommand(sub, process.argv.slice(4));
  } catch (e) {
    log(`accounts ${sub} failed: ${e?.stack || e}`);
    if (!fromHook) console.error(`accounts ${sub} failed: ${e?.message || e}`);
    code = fromHook ? 0 : 1;
  }
  process.exit(fromHook ? 0 : code);
}

// The SessionStart hook runs the account step first, before the `enabled` and rclone
// checks below (a machine can link accounts with no remote). It never throws.
if (cmd === 'auto-pull' && fromHook) {
  try { await accountsHookStep(); } catch (e) { log(`accounts hook step failed: ${e?.message || e}`); }
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
    await accountsSync('push');
    const r = await push(REMOTE, { quiet, onLog: log, notifyMode: CFG.notifyMode });
    if (r.ok) { ensureState(); writeFileSync(LAST_PUSH, new Date().toISOString()); await accountsDailyRemoteCheck(); }
    log(`push ${r.ok ? 'ok' : 'FAILED'} (${r.mins} min)`);
    process.exit(r.ok || !strict ? 0 : 1);
  }

  if (cmd === 'pull') {
    const lock = acquireLock(LOCK_FILE);
    if (!lock.acquired) { log(`pull skipped — ${lock.reason}`); process.exit(0); }
    process.on('exit', () => lock.release());
    log(`pull <- ${REMOTE}`);
    const r = await pull(REMOTE, { quiet, onLog: log, notifyMode: CFG.notifyMode });
    if (r.ok) { ensureState(); writeFileSync(LAST_PULL, new Date().toISOString()); await accountsSync('pull'); }
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
    if (r.ok) { ensureState(); writeFileSync(LAST_PULL, new Date().toISOString()); await accountsSync('pull'); }
    process.exit(0);
  }

  console.error(`unknown command: ${cmd}`);
  process.exit(2);
} catch (err) {
  log(`fatal: ${err?.message || err}`);
  // Never block a Claude session because a backup had a bad day.
  process.exit(strict ? 1 : 0);
}
