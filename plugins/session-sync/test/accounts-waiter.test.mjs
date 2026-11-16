/**
 * T21 - the waiter (plan 5.12): a single instance, a heartbeat, a pass only after two
 * "app stopped" readings a gap apart, a retry when the app comes back mid-pass, and a
 * clean exit that releases its files. In-process, real fs, injected timing; the app state
 * comes from the SESSION_SYNC_TEST_APP_STATE seam.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runWaiter, ensureWaiter, waiterStatus, claimWaiter } from '../lib/accounts/waiter.mjs';
import { loadState, saveState, emptyState, readJson, resetMutations } from '../lib/accounts/state.mjs';
import { answerPairs, pairKey } from '../lib/accounts/folders.mjs';
import { AppRunningError } from '../lib/accounts/appstate.mjs';
import { fullPass } from '../lib/accounts/pass.mjs';
import { makeRoot, makeClock, addFolder, putRecord, uuid, nlinkOf, recordName } from './fixtures/store.mjs';

afterEach(() => { delete process.env.SESSION_SYNC_TEST_APP_STATE; resetMutations(); });

const A = uuid('a', 1); const B = uuid('b', 1);
const OA = uuid('1', 1); const OB = uuid('2', 2);

function world({ linked = false, answered = true } = {}) {
  const r = makeRoot('waiter');
  const clock = makeClock();
  const fA = addFolder(r.store, A, OA);
  const fB = addFolder(r.store, B, OB);
  for (let i = 1; i <= 2; i++) putRecord(fA.path, i, {}, clock.tick());
  putRecord(fB.path, 3, {}, clock.tick());
  const appFile = join(r.root, 'app.json');
  const setApp = (running) => writeFileSync(appFile, JSON.stringify(running ? { running: true, signedIn: A, startedAtMs: 1 } : { running: false }));
  process.env.SESSION_SYNC_TEST_APP_STATE = appFile;
  setApp(false);
  const state = emptyState(r.store);
  if (answered) answerPairs(state, [pairKey(A, B)], 'yes', 'cli', clock.t);
  saveState(r.ctx, state);
  return { r, ctx: r.ctx, fA, fB, setApp, acc: r.acc };
}

/** A fake clock that moves 100 ms per reading and a counting sleep, so a test controls every step. */
function stepper(onSleep = () => {}) {
  let t = 0; let sleeps = 0;
  return {
    clock: () => (t += 100),
    sleep: async () => { sleeps++; await onSleep(sleeps); },
    get sleeps() { return sleeps; },
  };
}

const claimGone = (w) => !existsSync(join(w.acc, 'waiter.claim')) && !existsSync(join(w.acc, 'waiter.json'));
const common = { watchLockfile: false, gapMs: 150, pollMs: 1, probeEveryMs: 1 };

test('T21 waiter: runs the link only after two stopped readings a gap apart, then exits and releases', async () => {
  const w = world();
  const s = stepper();
  const toasts = [];
  let sleepsAtPass = null;
  const out = await runWaiter(w.ctx, {
    ...common, reason: 'link', clock: s.clock, sleep: s.sleep,
    notify: (title, body) => toasts.push({ title, body }),
    passOpts: () => { sleepsAtPass = s.sleeps; return {}; },
  });
  assert.equal(out.exit, 'done');
  assert.ok(sleepsAtPass >= 1, `the pass did not run on the first reading (slept ${sleepsAtPass}x before it)`);
  assert.equal(loadState(w.ctx).linked, true);
  assert.equal(nlinkOf(join(w.fA.path, recordName(1))), 2);
  const last = readJson(join(w.acc, 'last-pass.json'));
  assert.equal(last.ok, true);
  assert.equal(last.op, 'link');
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].title, /linked/);
  assert.equal(claimGone(w), true, 'claim and waiter.json are released');
});

test('T21 waiter: a flapping app (stopped, running, stopped, stopped) resets the count', async () => {
  const w = world();
  // reading 1 stopped; during sleep 1 the app starts; reading 2 running; sleep 2 it stops; readings 3 and 4 stopped
  const s = stepper((n) => { if (n === 1) w.setApp(true); if (n === 2) w.setApp(false); });
  let sleepsAtPass = null;
  const out = await runWaiter(w.ctx, {
    ...common, reason: 'link', clock: s.clock, sleep: s.sleep, notify: () => {},
    passOpts: () => { sleepsAtPass = s.sleeps; return {}; },
  });
  assert.equal(out.exit, 'done');
  assert.equal(sleepsAtPass, 3, 'the pass ran at the fourth reading, not the second');
});

test('T21 waiter: the app returning mid-pass aborts it; the waiter retries and finishes', async () => {
  const w = world();
  const s = stepper();
  let calls = 0;
  const out = await runWaiter(w.ctx, {
    ...common, reason: 'link', clock: s.clock, sleep: s.sleep, notify: () => {},
    passOpts: () => ({ guard: () => { calls++; if (calls === 1) throw new AppRunningError(); } }),
  });
  assert.ok(calls >= 2, 'the guard tripped once, then the retry ran');
  assert.equal(out.exit, 'done');
  assert.equal(loadState(w.ctx).linked, true);
  assert.equal(loadState(w.ctx).fullPassOwed, false);
});

test('T21 waiter: single instance - a second waiter exits at once while the first holds the claim', async () => {
  const w = world();
  let release;
  const gate = new Promise((res) => { release = res; });
  w.setApp(true);
  const s1 = stepper(async (n) => { if (n === 2) await gate; });
  const first = runWaiter(w.ctx, { ...common, reason: 'link', clock: s1.clock, sleep: s1.sleep, notify: () => {} });
  while (s1.sleeps < 2) await new Promise((r) => setTimeout(r, 5));
  const st = waiterStatus(w.ctx);
  assert.equal(st.alive, true);
  assert.equal(st.pid, process.pid);
  assert.ok(st.heartbeatAt);
  assert.deepEqual(st.reasons, ['link']);
  const second = await runWaiter(w.ctx, { ...common, reason: 'owed', clock: () => 0, sleep: async () => {}, notify: () => {} });
  assert.equal(second.exit, 'already-running');
  assert.equal(claimWaiter(w.ctx), false);
  assert.equal(existsSync(join(w.acc, 'waiter.claim')), true, 'the loser did not release the winner\'s claim');
  w.setApp(false);
  release();
  assert.equal((await first).exit, 'done');
  assert.equal(claimGone(w), true);
});

test('T21 ensureWaiter: joins a live waiter (adds the reason), spawns when none, never throws', async () => {
  const w = world();
  let spawned = 0;
  const spawnFn = () => { spawned++; return 4242; };
  const none = ensureWaiter(w.ctx, 'link', spawnFn);
  assert.deepEqual(none, { action: 'spawned', pid: 4242 });
  assert.equal(spawned, 1);

  w.setApp(true);
  let release; const gate = new Promise((res) => { release = res; });
  const s = stepper(async (n) => { if (n === 2) await gate; });
  const run = runWaiter(w.ctx, { ...common, reason: 'link', clock: s.clock, sleep: s.sleep, notify: () => {} });
  while (s.sleeps < 2) await new Promise((r) => setTimeout(r, 5));
  const joined = ensureWaiter(w.ctx, 'owed', spawnFn);
  assert.equal(joined.action, 'joined');
  assert.equal(spawned, 1, 'no second process');
  assert.deepEqual(readJson(join(w.acc, 'waiter.json')).reasons.sort(), ['link', 'owed']);

  const boom = ensureWaiter({ ...w.ctx, acc: join(w.acc, 'elsewhere') }, 'x', () => { throw new Error('no spawn'); });
  assert.equal(boom.action, 'failed');
  w.setApp(false);
  release();
  await run;
});

test('T21 waiter: nothing owed exits at once; an owed full pass runs; the lifetime cap expires', async () => {
  const w = world();
  assert.equal((await fullPass(w.ctx, { reasons: ['link'] })).ok, true);
  const idle = await runWaiter(w.ctx, { ...common, reason: 'owed', clock: () => 0, sleep: async () => {}, notify: () => {} });
  assert.equal(idle.exit, 'nothing-owed');
  assert.equal(claimGone(w), true);

  const st = loadState(w.ctx); st.fullPassOwed = true; saveState(w.ctx, st);
  const s = stepper();
  const owed = await runWaiter(w.ctx, { ...common, reason: 'owed', clock: s.clock, sleep: s.sleep, notify: () => {} });
  assert.equal(owed.exit, 'done');
  assert.equal(loadState(w.ctx).fullPassOwed, false);
  assert.equal(readJson(join(w.acc, 'last-pass.json')).op, 'full');

  w.setApp(true);
  const st2 = loadState(w.ctx); st2.fullPassOwed = true; saveState(w.ctx, st2);
  const s2 = stepper();
  const expired = await runWaiter(w.ctx, { ...common, reason: 'owed', maxLifetimeMs: 1000, clock: s2.clock, sleep: s2.sleep, notify: () => {} });
  assert.equal(expired.exit, 'expired');
  assert.equal(claimGone(w), true);
});

test('T21 waiter: an unlink reason unlinks, and the toast says so', async () => {
  const w = world();
  assert.equal((await fullPass(w.ctx, { reasons: ['link'] })).ok, true);
  const toasts = [];
  const s = stepper();
  const out = await runWaiter(w.ctx, { ...common, reason: 'unlink', clock: s.clock, sleep: s.sleep, notify: (t) => toasts.push(t) });
  assert.equal(out.exit, 'done');
  assert.equal(loadState(w.ctx).linked, false);
  assert.match(toasts[0], /unlinked/);
});

test('T21 waiter: a stale claim from a dead pid is taken over', async () => {
  const w = world();
  writeFileSync(join(w.acc, 'waiter.claim'), JSON.stringify({ pid: 2 ** 22 + 12345, at: 1 }));
  const s = stepper();
  const out = await runWaiter(w.ctx, { ...common, reason: 'link', clock: s.clock, sleep: s.sleep, notify: () => {} });
  assert.equal(out.exit, 'done');
});
