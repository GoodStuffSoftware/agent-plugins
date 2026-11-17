/**
 * waiter.mjs - the singleton background waiter and account-switch watcher (plan 5.12, account-switch design).
 *
 * A link, an unlink or a deferred full pass needs the desktop app stopped. The
 * waiter is a hidden, detached node process (spawned by cli.mjs through
 * spawnDetachedSelf, never from here) that watches for the app to exit, runs the
 * pass, writes `last-pass.json` and toasts. With `watch` (what `accounts wait`
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
import { createStopWatch, coolingEndsAt } from './appstate.mjs';
import { listFolders } from './folders.mjs';
import { fullPass, livePass, link, unlink, owedWork } from './pass.mjs';
import { PLUGIN_VERSION } from './version.mjs';
import { verifyProcess, WAITER_MARKER } from './procid.mjs';

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
 * `accounts answer yes`) only: the check asks the OS about the process, which the SessionStart hook must not wait for.
 *
 * Nothing is ended unless it is proven to be a waiter and is not working:
 *   - another version: the claim's version differs (no version is an older one); this copy must know its own version;
 *   - identity (procid.verifyProcess): its command line holds `accounts wait` and it started no later than the claim. A pid that
 *     fails this is not the waiter (pid reuse): the files are stale, they are dropped, nothing is ended. When the OS cannot be
 *     asked nothing is touched (`unverified`);
 *   - not mid-pass: accounts.lock is not held by it (checked again right before the kill). A waiter that waits holds no lock.
 * The new waiter is started by the caller (armWaiter), or by the next session start for an owed pass.
 * deps: { kill(pid), alive(pid), sleep(ms), verify(pid, want) } (tests).
 * @returns {{replaced:boolean, reason?:string, stale?:boolean, pid?:number, version?:string|null, reasons?:string[]}}
 */
export function replaceOldWaiter(ctx, deps = {}) {
  const st = waiterStatus(ctx);
  if (!st.alive || !st.pid) return { replaced: false, reason: 'no-waiter' };
  if (st.pid === process.pid) return { replaced: false, reason: 'no-waiter' };
  const claim = readJson(claimFile(ctx), null);
  const mine = claim?.pid === st.pid ? claim : null;
  const version = mine?.version ?? null;
  if (!PLUGIN_VERSION) return { replaced: false, reason: 'unknown-version' };
  if (version === PLUGIN_VERSION) return { replaced: false, reason: 'current', version };
  const lockHeld = () => { const h = readJson(accPath(ctx, 'accounts.lock'), null); return !!h && h.pid === st.pid && pidAlive(h.pid); };
  if (lockHeld()) return { replaced: false, reason: 'busy', pid: st.pid };
  const claimedAt = mine?.at ?? (Date.parse(st.armedAt ?? '') || NaN);
  const v = (deps.verify ?? ((pid, want) => verifyProcess(pid, want)))(st.pid, { marker: WAITER_MARKER, claimedAt });
  if (v.reason === 'unverified') return { replaced: false, reason: 'unverified', pid: st.pid };
  const drop = () => {
    const c = readJson(claimFile(ctx), null);
    if (!c || c.pid === st.pid) { try { unlinkSync(claimFile(ctx)); } catch { /* none */ } }
    const w = readJson(waiterFile(ctx), null);
    if (!w || w.pid === st.pid) { try { unlinkSync(waiterFile(ctx)); } catch { /* none */ } try { unlinkSync(`${waiterFile(ctx)}.bak`); } catch { /* none */ } }
  };
  if (!v.ok) { drop(); return { replaced: true, stale: true, pid: st.pid, version, reasons: st.reasons }; }   // pid reuse: end nothing
  if (lockHeld()) return { replaced: false, reason: 'busy', pid: st.pid };
  const alive = deps.alive ?? pidAlive;
  try { (deps.kill ?? ((pid) => process.kill(pid)))(st.pid); } catch { /* it may already be gone */ }
  const nap = deps.sleep ?? sleepSync;
  for (let i = 0; i < 50 && alive(st.pid); i++) nap(100);
  if (alive(st.pid)) return { replaced: false, reason: 'kill-failed', pid: st.pid };
  drop();
  return { replaced: true, pid: st.pid, version, reasons: st.reasons };
}

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
      try { writeSync(fd, JSON.stringify({ pid: process.pid, at: ctx.now(), version: PLUGIN_VERSION })); } finally { closeSync(fd); }
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
 * @param {object} o  {reason, watch, pollMs, gapMs, debounceMs, probeEveryMs, maxLifetimeMs, watchLockfile, watchFn, passOpts, notify, sleep, log}
 *   passOpts: () => extra options for fullPass/link/unlink/livePass (tests inject a guard)
 *   notify(title, body): the toast function (cli passes a config-aware one)
 *   log(line): where the stop watch says what it sees (the marker going and coming, an unknown process probe, a restart)
 *   watchFn: fs.watch (tests deliver the events themselves)
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

  const clock = o.clock ?? Date.now;           // loop timing; ctx.now() stays the stamp for files and state
  // the watcher's own state: events only set flags (S6: an event is a hint, the poll does the same work)
  const w = { dirty: false, dirtyAt: 0, event: false, coolUntil: 0, fullDone: false };
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
    // the lock marker wakes the loop (the app started or quit); config.json is the app's account switch
    openWatch(ctx.userData, (_ev, name) => {
      if (name === 'lockfile' || name === 'SingletonLock') wake?.();
      else if (watching && name === 'config.json') hint(true);
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
    const wantsOp = reasons.some((r) => r === 'link' || r === 'unlink') || !st0.linked;
    if (!wantsOp && !owedWork(ctx, {}).owed && !(watching && st0.linked)) return { exit: 'nothing-owed' };

    let negatives = 0; let firstNegAt = 0; let nullStreak = 0;
    const stopWatch = createStopWatch(ctx, { log: o.log ? (l) => o.log(`waiter: ${l}`) : undefined, clock, probeEveryMs });
    while (clock() - startedAt < maxLife) {
      // the claim is the single-instance proof: gone (the state folder was removed) or taken over, so this process has no business here
      const held = readJson(claimFile(ctx), null);
      if (!held || held.pid !== process.pid) return { exit: 'lost-claim' };
      reasons = beat();
      const now = clock();
      const app = stopWatch.read({ now });
      nullStreak = app.s2 === null && app.s1 === false ? nullStreak + 1 : 0;
      if (app.fullAllowed) { if (!negatives) firstNegAt = now; negatives++; } else { negatives = 0; }
      if (app.running) w.fullDone = false;

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
            if (res?.switched) o.log?.(`waiter: the signed-in account changed; the previous account's folders cool for a few seconds`);
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
        const asked = reasons.some((r) => r === 'link' || r === 'unlink') || !state.linked;
        // a watcher runs a full pass once per stop, and only when one is owed (the old waiter ran one pass and exited)
        const needed = !watching || asked || state.fullPassOwed || (!w.fullDone && owedWork(ctx, { state, app }).owed);
        if (needed) {
          const op = pickOp(reasons, state);
          let res;
          try {
            res = await op.fn(ctx, { reasons, ...(o.passOpts?.() ?? {}) });
          } catch (e) {
            const report = { at: new Date(ctx.now()).toISOString(), op: op.name, ok: false, error: String(e?.message ?? e) };
            writeJsonAtomic(accPath(ctx, 'last-pass.json'), report);
            return { exit: 'failed', report };
          }
          if (!res.ok && (res.aborted || RETRY_REASONS.has(res.reason))) { negatives = 0; await sleep(pollMs); continue; }
          const report = lastPassOf(op.name, res, ctx);
          writeJsonAtomic(accPath(ctx, 'last-pass.json'), report);
          if (res.ok && op.name !== 'full') {   // a routine full pass after the link says nothing
            const n = report.ids;
            o.notify?.(op.name === 'unlink' ? 'Claude accounts unlinked' : 'Claude accounts linked',
              op.name === 'unlink' ? 'Each conversation is back in its own account.' : `${n ?? 'All'} conversations in every account`);
          }
          if (watching && res.ok && op.name !== 'unlink') {   // linked, or a full pass done: go on watching for the next start
            w.fullDone = true; negatives = 0; reasons = dropAsked();
            await sleep(pollMs);
            continue;
          }
          return { exit: res.ok ? 'done' : 'gave-up', report };
        }
      }
      // the lock marker is gone: the stop is being confirmed, so look again at once (not after 30 s)
      await sleep(app.s1 === false && nullStreak < FAST_NULL_LIMIT && (!watching || negatives < 2) ? Math.min(pollMs, FAST_POLL_MS) : pollMs);
    }
    return { exit: 'expired' };
  } finally {
    for (const wt of watchers.values()) { try { wt?.close?.(); } catch { /* ignore */ } }
    releaseWaiter(ctx);
  }
}
