/**
 * waiter.mjs - the singleton background waiter and account-switch watcher (plan 5.12, account-switch design).
 *
 * A link, an unlink or a deferred full pass needs the desktop app stopped. The
 * waiter is a hidden, detached node process (spawned by cli.mjs through
 * spawnDetachedSelf, never from here) that watches for the app to exit, runs the
 * pass, writes `last-pass.json` and tells the user (a tray icon and balloons, S4). With `watch` (what `accounts wait`
 * passes) it then stays: while the app runs and the accounts are linked it follows
 * the app's account switches and saves and keeps every folder the app has not
 * loaded current (a targeted pass, see pass.mjs livePass); at the next app exit it
 * runs the owed full pass. Without `watch` it exits after the pass, as before.
 *
 *   ensureWaiter(ctx, reason, spawnWaiter)  join the live waiter or spawn one
 *   runWaiter(ctx, opts)                    the loop the detached process runs
 *   waiterStatus(ctx)                       {alive, pid, armedAt, heartbeatAt, reasons}
 *
 * Single instance: a claim file created with flag `wx` (stale when its pid is gone).
 * Liveness: the pid is alive and `heartbeatAt` is younger than 5 minutes.
 * Trigger: an fs.watch on USERDATA for the lock marker plus a poll timer
 * (SESSION_SYNC_TEST_POLL_MS shrinks every interval in tests). The pass runs only
 * after 2 consecutive "app stopped" readings at least `gapMs` (0.5 s) apart, so a
 * restart gap or a flapping lockfile never triggers it.
 */

import { openSync, writeSync, closeSync, unlinkSync, mkdirSync, watch } from 'node:fs';
import { dirname } from 'node:path';
import { pidAlive } from '../lock.mjs';
import { accPath, readJson, writeJsonAtomic, loadState, saveState, withAccountsLock } from './state.mjs';
import { createStopWatch, coolingEndsAt, readSignedIn, appState } from './appstate.mjs';
import { listFolders } from './folders.mjs';
import { setOldWaiterGate } from './rectify.mjs';
import { fullPass, livePass, link, unlink, owedWork } from './pass.mjs';
import { PLUGIN_VERSION, codeHash, compareVersions } from './version.mjs';
import { verifyProcess, WAITER_MARKER } from './procid.mjs';
import { nullUi, progressInfo } from './progress.mjs';
import { spawnFixCore, spawnFixStep, spawnLine } from './rcspawn.mjs';
import { recentSwitch } from './rclinks.mjs';
import { rcQuitStep, rcDoneText, RC_START_TEXT, readLaunchOutcome, defaultAppLog, MARKER_REFRESH_MS, liveRelinkPass } from './rcrestore.mjs';
import { queueBouncedRepairs } from './rcrepair.mjs';
import { RC_DEFAULTS } from '../config.mjs';

const asksOp = (rs) => rs.some((r) => r === 'link' || r === 'unlink');
/** How long the watcher looks for the app's own launch-restore lines after a start (they come within a minute or two). */
const LAUNCH_LOOK_MS = 10 * 60 * 1000;
/** The switch sweep's waits when the process list cannot be read: 3, 10, 30, 60 and 60 s, about 3 minutes in all (0.5.10). */
const SWEEP_BACKOFF_MS = [3000, 10000, 30000, 60000, 60000];
/** No per-pass cap for the switch sweep (rcRestore.liveMax stays the cap of the periodic pass). */
const SWEEP_MAX = 1000;
/** A watcher that starts this soon after a switch sweeps at once. */
const SWEEP_RECENT_MS = 15 * 60 * 1000;
/** 0.5.12: after a switch the sweep runs again every SWEEP_RETRY_MS until nothing is left to clear, for at most SWEEP_WINDOW_MS in all (RC reconnects about 3.5 minutes after a switch). */
export const SWEEP_RETRY_MS = 15 * 1000;
export const SWEEP_WINDOW_MS = 3 * 60 * 1000;
/** A candidate with one of these verdicts may be clearable on a later pass (a quiet window passes, a list reads, a CLI exits); cleared, changed and gone ones are done. */
const SWEEP_RETRY_VERDICTS = new Set(['quiet', 'unknown', 'mid-turn', 'failed', 'deferred', 'live']);

/** Is anything left for another sweep pass? The result of liveRelinkPass: a session still waiting, or a pass that found the accounts lock held. */
export const sweepLeft = (res) => !!res && (res.reason === 'locked' || (res.sessions ?? []).some((x) => SWEEP_RETRY_VERDICTS.has(x.outcome)));

/**
 * The switch sweep with retries (0.5.12): run `pass()` (one liveRelinkPass result), and again every retryMs while sweepLeft, until the window
 * (windowMs from the start, back-off waits included) is used up or `stop()` says so (a newer switch starts a sweep of its own). The first pass always runs.
 * o: { retryMs, windowMs, sleep(ms), now(), stop() }
 * @returns {Promise<{passes:number, left:boolean}>}
 */
export async function sweepWithRetry(pass, o = {}) {
  const retryMs = o.retryMs ?? SWEEP_RETRY_MS;
  const windowMs = o.windowMs ?? SWEEP_WINDOW_MS;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const t0 = now();
  let passes = 0; let left = false;
  for (;;) {
    const res = await pass();
    passes++;
    left = sweepLeft(res);
    if (!left || o.stop?.() === true || now() - t0 + retryMs > windowMs) break;
    await sleep(retryMs);
    if (o.stop?.() === true) break;
  }
  return { passes, left };
}
const RC_MAX_TRIES = 3;

export const HEARTBEAT_STALE_MS = 5 * 60 * 1000;
export const MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const POLL_MS = 30 * 1000;
// The pass starts when the app has stopped on two readings this far apart. Half a second is enough: the S1 guard aborts a pass
// the moment the app's lock marker comes back, and the waiter tries again at the next quit.
const GAP_MS = 500;
/** While the app's lock marker is gone the waiter looks this often (the stop is being confirmed); otherwise it sleeps POLL_MS. */
const FAST_POLL_MS = 500;
const FAST_NULL_LIMIT = 20;   // a probe that stays unknown does not keep PowerShell running twice a second for days
const PROBE_EVERY_MS = 10 * 60 * 1000;

const waiterFile = (ctx) => accPath(ctx, 'waiter.json');
const claimFile = (ctx) => accPath(ctx, 'waiter.claim');

export function waiterStatus(ctx) {
  const w = readJson(waiterFile(ctx), null);
  const claim = readJson(claimFile(ctx), null);
  const now = ctx.now();
  const hb = Date.parse(w?.heartbeatAt ?? '') || 0;
  const alive = !!w && pidAlive(w.pid) && now - hb < HEARTBEAT_STALE_MS;
  // a freshly spawned waiter holds the claim before it has written waiter.json
  const starting = !alive && !!claim && pidAlive(claim.pid) && now - (claim.at || 0) < CLAIM_STARTING_MS;
  return { alive: alive || starting, pid: (alive ? w?.pid : claim?.pid) ?? null, armedAt: w?.armedAt ?? null, heartbeatAt: w?.heartbeatAt ?? null, reasons: w?.reasons ?? [] };
}

/**
 * Join the live waiter (append the reason) or spawn one. `spawnWaiter(reason)` is
 * cli.mjs's detached spawn; it returns a pid. Never throws.
 */
export function ensureWaiter(ctx, reason, spawnWaiter) {
  try {
    const st = waiterStatus(ctx);
    if (st.alive) {
      const w = readJson(waiterFile(ctx), null);
      if (w && !w.reasons?.includes(reason)) { w.reasons = [...(w.reasons ?? []), reason]; writeJsonAtomic(waiterFile(ctx), w); }
      return { action: 'joined', pid: st.pid };
    }
    const pid = spawnWaiter(reason);
    return { action: 'spawned', pid: pid ?? null };
  } catch (e) {
    return { action: 'failed', error: String(e?.message ?? e) };
  }
}

const CLAIM_STARTING_MS = 60 * 1000;

const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait */ } };

/**
 * A waiter left by an older copy of the plugin (a 0.5.0 waiter cannot see the app stop on Windows, and ensureWaiter only adds
 * reasons to it) is ended so the caller can start one from this copy. For the interactive commands (`accounts go-live`,
 * `accounts answer yes`) and the background passes (`accounts rectify`, push, pull) only: the check asks the OS about the process,
 * which the SessionStart hook must not wait for (it asks only when the claim already differs from this copy).
 *
 * Nothing is ended unless it is proven to be a waiter and is not working:
 *   - an older copy: the claim's version is older than this copy's by semver (no version is an older one), or the version is the
 *     same and the claim's code hash differs from this copy's (S5: a fix that shipped without a version bump). A claim with a
 *     version and no hash is taken to be current. A claim of a NEWER version is never ended (`reason: 'newer'`, silent: the caller
 *     joins that waiter): the Claude app's own copy of the plugin can lag behind the user's cache, and its older code must not
 *     take the waiter of the newer one. This copy must know its own version;
 *   - identity (procid.verifyProcess): its command line holds `accounts wait` and it started no later than the claim. A pid that
 *     fails this is not the waiter (pid reuse): the files are stale, they are dropped, nothing is ended. When the OS cannot be
 *     asked nothing is touched (`unverified`);
 *   - not mid-pass: accounts.lock is not held by it (checked again right before the kill). A waiter that waits holds no lock.
 * The new waiter is started by the caller (armWaiter), or by the next session start for an owed pass.
 * deps: { kill(pid), alive(pid), sleep(ms), verify(pid, want), version, hash } (tests; version and hash stand for this copy's own).
 * @returns {{replaced:boolean, reason?:string, stale?:boolean, pid?:number, version?:string|null, reasons?:string[]}}
 */
export function replaceOldWaiter(ctx, deps = {}) {
  const st = waiterStatus(ctx);
  if (!st.alive || !st.pid) return { replaced: false, reason: 'no-waiter' };
  if (st.pid === process.pid) return { replaced: false, reason: 'no-waiter' };
  const claim = readJson(claimFile(ctx), null);
  const mine = claim?.pid === st.pid ? claim : null;
  const version = mine?.version ?? null;
  const myVersion = deps.version !== undefined ? deps.version : PLUGIN_VERSION;
  if (!myVersion) return { replaced: false, reason: 'unknown-version' };
  const myHash = deps.hash !== undefined ? deps.hash : codeHash();
  if (version) {
    // Two copies of the plugin can run on one machine (the user's cache and the Claude app's own, which can lag behind): the older
    // copy must never end a newer waiter. Only a newer copy replaces an older one; an equal version is told apart by its code hash.
    const order = compareVersions(version, myVersion);
    if (order === null) return { replaced: false, reason: 'unknown-version', version };   // not a version we can order: end nothing
    if (order > 0) return { replaced: false, reason: 'newer', version };
    if (order === 0 && (!mine?.hash || !myHash || mine.hash === myHash)) return { replaced: false, reason: 'current', version };
  }
  const lockHeld = () => { const h = readJson(accPath(ctx, 'accounts.lock'), null); return !!h && h.pid === st.pid && pidAlive(h.pid); };
  if (lockHeld()) return { replaced: false, reason: 'busy', pid: st.pid };
  if (deps.dry) return { replaced: false, reason: 'would-replace', pid: st.pid, version };   // a dry run: nothing is ended
  const claimedAt = mine?.at ?? (Date.parse(st.armedAt ?? '') || NaN);
  const v = (deps.verify ?? ((pid, want) => verifyProcess(pid, want)))(st.pid, { marker: WAITER_MARKER, claimedAt });
  if (v.reason === 'unverified') return { replaced: false, reason: 'unverified', pid: st.pid };
  const drop = () => {
    const c = readJson(claimFile(ctx), null);
    if (!c || c.pid === st.pid) { try { unlinkSync(claimFile(ctx)); } catch { /* none */ } }
    const w = readJson(waiterFile(ctx), null);
    if (!w || w.pid === st.pid) { try { unlinkSync(waiterFile(ctx)); } catch { /* none */ } try { unlinkSync(`${waiterFile(ctx)}.bak`); } catch { /* none */ } }
  };
  if (!v.ok) { drop(); return { replaced: true, stale: true, pid: st.pid, version, hash: mine?.hash ?? null, reasons: st.reasons }; }   // pid reuse: end nothing
  if (lockHeld()) return { replaced: false, reason: 'busy', pid: st.pid };
  const alive = deps.alive ?? pidAlive;
  try { (deps.kill ?? ((pid) => process.kill(pid)))(st.pid); } catch { /* it may already be gone */ }
  const nap = deps.sleep ?? sleepSync;
  for (let i = 0; i < 50 && alive(st.pid); i++) nap(100);
  if (alive(st.pid)) return { replaced: false, reason: 'kill-failed', pid: st.pid };
  drop();
  return { replaced: true, pid: st.pid, version, hash: mine?.hash ?? null, reasons: st.reasons };
}

// 0.5.16: the one-time hold reset (rectify.mjs) waits until no older-version waiter is alive: replaceOldWaiter ended it or found none
// (a current or newer waiter is no older one). An older waiter that is unverified, busy or will not die defers the reset to a later pass.
setOldWaiterGate((ctx, o = {}) => {
  // a dry run (`accounts rectify --dry-run`) asks the same question and ends nothing: an older waiter it would replace is no obstacle
  const r = replaceOldWaiter(ctx, o.dry ? { dry: true } : {});
  return r.replaced === true || ['no-waiter', 'current', 'newer', 'would-replace'].includes(r.reason);
});

/**
 * Is this claim held by a waiter that is really running? A live pid is not enough: after a reboot or a kill the pid
 * can belong to an unrelated process (S4). Past the 60 s start-up window the claim must be backed by waiter.json for
 * the same pid with a fresh heartbeat, the rule waiterStatus uses.
 */
function claimHeld(ctx, cur) {
  const now = ctx.now();
  if (!pidAlive(cur.pid) || now - (cur.at || 0) >= MAX_LIFETIME_MS) return false;
  if (now - (cur.at || 0) < CLAIM_STARTING_MS) return true;
  const w = readJson(waiterFile(ctx), null);
  const hb = Date.parse(w?.heartbeatAt ?? '') || 0;
  return !!w && w.pid === cur.pid && now - hb < HEARTBEAT_STALE_MS;
}

/** Take the single-instance claim. False when a live waiter holds it. */
export function claimWaiter(ctx) {
  const file = claimFile(ctx);
  mkdirSync(dirname(file), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(file, 'wx');
      try { writeSync(fd, JSON.stringify({ pid: process.pid, at: ctx.now(), version: PLUGIN_VERSION, hash: codeHash() })); } finally { closeSync(fd); }
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const cur = readJson(file, null);
      if (cur && claimHeld(ctx, cur)) return false;
      const again = readJson(file, null);            // only remove the stale claim we actually read
      if (JSON.stringify(again) === JSON.stringify(cur)) { try { unlinkSync(file); } catch { /* raced */ } }
    }
  }
  return false;
}

function releaseWaiter(ctx) {
  const w = readJson(waiterFile(ctx), null);
  if (!w || w.pid === process.pid) { try { unlinkSync(waiterFile(ctx)); } catch { /* none */ } try { unlinkSync(`${waiterFile(ctx)}.bak`); } catch { /* none */ } }
  const c = readJson(claimFile(ctx), null);
  if (!c || c.pid === process.pid) { try { unlinkSync(claimFile(ctx)); } catch { /* none */ } }
}

/** Which pass the reasons ask for. */
function pickOp(reasons, state) {
  if (reasons.includes('unlink')) return { name: 'unlink', fn: unlink };
  if (reasons.includes('link') || !state.linked) return { name: 'link', fn: link };
  return { name: 'full', fn: fullPass };
}

const RETRY_REASONS = new Set(['app-running', 'locked', 'pull-active', 'app-started']);

const UI_MUTE_MS = 10 * 60 * 1000;
const PASS_START_TEXT = 'Syncing your Claude accounts while Claude is closed.';
const PASS_DONE_TEXT = {
  link: 'Your Claude accounts are linked.',
  unlink: 'Your Claude accounts are unlinked. Each conversation is back in its own account.',
  full: 'Your Claude accounts are in sync.',
};

/** The save-to-save delay of the switch watcher: a burst of saves is one pass, and a record is current in the other folders about this long after its save. */
export const DEBOUNCE_MS = 2 * 1000;
/** Names in a folder that say nothing: our own temp names and the app's `.tmp` (the rename that follows is the event that counts). */
const QUIET_NAME = /(^\.session-sync-link-|\.tmp$|\.bak)/;

/** A trimmed report for last-pass.json and the toast. */
function lastPassOf(op, res, ctx) {
  return {
    at: new Date(ctx.now()).toISOString(), op, ok: !!res.ok, reason: res.reason ?? null, aborted: !!res.aborted,
    backupId: res.backupId ?? null, ids: res.rectify?.counts?.ids ?? null, counts: res.rectify?.counts ?? null,
    owed: res.rectify?.owed?.length ?? 0,
  };
}

/**
 * Toast every conflict that points at another transcript (the one switch case worth interrupting for) once, and mark it.
 * The others only show in `accounts status`. Never throws.
 */
async function toastConflicts(ctx, notify) {
  try {
    const st = loadState(ctx);
    const todo = Object.entries(st.conflicts ?? {}).filter(([, c]) => c && c.cliChanged && !c.notified);
    if (!todo.length) return;
    const r = await withAccountsLock(ctx, () => {
      const cur = loadState(ctx);
      for (const [id, c] of Object.entries(cur.conflicts ?? {})) if (c?.cliChanged && !c.notified) c.notified = true;
      saveState(ctx, cur);
    });
    if (r.ok) notify?.('Claude conversation continued from an older copy', `${todo.length} conversation(s) were continued from a copy that was not up to date in this account. The newest version is kept in every account and the older one is saved in the session-sync backups (run: accounts status).`);
  } catch { /* a toast must never stop the watcher */ }
}

/**
 * The waiter loop. Returns `{exit, report?}`:
 *   already-running | nothing-owed | done | expired | gave-up (a pass that cannot succeed, e.g. no group)
 *
 * Two jobs. The first is the original one: wait for the app to stop, run the pass that is owed (link, unlink or a full pass), exit.
 * With `o.watch` (what `accounts wait` passes) it is also the account-switch WATCHER and does not exit after a pass: while the app
 * runs and the accounts are linked it follows the app's config (a switch) and the folders (a save) and runs a targeted pass about
 * `debounceMs` after the last event (`livePass`), so every folder the app has not loaded stays current; on an app exit it runs the
 * owed full pass and goes on waiting for the next start. Watch events are only hints: the poll timer runs the same pass, so a
 * dropped or null-named event costs at most `pollMs`.
 *
 * @param {object} ctx
 * @param {object} o  {reason, watch, pollMs, gapMs, debounceMs, probeEveryMs, maxLifetimeMs, watchLockfile, watchFn, passOpts, notify, ui, logFile, status, sleep, log}
 *   passOpts: () => extra options for fullPass/link/unlink/livePass (tests inject a guard)
 *   notify(title, body): the toast function (cli passes a config-aware one)
 *   ui: {start(info), end(result)} from progress.mjs createProgressUi (S4). Every pass that runs with the app closed (link, unlink, the
 *     quit-time full pass) is announced through it: start when the pass begins, end with the result. Without it (or with the null UI,
 *     config progressIcon off) the old behaviour stays: a toast after a link or unlink, nothing after a routine full pass.
 *   status(ctx, {probeProcesses}): replaces appState in the stop watch (tests count the probes)
 *   log(line): where the stop watch says what it sees (the marker going and coming, an unknown process probe, a restart)
 *   watchFn: fs.watch (tests deliver the events themselves)
 *   rcRestore: () => ({enabled, days}) or {enabled, days}: Remote Control restore (rcrestore.mjs). With it on, a watcher also does the
 *     quit-time relink and free restore after the account pass (or alone, when the accounts are not linked), keeps the marker young
 *     while Claude stays closed and logs what the app's launch restore did. The caller passes it only where it applies (Windows).
 *   rcOpts: extra options for rcrestore (projects dir, app log file, now; tests)
 */
export async function runWaiter(ctx, o = {}) {
  const testPoll = Number(process.env.SESSION_SYNC_TEST_POLL_MS) || 0;
  const pollMs = o.pollMs ?? (testPoll || POLL_MS);
  const gapMs = o.gapMs ?? (testPoll || GAP_MS);
  const probeEveryMs = o.probeEveryMs ?? (testPoll || PROBE_EVERY_MS);
  const debounceMs = o.debounceMs ?? (testPoll ? Math.min(testPoll, DEBOUNCE_MS) : DEBOUNCE_MS);
  const maxLife = o.maxLifetimeMs ?? MAX_LIFETIME_MS;
  const reason = o.reason ?? 'deferred';
  const watching = o.watch === true;
  const watchFn = o.watchFn ?? watch;
  const rcCfg = () => { try { const c = typeof o.rcRestore === 'function' ? o.rcRestore() : o.rcRestore; return c && c.enabled ? c : null; } catch { return null; } };
  /** The settings when the spawn fix (rcspawn.mjs) is on: not gated by `enabled`, only by `spawnFix`. */
  const spawnCfg = () => { try { const c = typeof o.rcRestore === 'function' ? o.rcRestore() : o.rcRestore; return c && c.spawnFix !== 'off' ? c : null; } catch { return null; } };

  if (!claimWaiter(ctx)) return { exit: 'already-running' };
  const armedAt = new Date(ctx.now()).toISOString();
  let base = new Set([reason]);
  const beat = (extra = {}) => {
    const w = readJson(waiterFile(ctx), null);
    const reasons = [...new Set([...(w?.pid === process.pid ? w.reasons : []), ...base, ...(extra.reasons ?? [])])];
    writeJsonAtomic(waiterFile(ctx), { pid: process.pid, armedAt, heartbeatAt: new Date(ctx.now()).toISOString(), reasons });
    return reasons;
  };
  /** A pass that was asked for (link, unlink, an owed full pass) is done: the waiter keeps only the reason "watch". */
  const dropAsked = () => {
    base = new Set(['watch']);
    writeJsonAtomic(waiterFile(ctx), { pid: process.pid, armedAt, heartbeatAt: new Date(ctx.now()).toISOString(), reasons: ['watch'] });
    return ['watch'];
  };

  // S4: the indicator for a pass that runs with Claude closed (lib/accounts/progress.mjs: the tray helper reads `waiter-pass-result.json`)
  const ui = o.ui ?? nullUi;
  const uiOn = ui !== nullUi;
  const passResultFile = accPath(ctx, 'waiter-pass-result.json');
  let uiRun = null; let uiRuns = 0;
  const passUiStart = (startText = PASS_START_TEXT) => {
    if (!uiOn) return;
    uiRun = `${process.pid}-${++uiRuns}`;
    try {
      writeJsonAtomic(passResultFile, { status: 'running', progress: progressInfo('pass', 'running', undefined, uiRun) });
      ui.start({ resultFile: passResultFile, logFile: o.logFile ?? '', runnerPid: process.pid, run: uiRun, startText });
    } catch (e) { o.log?.(`waiter: progress indicator: ${e?.message ?? e}`); }
  };
  /** status: ok | failed | retry (the app came back or the pass could not start: the icon goes away quietly, the next try shows it again). */
  const passUiEnd = async (status, headline) => {
    if (!uiRun) return;
    const run = uiRun; uiRun = null;
    const quiet = status === 'retry';
    try {
      const info = progressInfo('pass', quiet ? 'waiting' : status, undefined, quiet ? null : run);
      if (headline && !quiet) info.headline = headline;
      writeJsonAtomic(passResultFile, { status: quiet ? 'waiting' : status, progress: info });
      await ui.end({ status, headline: info.headline, quiet });
      w.uiEndedAt = Date.now();   // the next balloon (the Remote Control step) waits uiGapMs so this one shows first
    } catch (e) { o.log?.(`waiter: progress indicator: ${e?.message ?? e}`); }
  };

  const clock = o.clock ?? Date.now;           // loop timing; ctx.now() stays the stamp for files and state

  // ---- Remote Control restore (rcrestore.mjs): runs after the account pass, once per stop; the marker is kept young while Claude stays closed
  const rcOptions = () => ({ days: rcCfg()?.days, spawnFix: rcCfg()?.spawnFix, ...(o.rcOpts ?? {}), refreshMs: rcRefreshMs, log: (l) => o.log?.(l) });
  const readApp = (probeProcesses) => (o.status ? o.status(ctx, { probeProcesses }) : appState({ ctx, probeProcesses, now: ctx.now() }));
  /** One attempt. w.rcDone is set when it is settled for this stop (done, or nothing to do); a busy lock or a refusal leaves it for a retry. */
  const rcStep = async () => {
    w.rcTries++;
    let shown = false;
    if (uiOn && Date.now() - w.uiEndedAt < uiGapMs) await new Promise((r) => setTimeout(r, uiGapMs - (Date.now() - w.uiEndedAt)));   // the helper of the account pass shows its closing balloon first
    let r;
    try {
      r = await rcQuitStep(ctx, { ...rcOptions(), onStart: () => { shown = true; passUiStart(RC_START_TEXT); } });
    } catch (e) {
      o.log?.(`waiter: remote control step failed: ${e?.message ?? e}`);
      if (shown) { await passUiEnd('failed', 'Remote Control could not be prepared. Click to open the log.'); w.uiEndedAt = Date.now(); }
      return;
    }
    if (!r.ran) { if (r.reason !== 'locked') { w.rcDone = true; w.rcRefreshAt = clock(); } return; }
    const res = r.res;
    o.log?.(`waiter: remote control restore: ${res.relinked} relinked, ${res.marked} marked, ${res.refreshed} refreshed, status ${res.status}`);
    if (res.status === 'refused_app_running') { if (shown) { await passUiEnd('retry'); w.uiEndedAt = Date.now(); } return; }
    const ok = res.status === 'ok';
    if (shown) { await passUiEnd(ok ? 'ok' : 'failed', ok ? rcDoneText(res) : `Remote Control: only part of it was prepared (${res.relinked} links reset, ${res.marked} sessions). Click to open the log.`); w.uiEndedAt = Date.now(); }
    if (ok || w.rcTries >= RC_MAX_TRIES) {
      w.rcDone = true; w.rcRefreshAt = clock();
      if (res.marked || res.refreshed || res.relinked) w.rcLaunch = { since: (o.rcOpts?.now ?? ctx.now()), runSince: 0 };
    }
  };
  /** While Claude stays closed: keep the marker younger than the hour the app accepts. The app is read afresh (with the process probe) first. */
  const rcRefresh = async () => {
    w.rcRefreshAt = clock();
    let a; try { a = readApp(true); } catch { return; }
    if (!a?.fullAllowed) return;
    try { await rcQuitStep(ctx, rcOptions()); } catch (e) { o.log?.(`waiter: remote control refresh failed: ${e?.message ?? e}`); }
  };
  /**
   * The live relink (rcrestore.mjs liveRelinkPass), while the app runs: clear the stale link of a session whose CLI is not running.
   * `all` is the sweep at an account switch (every record, not only the recent ones). It logs its own line. Never throws.
   */
  const liveStep = async (all) => {
    const c = rcCfg();
    if (!c || c.liveRelink !== 'idle-only') return;
    // the switch sweep (all) 0.5.10: right after a switch the app tears its CLIs down and the machine is busy, so the process list can come back
    // unreadable (2026-11-20: `unknown 43`, 0 cleared). Unknown never means "no CLI": nothing is written until the list reads, so the sweep
    // retries with a back-off for about 3 minutes (RC reconnected 3.5 minutes after that switch), logs each try, and has no per-pass cap (a
    // deferral would miss the window before RC reconnects).
    const sweep = all ? { liveBackoffMs: ctx.platform === 'win32' ? (o.sweepBackoffMs ?? SWEEP_BACKOFF_MS) : [], max: SWEEP_MAX, cimTimeoutMs: 25000, switchSweep: true } : {};   // off Windows the probe is never available: no back-off to wait out
    try {
      const res = await (o.liveRelinkFn ?? liveRelinkPass)(ctx, { days: c.days, ...sweep, ...(o.rcOpts ?? {}), settings: c, all, log: (l) => o.log?.(l) });
      // 0.5.12: a session that came back from a switch with a random name (idle, its CLI live): the repair is queued for the end of its own turn, never run mid-turn
      if (res?.bounced?.length) queueBouncedRepairs(ctx, res.bounced, { log: (l) => o.log?.(l) });
      return res;
    } catch (e) { o.log?.(`waiter: live relink failed: ${e?.message ?? e}`); return null; }
  };
  /**
   * The switch sweep, in the background (its back-off takes minutes; the watcher goes on serving the folders). One at a time, and one per
   * sign-in: a second trigger for the same switch (the switch event and a new waiter's start-up look) does nothing. `w.sweep` is the promise.
   */
  const switchSweep = () => {
    const c = rcCfg();
    if (!c || c.liveRelink !== 'idle-only') return;
    let at = null; try { at = recentSwitch(ctx, readSignedIn(ctx.userData), ctx.now(), Infinity, { rcLog: o.rcOpts?.rcLog }); } catch { /* no history: sweep anyway */ }
    if (at !== null && w.sweptSwitch === at) return;
    w.sweptSwitch = at;
    if (w.sweeping) { w.sweepAgain = true; return; }
    w.sweeping = true;
    w.sweep = (async () => {
      try {
        do {
          w.sweepAgain = false;
          await sweepWithRetry(() => liveStep(true), { retryMs: o.sweepRetryMs, windowMs: o.sweepWindowMs, sleep: o.sweepSleep, now: o.sweepNow, stop: () => w.sweepAgain });
        } while (w.sweepAgain);
      }
      finally { w.sweeping = false; }
    })();
  };
  /** A watcher that starts within SWEEP_RECENT_MS of a switch (the old one was replaced, or the app was just started) sweeps at once, not after liveEveryMs. */
  const startupSweep = () => {
    if (!rcCfg()) return;
    try {
      if (recentSwitch(ctx, readSignedIn(ctx.userData), ctx.now(), o.sweepRecentMs ?? SWEEP_RECENT_MS, { rcLog: o.rcOpts?.rcLog }) !== null) switchSweep();
    } catch (e) { o.log?.(`waiter: start-up sweep look failed: ${e?.message ?? e}`); }
  };
  /**
   * Sessions started from claude.ai under another account (rcspawn.mjs). While the app runs: detect and report only ("pending, fixed at the
   * next quit or switch"), once per change of the flagged set. At a stop with rcRestore off (rcQuitStep does it otherwise): repair.
   */
  const spawnLook = () => {
    const c = spawnCfg();
    if (!c) return;
    try {
      const r = spawnFixCore(ctx, { ...(o.rcOpts ?? {}), spawnFix: c.spawnFix, apply: false });
      const key = r.pending.map((x) => x.id).join(',');
      if (key && key !== w.spawnSeen) o.log?.(spawnLine(r));
      w.spawnSeen = key;
    } catch (e) { o.log?.(`waiter: rc-spawn look failed: ${e?.message ?? e}`); }
  };
  const spawnStop = async () => {
    w.spawnDone = true;
    const c = spawnCfg();
    if (!c) return;
    try { await spawnFixStep(ctx, { ...(o.rcOpts ?? {}), spawnFix: c.spawnFix, apply: true, log: (l) => o.log?.(l) }); }
    catch (e) { o.log?.(`waiter: rc-spawn step failed: ${e?.message ?? e}`); }
  };
  /** After the app started: say what its own launch restore did (the pass line with its outcome), so we learn whether the server flags allow it here. */
  const rcLaunchLook = () => {
    const L = w.rcLaunch;
    if (!L.runSince) L.runSince = clock();
    const out = readLaunchOutcome(o.rcOpts?.appLog ?? defaultAppLog(ctx.platform), L.since);
    const timedOut = clock() - L.runSince >= LAUNCH_LOOK_MS;
    if (out.outcome || timedOut) {
      if (out.found) { o.log?.(`waiter: the app's launch restore: outcome ${out.outcome ?? 'none logged'}`); for (const l of out.lines) o.log?.(`waiter:   ${l}`); }
      else o.log?.('waiter: the app logged nothing about a launch restore (no marker was consumed, or its log is elsewhere)');
      w.rcLaunch = null;
    }
  };
  // the watcher's own state: events only set flags (S6: an event is a hint, the poll does the same work)
  const w = { dirty: false, dirtyAt: 0, event: false, coolUntil: 0, fullDone: false, settledProbeAt: -Infinity, uiMuteUntil: 0,
    rcDone: false, rcTries: 0, rcRefreshAt: 0, rcLaunch: null, uiEndedAt: 0, liveAt: clock(), spawnDone: false, spawnSeen: '',
    sweep: null, sweeping: false, sweepAgain: false, sweptSwitch: null, startupLooked: false };
  const rcRefreshMs = o.rcRefreshMs ?? MARKER_REFRESH_MS;
  const uiGapMs = o.uiGapMs ?? (testPoll ? 0 : 1500);
  /** The accounts are not linked and nothing asks for a link: this watcher only does the Remote Control restore. */
  const rcOnly = (rs) => watching && !!rcCfg() && !asksOp(rs);
  let wake = null;
  const sleep = o.sleep ?? ((ms) => new Promise((res) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); wake = null; res(); }
    wake = done;
  }));
  const hint = (immediate) => { w.dirty = true; w.dirtyAt = immediate ? -Infinity : clock(); w.event = true; wake?.(); };
  const watchers = new Map();                  // path -> fs.FSWatcher
  const openWatch = (path, listener) => {
    if (watchers.has(path)) return;
    try {
      const wt = watchFn(path, { persistent: false }, listener);
      wt?.on?.('error', () => {});
      watchers.set(path, wt);
    } catch { /* the poll timer still works */ }
  };
  if (o.watchLockfile !== false && ctx.userData) {
    // the lock marker wakes the loop (the app started or quit); config.json is the app's account switch. The app rewrites config.json
    // for many other reasons (window state, settings): only a change of the signed-in account is urgent (N4), the rest waits for the poll.
    let lastSigned = readSignedIn(ctx.userData);
    openWatch(ctx.userData, (_ev, name) => {
      if (name === 'lockfile' || name === 'SingletonLock') wake?.();
      else if (watching && name === 'config.json') {
        const now = readSignedIn(ctx.userData);
        if (now !== lastSigned) { lastSigned = now; hint(true); }
      }
    });
  }
  /** One watch per account folder (not recursive: the app saves by rename, which a directory watch reports on every platform). */
  const syncFolderWatches = () => {
    if (!watching || o.watchLockfile === false || !ctx.store) return;
    const want = new Set([ctx.store, ...listFolders(ctx.store).map((f) => f.path)]);
    for (const [p, wt] of watchers) if (p !== ctx.userData && !want.has(p)) { try { wt?.close?.(); } catch { /* ignore */ } watchers.delete(p); }
    for (const p of want) openWatch(p, (_ev, name) => { if (!name || !QUIET_NAME.test(String(name))) hint(false); });
  };

  const startedAt = clock();
  try {
    let reasons = beat();
    const st0 = loadState(ctx);
    const wantsOp = asksOp(reasons) || (!st0.linked && !rcOnly(reasons));
    if (!wantsOp && !owedWork(ctx, {}).owed && !(watching && (st0.linked || rcCfg()))) return { exit: 'nothing-owed' };

    let negatives = 0; let firstNegAt = 0; let nullStreak = 0;
    const stopWatch = createStopWatch(ctx, { log: o.log ? (l) => o.log(`waiter: ${l}`) : undefined, clock, probeEveryMs, status: o.status });
    while (clock() - startedAt < maxLife) {
      // the claim is the single-instance proof: gone (the state folder was removed) or taken over, so this process has no business here
      // (N7: one failed read is not a lost claim, an antivirus scan or a sharing violation can fail it: look again before giving up)
      let held = readJson(claimFile(ctx), null);
      for (let i = 0; !held && i < 3; i++) { sleepSync(30); held = readJson(claimFile(ctx), null); }
      if (!held || held.pid !== process.pid) return { exit: 'lost-claim' };
      reasons = beat();
      const now = clock();
      // S4: settled = the pass for this stop is done (or none was owed) and nothing new is asked. The app is closed and the lock
      // marker is gone, so the stop watch would start a hidden PowerShell every poll just to learn the same thing again. While
      // settled it asks the OS only every probeEveryMs; the lock marker coming back wakes the loop and is read without a probe.
      const settled = watching && w.fullDone && !asksOp(reasons) && (() => { const s = loadState(ctx); return s.linked ? !s.fullPassOwed : rcOnly(reasons); })();
      const skipProbe = settled && now - w.settledProbeAt < probeEveryMs;
      if (settled && !skipProbe) w.settledProbeAt = now;
      const app = stopWatch.read({ now, ...(skipProbe ? { probeProcesses: false } : {}) });
      nullStreak = app.s2 === null && app.s1 === false ? nullStreak + 1 : 0;
      if (app.fullAllowed) { if (!negatives) firstNegAt = now; negatives++; } else { negatives = 0; }
      if (app.running) { w.fullDone = false; w.rcDone = false; w.rcTries = 0; w.spawnDone = false; }
      if (app.running && w.rcLaunch && rcCfg()) rcLaunchLook();
      else if (!app.running && w.rcDone && rcCfg() && clock() - w.rcRefreshAt >= rcRefreshMs) await rcRefresh();
      // the live relink, every liveEveryMs while the app runs (the first look after an app start is the wake hook's)
      if (app.running && !w.startupLooked) { w.startupLooked = true; startupSweep(); }
      if (!app.running) w.liveAt = clock();
      else if ((rcCfg() || spawnCfg()) && clock() - w.liveAt >= (o.liveEveryMs ?? rcCfg()?.liveEveryMs ?? RC_DEFAULTS.liveEveryMs)) { w.liveAt = clock(); if (rcCfg()) await liveStep(false); spawnLook(); }

      // ---- the app runs and the accounts are linked: keep the folders the app has not loaded current
      if (watching && app.running) {
        const state = loadState(ctx);
        if (state.linked) {
          syncFolderWatches();
          const byEvent = w.event; w.event = false;
          if (!byEvent) { w.dirty = true; w.dirtyAt = -Infinity; }                       // a poll tick: do the same check
          if (w.coolUntil && ctx.now() >= w.coolUntil) { w.dirty = true; w.dirtyAt = -Infinity; w.coolUntil = 0; }   // a cooling folder is free now
          if (w.dirty && now - w.dirtyAt < debounceMs) { await sleep(Math.max(1, debounceMs - (now - w.dirtyAt))); continue; }
          if (w.dirty) {
            w.dirty = false;
            let res = null;
            try { res = await livePass(ctx, { app, remoteList: readJson(accPath(ctx, 'remote-list.json'), null), ...(o.passOpts?.() ?? {}) }); } catch (e) { o.log?.(`waiter: targeted pass failed: ${e?.message ?? e}`); }
            if (res?.rectify?.conflicts?.length) o.log?.(`waiter: ${res.rectify.conflicts.length} conversation(s) continued from a stale copy`);
            if (res?.switched) {
              o.log?.(`waiter: the signed-in account changed; the previous account's folders cool for a few seconds`);
              switchSweep();          // the sessions of the account just signed in: clear every stale link while their CLIs are not running yet (background, with a back-off)
              spawnLook();            // and name the ones started from claude.ai under the account just left (detached at the next stop)
            }
            await toastConflicts(ctx, o.notify);
            const end = coolingEndsAt(loadState(ctx), ctx.now());
            w.coolUntil = end;
            await sleep(end ? Math.max(50, Math.min(pollMs, end - ctx.now() + 100)) : pollMs);
            continue;
          }
        }
      }

      // ---- the stop is confirmed: the pass that is owed
      if (negatives >= 2 && now - firstNegAt >= gapMs) {
        const state = loadState(ctx);
        const asked = asksOp(reasons) || (!state.linked && !rcOnly(reasons));
        // a watcher runs a full pass once per stop, and only when one is owed (the old waiter ran one pass and exited)
        const needed = !watching || asked || state.fullPassOwed || (!w.fullDone && owedWork(ctx, { state, app }).owed);
        if (needed) {
          const op = pickOp(reasons, state);
          // S4: whatever runs while Claude is closed is announced (a tray icon and a balloon at the start and the end; a
          // notification on macOS and Linux). A pass that did nothing because something else held the lock does not announce
          // itself again for ten minutes, so a long interactive command cannot turn into a balloon every poll.
          const shown = clock() >= w.uiMuteUntil;
          if (shown) passUiStart();
          let res;
          try {
            res = await op.fn(ctx, { reasons, log: (l) => o.log?.(l), ...(o.passOpts?.() ?? {}) });
          } catch (e) {
            const report = { at: new Date(ctx.now()).toISOString(), op: op.name, ok: false, error: String(e?.message ?? e) };
            writeJsonAtomic(accPath(ctx, 'last-pass.json'), report);
            await passUiEnd('failed');
            return { exit: 'failed', report };
          }
          if (!res.ok && (res.aborted || RETRY_REASONS.has(res.reason))) {
            await passUiEnd('retry');
            if (!res.aborted) w.uiMuteUntil = clock() + UI_MUTE_MS;
            negatives = 0; await sleep(pollMs); continue;
          }
          const report = lastPassOf(op.name, res, ctx);
          writeJsonAtomic(accPath(ctx, 'last-pass.json'), report);
          if (res.ok) w.uiMuteUntil = 0;
          if (!uiOn) {   // no indicator (config progressIcon off): the old toast after a link or unlink, nothing after a routine full pass
            if (res.ok && op.name !== 'full') {
              const n = report.ids;
              o.notify?.(op.name === 'unlink' ? 'Claude accounts unlinked' : 'Claude accounts linked',
                op.name === 'unlink' ? 'Each conversation is back in its own account.' : `${n ?? 'All'} conversations in every account`);
            }
          } else {
            if (!uiRun) passUiStart();   // an earlier attempt that did nothing kept the start notice back: the user is told now
            await passUiEnd(res.ok ? 'ok' : 'failed', res.ok ? PASS_DONE_TEXT[op.name] : undefined);
          }
          if (watching && res.ok && op.name !== 'unlink') {   // linked, or a full pass done: go on watching for the next start
            w.fullDone = true; negatives = 0; reasons = dropAsked();
            await sleep(rcCfg() && !w.rcDone ? Math.min(pollMs, FAST_POLL_MS) : pollMs);   // the Remote Control step is next: not after 30 s
            continue;
          }
          return { exit: res.ok ? 'done' : 'gave-up', report };
        } else if (watching) {
          w.fullDone = true;   // nothing is owed at this stop: settled until the app runs again (the probe backs off)
        }
        // Remote Control restore: after the account pass (the records are one inode per conversation by now), once per stop
        if (watching && w.fullDone && !w.rcDone && rcCfg() && w.rcTries < RC_MAX_TRIES) { await rcStep(); if (!w.rcDone) { negatives = 0; await sleep(pollMs); continue; } }
        // the spawn fix with rcRestore off (with it on, the step above did it): once per stop
        if (watching && w.fullDone && !w.spawnDone && !rcCfg()) await spawnStop();
      }
      // the lock marker is gone: the stop is being confirmed, so look again at once (not after 30 s)
      await sleep(app.s1 === false && !settled && nullStreak < FAST_NULL_LIMIT && (!watching || negatives < 2) ? Math.min(pollMs, FAST_POLL_MS) : pollMs);
    }
    return { exit: 'expired' };
  } finally {
    for (const wt of watchers.values()) { try { wt?.close?.(); } catch { /* ignore */ } }
    releaseWaiter(ctx);
  }
}
