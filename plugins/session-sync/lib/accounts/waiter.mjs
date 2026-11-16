/**
 * waiter.mjs - the singleton background waiter (plan 5.12).
 *
 * A link, an unlink or a deferred full pass needs the desktop app stopped. The
 * waiter is a hidden, detached node process (spawned by cli.mjs through
 * spawnDetachedSelf, never from here) that watches for the app to exit, runs the
 * pass once, writes `last-pass.json`, toasts and exits.
 *
 *   ensureWaiter(ctx, reason, spawnWaiter)  join the live waiter or spawn one
 *   runWaiter(ctx, opts)                    the loop the detached process runs
 *   waiterStatus(ctx)                       {alive, pid, armedAt, heartbeatAt, reasons}
 *
 * Single instance: a claim file created with flag `wx` (stale when its pid is gone).
 * Liveness: the pid is alive and `heartbeatAt` is younger than 5 minutes.
 * Trigger: an fs.watch on USERDATA for the lock marker plus a poll timer
 * (SESSION_SYNC_TEST_POLL_MS shrinks every interval in tests). The pass runs only
 * after 2 consecutive "app stopped" readings at least `gapMs` (10 s) apart, so a
 * restart gap or a flapping lockfile never triggers it.
 */

import { openSync, writeSync, closeSync, unlinkSync, mkdirSync, watch } from 'node:fs';
import { dirname } from 'node:path';
import { pidAlive } from '../lock.mjs';
import { accPath, readJson, writeJsonAtomic, loadState } from './state.mjs';
import { appState, lockfilePresent } from './appstate.mjs';
import { fullPass, link, unlink, owedWork } from './pass.mjs';

export const HEARTBEAT_STALE_MS = 5 * 60 * 1000;
export const MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const POLL_MS = 30 * 1000;
const GAP_MS = 10 * 1000;
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
  const starting = !alive && !!claim && pidAlive(claim.pid) && now - (claim.at || 0) < 60 * 1000;
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

/** Take the single-instance claim. False when a live waiter holds it. */
export function claimWaiter(ctx) {
  const file = claimFile(ctx);
  mkdirSync(dirname(file), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(file, 'wx');
      try { writeSync(fd, JSON.stringify({ pid: process.pid, at: ctx.now() })); } finally { closeSync(fd); }
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const cur = readJson(file, null);
      if (cur && pidAlive(cur.pid) && ctx.now() - (cur.at || 0) < MAX_LIFETIME_MS) return false;
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

/** A trimmed report for last-pass.json and the toast. */
function lastPassOf(op, res, ctx) {
  return {
    at: new Date(ctx.now()).toISOString(), op, ok: !!res.ok, reason: res.reason ?? null, aborted: !!res.aborted,
    backupId: res.backupId ?? null, ids: res.rectify?.counts?.ids ?? null, counts: res.rectify?.counts ?? null,
    owed: res.rectify?.owed?.length ?? 0,
  };
}

/**
 * The waiter loop. Returns `{exit, report?}`:
 *   already-running | nothing-owed | done | expired | gave-up (a pass that cannot succeed, e.g. no group)
 *
 * @param {object} ctx
 * @param {object} o  {reason, pollMs, gapMs, probeEveryMs, maxLifetimeMs, watchLockfile, passOpts, notify, sleep}
 *   passOpts: () => extra options for fullPass/link/unlink (tests inject a guard)
 *   notify(title, body): the toast function (cli passes a config-aware one)
 */
export async function runWaiter(ctx, o = {}) {
  const testPoll = Number(process.env.SESSION_SYNC_TEST_POLL_MS) || 0;
  const pollMs = o.pollMs ?? (testPoll || POLL_MS);
  const gapMs = o.gapMs ?? (testPoll || GAP_MS);
  const probeEveryMs = o.probeEveryMs ?? (testPoll || PROBE_EVERY_MS);
  const maxLife = o.maxLifetimeMs ?? MAX_LIFETIME_MS;
  const reason = o.reason ?? 'deferred';

  if (!claimWaiter(ctx)) return { exit: 'already-running' };
  const armedAt = new Date(ctx.now()).toISOString();
  const beat = (extra = {}) => {
    const w = readJson(waiterFile(ctx), null);
    const reasons = [...new Set([...(w?.pid === process.pid ? w.reasons : []), reason, ...(extra.reasons ?? [])])];
    writeJsonAtomic(waiterFile(ctx), { pid: process.pid, armedAt, heartbeatAt: new Date(ctx.now()).toISOString(), reasons });
    return reasons;
  };

  let wake = null;
  const sleep = o.sleep ?? ((ms) => new Promise((res) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); wake = null; res(); }
    wake = done;
  }));
  let watcher = null;
  if (o.watchLockfile !== false && ctx.userData) {
    try {
      watcher = watch(ctx.userData, { persistent: false }, (_ev, name) => { if (name === 'lockfile' || name === 'SingletonLock') wake?.(); });
      watcher.on('error', () => {});
    } catch { /* the poll timer still works */ }
  }

  const clock = o.clock ?? Date.now;           // loop timing; ctx.now() stays the stamp for files and state
  const startedAt = clock();
  try {
    let reasons = beat();
    const st0 = loadState(ctx);
    const wantsOp = reasons.some((r) => r === 'link' || r === 'unlink') || !st0.linked;
    if (!wantsOp && !owedWork(ctx, {}).owed) return { exit: 'nothing-owed' };

    let negatives = 0; let firstNegAt = 0; let lastProbe = -Infinity;
    while (clock() - startedAt < maxLife) {
      reasons = beat();
      const now = clock();
      const probe = !lockfilePresent(ctx) || now - lastProbe >= probeEveryMs;
      if (probe) lastProbe = now;
      const app = appState({ ctx, probeProcesses: probe, now: ctx.now() });
      if (app.fullAllowed) { if (!negatives) firstNegAt = now; negatives++; } else { negatives = 0; }

      if (negatives >= 2 && now - firstNegAt >= gapMs) {
        const state = loadState(ctx);
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
        if (res.ok) {
          const n = report.ids;
          o.notify?.(op.name === 'unlink' ? 'Claude accounts unlinked' : 'Claude accounts linked',
            op.name === 'unlink' ? 'Each conversation is back in its own account.' : `${n ?? 'All'} conversations in every account`);
        }
        return { exit: res.ok ? 'done' : 'gave-up', report };
      }
      await sleep(pollMs);
    }
    return { exit: 'expired' };
  } finally {
    try { watcher?.close(); } catch { /* ignore */ }
    releaseWaiter(ctx);
  }
}
