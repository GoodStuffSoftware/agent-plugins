/**
 * defer.mjs — "a push is owed" bookkeeping: COALESCE, never DROP.
 *
 * THE BUG THIS EXISTS TO PREVENT
 * ---------------------------------------------------------------------------
 * The debounce used to be a permanent skip: a hook-triggered push inside the
 * window logged one line and exited, and nothing ever scheduled the catch-up.
 * The same was true of the sync lock — a second push arriving while one was
 * running just no-oped. Both are fine right up until the DROPPED one was the
 * LAST push of a conversation: then that conversation's final state never
 * reaches the remote, and on a machine that is then closed or reimaged, it is
 * simply gone. Losing a conversation is not an acceptable price for throttling.
 *
 * THE MODEL
 * ---------------------------------------------------------------------------
 * Every hook-triggered push RECORDS a request instead of running one. The
 * record lives in a single small JSON file:
 *
 *   { requestedAt: <ms>, runAt: <ms>, pid: <worker pid> }
 *
 *   requestedAt  when the most recent request came in. Refreshed by every
 *                request, so it always names the LATEST one.
 *   runAt        when the scheduled worker intends to actually push.
 *   pid          the detached worker that will do it.
 *
 * The file's EXISTENCE means "a push is still owed." It is deleted only when a
 * push has actually succeeded AND that push started after the newest request
 * (`requestedAt <= claimedAt`) — so a request that lands mid-push is never
 * swallowed by the push that could not have seen it. That single comparison is
 * what makes "the last request is never the one dropped" true.
 *
 * Coalescing: a request finding a LIVE worker already scheduled for a future
 * runAt just refreshes requestedAt and returns. N rapid requests therefore
 * produce ONE worker and ONE push, not N of either — which is the whole point
 * of debouncing, achieved without discarding anything.
 *
 * Crash safety: if the worker dies (machine shut down mid-window), the record
 * survives on disk with a dead pid, and the very next request spawns a fresh
 * worker for it. Worst case the push is deferred to the next session; it is
 * never silently forgotten.
 */

import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pidAlive } from './lock.mjs';

/** Read the pending record, or null when nothing is owed. */
export function readDeferred(file) {
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    if (!d || typeof d !== 'object') return null;
    if (!Number.isFinite(d.requestedAt)) return null;
    return d;
  } catch { return null; }
}

function write(file, data) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data));
    return true;
  } catch { return false; }
}

/**
 * Record that a push is owed and make sure EXACTLY ONE worker is scheduled.
 *
 * @param {string} file            the pending-record path
 * @param {object} o
 * @param {number} o.runAt         when a NEW worker should run (ms epoch)
 * @param {Function} o.spawnWorker called only when a worker must actually be
 *                                 spawned; returns its pid
 * @param {Function} [o.isAlive]   pid liveness check (injected by tests)
 * @param {number} [o.now]
 * @returns {{action: 'coalesced'|'scheduled', runAt: number, pid: any}}
 */
export function requestDeferred(file, { runAt, spawnWorker, isAlive = pidAlive, now = Date.now() }) {
  const existing = readDeferred(file);

  // A live worker that has not started yet will pick this request up, because
  // it re-reads the record when it wakes. Nothing more to do than say we asked.
  if (existing && existing.runAt > now && isAlive(existing.pid)) {
    write(file, { ...existing, requestedAt: now });
    return { action: 'coalesced', runAt: existing.runAt, pid: existing.pid };
  }

  // Otherwise: no record, or its worker is dead, or its runAt already passed
  // (worker gone without settling). Either way nothing is going to run this on
  // its own, so schedule one. Writing the record AFTER the spawn means a spawn
  // failure leaves the old record intact rather than pointing at a phantom.
  let pid = null;
  try { pid = spawnWorker(); } catch { pid = null; }
  write(file, { requestedAt: now, runAt, pid });
  return { action: 'scheduled', runAt, pid };
}

/**
 * A worker re-stamps the record while it waits on the lock or backs off after
 * a failure, so requests arriving meanwhile coalesce onto IT rather than
 * spawning a competing worker. requestedAt is deliberately preserved.
 */
export function refreshDeferred(file, { runAt, pid }) {
  const existing = readDeferred(file);
  if (!existing) return false;
  return write(file, { ...existing, runAt, pid });
}

/**
 * Clear the record IFF the work that just succeeded covers the newest request.
 *
 * `claimedAt` must be captured BEFORE the push scans the tree. A request that
 * arrived after that instant may have changed files the scan already walked
 * past, so it is genuinely not covered and the record must survive.
 *
 * @returns {boolean} true when nothing is owed any more.
 */
export function settleDeferred(file, claimedAt) {
  const existing = readDeferred(file);
  if (!existing) return true;
  if (existing.requestedAt > claimedAt) return false;
  try { unlinkSync(file); } catch { /* already gone, or unwritable — the next run re-evaluates */ }
  return true;
}
