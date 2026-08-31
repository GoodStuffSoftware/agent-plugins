/**
 * Tests for the sync lock.
 *
 * These exist because Claude's SessionStart/SessionEnd hooks fire PER
 * CONVERSATION. Several conversations ending together means several concurrent
 * syncs at one remote, and Google Drive happily accepts two files with the same
 * name — we found three such duplicates before this lock existed.
 *
 * The first version of this lock had a bug these tests now catch: pidAlive()
 * special-cased our own pid as NOT alive, so a live lock looked dead and a
 * second acquire sailed straight through.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock } from '../lib/lock.mjs';

const lockPath = () => join(mkdtempSync(join(tmpdir(), 'ss-lock-')), 'sync.lock');

test('a second acquire is refused while the first is held', () => {
  const f = lockPath();
  const a = acquireLock(f);
  assert.ok(a.acquired, 'first acquire should succeed');
  const b = acquireLock(f);
  assert.equal(b.acquired, false, 'a concurrent sync must NOT get the lock');
  assert.match(b.reason, /another sync is running/);
  a.release();
  rmSync(f, { force: true });
});

test('releasing lets the next one in', () => {
  const f = lockPath();
  const a = acquireLock(f); a.release();
  const b = acquireLock(f);
  assert.ok(b.acquired, 'lock must be reusable after release');
  b.release();
});

test('release removes the lock file', () => {
  const f = lockPath();
  const a = acquireLock(f);
  assert.ok(existsSync(f));
  a.release();
  assert.equal(existsSync(f), false);
});

test('a lock owned by a dead process is taken over, not honoured forever', () => {
  const f = lockPath();
  writeFileSync(f, JSON.stringify({ pid: 999999, at: Date.now() }));
  const a = acquireLock(f);
  assert.ok(a.acquired, 'a crashed sync must never wedge syncing permanently');
  a.release();
});

test('a lock older than the TTL is taken over even if the pid is alive', () => {
  const f = lockPath();
  writeFileSync(f, JSON.stringify({ pid: process.pid, at: Date.now() - 40 * 60 * 1000 }));
  const a = acquireLock(f);
  assert.ok(a.acquired, 'an expired lock must not block forever');
  a.release();
});

test('a fresh lock from a live pid is honoured', () => {
  const f = lockPath();
  writeFileSync(f, JSON.stringify({ pid: process.pid, at: Date.now() }));
  const a = acquireLock(f);
  assert.equal(a.acquired, false, 'a live, fresh lock must block');
});

test('a corrupt lock file does not wedge syncing', () => {
  const f = lockPath();
  writeFileSync(f, 'not json');
  const a = acquireLock(f);
  assert.ok(a.acquired, 'unreadable lock must be treated as absent');
  a.release();
});

test('release never steals a lock owned by someone else', () => {
  const f = lockPath();
  const a = acquireLock(f);
  writeFileSync(f, JSON.stringify({ pid: 999999, at: Date.now() }));  // someone else took over
  a.release();
  assert.ok(existsSync(f), 'must not delete a lock we no longer own');
  rmSync(f, { force: true });
});
