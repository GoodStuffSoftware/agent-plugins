/**
 * T18, T19, T24 - the account link meeting push and pull. The real cli.mjs runs as a
 * child process against a synthetic store and a local-folder rclone remote (no
 * network, no live data). Skipped when rclone is not installed.
 *
 *   T18  push uploads each record once, from its home folder; no mirrored names, no temp names
 *   T19  pull replaces a home file with a newer remote copy, the pass re-links, newest everywhere
 *   T24  the remote duplicate check reports an id held under two folders and deletes nothing
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { findRclone } from '../lib/rclone.mjs';
import { readJson } from '../lib/accounts/state.mjs';
import { recordName, recordId, nlinkOf, setMtime } from './fixtures/store.mjs';
import { cworld, cleanupWorlds, waitFor, A, B, OA, OB } from './fixtures/cliworld.mjs';

const skip = findRclone() ? false : 'rclone is not installed on this machine';
test.after(() => cleanupWorlds());

const remoteStore = (w) => join(w.remote, 'claude-code-sessions');
const remoteNames = (w, acct, org) => {
  try { return readdirSync(join(remoteStore(w), acct, org)).filter((n) => /^local_/.test(n)).sort(); } catch { return []; }
};

/** A linked two-account world: records 1-2 homed in A, 3-4 in B. */
function linkedWorld() {
  const w = cworld();
  const r = w.run(['accounts', 'answer', 'yes']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(w.state().linked, true);
  return w;
}

test('T18 push: each record once, from its home folder; mirrored and temp names never upload', { skip }, () => {
  const w = linkedWorld();
  // a leftover temp name of ours and a stray non-record file next to the records
  writeFileSync(join(w.fA.path, '.session-sync-link-0123456789ab'), 'tmp');
  writeFileSync(join(w.fA.path, 'extra-note.txt'), 'kept');
  const r = w.run(['push', '--strict']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(remoteNames(w, A, OA), [recordName(1), recordName(2)]);
  assert.deepEqual(remoteNames(w, B, OB), [recordName(3), recordName(4)]);
  assert.equal(existsSync(join(remoteStore(w), A, OA, '.session-sync-link-0123456789ab')), false);
  assert.equal(existsSync(join(remoteStore(w), A, OA, 'extra-note.txt')), true, 'non-record files are not filtered');
  const total = [...remoteNames(w, A, OA), ...remoteNames(w, B, OB)];
  assert.equal(new Set(total).size, total.length, 'no record appears twice on the remote');

  // an incremental push after a change uploads only the changed home name
  const p = join(w.fB.path, recordName(3));
  const rec = JSON.parse(readFileSync(p, 'utf8'));
  writeFileSync(p, JSON.stringify({ ...rec, title: 'edited in B' }));       // in place: the mirror in A sees it too
  setMtime(p, 1_800_000_100_000);
  const again = w.run(['push', '--strict']);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(JSON.parse(readFileSync(join(remoteStore(w), B, OB, recordName(3)), 'utf8')).title, 'edited in B');
  assert.deepEqual(remoteNames(w, A, OA), [recordName(1), recordName(2)], 'still not duplicated');
});

test('T18 push: a single-account machine uploads exactly as before (no filter)', { skip }, () => {
  const w = cworld({ accounts: 1 });
  const r = w.run(['push', '--strict']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(remoteNames(w, A, OA), [recordName(1), recordName(2)]);
  assert.equal(existsSync(join(w.acc, 'state.json')), false, 'no account state is created');
});

test('T18 push: two accounts that are not linked upload everything unfiltered', { skip }, () => {
  const w = cworld();
  const r = w.run(['push', '--strict']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(remoteNames(w, A, OA), [recordName(1), recordName(2)]);
  assert.deepEqual(remoteNames(w, B, OB), [recordName(3), recordName(4)]);
});

test('T19 pull: a newer remote copy replaces the home file, the pass re-links, newest wins everywhere', { skip }, () => {
  const w = linkedWorld();
  assert.equal(w.run(['push', '--strict']).status, 0);
  const remoteFile = join(remoteStore(w), A, OA, recordName(1));
  const rec = JSON.parse(readFileSync(remoteFile, 'utf8'));
  writeFileSync(remoteFile, JSON.stringify({ ...rec, title: 'newer from another machine', lastActivityAt: new Date(1_800_000_900_000).toISOString() }));
  utimesSync(remoteFile, 1_800_000_900, 1_800_000_900);
  const r = w.run(['pull', '--strict']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const a = join(w.fA.path, recordName(1));
  const b = join(w.fB.path, recordName(1));
  assert.equal(waitFor(() => existsSync(b) && JSON.parse(readFileSync(b, 'utf8')).title === 'newer from another machine'), true, 'the mirrored name carries the pulled content');
  assert.equal(JSON.parse(readFileSync(a, 'utf8')).title, 'newer from another machine');
  assert.equal(nlinkOf(a), 2, 'the two names are one inode again');
  assert.equal(readJson(join(w.acc, 'pull-active'), null), null, 'pull-active is removed');
});

test('T19 pull: a pull never leaves pull-active behind, even when the pass has nothing to do', { skip }, () => {
  const w = linkedWorld();
  assert.equal(w.run(['push', '--strict']).status, 0);
  assert.equal(w.run(['pull', '--strict']).status, 0);
  assert.equal(existsSync(join(w.acc, 'pull-active')), false);
});

test('T24 remote duplicate check: an id under two folders is reported, never deleted', { skip }, () => {
  const w = linkedWorld();
  assert.equal(w.run(['push', '--strict']).status, 0);
  // the id of record 1 also appears under the other account's folder on the remote
  const src = join(remoteStore(w), A, OA, recordName(1));
  const dupDir = join(remoteStore(w), B, OB);
  writeFileSync(join(dupDir, recordName(1)), readFileSync(src));
  const r = w.run(['accounts', 'status', '--remote', '--json']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.remoteCheck.checked, true);
  assert.equal(j.remoteCheck.duplicates, 1);
  assert.equal(j.remote.duplicates, 1);
  assert.equal(existsSync(src), true);
  assert.equal(existsSync(join(dupDir, recordName(1))), true, 'reported only; nothing is deleted');
  const list = readJson(join(w.acc, 'remote-list.json'));
  assert.deepEqual(list.ids[recordId(1)].sort(), [`${A}/${OA}`, `${B}/${OB}`].sort());
  assert.ok(w.state().lastRemoteCheck);
  const human = w.run(['accounts', 'status', '--remote']);
  assert.match(human.stdout, /Remote duplicates: 1/);
});

test('T24 the daily remote check runs after a push of a linked machine, not on others', { skip }, () => {
  const one = cworld({ accounts: 1 });
  assert.equal(one.run(['push', '--strict']).status, 0);
  assert.equal(existsSync(join(one.acc, 'remote-list.json')), false);
  const w = linkedWorld();
  assert.equal(w.run(['push', '--strict']).status, 0);
  const list = readJson(join(w.acc, 'remote-list.json'), null);
  assert.ok(list, 'a push of a linked machine lists the remote once');
  assert.equal(Object.keys(list.ids).length, 4);
  const first = list.at;
  assert.equal(w.run(['push', '--strict']).status, 0);
  assert.equal(readJson(join(w.acc, 'remote-list.json')).at, first, 'at most daily');
});
