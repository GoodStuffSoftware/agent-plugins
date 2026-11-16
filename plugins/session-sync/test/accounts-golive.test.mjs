/**
 * go-live (leg A): the preflight, consent, the detached runner's state machine, resume, and the
 * launcher and desktop layers it stands on. In-process, real fs on synthetic fixtures; the app
 * state comes from the SESSION_SYNC_TEST_APP_STATE seam, and the process, launch and relaunch
 * layers are injected, so no real app is ever started or touched.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  planGoLive, beginGoLive, runGoLive, resumeIfDead, goLiveInProgress, runnerAlive, readGoLive, readGoLiveResult,
  goLiveFile, goLiveResultFile, goLiveLogFile, verifyLinked, expectedSet, readListing,
} from '../lib/accounts/golive.mjs';
import { loadState, saveState, emptyState, readJson, resetMutations, accPath, rollbackMarkerFile } from '../lib/accounts/state.mjs';
import { answerPairs, pairKey, listFolders } from '../lib/accounts/folders.mjs';
import { copyCapability, desktopCopies, relaunchApp, resolveAumid } from '../lib/accounts/desktop.mjs';
import { launchDetached, forwardedEnv, CLI_PATH } from '../lib/accounts/launcher.mjs';
import { collectStatus, formatStatus, formatGoLive } from '../lib/accounts/report.mjs';
import { requestAppQuit } from '../lib/accounts/appquit.mjs';
import { makeRoot, makeClock, addFolder, putRecord, putTombstone, uuid, treeHashes, recordName } from './fixtures/store.mjs';

afterEach(() => {
  delete process.env.SESSION_SYNC_TEST_APP_STATE;
  delete process.env.SESSION_SYNC_TEST_FAIL_AFTER;
  resetMutations();
});

const A = uuid('a', 1); const B = uuid('b', 1);
const OA = uuid('1', 1); const OB = uuid('2', 2);

/** Write the files that make a desktop copy of session-sync capable (or leave the push filter out). */
function makeCopy(userData, name, { capable = true } = {}) {
  const root = join(userData, 'rpm', 'acct-1', 'org-1', `plugin_${name}`);
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  mkdirSync(join(root, 'lib', 'accounts'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'session-sync', version: '0.3.0' }));
  const full = () => {
    for (const f of ['pass', 'waiter', 'folders']) writeFileSync(join(root, 'lib', 'accounts', `${f}.mjs`), '// x');
    writeFileSync(join(root, 'lib', 'sync.mjs'), 'export function accountsPushFilter() {}');
  };
  if (capable) full();
  else writeFileSync(join(root, 'lib', 'sync.mjs'), 'export function push() {}');
  return { root, makeCapable: full };
}

function world({ copies = [], answered = false, extraB = true } = {}) {
  const r = makeRoot('golive');
  const clock = makeClock();
  const fA = addFolder(r.store, A, OA);
  const fB = addFolder(r.store, B, OB);
  for (let i = 1; i <= 2; i++) putRecord(fA.path, i, {}, clock.tick());
  if (extraB) putRecord(fB.path, 3, {}, clock.tick());
  const appFile = join(r.root, 'app.json');
  const setApp = (running) => writeFileSync(appFile, JSON.stringify(running ? { running: true, signedIn: A, startedAtMs: 1 } : { running: false }));
  process.env.SESSION_SYNC_TEST_APP_STATE = appFile;
  setApp(false);
  const state = emptyState(r.store);
  if (answered) answerPairs(state, [pairKey(A, B)], 'yes', 'cli', clock.t);
  saveState(r.ctx, state);
  const made = copies.map((c, i) => makeCopy(r.userData, `c${i}`, c));
  return { r, ctx: r.ctx, fA, fB, setApp, acc: r.acc, made, appFile };
}

/** A virtual clock that moves 100 ms per reading, and a sleep that runs a hook. */
function stepper(onSleep = () => {}) {
  let t = 0; let sleeps = 0;
  return { clock: () => (t += 100), sleep: async () => { sleeps++; await onSleep(sleeps); }, get sleeps() { return sleeps; } };
}

/** Standard injected deps: a seam-driven app, recorded side effects, tunable results. */
function deps(w, over = {}) {
  const calls = { relaunch: 0, rectify: 0, remote: 0, push: [], link: 0, phases: [] };
  const s = stepper(over.onSleep);
  const d = {
    pollMs: 1, gapMs: 150, probeEveryMs: 1, clock: s.clock, sleep: s.sleep,
    appStatus: () => { const o = readJson(w.appFile, {}); return { fullAllowed: !o.running, running: !!o.running }; },
    relaunch: async () => { calls.relaunch++; w.setApp(true); return { ok: true, method: 'test' }; },
    rectify: async () => { calls.rectify++; return { ok: true }; },
    remoteCheck: async () => { calls.remote++; return { checked: true, ids: 3, duplicates: 0 }; },
    getPush: () => true,
    setPush: (on) => calls.push.push(on),
    onPhase: (p) => { calls.phases.push(p); over.onPhase?.(p); },
    ...over,
  };
  delete d.onSleep;
  d.onPhase = (p) => { calls.phases.push(p); return over.onPhase?.(p); };
  return { d, calls, s };
}

function start(w, d, opts = {}) {
  const plan = planGoLive(w.ctx, d);
  assert.equal(plan.ok, true, plan.text);
  return beginGoLive(w.ctx, plan, opts, d);
}

const res = (w) => readGoLiveResult(w.ctx);

/* ------------------------------------------------------------------ preflight */

test('plan: refuses one account, an already linked store, a rollback marker, an empty store', () => {
  const one = world({ extraB: false });
  rmSync(one.fB.path, { recursive: true, force: true });
  assert.equal(planGoLive(one.ctx).reason, 'one-account');

  const linked = world();
  const st = loadState(linked.ctx); st.linked = true; saveState(linked.ctx, st);
  assert.equal(planGoLive(linked.ctx).reason, 'already-linked');

  const rb = world();
  writeFileSync(rollbackMarkerFile(rb.ctx), '{}');
  assert.equal(planGoLive(rb.ctx).reason, 'rollback-active');

  const empty = world();
  for (const f of [empty.fA, empty.fB]) for (const n of [1, 2, 3]) { try { unlinkSync(join(f.path, recordName(n))); } catch { /* none */ } }
  assert.equal(planGoLive(empty.ctx).reason, 'empty');
});

test('plan: summary numbers, and desktop copies judged by capability, not version', () => {
  const w = world({ copies: [{ capable: true }, { capable: false }] });
  const plan = planGoLive(w.ctx);
  assert.equal(plan.ok, true);
  assert.equal(plan.accounts, 2);
  assert.equal(plan.folders, 2);
  assert.equal(plan.conversations, 3);
  assert.equal(plan.expected, 3);
  assert.equal(plan.copies.length, 2);
  assert.equal(plan.stale.length, 1);
  assert.equal(plan.copies.every((c) => c.version === '0.3.0'), true, 'both carry the same old version label');
  assert.equal(plan.copies.filter((c) => c.capable).length, 1);
});

test('begin: records consent like `answer yes`, saves before-state and the expected set, writes a waiting result', () => {
  const w = world();
  const { d, calls } = deps(w);
  const gl = start(w, d);
  const st = loadState(w.ctx);
  assert.equal(st.pairs[pairKey(A, B)].answer, 'yes');
  assert.equal(gl.expected.length, 3);
  assert.equal(gl.before.folders.length, 2);
  assert.equal(readGoLive(w.ctx).phase, 'wait-stop');
  assert.equal(res(w).status, 'waiting');
  assert.deepEqual(calls.push, [], 'a capable store leaves push alone');
  assert.equal(goLiveInProgress(w.ctx)?.result.status, 'waiting');
});

test('begin: an expected set excludes ids that carry a tombstone', () => {
  const w = world();
  putTombstone(w.fA.path, uuid('c', 3), 1_700_000_000_000);
  const e = expectedSet(readListing(w.ctx));
  assert.equal(e.union, 3);
  assert.equal(e.expected.length, 2);
  assert.equal(e.undetermined, 1);
});

/* ------------------------------------------------------------------ the runner */

test('runner: the whole path ok - waits for stop, links, verifies, relaunches, waits, rectifies, checks the remote', async () => {
  const w = world({ copies: [{ capable: true }] });
  w.setApp(true);
  const { d, calls } = deps(w, { onSleep: (n) => { if (n === 2) w.setApp(false); } });
  // the relaunch flips the seam to running; wait-start sees it
  start(w, d);
  const out = await runGoLive(w.ctx, d);
  assert.deepEqual(out, { exit: 'done', status: 'ok' });
  assert.deepEqual(calls.phases, ['wait-stop', 'relist', 'link', 'verify', 'relaunch', 'wait-start', 'wait-capability', 'rectify', 'remote', 'finish']);
  const r = res(w);
  assert.equal(r.status, 'ok');
  assert.equal(r.finishedAt !== null, true);
  assert.equal(r.counts.split, 0);
  assert.equal(r.counts.missing, 0);
  assert.equal(r.counts.ids, 3);
  assert.equal(r.counts.remoteDuplicates, 0);
  assert.ok(r.backupId);
  assert.ok(existsSync(r.rollbackScript), 'the standalone rollback script is named in the result');
  assert.equal(r.resumable, false);
  assert.deepEqual(calls.push, []);
  assert.equal(calls.relaunch, 1);
  assert.equal(calls.rectify, 1);
  assert.equal(calls.remote, 1);
  assert.equal(loadState(w.ctx).linked, true);
  // every folder holds every id
  const v = verifyLinked(w.ctx, readGoLive(w.ctx).expected, 2);
  assert.deepEqual(v.problems, []);
  assert.match(readFileSync(goLiveLogFile(w.ctx), 'utf8'), /result: ok/);
  assert.equal(existsSync(join(w.acc, 'go-live.claim')), false, 'the claim is released');
});

test('runner: waits while the app runs; on timeout stops, leaves consent recorded, and a later run resumes', async () => {
  const w = world();
  w.setApp(true);
  const { d } = deps(w, { timeouts: { stopMs: 2000 } });
  start(w, d);
  const first = await runGoLive(w.ctx, d);
  assert.equal(first.exit, 'done');
  assert.equal(first.status, 'failed');
  assert.equal(res(w).status, 'failed');
  assert.equal(res(w).resumable, true);
  assert.equal(loadState(w.ctx).pairs[pairKey(A, B)].answer, 'yes', 'consent stays recorded');
  assert.equal(loadState(w.ctx).linked, false, 'nothing was changed');
  assert.match(res(w).messages.join('\n'), /Timed out waiting for the app to stop/);
  // the user quits the app; run again
  w.setApp(false);
  const { d: d2 } = deps(w);
  const second = await runGoLive(w.ctx, d2);
  assert.deepEqual(second, { exit: 'done', status: 'ok' });
  assert.equal(loadState(w.ctx).linked, true);
});

test('runner: a link refused because the app came back goes back to waiting, then links', async () => {
  const w = world();
  let flipped = false;
  const { d, calls } = deps(w, {
    onPhase: (p) => { if (p === 'link' && !flipped) { flipped = true; w.setApp(true); } },
    onSleep: () => { if (flipped) w.setApp(false); },
  });
  start(w, d);
  const out = await runGoLive(w.ctx, d);
  assert.equal(out.status, 'ok');
  assert.equal(calls.phases.filter((p) => p === 'link').length, 2, 'link phase ran twice');
  assert.equal(calls.phases.filter((p) => p === 'wait-stop').length, 2);
  assert.match(readFileSync(goLiveLogFile(w.ctx), 'utf8'), /came back during the link/);
  assert.equal(loadState(w.ctx).linked, true);
});

test('runner: a pass holding the accounts lock (the waiter) is waited for while its holder lives', async () => {
  const w = world();
  const lockFile = join(w.acc, 'accounts.lock');
  // the parent of this test process is alive and is not us
  writeFileSync(lockFile, JSON.stringify({ pid: process.ppid, at: Date.now() }));
  let slept = 0;
  const { d } = deps(w, { onSleep: () => { slept++; if (slept >= 3) { try { unlinkSync(lockFile); } catch { /* gone */ } } } });
  start(w, d);
  const out = await runGoLive(w.ctx, d);
  assert.equal(out.status, 'ok');
  assert.match(readFileSync(goLiveLogFile(w.ctx), 'utf8'), /another pass holds the accounts lock/);
  assert.equal(loadState(w.ctx).linked, true);
});

test('runner: the lock wait is bounded - a holder that never lets go ends in failed, resumable', async () => {
  const w = world();
  writeFileSync(join(w.acc, 'accounts.lock'), JSON.stringify({ pid: process.ppid, at: Date.now() }));
  const { d } = deps(w, { timeouts: { lockMs: 2000 } });
  start(w, d);
  const out = await runGoLive(w.ctx, d);
  assert.equal(out.status, 'failed');
  assert.equal(res(w).resumable, true);
  assert.equal(loadState(w.ctx).linked, false);
});

test('runner: a failed verification rolls back byte for byte, result rolled_back, push back on', async () => {
  const w = world({ copies: [{ capable: false }] });
  const before = treeHashes(w.r.store);
  const { d, calls } = deps(w, {
    // damage the store right after the link: a record vanishes from one folder
    afterLink: async () => { unlinkSync(join(w.fB.path, recordName(1))); },
  });
  start(w, d);
  assert.deepEqual(calls.push, [false], 'push was paused at the start (a stale copy)');
  const out = await runGoLive(w.ctx, d);
  assert.deepEqual(out, { exit: 'done', status: 'rolled_back' });
  const r = res(w);
  assert.equal(r.status, 'rolled_back');
  assert.ok(r.backupId);
  assert.match(r.messages.join('\n'), /PROBLEM: the post-link check failed/);
  assert.match(r.messages.join('\n'), /Rollback finished/);
  assert.deepEqual(treeHashes(w.r.store), before, 'the store is byte-identical to its pre-link state');
  assert.equal(loadState(w.ctx).linked, false);
  assert.deepEqual(calls.push, [false, true], 'push is switched back on after the rollback');
  assert.equal(calls.relaunch, 1, 'the app is started again after the rollback');
  assert.equal(calls.remote, 0);
  assert.equal(calls.rectify, 0);
});

test('runner: a rollback that never finishes ends in failed with the standalone script named', async () => {
  const w = world();
  let tries = 0;
  const { d } = deps(w, {
    afterLink: async () => { unlinkSync(join(w.fB.path, recordName(1))); },
    rollback: async () => { tries++; return { ok: false, code: 3 }; },
  });
  start(w, d);
  const out = await runGoLive(w.ctx, d);
  assert.equal(out.status, 'failed');
  assert.equal(tries, 3);
  assert.match(res(w).messages.join('\n'), /rollback\.mjs/);
});

test('runner: a link that throws is rolled back', async () => {
  const w = world();
  const { d } = deps(w, { link: async () => { throw new Error('disk on fire'); } });
  start(w, d);
  // no backup exists yet, so there is nothing to roll back to
  const out = await runGoLive(w.ctx, d);
  assert.equal(out.status, 'failed');
  assert.match(res(w).messages.join('\n'), /disk on fire/);
  assert.match(res(w).messages.join('\n'), /no backup/i);
});

test('runner: remote duplicates pause push and set the result to attention', async () => {
  const w = world();
  const { d, calls } = deps(w, { remoteCheck: async () => ({ checked: true, ids: 3, duplicates: 2 }) });
  start(w, d);
  const out = await runGoLive(w.ctx, d);
  assert.equal(out.status, 'attention');
  assert.deepEqual(calls.push, [false]);
  assert.equal(res(w).counts.remoteDuplicates, 2);
  assert.match(res(w).messages.join('\n'), /2 conversation\(s\) under more than one folder/);
  assert.equal(loadState(w.ctx).linked, true, 'the link itself stays');
});

test('runner: no rclone or remote is a note, not an attention', async () => {
  const w = world();
  const { d } = deps(w, { remoteCheck: async () => ({ checked: false, notConfigured: true, reason: 'rclone or the remote is not configured' }) });
  start(w, d);
  assert.equal((await runGoLive(w.ctx, d)).status, 'ok');
});

test('runner: a stale desktop copy pauses push at the start; it comes back on once the copy can filter', async () => {
  const w = world({ copies: [{ capable: false }] });
  w.setApp(false);
  const { d, calls } = deps(w, { onSleep: () => { w.made[0].makeCapable(); } });
  const gl = start(w, d);
  assert.equal(gl.pausedPush, true);
  assert.deepEqual(calls.push, [false]);
  assert.equal(res(w).push.pausedByGoLive, true);
  const out = await runGoLive(w.ctx, d);
  assert.equal(out.status, 'ok');
  assert.deepEqual(calls.push, [false, true]);
  assert.equal(res(w).push.reEnabled, true);
});

test('runner: a copy that never gets the capability leaves push paused and says so (attention)', async () => {
  const w = world({ copies: [{ capable: false }] });
  const { d, calls } = deps(w, { timeouts: { capabilityMs: 1500 } });
  start(w, d);
  const out = await runGoLive(w.ctx, d);
  assert.equal(out.status, 'attention');
  assert.deepEqual(calls.push, [false], 'never re-enabled');
  assert.equal(res(w).push.reEnabled, false);
  assert.match(res(w).messages.join('\n'), /Push stays PAUSED/);
});

test('runner: push that was already off before go-live stays off and is not touched', async () => {
  const w = world({ copies: [{ capable: false }] });
  const { d, calls } = deps(w, { getPush: () => false, onSleep: () => { w.made[0].makeCapable(); } });
  start(w, d);
  const out = await runGoLive(w.ctx, d);
  assert.equal(out.status, 'ok');
  assert.deepEqual(calls.push, []);
  assert.equal(res(w).push.pausedByGoLive, false);
  assert.match(res(w).messages.join('\n'), /already paused before go-live/);
});

test('runner: --no-relaunch does not start the app and waits for the user to start it', async () => {
  const w = world();
  let slept = 0;
  const { d, calls } = deps(w, { onSleep: () => { slept++; if (slept >= 3) w.setApp(true); } });
  start(w, d, { noRelaunch: true });
  const out = await runGoLive(w.ctx, d);
  assert.equal(out.status, 'ok');
  assert.equal(calls.relaunch, 0);
  assert.match(res(w).messages.join('\n'), /--no-relaunch/);
});

test('runner: a relaunch failure or an app that never starts is attention, not a failure', async () => {
  const w = world();
  const { d } = deps(w, { relaunch: async () => ({ ok: false, error: 'no app id' }), timeouts: { startMs: 1000 } });
  start(w, d);
  const out = await runGoLive(w.ctx, d);
  assert.equal(out.status, 'attention');
  assert.equal(loadState(w.ctx).linked, true);
});

/* ------------------------------------------------------------------ resume */

test('resume: a runner that stopped after the link continues at verify; link is not run again', async () => {
  const w = world();
  const { d, calls } = deps(w, { haltAfter: 'link' });
  start(w, d);
  const first = await runGoLive(w.ctx, d);
  assert.deepEqual(first, { exit: 'halted' });
  assert.equal(readGoLive(w.ctx).phase, 'verify');
  assert.equal(res(w).status, 'waiting');
  const backupId = loadState(w.ctx).backupId;

  const { d: d2, calls: c2 } = deps(w);
  const second = await runGoLive(w.ctx, d2);
  assert.deepEqual(second, { exit: 'done', status: 'ok' });
  assert.equal(c2.phases[0], 'verify', 'resumed at the persisted phase');
  assert.equal(c2.phases.includes('link'), false);
  assert.equal(loadState(w.ctx).backupId, backupId, 'no second backup');
  assert.equal(calls.relaunch + c2.relaunch, 1);
});

test('resume: a dead runner (stale claim) is relaunched by the SessionStart step; a live one is left alone', async () => {
  const w = world();
  const { d } = deps(w, { haltAfter: 'relist' });
  start(w, d);
  await runGoLive(w.ctx, d);
  // simulate the runner dying mid-state: its claim stays behind, with a pid that no longer exists
  const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
  writeFileSync(join(w.acc, 'go-live.claim'), JSON.stringify({ pid: dead, at: Date.now(), beatAt: Date.now() }));
  assert.equal(runnerAlive(w.ctx), false);
  const launched = [];
  assert.deepEqual(resumeIfDead(w.ctx, (a) => { launched.push(a); return { ok: true, method: 'test' }; }).resumed, true);
  assert.deepEqual(launched, [['accounts', 'golive-run']]);
  // the relaunched runner takes over the dead claim and finishes
  const { d: d2, calls } = deps(w);
  const out = await runGoLive(w.ctx, d2);
  assert.equal(out.status, 'ok');
  assert.equal(calls.phases[0], 'link');

  // a live runner (this process holds the claim, fresh heartbeat) is not relaunched and not doubled
  const w2 = world();
  const { d: dd } = deps(w2, { haltAfter: 'relist' });
  start(w2, dd);
  await runGoLive(w2.ctx, dd);
  writeFileSync(join(w2.acc, 'go-live.claim'), JSON.stringify({ pid: process.pid, at: w2.ctx.now(), beatAt: w2.ctx.now() }));
  assert.equal(runnerAlive(w2.ctx), true);
  assert.equal(resumeIfDead(w2.ctx, () => assert.fail('must not launch')).resumed, false);
  assert.deepEqual(await runGoLive(w2.ctx, deps(w2).d), { exit: 'already-running' });
});

test('resume: nothing in progress, a finished go-live and a missing state file are no-ops', async () => {
  const w = world();
  assert.deepEqual(await runGoLive(w.ctx, deps(w).d), { exit: 'no-go-live' });
  assert.equal(resumeIfDead(w.ctx, () => assert.fail('no')).resumed, false);
  const { d } = deps(w);
  start(w, d);
  assert.equal((await runGoLive(w.ctx, d)).status, 'ok');
  assert.equal(goLiveInProgress(w.ctx), null);
  assert.deepEqual(await runGoLive(w.ctx, deps(w).d), { exit: 'done', status: 'ok' }, 'idempotent after the end');
  assert.equal(resumeIfDead(w.ctx, () => assert.fail('no')).resumed, false);
});

test('result and status: the status report carries the go-live state', async () => {
  const w = world();
  const { d } = deps(w);
  start(w, d);
  assert.match(formatGoLive(res(w)), /^Go-live: waiting \(phase wait-stop\)/);
  await runGoLive(w.ctx, d);
  const st = collectStatus(w.ctx, { probe: false });
  assert.equal(st.goLive.status, 'ok');
  assert.ok(formatStatus(st, {}).some((l) => /^Go-live: ok/.test(l)));
  const keys = Object.keys(readJson(goLiveResultFile(w.ctx)));
  for (const k of ['status', 'startedAt', 'finishedAt', 'counts', 'backupId', 'rollbackScript', 'messages', 'log']) assert.ok(keys.includes(k), k);
  assert.ok(existsSync(goLiveFile(w.ctx)));
});

/* ------------------------------------------------------------------ launcher */

test('launcher: a detached spawn on posix, hidden, with the whole argument list', () => {
  const calls = [];
  const spawnFn = (cmd, argv, o) => { calls.push({ cmd, argv, o }); return { pid: 4242, on() {}, unref() {} }; };
  const r = launchDetached(['accounts', 'golive-run'], { platform: 'linux', env: {}, spawnFn, execPath: '/node', cli: '/x/cli.mjs' });
  assert.deepEqual(r, { ok: true, pid: 4242, method: 'detached-spawn' });
  assert.equal(calls[0].cmd, '/node');
  assert.deepEqual(calls[0].argv, ['/x/cli.mjs', 'accounts', 'golive-run']);
  assert.equal(calls[0].o.detached, true);
  assert.equal(calls[0].o.windowsHide, true);
  assert.equal(calls[0].o.stdio, 'ignore');
});

test('launcher: Windows goes through CIM, hidden, with the env forwarded in a file; no spawn of node itself', () => {
  const w = world();
  const sync = [];
  const spawnSyncFn = (cmd, argv, o) => { sync.push({ cmd, argv, o }); return { status: 0, stdout: '{"rc":0,"pid":777}\n' }; };
  const spawnFn = () => assert.fail('node must not be spawned directly on Windows');
  const env = { SESSION_SYNC_TEST_APP_STATE: 'x', CLAUDE_SESSION_SYNC_REMOTE: 'remote', HOME: '/h', USERPROFILE: 'C:/h', UNRELATED: 'no' };
  const r = launchDetached(['accounts', 'wait', '--reason', 'link'], { ctx: w.ctx, platform: 'win32', env, spawnFn, spawnSyncFn, execPath: 'C:/Program Files/node.exe', cli: CLI_PATH });
  assert.deepEqual(r, { ok: true, pid: 777, method: 'cim' });
  const c = sync[0];
  assert.equal(c.cmd, 'powershell.exe');
  assert.equal(c.o.windowsHide, true);
  const script = c.argv[c.argv.length - 1];
  assert.match(script, /Win32_Process/);
  assert.match(script, /ShowWindow = \[uint16\]0/);
  assert.doesNotMatch(script, /CreateFlags/);
  const cmdline = c.o.env.SS_LAUNCH_CMD;
  assert.match(cmdline, /"C:\/Program Files\/node\.exe" --import /);
  assert.match(cmdline, /accounts wait --reason link/);
  const file = /--ss-env-file (\S+)$/.exec(cmdline)?.[1];
  assert.ok(file && existsSync(file), 'the env file exists until the child reads it');
  const forwarded = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(forwarded.CLAUDE_SESSION_SYNC_REMOTE, 'remote');
  assert.equal(forwarded.HOME, '/h', 'a sandbox (app seam set) forwards the redirected home');
  assert.equal(forwarded.UNRELATED, undefined);
});

test('launcher: CIM failure falls back to a detached spawn and says so; the env file is removed', () => {
  const w = world();
  const spawnSyncFn = () => ({ status: 0, stdout: '{"rc":21,"pid":0}\n' });
  const spawnFn = () => ({ pid: 9, on() {}, unref() {} });
  const r = launchDetached(['accounts', 'wait'], { ctx: w.ctx, platform: 'win32', env: { SESSION_SYNC_X: '1' }, spawnFn, spawnSyncFn });
  assert.equal(r.ok, true);
  assert.equal(r.method, 'spawn-fallback');
  assert.match(r.note, /Win32_Process\.Create returned 21/);
  const leftovers = existsSync(w.acc) ? readdirSyncSafe(w.acc).filter((n) => n.startsWith('launch-env-')) : [];
  assert.deepEqual(leftovers, []);
});

test('launcher: the log seam records the request and starts nothing; never throws', () => {
  const log = join(tmpdir(), `ss-launch-${process.pid}-${Date.now()}.log`);
  try {
    const r = launchDetached(['accounts', 'golive-run'], { env: { SESSION_SYNC_TEST_LAUNCH_LOG: log }, spawnFn: () => assert.fail('no'), spawnSyncFn: () => assert.fail('no') });
    assert.deepEqual(r, { ok: true, pid: null, method: 'test-log' });
    assert.deepEqual(JSON.parse(readFileSync(log, 'utf8').trim()), { args: ['accounts', 'golive-run'] });
  } finally { rmSync(log, { force: true }); }
  const bad = launchDetached(['x'], { platform: 'linux', env: {}, spawnFn: () => { throw new Error('boom'); } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /boom/);
});

test('launcher: forwardedEnv passes only the plugin and rclone variables unless a sandbox is declared', () => {
  const f = forwardedEnv({ SESSION_SYNC_TEST_POLL_MS: '5', CLAUDE_PLUGIN_OPTION_X: 'y', RCLONE_CONFIG: 'c', PATH: 'p', HOME: 'h' });
  assert.deepEqual(Object.keys(f).sort(), ['CLAUDE_PLUGIN_OPTION_X', 'RCLONE_CONFIG', 'SESSION_SYNC_TEST_POLL_MS']);
});

test('launcher: the env preload applies the file, strips its own argument and deletes the file', () => {
  const dir = join(tmpdir(), `ss-preload-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    const envFile = join(dir, 'e.json');
    const script = join(dir, 'probe.mjs');
    writeFileSync(envFile, JSON.stringify({ SS_PROBE_VALUE: 'forwarded' }));
    writeFileSync(script, 'console.log(JSON.stringify({ v: process.env.SS_PROBE_VALUE, argv: process.argv.slice(2) }));');
    const preload = new URL('../lib/accounts/launch-env.mjs', import.meta.url).href;
    const r = spawnSync(process.execPath, ['--import', preload, script, 'accounts', 'golive-run', '--ss-env-file', envFile], { encoding: 'utf8', windowsHide: true, env: { ...process.env, SS_PROBE_VALUE: '' } });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { v: 'forwarded', argv: ['accounts', 'golive-run'] });
    assert.equal(existsSync(envFile), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

import { readdirSync } from 'node:fs';
function readdirSyncSafe(d) { try { return readdirSync(d); } catch { return []; } }

/* ------------------------------------------------------------------ desktop */

test('desktop: capability is read from the files, never the version label', () => {
  const w = world({ copies: [{ capable: true }, { capable: false }] });
  const list = desktopCopies(w.ctx);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((c) => c.capable).sort(), [false, true]);
  assert.equal(copyCapability(w.made[0].root).capable, true);
  assert.equal(copyCapability(w.made[1].root).pushFilter, false);
  assert.equal(desktopCopies({ userData: null }).length, 0);
  assert.equal(desktopCopies({ userData: join(w.r.root, 'nowhere') }).length, 0);
});

test('desktop: the relaunch seam flips the app state and never starts anything', () => {
  const w = world();
  const r = relaunchApp(w.ctx, { platform: 'win32', spawnFn: () => assert.fail('no'), spawnSyncFn: () => assert.fail('no') });
  assert.deepEqual(r, { ok: true, method: 'test-seam' });
  assert.equal(readJson(w.appFile).running, true);
});

test('desktop: Windows relaunch uses explorer shell:AppsFolder with the AUMID read from the package', () => {
  const w = world();
  const env = {};
  const spawned = [];
  const spawnFn = (cmd, argv, o) => { spawned.push({ cmd, argv, o }); return { pid: 1, on() {}, unref() {} }; };
  const spawnSyncFn = (cmd, argv) => { assert.equal(cmd, 'powershell.exe'); assert.match(argv.at(-1), /Get-AppxPackage/); return { status: 0, stdout: 'warning noise\nFamily_abc123!Claude\n' }; };
  const r = relaunchApp(w.ctx, { platform: 'win32', env, spawnFn, spawnSyncFn });
  assert.deepEqual(r, { ok: true, method: 'explorer', aumid: 'Family_abc123!Claude' });
  assert.equal(spawned[0].cmd, 'explorer.exe');
  assert.deepEqual(spawned[0].argv, ['shell:AppsFolder\\Family_abc123!Claude']);
  assert.equal(spawned[0].o.windowsHide, true);
  const none = relaunchApp(w.ctx, { platform: 'win32', env, spawnFn, spawnSyncFn: () => ({ status: 0, stdout: '' }) });
  assert.equal(none.ok, false);
  assert.equal(resolveAumid({ spawnSyncFn: () => { throw new Error('x'); } }), null);
});

test('desktop: macOS relaunch is `open -a Claude`; other platforms are reported unsupported', () => {
  const w = world();
  const spawned = [];
  const spawnFn = (cmd, argv) => { spawned.push([cmd, ...argv]); return { pid: 1, on() {}, unref() {} }; };
  assert.equal(relaunchApp(w.ctx, { platform: 'darwin', env: {}, spawnFn }).ok, true);
  assert.deepEqual(spawned, [['open', '-a', 'Claude']]);
  assert.equal(relaunchApp(w.ctx, { platform: 'linux', env: {}, spawnFn }).ok, false);
});

test('appquit: the leg B seam says it is not supported yet', async () => {
  const q = await requestAppQuit();
  assert.equal(q.supported, false);
  assert.ok(q.reason);
});
