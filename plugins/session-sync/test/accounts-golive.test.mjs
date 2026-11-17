/**
 * go-live (leg A): the preflight, consent, the detached runner's state machine, resume, and the
 * launcher and desktop layers it stands on. In-process, real fs on synthetic fixtures; the app
 * state comes from the SESSION_SYNC_TEST_APP_STATE seam, and the process, launch and relaunch
 * layers are injected, so no real app is ever started or touched.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import {
  planGoLive, beginGoLive, runGoLive, resumeIfDead, takeGoLiveReport, goLiveInProgress, runnerAlive, readGoLive, readGoLiveResult,
  goLiveFile, goLiveResultFile, goLiveLogFile, verifyLinked, expectedSet, readListing, defaultRollback, copyWords,
  DEFAULT_TIMEOUTS, STOP_POLL_MS, STOP_GAP_MS, PLUGIN_VERSION, replaceWaitingRunner, PHASES, FINAL_STATUSES,
} from '../lib/accounts/golive.mjs';
import { stepWord, tooltipFor, startText, endText, progressInfo, createProgressUi, TRAY_SCRIPT, TITLE } from '../lib/accounts/progress.mjs';
import { DEFAULTS, describeConfig } from '../lib/config.mjs';
import { loadState, saveState, emptyState, readJson, resetMutations, accPath, rollbackMarkerFile } from '../lib/accounts/state.mjs';
import { answerPairs, pairKey, listFolders } from '../lib/accounts/folders.mjs';
import { link, fullPass } from '../lib/accounts/pass.mjs';
import { cliCopies, sessionSyncCopies, copyCapability, desktopCopies, relaunchApp, resolveAumid } from '../lib/accounts/desktop.mjs';
import { launchDetached, launchViaHelper, forwardedEnv, CLI_PATH } from '../lib/accounts/launcher.mjs';
import { collectStatus, formatStatus, formatGoLive } from '../lib/accounts/report.mjs';
import { requestAppQuit, quitSupport } from '../lib/accounts/appquit.mjs';
import { remoteRecordList } from '../lib/sync.mjs';
import { findRclone } from '../lib/rclone.mjs';
import { makeRoot, makeClock, addFolder, putRecord, putTombstone, uuid, treeHashes, recordName } from './fixtures/store.mjs';
import { makeProbeApp } from './fixtures/probe-app.mjs';

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
  const plan = planGoLive(w.ctx, { copies: (c) => sessionSyncCopies(c, { home: join(w.r.root, 'home') }) });   // never the real terminal install
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
  assert.doesNotMatch(r.messages.join('\n'), /Restart Claude to sync/, 'the finished result never asks for a restart again');
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

/* ------------------------------------------------------------------ leg B: app quit */

test('appquit: macOS asks through osascript (hidden, bounded); a failure is reported, never forced', async () => {
  const calls = [];
  const ok = await requestAppQuit({ platform: 'darwin', env: {}, spawnSyncFn: (cmd, argv, o) => { calls.push({ cmd, argv, o }); return { status: 0 }; } });
  assert.deepEqual(ok, { supported: true, requested: true });
  assert.equal(calls[0].cmd, 'osascript');
  assert.deepEqual(calls[0].argv, ['-e', 'quit app "Claude"']);
  assert.equal(calls[0].o.windowsHide, true);
  assert.ok(calls[0].o.timeout > 0);
  const bad = await requestAppQuit({ platform: 'darwin', env: {}, spawnSyncFn: () => ({ status: 1, stderr: 'not allowed\n' }) });
  assert.deepEqual(bad, { supported: true, requested: false, reason: 'not allowed' });
  const err = await requestAppQuit({ platform: 'darwin', env: {}, spawnSyncFn: () => ({ error: new Error('ENOENT') }) });
  assert.equal(err.requested, false);
  assert.match(err.reason, /ENOENT/);
  const thrown = await requestAppQuit({ platform: 'darwin', env: {}, spawnSyncFn: () => { throw new Error('boom'); } });
  assert.equal(thrown.requested, false);
});

test('appquit: Windows and Linux are unsupported with a reason, and nothing is spawned', async () => {
  const spawnSyncFn = () => { throw new Error('must not spawn'); };
  for (const platform of ['win32', 'linux']) {
    const q = await requestAppQuit({ platform, env: {}, spawnSyncFn });
    assert.equal(q.supported, false);
    assert.ok(q.reason.length > 10);
    assert.equal(q.requested, undefined);
    assert.equal(quitSupport(platform).supported, false);
  }
  assert.equal(quitSupport('darwin').supported, true);
});

test('appquit: with the app-state test seam set, no real app is ever asked to quit', async () => {
  const q = await requestAppQuit({ platform: 'darwin', env: { SESSION_SYNC_TEST_APP_STATE: 'x' }, spawnSyncFn: () => { throw new Error('must not spawn'); } });
  assert.equal(q.requested, false);
});

test('runner --quit-app: asks once after a delay while the app runs, then waits for the stop', async () => {
  const w = world();
  w.setApp(true);
  let asked = 0; const order = [];
  const { d } = deps(w, {
    quitDelayMs: 1,
    requestQuit: async () => { asked++; order.push('ask'); w.setApp(false); return { supported: true, requested: true }; },
    onPhase: (p) => order.push(p),
  });
  start(w, d, { quitApp: true });
  const out = await runGoLive(w.ctx, d);
  assert.equal(out.status, 'ok');
  assert.equal(asked, 1);
  assert.ok(order.indexOf('ask') > order.indexOf('wait-stop') && order.indexOf('ask') < order.indexOf('relist'));
  assert.equal(readGoLive(w.ctx).quitRequested, true);
  assert.match(res(w).messages.join('\n'), /Asked Claude to quit/);
});

test('runner --quit-app: an unsupported quit says to use the tray icon, still waits, and is not asked again on resume', async () => {
  const w = world();
  w.setApp(true);
  let asked = 0;
  const { d } = deps(w, {
    quitDelayMs: 1, timeouts: { stopMs: 2000 },
    requestQuit: async () => { asked++; return { supported: false, reason: 'not here' }; },
  });
  start(w, d, { quitApp: true });
  const first = await runGoLive(w.ctx, d);
  assert.equal(first.status, 'failed', 'timed out waiting; nothing was forced');
  assert.equal(asked, 1);
  assert.match(res(w).messages.join('\n'), /could not be asked to quit \(not here\)[\s\S]*tray icon/);
  const d2 = { ...d, onSleep: undefined, sleep: async () => { w.setApp(false); } };
  const second = await runGoLive(w.ctx, d2);
  assert.equal(second.status, 'ok');
  assert.equal(asked, 1, 'asked only once');
});

test('runner --quit-app: nothing is asked when the app is not running, or without the flag', async () => {
  for (const quitApp of [true, false]) {
    const w = world();
    w.setApp(!quitApp);
    let asked = 0;
    const { d } = deps(w, { quitDelayMs: 1, requestQuit: async () => { asked++; return { supported: true, requested: true }; }, onSleep: (n) => { if (n === 2) w.setApp(false); } });
    start(w, d, { quitApp });
    await runGoLive(w.ctx, d);
    assert.equal(asked, 0);
  }
});

/* ------------------------------------------------------------------ leg B: remote check on a never-pushed remote */

test('runner: a remote that was never pushed is 0 duplicates with a note, not attention', async () => {
  const w = world();
  const { d } = deps(w, { remoteCheck: async () => ({ checked: true, ids: 0, duplicates: 0, neverPushed: true }) });
  start(w, d);
  assert.equal((await runGoLive(w.ctx, d)).status, 'ok');
  assert.equal(res(w).counts.remoteDuplicates, 0);
  assert.match(res(w).messages.join('\n'), /nothing has been pushed yet, so 0 records and 0 duplicates/);
});

test('runner: a remote check that really fails stays attention', async () => {
  const w = world();
  const { d } = deps(w, { remoteCheck: async () => ({ checked: false, reason: 'the remote could not be listed' }) });
  start(w, d);
  assert.equal((await runGoLive(w.ctx, d)).status, 'attention');
});

const rcloneSkip = findRclone() ? false : 'rclone is not installed on this machine';
test('remoteRecordList: a missing claude-code-sessions folder is ok and neverPushed; a real rclone error is not ok', { skip: rcloneSkip }, async () => {
  const remote = makeRoot('rem').root;
  const never = await remoteRecordList(remote);
  assert.equal(never.ok, true);
  assert.equal(never.neverPushed, true);
  assert.equal(never.count, 0);
  const real = join(remote, 'claude-code-sessions', A, OA);
  mkdirSync(real, { recursive: true });
  writeFileSync(join(real, recordName(1)), '{}');
  const pushed = await remoteRecordList(remote);
  assert.equal(pushed.ok, true);
  assert.equal(pushed.neverPushed, undefined);
  assert.equal(pushed.count, 1);
  const broken = await remoteRecordList('session-sync-no-such-remote:x');
  assert.equal(broken.ok, false, 'an rclone error other than "not found" is not a never-pushed remote');
});

/* ------------------------------------------------------------------ leg B: the SessionStart report */

const claimFileOf = (w) => join(w.acc, 'go-live.claim');
const putResult = (w, over) => writeFileSync(goLiveResultFile(w.ctx), JSON.stringify({
  v: 1, id: 'gl-1', status: 'ok', phase: 'done', resumable: false, counts: { expected: 562, folders: 3, remoteDuplicates: 0 },
  messages: ['m1', 'm2'], attention: [], log: '/x/go-live.log', ...over,
}));

test('report: a final result is told once, in plain lines with counts and the log path', () => {
  const w = world();
  putResult(w, {});
  const t = takeGoLiveReport(w.ctx);
  assert.match(t, /go-live finished/);
  assert.match(t, /562 conversation\(s\) in 3 folder\(s\), 0 remote duplicate\(s\)/);
  assert.match(t, /Log: \/x\/go-live\.log/);
  assert.doesNotMatch(t, /2014/);
  assert.equal(takeGoLiveReport(w.ctx), null, 'once only');
  assert.equal(takeGoLiveReport(w.ctx), null);
  putResult(w, { id: 'gl-2' });
  assert.ok(takeGoLiveReport(w.ctx), 'a new go-live is reported again');
});

test('report: attention names what to do; rolled back and failed say so', () => {
  const w = world();
  putResult(w, { status: 'attention', attention: ['Push stays PAUSED: 1 copy lacks the feature.', 'Second.', 'Third.'] });
  const a = takeGoLiveReport(w.ctx);
  assert.match(a, /needs you/);
  assert.match(a, /Push stays PAUSED/);
  assert.match(a, /Second\./);
  assert.doesNotMatch(a, /Third\./, 'at most two');
  putResult(w, { id: 'gl-2', status: 'rolled_back', messages: ['PROBLEM: x. Rolling back.', 'Rollback finished.'] });
  assert.match(takeGoLiveReport(w.ctx), /rolled back; nothing is linked[\s\S]*Rollback finished/);
  putResult(w, { id: 'gl-3', status: 'failed', phase: 'wait-stop', resumable: true, messages: ['Timed out.'] });
  assert.match(takeGoLiveReport(w.ctx), /stopped at phase "wait-stop"[\s\S]*Run: accounts go-live/);
});

test('report: mid-run (after the restart, runner alive) says so once per phase; before that it is silent', () => {
  const w = world();
  putResult(w, { status: 'waiting', phase: 'rectify', resumable: true });
  assert.equal(takeGoLiveReport(w.ctx), null, 'no live runner: nothing to say');
  writeFileSync(claimFileOf(w), JSON.stringify({ pid: process.pid, at: w.ctx.now(), beatAt: w.ctx.now() }));
  const t = takeGoLiveReport(w.ctx);
  assert.match(t, /still running \(phase "rectify"/);
  assert.equal(takeGoLiveReport(w.ctx), null, 'once per phase');
  putResult(w, { status: 'waiting', phase: 'remote', resumable: true });
  assert.match(takeGoLiveReport(w.ctx), /phase "remote"/);
  putResult(w, { status: 'waiting', phase: 'wait-stop', resumable: true, id: 'gl-2' });
  assert.equal(takeGoLiveReport(w.ctx), null, 'while still waiting for the quit, the agent that started it knows');
  assert.equal(takeGoLiveReport(makeRoot('nores').ctx), null, 'no result file: nothing');
});

/* ------------------------------------------------------------------ go-live review fixes (B1, B2, S1 to S5) */

/** The app saving a record (tmp + rename) breaks the hard link: that folder's copy gets a new inode. */
function appSaves(folderPath, n) {
  const p = join(folderPath, recordName(n));
  const tmp = `${p}.app-tmp`;
  writeFileSync(tmp, readFileSync(p));
  renameSync(tmp, p);
}

test('B1 verify: a link made by another pass is NOT rolled back when the app ran since; the check waits for the stop and runs one pass first', async () => {
  const w = world();
  const { d: d0 } = deps(w);
  start(w, d0);
  const lk = await link(w.ctx, { reasons: ['waiter'] });         // the waiter links with the app stopped
  assert.equal(lk.ok, true);
  let flipped = false;
  let rollbacks = 0;
  let passes = 0;
  let splitSeen = false;
  const { d } = deps(w, {
    onPhase: (p) => { if (p === 'verify' && !flipped) { flipped = true; w.setApp(true); appSaves(w.fB.path, 1); splitSeen = verifyLinked(w.ctx, readGoLive(w.ctx).expected, 2).problems.some((x) => /split/.test(x)); } },   // the user reopens the app and it saves
    onSleep: () => { if (flipped) w.setApp(false); },
    rollback: async () => { rollbacks++; return { ok: true }; },
    fullPass: async (ctx, o) => { passes++; return fullPass(ctx, o); },
  });
  const out = await runGoLive(w.ctx, d);
  assert.deepEqual(out, { exit: 'done', status: 'ok' });
  assert.equal(splitSeen, true, 'the app save really split the record before the pass');
  assert.equal(rollbacks, 0, 'a good link is never rolled back because the app was reopened');
  assert.equal(passes >= 1, true, 'one full pass ran before the check');
  assert.equal(loadState(w.ctx).linked, true);
  assert.equal(readGoLive(w.ctx).appSeenSinceLink, true);
  assert.match(res(w).messages.join('\n'), /the check waits until it has stopped/);
  assert.deepEqual(verifyLinked(w.ctx, readGoLive(w.ctx).expected, 2).problems, []);
});

test('B1 verify: a resume at verify with the app running waits instead of rolling back; a timeout leaves the link and a resumable failure', async () => {
  const w = world();
  const { d: d0 } = deps(w, { haltAfter: 'link' });
  start(w, d0);
  await runGoLive(w.ctx, d0);                                    // linked by this runner, halted before verify
  w.setApp(true);
  appSaves(w.fA.path, 2);
  let rollbacks = 0;
  const { d } = deps(w, { timeouts: { stopMs: 2000 }, rollback: async () => { rollbacks++; return { ok: true }; } });
  const out = await runGoLive(w.ctx, d);
  assert.equal(out.status, 'failed');
  assert.equal(rollbacks, 0);
  assert.equal(res(w).resumable, true);
  assert.equal(loadState(w.ctx).linked, true, 'the link stays');
  assert.match(res(w).messages.join('\n'), /was not rolled back/);
  // the user quits; the resume heals the split with one pass and finishes
  w.setApp(false);
  const { d: d2 } = deps(w, { rollback: async () => { rollbacks++; return { ok: true }; } });
  assert.deepEqual(await runGoLive(w.ctx, d2), { exit: 'done', status: 'ok' });
  assert.equal(rollbacks, 0);
});

test('B2 copies: the terminal install is judged too (installed_plugins.json), a stale one pauses push, a capable one does not', () => {
  const w = world({ copies: [{ capable: true }] });
  const home = join(w.r.root, 'home');
  const cacheRoot = (v) => join(home, '.claude', 'plugins', 'cache', 'goodstuff', 'session-sync', v);
  const writeCopy = (v, capable) => {
    const root = cacheRoot(v);
    mkdirSync(join(root, '.claude-plugin'), { recursive: true });
    mkdirSync(join(root, 'lib', 'accounts'), { recursive: true });
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'session-sync', version: v }));
    if (capable) {
      for (const f of ['pass', 'waiter', 'folders']) writeFileSync(join(root, 'lib', 'accounts', `${f}.mjs`), '// x');
      writeFileSync(join(root, 'lib', 'sync.mjs'), 'export function accountsPushFilter() {}');
    } else writeFileSync(join(root, 'lib', 'sync.mjs'), 'export function push() {}');
    return root;
  };
  const oldRoot = writeCopy('0.3.0', false);
  const newRoot = writeCopy('0.5.0', true);
  const installed = (p) => writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'session-sync@goodstuff': [{ scope: 'user', installPath: p, version: '0.3.0' }], 'other@goodstuff': [{ installPath: '/nope' }] } }));
  // the installed copy is the old one: stale, even though a newer one sits in the cache
  installed(oldRoot);
  let cli = cliCopies(w.ctx, { home });
  assert.equal(cli.length, 1);
  assert.equal(cli[0].kind, 'cli');
  assert.equal(cli[0].marketplace, 'goodstuff');
  assert.equal(cli[0].capable, false);
  const all = sessionSyncCopies(w.ctx, { home });
  assert.deepEqual(all.map((c) => c.kind).sort(), ['cli', 'desktop']);
  const plan = planGoLive(w.ctx, { copies: (c) => sessionSyncCopies(c, { home }) });
  assert.equal(plan.stale.length, 1);
  assert.equal(plan.stale[0].kind, 'cli');
  assert.match(copyWords(plan.stale), /1 installed terminal copy/);
  const gl = beginGoLive(w.ctx, plan, {}, { getPush: () => true, setPush: () => {} });
  assert.equal(gl.pausedPush, true, 'push is paused for a stale terminal copy');
  // the installed copy is the new one: capable
  installed(newRoot);
  assert.equal(cliCopies(w.ctx, { home })[0].capable, true);
  // no install list: the newest cached version is the one judged
  rmSync(join(home, '.claude', 'plugins', 'installed_plugins.json'));
  cli = cliCopies(w.ctx, { home });
  assert.equal(cli.length, 1);
  assert.equal(cli[0].version, '0.5.0');
  // nothing installed from the terminal: nothing to judge
  assert.deepEqual(cliCopies(w.ctx, { home: join(w.r.root, 'empty') }), []);
});

test('B2 runner: a stale terminal copy keeps push paused (not waited for) and says how to update it; once updated push comes back', async () => {
  const w = world();
  const stale = { path: '/cli', version: '0.3.0', kind: 'cli', marketplace: 'goodstuff', capable: false };
  let copies = [stale];
  const { d, calls } = deps(w, { copies: () => copies, timeouts: { capabilityMs: 1000000 } });
  start(w, d);
  assert.deepEqual(calls.push, [false], 'paused at the start');
  const out = await runGoLive(w.ctx, d);
  assert.equal(out.status, 'attention');
  assert.deepEqual(calls.push, [false]);
  assert.match(res(w).messages.join('\n'), /Push stays PAUSED: 1 installed terminal copy\(ies\)/);
  assert.match(res(w).messages.join('\n'), /claude plugin update session-sync@goodstuff --scope user/);
  assert.equal(calls.phases.filter((p) => p === 'wait-capability').length, 1);
  // a second world: the copy is updated before the capability check
  const w2 = world();
  copies = [{ ...stale }];
  const { d: d2, calls: c2 } = deps(w2, { copies: () => copies, onPhase: (p) => { if (p === 'wait-capability') copies = [{ ...stale, version: '0.5.0', capable: true }]; } });
  start(w2, d2);
  assert.equal((await runGoLive(w2.ctx, d2)).status, 'ok');
  assert.deepEqual(c2.push, [false, true]);
});

test('S1 heartbeat: a timer keeps the claim fresh while a step awaits, and a runner never writes over another holder\'s claim', async () => {
  const w = world();
  const claim = join(w.acc, 'go-live.claim');
  let seen = null;
  const { d } = deps(w, {
    heartbeatMs: 10,
    onPhase: async (p) => {
      if (p !== 'relaunch') return;
      const t0 = w.ctx.now();
      w.ctx.setNow(t0 + 600000);
      await new Promise((r) => setTimeout(r, 80));                // an awaiting step: only the timer can beat
      seen = readJson(claim).beatAt;
      assert.equal(seen, t0 + 600000, 'the timer beat during the await');
      // another process took the claim over: the old runner must leave it alone
      writeFileSync(claim, JSON.stringify({ pid: process.ppid, at: 1, beatAt: 5 }));
      await new Promise((r) => setTimeout(r, 80));
      assert.deepEqual(readJson(claim), { pid: process.ppid, at: 1, beatAt: 5 });
    },
  });
  start(w, d);
  assert.equal((await runGoLive(w.ctx, d)).status, 'ok');
  assert.equal(readJson(claim).pid, process.ppid, 'releaseClaim does not delete a claim that is not ours either');
  assert.ok(seen);
});

test('S1 rollback: the real rollback is an async child (the heartbeat keeps beating), parses --json, and passes --exact', async () => {
  const w = world();
  const st = loadState(w.ctx); st.backupId = 'bk1'; saveState(w.ctx, st);
  const seen = [];
  const fake = (stdout, code) => (cmd, argv, o) => {
    seen.push({ argv, o });
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {};
    setTimeout(() => { c.stdout.emit('data', stdout); c.emit('close', code); }, 5);
    return c;
  };
  const p = defaultRollback(w.ctx, { exact: true, spawnFn: fake('', 0) });
  assert.equal(typeof p.then, 'function', 'async: nothing blocks the event loop');
  assert.deepEqual(await p, { ok: true, code: 0, errors: undefined, snapshot: undefined });
  assert.ok(seen[0].argv.includes('--exact') && seen[0].argv.includes('--json'));
  assert.equal(seen[0].o.windowsHide, true);
  const bad = await defaultRollback(w.ctx, { spawnFn: fake(`${JSON.stringify({ errors: ['store:a.json'], snapshot: '/snap' })}\n`, 1) });
  assert.deepEqual(bad, { ok: false, code: 1, errors: ['store:a.json'], snapshot: '/snap' });
  assert.equal(seen[1].argv.includes('--exact'), false);
  const none = await defaultRollback(makeRoot('nobk').ctx);
  assert.deepEqual(none, { ok: false, error: 'no backup' });
});

test('S2 rollback is --exact when the app has not run since the link, and not exact once it has been seen', async () => {
  // damage right after our own link, app never seen: exact
  const a = world();
  let optsA = null;
  const { d: da } = deps(a, {
    afterLink: async () => { unlinkSync(join(a.fB.path, recordName(1))); },
    rollback: async (ctx, o) => { optsA = o; return defaultRollback(ctx, o); },
  });
  start(a, da);
  assert.equal((await runGoLive(a.ctx, da)).status, 'rolled_back');
  assert.deepEqual(optsA, { exact: true });
  // linked by another pass (the app may have run): not exact
  const b = world();
  let optsB = null;
  const { d: db0 } = deps(b);
  start(b, db0);
  assert.equal((await link(b.ctx, { reasons: ['waiter'] })).ok, true);
  unlinkSync(join(b.fB.path, recordName(1)));
  const { d: db } = deps(b, {
    fullPass: async () => ({ ok: true }),                         // a pass that cannot heal it
    rollback: async (ctx, o) => { optsB = o; return defaultRollback(ctx, o); },
  });
  assert.equal((await runGoLive(b.ctx, db)).status, 'rolled_back');
  assert.deepEqual(optsB, { exact: false });
});

test('S3 rollback: a finished rollback that does not match the backup is not retried and names the files and the snapshot', async () => {
  const w = world();
  let tries = 0;
  const { d } = deps(w, {
    afterLink: async () => { unlinkSync(join(w.fB.path, recordName(1))); },
    rollback: async () => {
      tries++;
      const st = loadState(w.ctx); st.backupId = null; saveState(w.ctx, st);   // what the script does at its end
      return { ok: false, code: 1, errors: ['store:a/b/local_x.json', 'store:c.json'], snapshot: '/snap/pre-rollback-1' };
    },
  });
  start(w, d);
  const out = await runGoLive(w.ctx, d);
  assert.equal(out.status, 'failed');
  assert.equal(tries, 1, 'no pointless retries');
  const m = res(w).messages.join('\n');
  assert.match(m, /2 file\(s\) do not match the backup/);
  assert.match(m, /store:a\/b\/local_x\.json/);
  assert.match(m, /\/snap\/pre-rollback-1/);
  assert.doesNotMatch(m, /run: accounts rollback/);
});

test('S3 rollback: a refused or part-way run keeps its state and is retried', async () => {
  const w = world();
  let tries = 0;
  const { d } = deps(w, {
    afterLink: async () => { unlinkSync(join(w.fB.path, recordName(1))); },
    rollback: async (ctx, o) => { tries++; if (tries < 3) return { ok: false, code: tries === 1 ? 3 : 1 }; return defaultRollback(ctx, o); },
  });
  start(w, d);
  assert.equal((await runGoLive(w.ctx, d)).status, 'rolled_back');
  assert.equal(tries, 3);
});

test('S4 push paused: a failed or waiting go-live says push is paused by go-live, in the report and in status', async () => {
  const w = world({ copies: [{ capable: false }] });
  w.setApp(true);
  const { d } = deps(w, { timeouts: { stopMs: 2000 } });
  start(w, d);
  assert.match(formatGoLive(res(w)), /Push is paused by go-live/, 'already while it waits');
  assert.equal((await runGoLive(w.ctx, d)).status, 'failed');
  const r = res(w);
  assert.equal(r.push.pausedByGoLive, true);
  assert.equal(r.push.reEnabled, false);
  assert.match(formatGoLive(r), /Push is paused by go-live and stays off/);
  assert.match(takeGoLiveReport(w.ctx), /Push is paused by go-live[\s\S]*Log:/);
  // a finished go-live that switched push back on does not say it
  const ok = world();
  const { d: dok } = deps(ok);
  start(ok, dok);
  await runGoLive(ok.ctx, dok);
  assert.doesNotMatch(formatGoLive(res(ok)), /paused/);
});

test('nit: remote duplicates leave the result saying push is paused, not re-enabled', async () => {
  const w = world({ copies: [{ capable: false }] });
  const { d } = deps(w, { remoteCheck: async () => ({ checked: true, ids: 3, duplicates: 1 }), onSleep: () => { w.made[0].makeCapable(); } });
  start(w, d);
  const out = await runGoLive(w.ctx, d);
  assert.equal(out.status, 'attention');
  assert.equal(res(w).push.reEnabled, false);
  assert.equal(res(w).push.pausedByGoLive, true);
});

test('nit: beginning a go-live sweeps the report markers of earlier go-lives', () => {
  const w = world();
  writeFileSync(join(w.acc, 'go-live-reported-gl-1-ok'), '');
  writeFileSync(join(w.acc, 'go-live-reported-gl-1-mid-rectify'), '');
  const { d } = deps(w);
  const gl = start(w, d);
  assert.deepEqual(readdirSyncSafe(w.acc).filter((n) => n.startsWith('go-live-reported-')), []);
  assert.ok(gl.id);
});

test('nit: a quit request that times out means the quit is under way, not that it failed', async () => {
  const q = await requestAppQuit({ platform: 'darwin', env: {}, spawnSyncFn: () => ({ error: Object.assign(new Error('spawnSync osascript ETIMEDOUT'), { code: 'ETIMEDOUT' }) }) });
  assert.deepEqual(q, { supported: true, requested: true, slow: true });
});

test('S5 hook launch: the helper is a tiny detached hidden node, never PowerShell; the log seam records the request directly', () => {
  const calls = [];
  const spawnFn = (cmd, argv, o) => { calls.push({ cmd, argv, o }); return { pid: 31, on() {}, unref() {} }; };
  const spawnSyncFn = () => assert.fail('the hook must not run a synchronous child (no PowerShell)');
  const r = launchViaHelper(['accounts', 'wait', '--reason', 'link'], { platform: 'win32', env: {}, spawnFn, spawnSyncFn, execPath: '/node', cli: '/x/cli.mjs' });
  assert.equal(r.ok, true);
  assert.equal(r.method, 'helper');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, '/node');
  assert.deepEqual(calls[0].argv, ['/x/cli.mjs', 'accounts', 'launch-detached', 'accounts', 'wait', '--reason', 'link']);
  assert.equal(calls[0].o.detached, true);
  assert.equal(calls[0].o.windowsHide, true);
  assert.equal(calls[0].o.stdio, 'ignore');
  const bad = launchViaHelper(['accounts', 'wait'], { env: {}, spawnFn: () => { throw new Error('boom'); } });
  assert.equal(bad.ok, false);
  const log = join(tmpdir(), `ss-helper-${process.pid}-${Date.now()}.log`);
  try {
    const seam = launchViaHelper(['accounts', 'golive-run'], { env: { SESSION_SYNC_TEST_LAUNCH_LOG: log }, spawnFn: () => assert.fail('no') });
    assert.equal(seam.method, 'test-log');
    assert.deepEqual(JSON.parse(readFileSync(log, 'utf8').trim()), { args: ['accounts', 'golive-run'] });
  } finally { rmSync(log, { force: true }); }
});

/* ------------------------------------------------------------------ 0.5.1: no wait limit, fast start, relaunch in every end state, replace, restart */

const claimPath = (w) => join(w.acc, 'go-live.claim');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** A stand-in for a runner: a real, idle, hidden node process that only the test (and the code under test) may end.
 *  It is NOT our child (its parent exits at once, so init reaps it like a real detached runner; a child of ours would stay
 *  a zombie that still answers kill(pid, 0) on Linux and macOS). */
const fakeRunner = () => {
  const code = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',windowsHide:true});c.unref();console.log(c.pid)";
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', windowsHide: true });
  const pid = Number(String(r.stdout).trim());
  return { pid, kill: () => { try { process.kill(pid); } catch { /* gone */ } } };
};
const writeClaim = (w, pid, extra = {}) => writeFileSync(claimPath(w), JSON.stringify({ pid, at: w.ctx.now(), beatAt: w.ctx.now(), ...extra }));

test('0.5.1 wait-stop has no time limit by default: a very long wait ends when the app stops, and a stored 30 minute limit is ignored', async () => {
  assert.equal(DEFAULT_TIMEOUTS.stopMs, Infinity);
  const w = world();
  w.setApp(true);
  let t = 0;
  const { d } = deps(w, { clock: () => (t += 3_600_000), onSleep: (n) => { if (n === 40) w.setApp(false); } });   // an hour per reading
  start(w, d);
  const g = readGoLive(w.ctx); g.deadlines['wait-stop'] = 1; writeFileSync(goLiveFile(w.ctx), JSON.stringify(g));   // what a 0.5.0 runner stored
  const out = await runGoLive(w.ctx, d);
  assert.deepEqual(out, { exit: 'done', status: 'ok' });
  assert.equal(loadState(w.ctx).linked, true);
  assert.match(readFileSync(goLiveLogFile(w.ctx), 'utf8'), /Restart Claude to sync your accounts: quit Claude from the tray icon or app menu[^\n]*no time limit/);
  assert.doesNotMatch(readGoLive(w.ctx).messages.join('\n'), /Restart Claude to sync/, 'once the app stopped, the ask is not kept in the result');
});

test('0.5.1 the verify-stop wait has no limit either: it ends only on a stopped app', async () => {
  const w = world();
  let t = 0; let came = false;
  const { d } = deps(w, {
    clock: () => (t += 3_600_000),
    onPhase: (p) => { if (p === 'verify' && !came) { came = true; w.setApp(true); } },   // the app comes back right after the link
    onSleep: (n) => { if (came && n % 30 === 0) w.setApp(false); },
  });
  start(w, d);
  const out = await runGoLive(w.ctx, d);
  assert.equal(out.status, 'ok');
  assert.match(readGoLive(w.ctx).messages.join('\n'), /The app is running; the check waits/);
});

test('0.5.1 intervals: the stop wait looks every half second, and the link starts within about 2 seconds of the app stopping', async () => {
  assert.ok(STOP_POLL_MS <= 500 && STOP_GAP_MS <= 500, `poll ${STOP_POLL_MS} ms, confirm gap ${STOP_GAP_MS} ms`);
  const w = world();
  w.setApp(true);
  let stoppedAt = 0; let relistAt = 0;
  const d = {   // no pollMs, gapMs, clock or sleep: the real defaults
    appStatus: () => { const o = readJson(w.appFile, {}); return { fullAllowed: !o.running, running: !!o.running }; },
    onPhase: (p) => { if (p === 'relist') relistAt = Date.now(); },
    haltAfter: 'relist',
  };
  start(w, d);
  setTimeout(() => { stoppedAt = Date.now(); w.setApp(false); }, 300);
  assert.deepEqual(await runGoLive(w.ctx, d), { exit: 'halted' });
  const took = relistAt - stoppedAt;
  assert.ok(took >= STOP_GAP_MS - 50 && took < 2000, `the link phase began ${took} ms after the app stopped`);
});

/** Run a go-live to an end state; `rel` lists the phase each app start happened in. mk(w) gives the extra deps. */
async function endState(mk, { setup, opts } = {}) {
  const w = world();
  setup?.(w);
  const rel = [];
  let phase = '';
  const o = mk(w);
  const relaunchResult = o.relaunchResult; delete o.relaunchResult;
  const { d } = deps(w, {
    ...o,
    onPhase: (p) => { phase = p; return o.onPhase?.(p); },
    relaunch: async () => { rel.push(phase); w.setApp(true); return relaunchResult ?? { ok: true, method: 'test' }; },
  });
  start(w, d, opts);
  const out = await runGoLive(w.ctx, d);
  return { w, rel, out };
}
const damage = (w) => ({ afterLink: async () => { unlinkSync(join(w.fB.path, recordName(1))); } });

test('0.5.1 relaunch, ok: Claude is started in the relaunch phase, before the pass and the remote check', async () => {
  const { rel, out } = await endState(() => ({}));
  assert.equal(out.status, 'ok');
  assert.deepEqual(rel, ['relaunch']);
});

test('0.5.1 relaunch, attention: Claude is started once even when the remote check then needs attention', async () => {
  const { rel, out, w } = await endState(() => ({ remoteCheck: async () => ({ checked: true, ids: 3, duplicates: 2 }) }));
  assert.equal(out.status, 'attention');
  assert.deepEqual(rel, ['relaunch']);
  assert.equal(res(w).relaunch.ok, true);
});

test('0.5.1 relaunch, attention: a start that fails is reported and not retried', async () => {
  const { rel, out, w } = await endState(() => ({ relaunchResult: { ok: false, error: 'no app id' }, timeouts: { startMs: 1000 } }));
  assert.equal(out.status, 'attention');
  assert.equal(rel.length, 1);
  assert.match(res(w).attention.join('\n'), /Could not start Claude \(no app id\)/);
});

test('0.5.1 relaunch, rolled_back: Claude is started right after the rollback, before any later phase', async () => {
  const { rel, out, w } = await endState(damage);
  assert.equal(out.status, 'rolled_back');
  assert.deepEqual(rel, ['verify']);
  assert.match(res(w).messages.join('\n'), /Claude was started again/);
});

test('0.5.1 relaunch, failed (the rollback never finishes): Claude is started, and the failure text stays the last message', async () => {
  const { rel, out, w } = await endState((w0) => ({ ...damage(w0), rollback: async () => ({ ok: false, code: 3 }) }));
  assert.equal(out.status, 'failed');
  assert.equal(rel.length, 1);
  const m = res(w).messages;
  assert.match(m[m.length - 1], /The rollback did not finish/);
  assert.ok(m.some((x) => /Claude was started again/.test(x)));
});

test('0.5.1 relaunch, failed (another pass holds the lock too long): Claude is started; a second failure after another quit starts it again', async () => {
  const w = world();
  writeFileSync(join(w.acc, 'accounts.lock'), JSON.stringify({ pid: process.ppid, at: Date.now() }));
  const mk = () => { const rel = []; const { d } = deps(w, { timeouts: { lockMs: 2000 }, relaunch: async () => { rel.push(1); w.setApp(true); return { ok: true, method: 'test' }; } }); return { rel, d }; };
  const a = mk();
  start(w, a.d);
  assert.equal((await runGoLive(w.ctx, a.d)).status, 'failed');
  assert.equal(a.rel.length, 1);
  w.setApp(false);                       // the user quits Claude again and re-runs go-live
  const b = mk();
  assert.equal((await runGoLive(w.ctx, b.d)).status, 'failed');
  assert.equal(b.rel.length, 1, 'started again after the second stop');
});

test('0.5.1 relaunch, failed (the runner throws): Claude is started', async () => {
  const { rel, out, w } = await endState(() => ({ onPhase: (p) => { if (p === 'link') throw new Error('boom'); } }));
  assert.equal(out.exit, 'failed');
  assert.equal(res(w).status, 'failed');
  assert.equal(rel.length, 1);
});

test('0.5.1 relaunch, failed (the app never stopped): Claude was never quit, so it is not started', async () => {
  const { rel, out } = await endState(() => ({ timeouts: { stopMs: 2000 } }), { setup: (w) => w.setApp(true) });
  assert.equal(out.status, 'failed');
  assert.deepEqual(rel, []);
});

test('0.5.1 relaunch: --no-relaunch opts out in the rolled_back and failed end states too', async () => {
  const a = await endState(damage, { opts: { noRelaunch: true } });
  assert.equal(a.out.status, 'rolled_back');
  assert.deepEqual(a.rel, []);
  const b = await endState((w0) => ({ ...damage(w0), rollback: async () => ({ ok: false, code: 3 }) }), { opts: { noRelaunch: true } });
  assert.equal(b.out.status, 'failed');
  assert.deepEqual(b.rel, []);
});

test('0.5.1 replace: a runner waiting in wait-stop is ended, its stale limit dropped, and a new runner continues the same go-live', async () => {
  const w = world();
  w.setApp(true);
  const { d } = deps(w);
  const gl = start(w, d);
  const g = readGoLive(w.ctx); g.deadlines['wait-stop'] = 5; writeFileSync(goLiveFile(w.ctx), JSON.stringify(g));
  const child = fakeRunner();
  try {
    writeClaim(w, child.pid);                                   // a 0.5.0 runner: its claim has no version
    assert.equal(runnerAlive(w.ctx), true);
    const r = replaceWaitingRunner(w.ctx);
    assert.equal(r.replaced, true);
    assert.equal(alive(child.pid), false, 'the old runner is gone');
    assert.equal(existsSync(claimPath(w)), false);
    const after = readGoLive(w.ctx);
    assert.equal(after.id, gl.id);
    assert.equal(after.phase, 'wait-stop');
    assert.deepEqual(after.deadlines, {});
    assert.equal(res(w).status, 'waiting');
    assert.equal(loadState(w.ctx).linked, false, 'nothing was changed');
    w.setApp(false);
    const { d: d2 } = deps(w);
    assert.deepEqual(await runGoLive(w.ctx, d2), { exit: 'done', status: 'ok' });
    assert.equal(res(w).id, gl.id, 'the new runner finished the same go-live');
  } finally { try { child.kill(); } catch { /* gone */ } }
});

test('0.5.1 replace: refused in any other phase, for a runner of this version, with the app stopped, or with nothing waiting; nothing is ended', async () => {
  const kill = () => assert.fail('no process may be ended');
  assert.equal(replaceWaitingRunner(world().ctx, { kill }).reason, 'no-waiting-runner');
  // another phase (the link is done, verify is next)
  const busy = world();
  const { d } = deps(busy, { haltAfter: 'link' });
  start(busy, d);
  await runGoLive(busy.ctx, d);
  writeClaim(busy, process.ppid);
  assert.deepEqual(replaceWaitingRunner(busy.ctx, { kill, appRunning: () => true }), { replaced: false, reason: 'busy', phase: 'verify' });
  // a runner of this very version
  assert.ok(PLUGIN_VERSION, 'the plugin version is readable');
  const same = world(); start(same, deps(same).d);
  writeClaim(same, process.ppid, { version: PLUGIN_VERSION });
  assert.equal(replaceWaitingRunner(same.ctx, { kill, appRunning: () => true }).reason, 'current');
  // the app is stopped: the link is about to start and is not interrupted
  const stopped = world(); start(stopped, deps(stopped).d);
  writeClaim(stopped, process.ppid);
  assert.equal(replaceWaitingRunner(stopped.ctx, { kill, appRunning: () => false }).reason, 'app-stopped');
  assert.equal(readGoLive(stopped.ctx).phase, 'wait-stop');
});

test('0.5.1 hook restart: a dead runner in wait-stop is restarted once, never twice in a row, never past five, never beside a live one', async () => {
  const w = world();
  w.setApp(true);
  start(w, deps(w).d);
  const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
  writeClaim(w, dead);
  const launched = [];
  const launch = (a) => { launched.push(a); return { ok: true, method: 'test' }; };
  assert.equal(resumeIfDead(w.ctx, launch).resumed, true);
  assert.deepEqual(launched, [['accounts', 'golive-run']]);
  assert.deepEqual(resumeIfDead(w.ctx, launch), { resumed: false, reason: 'recent' }, 'two hooks that start together launch once');
  assert.equal(launched.length, 1);
  const stamp = join(w.acc, 'go-live-resume.json');
  const age = (tries) => writeFileSync(stamp, JSON.stringify({ id: readGoLive(w.ctx).id, at: w.ctx.now() - 3 * 60 * 1000, tries }));
  for (let tries = 1; tries < 5; tries++) { age(tries); assert.equal(resumeIfDead(w.ctx, launch).resumed, true); }
  age(5);
  assert.deepEqual(resumeIfDead(w.ctx, launch), { resumed: false, reason: 'gave-up' }, 'no respawn loop');
  // a live runner is left alone, and the count starts again
  writeClaim(w, process.ppid);
  assert.equal(resumeIfDead(w.ctx, () => assert.fail('a runner is alive')).resumed, false);
  assert.equal(existsSync(stamp), false);
  // a runner whose heartbeat went stale (a hung or frozen one, or a reboot that reused its pid) counts as gone
  writeClaim(w, process.ppid, { beatAt: w.ctx.now() - 20 * 60 * 1000 });
  assert.equal(resumeIfDead(w.ctx, launch).resumed, true);
});

test('0.5.1 hook restart: a failed go-live is not restarted by a session start (only an explicit go-live resumes it)', async () => {
  const w = world();
  w.setApp(true);
  const { d } = deps(w, { timeouts: { stopMs: 2000 } });
  start(w, d);
  assert.equal((await runGoLive(w.ctx, d)).status, 'failed');
  writeClaim(w, spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid);
  assert.equal(resumeIfDead(w.ctx, () => assert.fail('a failed go-live is not restarted')).resumed, false);
});

test('0.5.1 notices: the wait text leads with Restart Claude to sync your accounts, in the status line and the session notice', () => {
  const w = world();
  start(w, deps(w).d);
  const text = takeGoLiveReport(w.ctx) ?? '';
  assert.equal(text, '', 'a waiting runner is not announced before it has done something');
  const lead = /Restart Claude to sync your accounts: quit Claude from the tray icon or app menu/;
  const st = formatStatus(collectStatus(w.ctx, { probe: false })).join('\n');
  assert.match(st, new RegExp(`^${lead.source}`), 'the first line of accounts status');
  assert.match(st, /no time limit/);
  assert.match(st, /Closing the window only hides it/);
});

/* ------------------------------------------------------------------ 0.5.2: the stop waits go through the REAL probe (no seam) */

/** world() minus the seam: the app is a real lockfile plus an injected PowerShell answer (fixtures/probe-app.mjs). */
function probeWorld(opts) {
  const w = world(opts);
  delete process.env.SESSION_SYNC_TEST_APP_STATE;
  const app = makeProbeApp(w.ctx);
  return { ...w, ctx: app.ctx, app, setApp: (running) => app.setApp(running) };
}

test('0.5.2 wait-stop through the real probe: the app quits and no claude process is left (the 0.5.1 bug); the link starts within 3 readings', async () => {
  const w = probeWorld();
  w.app.start();
  let quitAt = 0;
  const { d, s } = deps(w, { appStatus: undefined, haltAfter: 'wait-stop', onSleep: (n) => { if (n === 3) { quitAt = n; w.app.quit(); } } });
  start(w, d);
  assert.deepEqual(await runGoLive(w.ctx, d), { exit: 'halted' });
  assert.equal(readGoLive(w.ctx).phase, 'relist');
  assert.ok(s.sleeps <= quitAt + 3, `slept ${s.sleeps} times, the app quit at sleep ${quitAt}`);
  assert.ok(w.app.probes >= 3, 'the process probe ran');
  const log = readFileSync(goLiveLogFile(w.ctx), 'utf8');
  assert.match(log, /app lock marker gone \(S1 true -> false\)/);
  assert.doesNotMatch(log, /WARN|is unknown/, 'a probe that answers is never reported as unknown');
});

test('0.5.2 wait-stop through the real probe: a quit that is undone within one reading does not start the link; the next quit does', async () => {
  const w = probeWorld();
  w.app.start();
  // sleep 2: quit; sleep 3: Claude is back before the second stopped reading; sleep 4: quit again
  const { d, s } = deps(w, { appStatus: undefined, haltAfter: 'wait-stop', onSleep: (n) => { if (n === 2) w.app.quit(); if (n === 3) w.app.start(); if (n === 4) w.app.quit(); } });
  start(w, d);
  assert.deepEqual(await runGoLive(w.ctx, d), { exit: 'halted' });
  assert.ok(s.sleeps >= 5, `the blip must not count (slept ${s.sleeps})`);
  const log = readFileSync(goLiveLogFile(w.ctx), 'utf8');
  assert.match(log, /app lock marker gone/);
  assert.match(log, /app lock marker is back \(S1 false -> true\) after \d+ ms/);
});

test('0.5.2 wait-stop: a probe that stays unknown while the lock marker is gone is logged with its reason, then a WARN, and the link waits for a real answer', async () => {
  const w = probeWorld();
  w.app.quit();
  w.app.broken = true;
  let t = 0;
  const { d } = deps(w, { appStatus: undefined, haltAfter: 'wait-stop', clock: () => (t += 1000), onSleep: (n) => { if (n === 30) w.app.broken = false; } });
  start(w, d);
  assert.deepEqual(await runGoLive(w.ctx, d), { exit: 'halted' }, 'it ends once the probe answers "no process"');
  const log = readFileSync(goLiveLogFile(w.ctx), 'utf8');
  assert.equal((log.match(/is unknown while the lock marker is gone/g) ?? []).length, 1, 'once, not once per poll');
  assert.match(log, /WARN: the process probe has been unknown for \d+ ms[^\n]*status 1[^\n]*boom/);
});

test('0.5.2 verify-stop through the real probe: the app comes back after the link, the check waits for the real stop and the go-live ends ok', async () => {
  const w = probeWorld();
  let came = false;
  const { d } = deps(w, {
    appStatus: undefined,
    onPhase: (p) => { if (p === 'verify' && !came) { came = true; w.app.start(); } },
    onSleep: (n) => { if (came && n % 6 === 0) w.app.quit(); },
  });
  start(w, d);
  const out = await runGoLive(w.ctx, d);
  assert.equal(out.status, 'ok', readFileSync(goLiveLogFile(w.ctx), 'utf8'));
  assert.match(readGoLive(w.ctx).messages.join('\n'), /The app is running; the check waits/);
  assert.match(readFileSync(goLiveLogFile(w.ctx), 'utf8'), /app lock marker is back/);
});

/* ------------------------------------------------------------------ 0.5.2: the progress indicator */

/** A recording UI layer for runGoLive (deps.ui). */
const fakeUi = (over = {}) => { const calls = []; return { calls, start: (i) => { calls.push(['start', i]); over.start?.(i); }, end: (r) => { calls.push(['end', r]); over.end?.(r); } }; };

test('progress: every phase has plain words, the tooltip fits a NotifyIcon, and the start and end texts say what happens', () => {
  for (const p of PHASES) {
    assert.ok(stepWord(p) && stepWord(p) !== 'working', `a word for phase ${p}`);
    assert.ok(tooltipFor(p).length <= 63, tooltipFor(p));
    assert.match(tooltipFor(p), /^Syncing accounts: /);
  }
  assert.equal(stepWord('relist'), 'backing up');
  assert.equal(stepWord('link'), 'backing up and linking');
  assert.equal(stepWord('verify'), 'checking');
  assert.equal(stepWord('relaunch'), 'reopening Claude');
  assert.equal(stepWord('wait-start'), 'reopening Claude');
  assert.equal(stepWord('finish'), 'finishing');
  assert.equal(stepWord('nonsense'), 'working');
  assert.equal(startText(), 'Syncing your Claude accounts. Claude will reopen by itself.');
  assert.match(startText({ noRelaunch: true }), /Open Claude again/);
  for (const s of FINAL_STATUSES) assert.ok(endText(s).length > 10 && !endText(s).includes('\u2014'), s);
  assert.match(endText('ok'), /linked/);
  assert.match(endText('rolled_back'), /undone.*nothing changed/);
  assert.match(endText('attention'), /needs your attention/);
  assert.deepEqual(progressInfo('verify', 'waiting'), { step: 'checking', tooltip: 'Syncing accounts: checking', headline: null });
  assert.equal(progressInfo('done', 'ok').headline, endText('ok'));
});

test('progress: the runner starts the UI when the link begins (not while waiting for the stop), writes the step into the result, and ends it once', async () => {
  const w = world();
  w.setApp(true);
  const ui = fakeUi({ start: () => { assert.equal(res(w).progress.tooltip, 'Syncing accounts: backing up', 'the result already holds the first step'); } });
  const { d } = deps(w, { ui, onSleep: (n) => { if (n === 2) w.setApp(false); } });
  start(w, d);
  assert.equal(res(w).progress.step, 'waiting for Claude to close');
  const out = await runGoLive(w.ctx, d);
  assert.equal(out.status, 'ok');
  assert.deepEqual(ui.calls.map((c) => c[0]), ['start', 'end'], 'one start and one end, none for the wait');
  assert.equal(ui.calls[0][1].resultFile, goLiveResultFile(w.ctx));
  assert.equal(ui.calls[0][1].logFile, goLiveLogFile(w.ctx));
  assert.equal(ui.calls[0][1].runnerPid, process.pid);
  assert.equal(ui.calls[0][1].noRelaunch, false);
  assert.equal(ui.calls[1][1].status, 'ok');
  assert.equal(ui.calls[1][1].headline, endText('ok'));
  assert.deepEqual(res(w).progress, { step: 'finishing', tooltip: 'Syncing accounts: finishing', headline: endText('ok') });
});

test('progress: while the runner only waits for the app to stop nothing is shown, and a rolled back go-live ends with its own text', async () => {
  const w = world();
  w.setApp(true);
  const idle = fakeUi();
  const { d: d1 } = deps(w, { ui: idle, haltAfter: 'wait-stop', onSleep: (n) => { if (n === 3) w.setApp(false); } });
  start(w, d1);
  assert.deepEqual(await runGoLive(w.ctx, d1), { exit: 'halted' });
  assert.deepEqual(idle.calls, [], 'the wait for the stop shows nothing');
  const rb = world();
  const ui = fakeUi();
  const { d } = deps(rb, { ui, ...damage(rb) });
  start(rb, d);
  const out = await runGoLive(rb.ctx, d);
  assert.equal(out.status, 'rolled_back');
  assert.deepEqual(ui.calls.map((c) => c[0]), ['start', 'end']);
  assert.equal(ui.calls[1][1].status, 'rolled_back');
  assert.equal(ui.calls[1][1].headline, endText('rolled_back'));
});

test('progress: an indicator that throws never stops the go-live, and --no-relaunch changes the start text input', async () => {
  const w = world();
  const ui = { start: () => { throw new Error('no tray'); }, end: () => { throw new Error('no tray either'); } };
  const { d } = deps(w, { ui });
  start(w, d);
  const out = await runGoLive(w.ctx, d);
  assert.equal(out.status, 'ok');
  assert.match(readFileSync(goLiveLogFile(w.ctx), 'utf8'), /progress indicator: no tray/);
  const w2 = world();
  const rec = fakeUi();
  const { d: d2 } = deps(w2, { ui: rec, timeouts: { startNoRelaunchMs: 1000 } });   // nobody starts Claude again: the run ends in attention
  start(w2, d2, { noRelaunch: true });
  await runGoLive(w2.ctx, d2);
  assert.equal(rec.calls[0][1].noRelaunch, true);
});

test('progress: createProgressUi on Windows starts one hidden, non-detached powershell helper with the files it reads; a failing spawn is swallowed', () => {
  const calls = [];
  const spawnFn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { on() {}, unref() {} }; };
  const ui = createProgressUi({ platform: 'win32', spawnFn, env: {} });
  ui.start({ resultFile: 'C:\\acc\\go-live-result.json', logFile: 'C:\\acc\\go-live.log', runnerPid: 4321, noRelaunch: false });
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.cmd, 'powershell.exe');
  assert.equal(c.opts.windowsHide, true);
  assert.notEqual(c.opts.detached, true);
  assert.deepEqual(c.args.slice(0, 7), ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', TRAY_SCRIPT]);
  const arg = (n) => c.args[c.args.indexOf(n) + 1];
  assert.equal(arg('-Result'), 'C:\\acc\\go-live-result.json');
  assert.equal(arg('-RunnerPid'), '4321');
  assert.equal(arg('-Log'), 'C:\\acc\\go-live.log');
  assert.equal(arg('-StartText'), 'Syncing your Claude accounts. Claude will reopen by itself.');
  assert.ok(existsSync(TRAY_SCRIPT), 'the helper script ships next to the module');
  ui.end({ status: 'ok' });
  assert.equal(calls.length, 1, 'on Windows the helper itself shows the end from the result file');
  assert.doesNotThrow(() => createProgressUi({ platform: 'win32', spawnFn: () => { throw new Error('spawn failed'); }, env: {} }).start({}));
});

test('progress: macOS and Linux get a notification at the start and one at the end; disabled and the test seam show nothing', () => {
  for (const platform of ['darwin', 'linux']) {
    const sent = [];
    const spawnFn = () => assert.fail('no helper process off Windows');
    const ui = createProgressUi({ platform, spawnFn, notifyFn: (t, b, o) => sent.push({ t, b, o }), env: {} });
    ui.start({ noRelaunch: false });
    ui.end({ status: 'rolled_back', headline: endText('rolled_back') });
    assert.equal(sent.length, 2, platform);
    assert.equal(sent[0].t, TITLE);
    assert.match(sent[0].b, /Claude will reopen by itself/);
    assert.equal(sent[1].b, endText('rolled_back'));
    assert.equal(sent[1].o.persist, true, 'a problem stays until dismissed');
    assert.ok(!createProgressUi({ platform, notifyFn: () => { throw new Error('x'); }, env: {} }).start());
  }
  let n = 0;
  const count = () => { n++; };
  createProgressUi({ enabled: false, platform: 'darwin', notifyFn: count, env: {} }).start({});
  createProgressUi({ platform: 'win32', spawnFn: count, env: { SESSION_SYNC_TEST_APP_STATE: 'x' } }).start({});
  createProgressUi({ platform: 'darwin', notifyFn: count, env: { SESSION_SYNC_TEST_APP_STATE: 'x' } }).end({ status: 'ok' });
  assert.equal(n, 0);
  createProgressUi({ platform: 'darwin', notifyFn: count, env: { SESSION_SYNC_TEST_APP_STATE: 'x', SESSION_SYNC_TEST_PROGRESS_UI: '1' } }).start({});
  assert.equal(n, 1);
});

test('progress: config progressIcon defaults to on and is described', () => {
  assert.equal(DEFAULTS.progressIcon, true);
  assert.equal(describeConfig({ ...DEFAULTS, remoteFrom: 'default' }).progressIcon, true);
  assert.equal(describeConfig({ ...DEFAULTS, progressIcon: false, remoteFrom: 'default' }).progressIcon, false);
});

/* the real helper script under real Windows PowerShell, in -DryRun (no icon, no message loop; what it would show goes to a trace file) */

const onWin = { skip: process.platform !== 'win32' ? 'Windows PowerShell only' : false };
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const resultDoc = (status, phase) => JSON.stringify({ v: 1, id: 'gl-1', status, phase, progress: progressInfo(phase, status) });

function trayRun(dir, { runnerPid, extra = [] }) {
  const resultFile = join(dir, 'go-live-result.json');
  const trace = join(dir, 'trace.txt');
  const logFile = join(dir, 'go-live.log');
  writeFileSync(logFile, 'x');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', TRAY_SCRIPT,
    '-Result', resultFile, '-RunnerPid', String(runnerPid), '-Log', logFile, '-StartText', startText(), '-DryRun', '-Trace', trace, '-PollMs', '100', '-LingerMs', '400', ...extra],
  { windowsHide: true, stdio: 'ignore' });
  const exited = new Promise((resolve) => { child.on('exit', (code) => resolve(code)); });
  const read = () => { try { return readFileSync(trace, 'utf8').split(/\r?\n/).filter(Boolean); } catch { return []; } };
  const until = async (pred, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred(read())) return true; await sleepMs(50); } return false; };
  return { child, exited, read, until, resultFile };
}

test('progress helper (real PowerShell, dry run): it exits on its own when the runner dies, without a final result', onWin, async () => {
  const dir = join(tmpdir(), `ss-tray-${Date.now()}-a`); mkdirSync(dir, { recursive: true });
  const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });   // a pid that has just ended
  writeFileSync(join(dir, 'go-live-result.json'), resultDoc('waiting', 'verify'));
  const h = trayRun(dir, { runnerPid: dead.pid });
  try {
    assert.equal(await Promise.race([h.exited, sleepMs(20000).then(() => 'hung')]), 0, 'exit code 0, no hang');
    const t = h.read();
    assert.ok(t.includes('balloon: Syncing your Claude accounts. Claude will reopen by itself.'), t.join('|'));
    assert.ok(t.includes('tip: Syncing accounts: checking'), t.join('|'));
    assert.ok(t.includes('exit: runner-gone'), t.join('|'));
    assert.ok(!t.some((l) => l.startsWith('balloon: ') && /linked|undone|stopped/.test(l)), 'no closing balloon for a dead runner');
  } finally { try { h.child.kill(); } catch { /* gone */ } rmSync(dir, { recursive: true, force: true }); }
});

test('progress helper (real PowerShell, dry run): the tooltip follows the result file, the closing balloon comes from it, then the icon is removed and it exits', onWin, async () => {
  const dir = join(tmpdir(), `ss-tray-${Date.now()}-b`); mkdirSync(dir, { recursive: true });
  const fake = fakeRunner();   // a live "runner"
  writeFileSync(join(dir, 'go-live-result.json'), resultDoc('waiting', 'relist'));
  const h = trayRun(dir, { runnerPid: fake.pid });
  try {
    assert.ok(await h.until((t) => t.includes('tip: Syncing accounts: backing up')), h.read().join('|'));
    writeFileSync(join(dir, 'go-live-result.json'), resultDoc('waiting', 'link'));
    assert.ok(await h.until((t) => t.includes('tip: Syncing accounts: backing up and linking')), h.read().join('|'));
    writeFileSync(join(dir, 'go-live-result.json'), resultDoc('waiting', 'relaunch'));
    assert.ok(await h.until((t) => t.includes('tip: Syncing accounts: reopening Claude')), h.read().join('|'));
    writeFileSync(join(dir, 'go-live-result.json'), resultDoc('attention', 'done'));
    assert.equal(await Promise.race([h.exited, sleepMs(20000).then(() => 'hung')]), 0);
    const t = h.read();
    assert.ok(t.includes(`balloon: ${endText('attention')} Click to open the log.`), t.join('|'));
    assert.equal(t.at(-1), 'exit: done', 'the icon is removed after the closing balloon');
    assert.ok(!t.includes('exit: runner-gone'));
    assert.ok(alive(fake.pid), 'the helper never touches the runner');
  } finally { fake.kill(); try { h.child.kill(); } catch { /* gone */ } rmSync(dir, { recursive: true, force: true }); }
});
