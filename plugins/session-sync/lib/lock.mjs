/**
 * lock.mjs — one sync at a time on this machine.
 *
 * WHY: Claude's SessionStart/SessionEnd hooks fire PER CONVERSATION, not per
 * client. Four conversations open, three closed together, and you get three
 * concurrent pushes at the same remote. Google Drive permits two files with the
 * same name in a folder, so racing writers really do produce duplicates — we
 * found three on Drive before this existed.
 *
 * DESIGN: a lock file holding pid + start time.
 *   - A second sync does not queue and does not fail; it NO-OPS. Whatever it was
 *     about to send, the running sync is already sending, or the next one will.
 *     Blocking a session-end hook to wait for a 10-minute upload would be worse
 *     than skipping it.
 *   - Locks EXPIRE. A crashed or killed process must never wedge syncing
 *     forever, so a lock older than the TTL is taken over.
 *   - Liveness is checked too: if the owning pid is gone, the lock is dead
 *     regardless of age.
 */

import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const TTL_MS = 30 * 60 * 1000;   // generous: a first full sync can take ~10 min

function readLock(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function pidAlive(pid) {
  if (!pid) return false;
  if (pid === process.pid) return true;   // it is us, and we are demonstrably running
  try { process.kill(pid, 0); return true; }        // signal 0 = existence check
  catch (e) { return e.code === 'EPERM'; }          // EPERM: alive, owned by someone else
}

/**
 * Try to take the lock.
 * @returns {{acquired: boolean, heldBy?: object, reason?: string, release: Function}}
 */
export function acquireLock(file, { ttlMs = TTL_MS } = {}) {
  const noop = () => {};
  try { mkdirSync(dirname(file), { recursive: true }); } catch {}

  const existing = readLock(file);
  if (existing) {
    const ageMs = Date.now() - (existing.at || 0);
    const alive = pidAlive(existing.pid);
    if (alive && ageMs < ttlMs) {
      return {
        acquired: false,
        heldBy: existing,
        reason: `another sync is running (pid ${existing.pid}, started ${Math.round(ageMs / 1000)}s ago)`,
        release: noop,
      };
    }
    // Stale: owner gone, or it outlived the TTL. Take it over rather than
    // letting one dead process disable syncing indefinitely.
  }

  try {
    writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now(), host: process.env.COMPUTERNAME || '' }));
  } catch {
    // Cannot write a lock — proceed unlocked rather than refuse to back up.
    // A missed lock is a small risk; a skipped backup is a real one.
    return { acquired: true, degraded: true, release: noop };
  }

  return {
    acquired: true,
    release: () => {
      try {
        const now = readLock(file);
        if (now && now.pid === process.pid) unlinkSync(file);   // never steal another's
      } catch {}
    },
  };
}
