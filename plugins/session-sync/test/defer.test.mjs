/**
 * Unit tests for the coalescing deferral (lib/defer.mjs) — the mechanism that
 * makes a suppressed push DEFERRED rather than DROPPED.
 *
 * The invariant these exist to protect: THE LAST PUSH REQUESTED FOR A
 * CONVERSATION MUST NEVER BE THE ONE THAT GETS DISCARDED. A dropped final push
 * means that conversation's state never reaches the remote, and on a machine
 * that is then closed or reimaged it is gone for good. Throttling is worth
 * having; it is not worth a conversation.
 *
 * No rclone, no child processes, no clock-watching: spawnWorker, the liveness
 * check and `now` are all injected, so every ordering below is exercised
 * deterministically rather than raced for.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDeferred, requestDeferred, refreshDeferred, settleDeferred } from '../lib/defer.mjs';

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'ss-defer-'));
  return { dir, file: join(dir, 'deferred-push.json'), clean: () => rmSync(dir, { recursive: true, force: true }) };
}

const alive = () => true;
const dead = () => false;

test('the first request schedules exactly one worker and records that a push is owed', () => {
  const { file, clean } = scratch();
  try {
    let spawns = 0;
    const r = requestDeferred(file, { runAt: 5_000, spawnWorker: () => { spawns++; return 4242; }, isAlive: alive, now: 1_000 });
    assert.equal(r.action, 'scheduled');
    assert.equal(spawns, 1);
    const rec = readDeferred(file);
    assert.equal(rec.requestedAt, 1_000);
    assert.equal(rec.runAt, 5_000);
    assert.equal(rec.pid, 4242);
  } finally { clean(); }
});

test('rapid repeat requests COALESCE onto the one live worker — N requests, one push', () => {
  const { file, clean } = scratch();
  try {
    let spawns = 0;
    const spawnWorker = () => { spawns++; return 4242; };
    const first = requestDeferred(file, { runAt: 5_000, spawnWorker, isAlive: alive, now: 1_000 });
    const second = requestDeferred(file, { runAt: 9_000, spawnWorker, isAlive: alive, now: 2_000 });
    const third = requestDeferred(file, { runAt: 9_500, spawnWorker, isAlive: alive, now: 2_500 });

    assert.equal(first.action, 'scheduled');
    assert.equal(second.action, 'coalesced');
    assert.equal(third.action, 'coalesced');
    assert.equal(spawns, 1, 'three conversations ending together must cost ONE background push, not three');

    const rec = readDeferred(file);
    assert.equal(rec.runAt, 5_000, 'coalescing must not push the run further out — that would let requests starve the worker forever');
    assert.equal(rec.requestedAt, 2_500, 'the record must always name the LATEST request, so settling can tell whether it was covered');
  } finally { clean(); }
});

test('a coalesced request is still owed: nothing is discarded on the way in', () => {
  const { file, clean } = scratch();
  try {
    const spawnWorker = () => 4242;
    requestDeferred(file, { runAt: 5_000, spawnWorker, isAlive: alive, now: 1_000 });
    requestDeferred(file, { runAt: 9_000, spawnWorker, isAlive: alive, now: 2_000 });
    assert.ok(readDeferred(file), 'the "a push is owed" record must survive coalescing — its absence is the only thing that means "nothing owed"');
  } finally { clean(); }
});

test('a request whose worker DIED gets a fresh worker — a killed machine never loses the push', () => {
  const { file, clean } = scratch();
  try {
    let spawns = 0;
    const spawnWorker = () => { spawns++; return 100 + spawns; };
    requestDeferred(file, { runAt: 5_000, spawnWorker, isAlive: alive, now: 1_000 });
    const again = requestDeferred(file, { runAt: 8_000, spawnWorker, isAlive: dead, now: 2_000 });
    assert.equal(again.action, 'scheduled', 'a dead worker means nobody is going to run this — schedule another');
    assert.equal(spawns, 2);
    assert.equal(readDeferred(file).pid, 102);
  } finally { clean(); }
});

test('a request whose runAt already passed with no worker left gets rescheduled, not abandoned', () => {
  const { file, clean } = scratch();
  try {
    let spawns = 0;
    const spawnWorker = () => { spawns++; return 4242; };
    requestDeferred(file, { runAt: 5_000, spawnWorker, isAlive: alive, now: 1_000 });
    const late = requestDeferred(file, { runAt: 12_000, spawnWorker, isAlive: alive, now: 10_000 });
    assert.equal(late.action, 'scheduled', 'a runAt in the past means the worker is gone or wedged — do not trust it to still fire');
    assert.equal(spawns, 2);
  } finally { clean(); }
});

test('settling clears the record when the push STARTED after the newest request', () => {
  const { file, clean } = scratch();
  try {
    requestDeferred(file, { runAt: 5_000, spawnWorker: () => 1, isAlive: alive, now: 1_000 });
    assert.equal(settleDeferred(file, 6_000), true, 'a push begun at t=6000 covers a request made at t=1000');
    assert.equal(existsSync(file), false, 'nothing is owed any more, so the record must be gone');
  } finally { clean(); }
});

test('THE KEY INVARIANT: a request arriving MID-PUSH is not swallowed by that push', () => {
  const { file, clean } = scratch();
  try {
    // Worker claims the work at t=1000 and starts scanning the tree.
    requestDeferred(file, { runAt: 1_000, spawnWorker: () => 1, isAlive: alive, now: 900 });
    const claimedAt = 1_000;

    // The conversation's FINAL SessionEnd lands at t=1500, while that push is
    // still running. Its changes may be behind the scan already.
    requestDeferred(file, { runAt: 9_000, spawnWorker: () => 1, isAlive: alive, now: 1_500 });

    assert.equal(settleDeferred(file, claimedAt), false,
      'the in-flight push cannot be assumed to cover a request made after it started — settling here would discard the LAST push of the conversation');
    assert.ok(readDeferred(file), 'the record must survive so the worker runs again for it');

    // Second run, started after that request, does cover it.
    assert.equal(settleDeferred(file, 2_000), true);
    assert.equal(existsSync(file), false);
  } finally { clean(); }
});

test('refreshing (waiting on the lock / backing off) preserves requestedAt', () => {
  const { file, clean } = scratch();
  try {
    requestDeferred(file, { runAt: 5_000, spawnWorker: () => 1, isAlive: alive, now: 1_000 });
    refreshDeferred(file, { runAt: 30_000, pid: 777 });
    const rec = readDeferred(file);
    assert.equal(rec.requestedAt, 1_000, 'a retry must not rewrite when the work was asked for — that is what settling compares against');
    assert.equal(rec.runAt, 30_000);
    assert.equal(rec.pid, 777);
  } finally { clean(); }
});

test('nothing owed, and a corrupt record, both read as "nothing owed" rather than throwing', () => {
  const { file, clean } = scratch();
  try {
    assert.equal(readDeferred(file), null);
    assert.equal(settleDeferred(file, Date.now()), true, 'settling when nothing is owed is a no-op, not an error');
    writeFileSync(file, 'not json at all');
    assert.equal(readDeferred(file), null);
    assert.equal(refreshDeferred(file, { runAt: 1, pid: 2 }), false);
  } finally { clean(); }
});
