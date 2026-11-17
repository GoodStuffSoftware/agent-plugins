/**
 * T21 - the waiter (plan 5.12): a single instance, a heartbeat, a pass only after two
 * "app stopped" readings a gap apart, a retry when the app comes back mid-pass, and a
 * clean exit that releases its files. In-process, real fs, injected timing; the app state
 * comes from the SESSION_SYNC_TEST_APP_STATE seam.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runWaiter, ensureWaiter, waiterStatus, claimWaiter, replaceOldWaiter } from '../lib/accounts/waiter.mjs';
import { PLUGIN_VERSION, codeHash } from '../lib/accounts/version.mjs';
import { loadState, saveState, emptyState, readJson, resetMutations } from '../lib/accounts/state.mjs';
import { answerPairs, pairKey } from '../lib/accounts/folders.mjs';
import { AppRunningError, appState } from '../lib/accounts/appstate.mjs';
import { fullPass } from '../lib/accounts/pass.mjs';
import { makeRoot, makeClock, addFolder, putRecord, uuid, nlinkOf, recordName } from './fixtures/store.mjs';
import { makeProbeApp } from './fixtures/probe-app.mjs';

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

test('0.5.1 waiter: an owed full pass after the link finishes silently (no toast); the first link still says it is done', async () => {
  const w = world();
  const first = [];
  const s0 = stepper();
  assert.equal((await runWaiter(w.ctx, { ...common, reason: 'link', clock: s0.clock, sleep: s0.sleep, notify: (t) => first.push(t) })).exit, 'done');
  assert.equal(first.length, 1, 'the link itself is announced');
  const st = loadState(w.ctx); st.fullPassOwed = true; saveState(w.ctx, st);
  const toasts = [];
  const s = stepper();
  const out = await runWaiter(w.ctx, { ...common, reason: 'owed', clock: s.clock, sleep: s.sleep, notify: (t) => toasts.push(t) });
  assert.equal(out.exit, 'done');
  assert.equal(readJson(join(w.acc, 'last-pass.json')).op, 'full');
  assert.deepEqual(toasts, [], 'no notice for routine owed work after the link');
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

test('S4 waiter: a claim whose pid was reused by an unrelated live process is taken over; a backed claim is kept', async () => {
  const w = world();
  const now = w.ctx.now();
  const reused = process.ppid;                                  // alive, but not a waiter
  const claim = (at) => writeFileSync(join(w.acc, 'waiter.claim'), JSON.stringify({ pid: reused, at }));
  const beatFile = (pid, hbMs) => writeFileSync(join(w.acc, 'waiter.json'), JSON.stringify({ pid, armedAt: new Date(now).toISOString(), heartbeatAt: new Date(hbMs).toISOString(), reasons: ['link'] }));
  claim(now - 2 * 3600 * 1000);                                 // old claim, no waiter.json
  assert.equal(waiterStatus(w.ctx).alive, false, 'status already says not alive');
  assert.equal(claimWaiter(w.ctx), true, 'no heartbeat for that pid: the claim is stale');
  assert.equal(readJson(join(w.acc, 'waiter.claim'), null).pid, process.pid);
  claim(now - 2 * 3600 * 1000); beatFile(reused + 1, now);      // waiter.json belongs to another pid
  assert.equal(claimWaiter(w.ctx), true);
  claim(now - 2 * 3600 * 1000); beatFile(reused, now - 10 * 60 * 1000);   // heartbeat 10 min old
  assert.equal(claimWaiter(w.ctx), true);
  claim(now - 2 * 3600 * 1000); beatFile(reused, now - 1000);   // a real, beating waiter
  assert.equal(claimWaiter(w.ctx), false, 'old claim backed by a fresh heartbeat of the same pid is kept');
  claim(now - 5000); try { unlinkSync(join(w.acc, 'waiter.json')); } catch { /* none */ }
  assert.equal(claimWaiter(w.ctx), false, 'a fresh claim (start-up window) is kept');
  // and a spawned waiter runs instead of exiting already-running
  claim(now - 2 * 3600 * 1000);
  const s = stepper();
  const out = await runWaiter(w.ctx, { ...common, reason: 'link', clock: s.clock, sleep: s.sleep, notify: () => {} });
  assert.equal(out.exit, 'done');
});

test('T21 waiter: a stale claim from a dead pid is taken over', async () => {
  const w = world();
  writeFileSync(join(w.acc, 'waiter.claim'), JSON.stringify({ pid: 2 ** 22 + 12345, at: 1 }));
  const s = stepper();
  const out = await runWaiter(w.ctx, { ...common, reason: 'link', clock: s.clock, sleep: s.sleep, notify: () => {} });
  assert.equal(out.exit, 'done');
});

/** world() minus the seam: a real lockfile plus an injected PowerShell answer, so the real probe code decides (fixtures/probe-app.mjs). */
function probeWorld() {
  const w = world();
  delete process.env.SESSION_SYNC_TEST_APP_STATE;
  const app = makeProbeApp(w.ctx);
  return { ...w, ctx: app.ctx, app };
}

test('0.5.2 waiter through the real probe: the app quits and no claude process is left (the 0.5.1 bug); the link runs and the stop is logged', async () => {
  const w = probeWorld();
  w.app.start();
  const s = stepper((n) => { if (n === 3) w.app.quit(); });
  const lines = [];
  const out = await runWaiter(w.ctx, { ...common, reason: 'link', clock: s.clock, sleep: s.sleep, notify: () => {}, log: (l) => lines.push(l) });
  assert.equal(out.exit, 'done');
  assert.equal(loadState(w.ctx).linked, true);
  assert.ok(s.sleeps <= 6, `slept ${s.sleeps} times`);
  assert.ok(lines.some((l) => /^waiter: app lock marker gone/.test(l)), lines.join('\n'));
  assert.ok(!lines.some((l) => /WARN|unknown/.test(l)));
});

test('0.5.2 waiter through the real probe: a probe that keeps failing never links, logs a WARN, and a good answer then links', async () => {
  const w = probeWorld();
  w.app.quit();
  w.app.broken = true;
  let t = 0;
  const s = stepper((n) => { if (n === 25) w.app.broken = false; });
  const lines = [];
  const out = await runWaiter(w.ctx, { ...common, reason: 'link', clock: () => (t += 1000), sleep: s.sleep, notify: () => {}, log: (l) => lines.push(l) });
  assert.equal(out.exit, 'done');
  assert.ok(s.sleeps >= 25, 'no pass while the probe could not say');
  assert.ok(lines.some((l) => /WARN: the process probe has been unknown/.test(l) && /boom/.test(l)), lines.join('\n'));
});

test('0.5.2 waiter: the default confirm gap is half a second, and after the lock marker goes it looks again at once, not after 30 s', async () => {
  const w = probeWorld();
  w.app.start();
  const naps = [];
  const sleep = async (ms) => { naps.push(ms); if (naps.length === 1) w.app.quit(); };
  // real defaults for pollMs and gapMs (30 s / 0.5 s); a real clock with a fake sleep that never waits
  let t = 0;
  const out = await runWaiter(w.ctx, { watchLockfile: false, probeEveryMs: 1, reason: 'link', clock: () => (t += 400), sleep, notify: () => {} });
  assert.equal(out.exit, 'done');
  assert.equal(naps[0], 30000, 'app up: the slow poll');
  assert.ok(naps.slice(1).every((n) => n <= 500), `after the marker went: ${naps.join(', ')}`);
});

/* ------------------------------------------------------------------ 0.5.2 review round: S7 an older waiter is replaced, safely */

/** A live, idle, hidden node process whose command line ends in `args`, detached from us like a real waiter. */
function fakeProc(args) {
  const code = `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)',...${JSON.stringify(args)}],{detached:true,stdio:'ignore',windowsHide:true});c.unref();console.log(c.pid)`;
  const pid = Number(String(spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', windowsHide: true }).stdout).trim());
  return { pid, alive: () => { try { process.kill(pid, 0); return true; } catch { return false; } }, kill: () => { try { process.kill(pid); } catch { /* gone */ } } };
}
/** waiter.json + waiter.claim for `pid`, as a waiter of `version` (undefined: an older copy, no version in the claim). */
function putWaiter(w, pid, { version, at = w.ctx.now(), reasons = ['link'] } = {}) {
  const iso = new Date(w.ctx.now()).toISOString();
  writeFileSync(join(w.acc, 'waiter.json'), JSON.stringify({ pid, armedAt: iso, heartbeatAt: iso, reasons }));
  writeFileSync(join(w.acc, 'waiter.claim'), JSON.stringify({ pid, at, ...(version ? { version } : {}) }));
}
const noKill = () => assert.fail('no process may be ended');

test('S7 waiter: a waiter of an older version is ended and its files dropped, so a new one can start', () => {
  const w = world();
  const p = fakeProc(['accounts', 'wait']);
  try {
    putWaiter(w, p.pid, { reasons: ['link', 'owed'] });
    assert.equal(waiterStatus(w.ctx).alive, true);
    const r = replaceOldWaiter(w.ctx);
    assert.deepEqual([r.replaced, r.pid, r.version, r.reasons], [true, p.pid, null, ['link', 'owed']]);
    assert.equal(p.alive(), false, 'the old waiter is gone');
    assert.equal(claimGone(w), true);
    assert.equal(waiterStatus(w.ctx).alive, false);
  } finally { p.kill(); }
});

test('S7 waiter: another version string is replaced too; the current version, no waiter, a pass in progress and an unverifiable pid are left alone', () => {
  const w = world();
  assert.equal(replaceOldWaiter(w.ctx, { kill: noKill }).reason, 'no-waiter');
  putWaiter(w, process.ppid, { version: PLUGIN_VERSION });
  assert.deepEqual(replaceOldWaiter(w.ctx, { kill: noKill }), { replaced: false, reason: 'current', version: PLUGIN_VERSION });
  putWaiter(w, process.ppid, { version: '0.0.1' });
  writeFileSync(join(w.acc, 'accounts.lock'), JSON.stringify({ pid: process.ppid, at: Date.now() }));
  assert.equal(replaceOldWaiter(w.ctx, { kill: noKill, verify: () => ({ ok: true, reason: 'match' }) }).reason, 'busy', 'a waiter holding accounts.lock is mid-pass');
  unlinkSync(join(w.acc, 'accounts.lock'));
  assert.equal(replaceOldWaiter(w.ctx, { kill: noKill, verify: () => ({ ok: false, reason: 'unverified' }) }).reason, 'unverified');
  assert.equal(existsSync(join(w.acc, 'waiter.claim')), true, 'unverified touches nothing');
  const r = replaceOldWaiter(w.ctx, { verify: () => ({ ok: true, reason: 'match' }), kill: () => {}, alive: () => false });
  assert.deepEqual([r.replaced, r.version], [true, '0.0.1']);
});

test('S7 waiter: a pid that is not a waiter (reused) is never ended; its stale files are dropped', () => {
  const w = world();
  const other = fakeProc(['something-else']);
  try {
    putWaiter(w, other.pid);
    const r = replaceOldWaiter(w.ctx, { kill: noKill });
    assert.deepEqual([r.replaced, r.stale], [true, true]);
    assert.equal(other.alive(), true, 'the unrelated process lives on');
    assert.equal(claimGone(w), true);
  } finally { other.kill(); }
  // a process that started after the claim, even with a waiter-like command line
  const late = fakeProc(['accounts', 'wait']);
  try {
    putWaiter(w, late.pid, { at: 1000 });
    const r = replaceOldWaiter(w.ctx, { kill: noKill });
    assert.deepEqual([r.replaced, r.stale], [true, true]);
    assert.equal(late.alive(), true);
  } finally { late.kill(); }
});

test('S7 waiter: the SessionStart path (ensureWaiter) only joins an older waiter: it never ends it and never asks the OS about it', () => {
  const w = world();
  putWaiter(w, process.ppid, { reasons: ['link'] });
  let spawned = 0;
  const out = ensureWaiter(w.ctx, 'owed', () => { spawned++; return 1; });
  assert.deepEqual(out, { action: 'joined', pid: process.ppid });
  assert.equal(spawned, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(w.acc, 'waiter.json'), 'utf8')).reasons, ['link', 'owed']);
});

test('S7 waiter: a waiter that claims its single-instance slot records its plugin version', () => {
  const w = world();
  assert.equal(claimWaiter(w.ctx), true);
  assert.equal(JSON.parse(readFileSync(join(w.acc, 'waiter.claim'), 'utf8')).version, PLUGIN_VERSION);
  assert.ok(PLUGIN_VERSION);
});

/* ---------------------------------------------------------------- 0.5.3 review round: S4 (the user is told) and S5 (a stale watcher is replaced) */

/** A progress UI that records what the waiter asks of it, and the result file the tray helper would read at that moment. */
function recUi(w) {
  const calls = [];
  const peek = () => readJson(join(w.acc, 'waiter-pass-result.json'));
  return {
    calls,
    start(info) { calls.push({ what: 'start', run: info.run, text: info.startText, file: info.resultFile, at: peek() }); },
    end(res) { calls.push({ what: 'end', status: res.status, quiet: !!res.quiet, headline: res.headline, at: peek() }); },
  };
}

/** A stepper whose sleep ends the watcher (removes its claim) at the given sleep, so a watching waiter can be run to a stop. */
function stopAt(w, n, onSleep = () => {}) {
  return stepper((i) => { onSleep(i); if (i >= n) { try { unlinkSync(join(w.acc, 'waiter.claim')); } catch { /* gone */ } } });
}

test('S4 the quit-time full pass is announced: ui.start when it begins, ui.end with the result, and the result file names the run', async () => {
  const w = world();
  const first = await runWaiter(w.ctx, { ...common, reason: 'link', clock: stepper().clock, sleep: stepper().sleep, notify: () => {} });
  assert.equal(first.exit, 'done');
  const st = loadState(w.ctx); st.fullPassOwed = true; saveState(w.ctx, st);
  const ui = recUi(w); const toasts = [];
  const s = stopAt(w, 4);
  const out = await runWaiter(w.ctx, { ...common, gapMs: 50, reason: 'owed', watch: true, clock: s.clock, sleep: s.sleep, notify: (t) => toasts.push(t), ui, logFile: 'waiter.log' });
  assert.equal(out.exit, 'lost-claim', 'the watcher goes on waiting after the pass');
  assert.deepEqual(ui.calls.map((c) => c.what), ['start', 'end']);
  const [start, end] = ui.calls;
  assert.match(start.text, /while Claude is closed/);
  assert.equal(start.at.status, 'running');
  assert.equal(start.at.progress.run, start.run, 'the helper started for this run reads its own run id');
  assert.equal(end.status, 'ok');
  assert.match(end.headline, /in sync/);
  assert.equal(end.at.status, 'ok');
  assert.equal(end.at.progress.run, start.run);
  assert.match(end.at.progress.headline, /in sync/);
  assert.equal(toasts.length, 0, 'the indicator replaces the toast');
  assert.equal(loadState(w.ctx).fullPassOwed, false);
});

test('S4 a link and an unlink are announced through the ui too (no separate toast); without a ui the toast stays and a full pass is silent', async () => {
  const w = world();
  const ui = recUi(w); const toasts = [];
  const s = stepper();
  const out = await runWaiter(w.ctx, { ...common, reason: 'link', clock: s.clock, sleep: s.sleep, notify: (t) => toasts.push(t), ui });
  assert.equal(out.exit, 'done');
  assert.deepEqual(ui.calls.map((c) => [c.what, c.status ?? null]), [['start', null], ['end', 'ok']]);
  assert.match(ui.calls[1].headline, /linked/);
  assert.equal(toasts.length, 0);
  const s2 = stepper(); const quiet = [];
  const un = await runWaiter(w.ctx, { ...common, reason: 'unlink', clock: s2.clock, sleep: s2.sleep, notify: (t) => quiet.push(t) });   // no ui: the old toast
  assert.equal(un.exit, 'done');
  assert.equal(quiet.length, 1);
  assert.match(quiet[0], /unlinked/);
});

test('S4 a pass cut short by the app coming back withdraws the notice quietly and the retry announces itself again', async () => {
  const w = world();
  const ui = recUi(w); let calls = 0;
  const s = stepper();
  const out = await runWaiter(w.ctx, {
    ...common, reason: 'link', clock: s.clock, sleep: s.sleep, notify: () => {}, ui,
    passOpts: () => ({ guard: () => { calls++; if (calls === 1) throw new AppRunningError(); } }),
  });
  assert.equal(out.exit, 'done');
  assert.deepEqual(ui.calls.map((c) => [c.what, c.status ?? null, c.quiet ?? null]), [['start', null, null], ['end', 'retry', true], ['start', null, null], ['end', 'ok', false]]);
  assert.equal(ui.calls[1].at.status, 'waiting');
  assert.equal(ui.calls[1].at.progress.run ?? null, null, 'no run in the result: the Windows helper removes its icon');
  assert.notEqual(ui.calls[0].run, ui.calls[2].run);
});

test('S4 a pass that did nothing because another command holds the lock does not announce itself again at every poll', async () => {
  const w = world();
  writeFileSync(join(w.acc, 'accounts.lock'), JSON.stringify({ pid: process.ppid, at: Date.now() }));
  const ui = recUi(w);
  const s = stepper((n) => { if (n === 5) unlinkSync(join(w.acc, 'accounts.lock')); });
  const out = await runWaiter(w.ctx, { ...common, reason: 'link', clock: s.clock, sleep: s.sleep, notify: () => {}, ui });
  assert.equal(out.exit, 'done');
  assert.deepEqual(ui.calls.map((c) => [c.what, c.status ?? null]), [['start', null], ['end', 'retry'], ['start', null], ['end', 'ok']],
    'one notice for the first try, then silence until the pass really runs; the user is told when it does');
});

test('S4 a closed, settled watcher does not start the process probe at every poll', async () => {
  const w = world();
  const first = await runWaiter(w.ctx, { ...common, reason: 'link', clock: stepper().clock, sleep: stepper().sleep, notify: () => {} });
  assert.equal(first.exit, 'done');
  let probes = 0; let reads = 0;
  const status = (ctx, { probeProcesses }) => { reads++; if (probeProcesses) probes++; return appState({ ctx, probeProcesses, now: ctx.now() }); };
  const s = stopAt(w, 40);
  const out = await runWaiter(w.ctx, { ...common, gapMs: 50, pollMs: 1000, probeEveryMs: 60 * 1000, reason: 'watch', watch: true, clock: s.clock, sleep: s.sleep, notify: () => {}, status });
  assert.equal(out.exit, 'lost-claim');
  assert.ok(reads >= 30, `the loop ran ${reads} readings`);
  assert.ok(probes <= 4, `the probe ran ${probes} times in ${reads} readings while Claude was closed and nothing was owed`);
});

test('S4 a settled watcher still acts at once when work is asked (a joined unlink), across an app run in between', async () => {
  const w = world();
  const first = await runWaiter(w.ctx, { ...common, reason: 'link', clock: stepper().clock, sleep: stepper().sleep, notify: () => {} });
  assert.equal(first.exit, 'done');
  const s = stopAt(w, 40, (n) => {
    if (n === 15) w.setApp(true);
    if (n === 18) w.setApp(false);
    if (n === 24) { const j = readJson(join(w.acc, 'waiter.json')); writeFileSync(join(w.acc, 'waiter.json'), JSON.stringify({ ...j, reasons: [...j.reasons, 'unlink'] })); }
  });
  const out = await runWaiter(w.ctx, { ...common, gapMs: 50, pollMs: 1000, probeEveryMs: 3600 * 1000, reason: 'watch', watch: true, clock: s.clock, sleep: s.sleep, notify: () => {} });
  assert.equal(out.exit, 'done', 'an unlink ends the watcher once it has run');
  assert.equal(loadState(w.ctx).linked, false, 'the unlink that was asked while settled ran at once, not after the next probe window');
});

test('S5 a waiter claim records the code hash next to the version', () => {
  const w = world();
  assert.equal(claimWaiter(w.ctx), true);
  const c = JSON.parse(readFileSync(join(w.acc, 'waiter.claim'), 'utf8'));
  assert.match(c.hash, /^[0-9a-f]{16}$/);
  assert.equal(c.hash, codeHash());
});

test('S5 codeHash: stable for the same code, different when a source file changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ss-hash-'));
  try {
    mkdirSync(join(dir, 'accounts'));
    writeFileSync(join(dir, 'a.mjs'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'accounts', 'b.mjs'), 'export const b = 2;\n');
    writeFileSync(join(dir, 'notes.txt'), 'not code');
    const h1 = codeHash(dir);
    assert.equal(codeHash(dir), h1);
    writeFileSync(join(dir, 'notes.txt'), 'still not code');
    assert.equal(codeHash(dir), h1, 'a non-source file does not count');
    writeFileSync(join(dir, 'accounts', 'b.mjs'), 'export const b = 3;\n');
    assert.notEqual(codeHash(dir), h1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('S5 a waiter of the same version but other code is replaced; the same code, and a claim with no hash, are left alone', () => {
  const w = world();
  const p = fakeProc(['accounts', 'wait']);
  try {
    const claim = (hash) => writeFileSync(join(w.acc, 'waiter.claim'), JSON.stringify({ pid: p.pid, at: w.ctx.now(), version: PLUGIN_VERSION, ...(hash ? { hash } : {}) }));
    putWaiter(w, p.pid, { version: PLUGIN_VERSION });
    claim(codeHash());
    assert.deepEqual(replaceOldWaiter(w.ctx, { kill: noKill }), { replaced: false, reason: 'current', version: PLUGIN_VERSION }, 'same code');
    claim(null);
    assert.equal(replaceOldWaiter(w.ctx, { kill: noKill }).reason, 'current', 'a claim with a version and no hash cannot be told apart: left alone');
    claim('0123456789abcdef');
    const r = replaceOldWaiter(w.ctx);
    assert.deepEqual([r.replaced, r.pid, r.version, r.hash], [true, p.pid, PLUGIN_VERSION, '0123456789abcdef']);
    assert.equal(p.alive(), false, 'the stale watcher is ended');
    assert.equal(claimGone(w), true, 'the singleton is free for the new one');
  } finally { p.kill(); }
});

test('S5 a stale watcher is never ended while it is mid-pass, and a pid that is not a waiter is left alone', () => {
  const w = world();
  putWaiter(w, process.ppid, { version: PLUGIN_VERSION });
  writeFileSync(join(w.acc, 'waiter.claim'), JSON.stringify({ pid: process.ppid, at: w.ctx.now(), version: PLUGIN_VERSION, hash: 'ffffffffffffffff' }));
  writeFileSync(join(w.acc, 'accounts.lock'), JSON.stringify({ pid: process.ppid, at: Date.now() }));
  assert.equal(replaceOldWaiter(w.ctx, { kill: noKill }).reason, 'busy');
  unlinkSync(join(w.acc, 'accounts.lock'));
  const other = fakeProc(['something-else']);
  try {
    putWaiter(w, other.pid, { version: PLUGIN_VERSION });
    writeFileSync(join(w.acc, 'waiter.claim'), JSON.stringify({ pid: other.pid, at: w.ctx.now(), version: PLUGIN_VERSION, hash: 'ffffffffffffffff' }));
    const r = replaceOldWaiter(w.ctx, { kill: noKill });
    assert.deepEqual([r.replaced, r.stale], [true, true]);
    assert.equal(other.alive(), true);
  } finally { other.kill(); }
});
