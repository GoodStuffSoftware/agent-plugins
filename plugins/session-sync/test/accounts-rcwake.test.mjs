/**
 * Remote Control wake (0.5.4): the UserPromptSubmit hook. One session per app restart gets the instruction; scheduled and other
 * unattended sessions never use the claim; nothing happens off Windows or when the setting is off; the command itself prints nothing
 * for every prompt that is not the one. Synthetic stores only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readdirSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { makeRoot, addFolder, putRecord, uuid } from './fixtures/store.mjs';
import {
  decideWake, wakeInstruction, WAKE_MESSAGE, interactiveSession, recordForCliSession, wakeClaimFile, WAKE_BASELINE_MS, RC_DEFAULTS,
} from '../lib/accounts/rcrestore.mjs';
import { lockStartedAtMs } from '../lib/accounts/appstate.mjs';

const ME = uuid('a', 1);
const ORG = uuid('f', 1);

function world({ lock = true } = {}) {
  const r = makeRoot('wake');
  writeFileSync(join(r.userData, 'config.json'), JSON.stringify({ lastKnownAccountUuid: ME }));
  const folder = addFolder(r.store, ME, ORG);
  r.ctx.platform = 'win32';
  if (lock) writeFileSync(join(r.userData, 'lockfile'), '');
  return { ...r, folder, now: Date.now() };
}
const sid = (n) => uuid('d', n);
const put = (w, n, over = {}) => putRecord(w.folder.path, n, { lastActivityAt: new Date(w.now - 60_000).toISOString(), ...over });
const decide = (w, n, extra = {}) => decideWake(w.ctx, { settings: RC_DEFAULTS, sessionId: sid(n), now: w.now, ...extra });

test('K1 the first qualifying prompt after a restart gets the instruction; every later one, in any session, does not (exactly one)', () => {
  const w = world();
  for (let n = 1; n <= 4; n++) put(w, n);
  const first = decide(w, 1);
  assert.equal(first.act, true);
  assert.match(first.text, /list_sessions/);
  assert.ok(first.text.includes(WAKE_MESSAGE));
  for (const n of [1, 2, 3, 4]) assert.deepEqual([decide(w, n).act, decide(w, n).reason], [false, 'claimed']);
});

test('K2 exactly one of several sessions that prompt at the same moment acts (the claim is an exclusive create)', async () => {
  const w = world();
  for (let n = 1; n <= 8; n++) put(w, n);
  const results = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(async (n) => decide(w, n)));
  assert.equal(results.filter((r) => r.act).length, 1);
});

test('K3 a scheduled task, an archived or a cloud session never uses the claim; the next interactive one does', () => {
  const w = world();
  put(w, 1, { scheduledTaskId: 'nightly' });
  put(w, 2, { isArchived: true });
  put(w, 3, { movedToCloud: true });
  put(w, 4, {});
  for (const n of [1, 2, 3]) assert.deepEqual([decide(w, n).act, decide(w, n).reason], [false, 'not-interactive']);
  assert.equal(readdirSync(w.acc).some((x) => x.startsWith('rc-wake-')), false, 'no claim was taken');
  assert.equal(decide(w, 4).act, true);
});

test('K4 a session the app has no record of (a CLI run outside the app, a subagent) never claims', () => {
  const w = world();
  put(w, 1, {});
  assert.deepEqual([decide(w, 9).act, decide(w, 9).reason], [false, 'no-record']);
  assert.deepEqual([decideWake(w.ctx, { settings: RC_DEFAULTS, sessionId: 'not-a-uuid', now: w.now }).act], [false]);
  assert.equal(decide(w, 1).act, true);
});

test('K5 a record of another account is not a match', () => {
  const w = world();
  const other = addFolder(w.store, uuid('b', 2), ORG);
  putRecord(other.path, 5, { lastActivityAt: new Date(w.now).toISOString() });
  assert.equal(decide(w, 5).reason, 'no-record');
});

test('K6 the claim is keyed to the app run (the creation time of the lock marker): the run that claimed is done, another run is a new restart', () => {
  // (Windows keeps the creation time of a file that is deleted and created again within about 15 seconds, so a relaunch that fast
  // reads as the same run: no second wake. That is the same latch the stop watch of 0.5.3 uses.)
  const w = world();
  put(w, 1, {});
  const run = lockStartedAtMs(w.ctx);
  assert.ok(run > 0);
  writeFileSync(wakeClaimFile(w.ctx, run - 60_000), '');          // an earlier run's claim
  assert.equal(decide(w, 1).act, true, 'the earlier run does not block this one');
  assert.equal(decide(w, 1).act, false, 'this run has claimed');
  assert.equal(existsSync(wakeClaimFile(w.ctx, run)), true);
});

test('K7 no app running, no latch, wrong platform and the settings that turn it off: no claim, no text', () => {
  const closed = world({ lock: false });
  put(closed, 1, {});
  assert.equal(decide(closed, 1).reason, 'app-not-running');
  const w = world();
  put(w, 1, {});
  assert.equal(decide(w, 1, { platform: 'darwin' }).reason, 'platform');
  assert.equal(decide(w, 1, { platform: 'linux' }).reason, 'platform');
  assert.equal(decide(w, 1, { settings: { enabled: false, days: 3, wake: true } }).reason, 'disabled');
  assert.equal(decide(w, 1, { settings: { enabled: true, days: 3, wake: false } }).reason, 'disabled');
  assert.equal(readdirSync(w.acc).some((x) => x.startsWith('rc-wake-')), false);
  assert.equal(decide(w, 1).act, true);
});

test('K8 the very first claim on a machine, from an app run that is old, is a baseline: no instruction, and the claim is taken', () => {
  const w = world();
  put(w, 1, {});
  const old = decide(w, 1, { now: w.now + WAKE_BASELINE_MS + 60_000 });
  assert.deepEqual([old.act, old.reason], [false, 'baseline']);
  assert.equal(decide(w, 1).reason, 'claimed');
  // a later restart on the same machine is not a baseline
  const w2 = world();
  put(w2, 1, {});
  writeFileSync(wakeClaimFile(w2.ctx, 12345), '');
  assert.equal(decide(w2, 1, { now: w2.now + WAKE_BASELINE_MS + 60_000 }).act, true);
});

test('K9 old claim markers are pruned, the last few kept', () => {
  const w = world();
  put(w, 1, {});
  mkdirSync(w.acc, { recursive: true });
  for (let i = 1; i <= 8; i++) writeFileSync(wakeClaimFile(w.ctx, i), '');
  assert.equal(decide(w, 1).act, true);
  assert.ok(readdirSync(w.acc).filter((x) => /^rc-wake-\d+$/.test(x)).length <= 5);
  assert.equal(existsSync(wakeClaimFile(w.ctx, lockStartedAtMs(w.ctx))), true, 'the claim just taken is kept');
});

test('K10 interactiveSession and recordForCliSession', () => {
  assert.equal(interactiveSession({}), true);
  assert.equal(interactiveSession({ scheduledTaskId: 'x' }), false);
  assert.equal(interactiveSession({ isArchived: true }), false);
  assert.equal(interactiveSession({ backend: { kind: 'ssh' } }), false);
  assert.equal(interactiveSession(null), false);
  const w = world();
  put(w, 1, {});
  assert.equal(recordForCliSession(w.ctx, ME, sid(1)).rec.cliSessionId, sid(1));
  assert.equal(recordForCliSession(w.ctx, ME, sid(2)), null);
  assert.equal(recordForCliSession(w.ctx, uuid('b', 9), sid(1)), null);
});

test('K11 the instruction: both one-line messages, the exact wake message, the window, the refusal rule, no em dashes', () => {
  const t = wakeInstruction({ days: 5 });
  assert.match(t, /Reconnecting Remote Control for your recent sessions/);
  assert.match(t, /Remote Control: N sessions reconnected, M still off\./);
  assert.match(t, /within the last 5 days/);
  assert.match(t, /remoteControlActive false/);
  assert.match(t, /refused/);
  assert.match(t, /not a scheduled task/);
  assert.equal(WAKE_MESSAGE, 'Remote Control reconnect after the Claude app restart. No action needed: reply with the single word ok. Do not run any tools or resume any work.');
  assert.equal(new RegExp(`${String.fromCharCode(0x2014)}|${String.fromCharCode(0x2013)}`).test(t + WAKE_MESSAGE), false);
});

/* ------------------------------------------------------------------ the command */

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'lib', 'cli.mjs');
const run = (input, env = {}) => spawnSync(process.execPath, [CLI, 'rc-wake', '--from-hook'], {
  input, encoding: 'utf8', windowsHide: true, timeout: 20_000, env: { ...process.env, ...env },
});

test('K12 the command: off Windows, or with no usable input, it prints nothing and exits 0; it never throws', () => {
  for (const input of ['', 'not json', '{}', JSON.stringify({ session_id: sid(1), prompt: '' }), JSON.stringify({ session_id: sid(1), prompt: '/clear' })]) {
    const r = run(input);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
  }
});

test('K13 the hooks file registers the command on UserPromptSubmit with no matcher and a short timeout', async () => {
  const { readFileSync } = await import('node:fs');
  const hooks = JSON.parse(readFileSync(join(HERE, '..', 'hooks', 'hooks.json'), 'utf8')).hooks;
  const entry = hooks.UserPromptSubmit;
  assert.equal(entry.length, 1);
  assert.equal(entry[0].matcher, undefined);
  const h = entry[0].hooks[0];
  assert.deepEqual(h.args.slice(1), ['rc-wake', '--from-hook']);
  assert.ok(h.timeout <= 10);
  assert.equal(hooks.SessionStart.some((e) => JSON.stringify(e).includes('rc-wake')), false, 'not on SessionStart');
});

// A real run of the command inside the test sandbox (APPDATA, HOME and the state folder are redirected by test/sandbox-env.mjs): Windows
// only, because the wake is Windows only. Skipped when the sandbox is not active, so it can never reach a real store.
test('K14 the command end to end: the first prompt of an interactive session gets the instruction as UserPromptSubmit context, nobody else does', { skip: process.platform !== 'win32' || !process.env.SESSION_SYNC_TEST_SANDBOX }, () => {
  const userData = join(process.env.APPDATA, 'Claude');
  const store = join(userData, 'claude-code-sessions');
  mkdirSync(store, { recursive: true });
  writeFileSync(join(userData, 'config.json'), JSON.stringify({ lastKnownAccountUuid: ME }));
  writeFileSync(join(userData, 'lockfile'), '');
  const folder = addFolder(store, ME, ORG);
  putRecord(folder.path, 1, { lastActivityAt: new Date().toISOString() });
  putRecord(folder.path, 2, { lastActivityAt: new Date().toISOString(), scheduledTaskId: 'nightly' });
  const prompt = (n) => JSON.stringify({ session_id: sid(n), prompt: 'please continue', hook_event_name: 'UserPromptSubmit' });
  const sched = run(prompt(2));
  assert.equal(sched.status, 0, sched.stderr);
  assert.equal(sched.stdout, '', 'a scheduled task does not get it and does not use the claim');
  const first = run(prompt(1));
  assert.equal(first.status, 0, first.stderr);
  const out = JSON.parse(first.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.ok(out.hookSpecificOutput.additionalContext.includes(WAKE_MESSAGE));
  assert.equal(run(prompt(1)).stdout, '', 'one session per restart');
  // turned off in the config: even a fresh run of the app is not woken
  unlinkSync(join(userData, 'lockfile'));
  const cfgDir = join(process.env.HOME, '.claude', 'session-sync');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ rcRestore: { wake: false } }));
  writeFileSync(join(userData, 'lockfile'), '');
  assert.equal(run(prompt(1)).stdout, '');
});
