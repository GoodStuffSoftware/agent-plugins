/**
 * fixtures/appsim.mjs - a small simulator of the desktop app's file behaviour.
 *
 * It reproduces what matters to the account link, as read from the app bundle:
 *   - a record save is tmp + fsync + rename (a NEW inode: it breaks hard links);
 *   - a delete removes the .tmp, then the record, then writes a tombstone
 *     `deleted_<key>` whose content is a 13-digit ms timestamp;
 *   - after an account switch, parked sessions keep saving to the OLD folder;
 *   - the scheduler updates run-times with an atomic write of scheduled-tasks.json;
 *   - the app's running state is exposed through the test seam
 *     SESSION_SYNC_TEST_APP_STATE (a JSON file re-read on every check).
 *
 * All times come from the virtual clock so tests never sleep.
 */

import {
  openSync, writeSync, fsyncSync, closeSync, renameSync, readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { setMtime, recordName } from './store.mjs';

const msOf = (v) => (typeof v === 'number' ? v : Date.parse(v) || 0);
const folderPath = (f) => (typeof f === 'string' ? f : f.path);

function atomicWrite(path, text) {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'wx');
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}

export function createSim({ clock, appFile }) {
  const sim = {
    clock,
    parked: [],

    /** App save: tmp, fsync, rename; mtime advances. `patch` merges into the record. */
    save(folder, id, patch = {}) {
      const p = join(folderPath(folder), `${id}.json`);
      let cur = {};
      try { cur = JSON.parse(readFileSync(p, 'utf8')); } catch { /* new record */ }
      const t = clock.tick();
      const next = { ...cur, lastActivityAt: new Date(t).toISOString(), ...patch };
      atomicWrite(p, JSON.stringify(next));
      setMtime(p, t);
      return p;
    },

    /** App delete: rm tmp, rm record, tombstone with a 13-digit ms. `key` defaults to the bare uuid. */
    del(folder, id, key) {
      const dir = folderPath(folder);
      const p = join(dir, `${id}.json`);
      try { unlinkSync(`${p}.tmp`); } catch { /* none */ }
      try { unlinkSync(p); } catch { /* already gone */ }
      const t = clock.tick();
      const tomb = join(dir, `deleted_${key ?? id.slice('local_'.length)}`);
      writeFileSync(tomb, String(t));
      return t;
    },

    /** Switch accounts: `parkedIds` ([{folder,id}]) keep saving to their old folder. */
    switchAccount(parked) {
      sim.parked = parked;
    },

    /** One round of saves by the parked sessions (they write to the folder they were loaded from). */
    tickParked(patch = {}) {
      for (const { folder, id } of sim.parked) sim.save(folder, id, patch);
    },

    /** Simulates an rclone pull replacing/creating a record with a given (older) mtime. */
    pull(folder, id, obj, mtimeMs) {
      const p = join(folderPath(folder), `${id}.json`);
      const tmp = `${p}.rclone.partial`;
      writeFileSync(tmp, JSON.stringify(obj));
      setMtime(tmp, mtimeMs);
      renameSync(tmp, p);
      return p;
    },

    /** The scheduler: atomic update of one task's run-times in scheduled-tasks.json. */
    runTask(folder, taskId, at = clock.tick()) {
      const f = join(folderPath(folder), 'scheduled-tasks.json');
      const doc = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { scheduledTasks: [] };
      const t = doc.scheduledTasks.find((x) => x.id === taskId);
      if (!t) throw new Error(`no task ${taskId} in ${f}`);
      t.lastRunAt = new Date(at).toISOString();
      t.lastScheduledFor = new Date(at).toISOString();
      mkdirSync(dirname(f), { recursive: true });
      atomicWrite(f, JSON.stringify(doc, null, 2));
      setMtime(f, clock.tick());
      return f;
    },

    /**
     * Subset of the app's missed-slot rule: daily crons ("M H * * *") fire for the latest
     * slot within 7 days after `lastScheduledFor ?? lastRunAt`, never before `missedRunScanFloor`;
     * a one-shot fires when `enabled && !lastRunAt && fireAt <= now`. Returns fired ids or null.
     */
    catchUp(file, now) {
      const doc = JSON.parse(readFileSync(file, 'utf8'));
      const fired = [];
      for (const t of doc.scheduledTasks ?? []) {
        if (!t.enabled) continue;
        if (t.fireAt) {
          if (!t.lastRunAt && Date.parse(t.fireAt) <= now) fired.push(t.id);
          continue;
        }
        const m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(t.cronExpression ?? '');
        if (!m) continue;
        const after = Math.max(
          msOf(t.lastScheduledFor ?? t.lastRunAt ?? t.createdAt ?? 0),
          msOf(t.missedRunScanFloor ?? 0),
          now - 7 * 86400000,
        );
        const d = new Date(now);
        d.setUTCHours(Number(m[2]), Number(m[1]), 0, 0);
        let slot = d.getTime();
        if (slot > now) slot -= 86400000;
        if (slot > after) fired.push(t.id);
      }
      return fired.length ? fired : null;
    },

    /** Set the mocked app state (the seam file) and point the environment at it. */
    setApp(state) {
      writeFileSync(appFile, JSON.stringify(state));
      process.env.SESSION_SYNC_TEST_APP_STATE = appFile;
    },

    stopApp() { sim.setApp({ running: false, signedIn: null, startedAtMs: 0 }); },

    cleanup() { delete process.env.SESSION_SYNC_TEST_APP_STATE; },
  };
  return sim;
}

export { recordName };
