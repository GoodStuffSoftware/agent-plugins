/**
 * Remote Control wake (0.5.4): the UserPromptSubmit hook. One session per app restart gets the instruction; scheduled and other
 * unattended sessions never use the claim; nothing happens off Windows or when the setting is off; the command itself prints nothing
 * for every prompt that is not the one. Synthetic stores only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, readdirSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { makeRoot, addFolder, putRecord, uuid } from './fixtures/store.mjs';
import {
  decideWake, wakeInstruction, WAKE_MESSAGE, interactiveSession, recordForCliSession, wakeClaimFile, WAKE_BASELINE_MS, RC_DEFAULTS,
  RELINK_OWED_TEXT, relinkOwedFile, restorePassRanBefore, checkRelinkOwed, rcQuitStep,
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
const decide = (w, n, extra = {}) => decideWake(w.ctx, { settings: RC_DEFAULTS, sessionId: sid(n), now: w.now, projects: join(w.root, 'projects'), ...extra });
/** A transcript for session n whose last bridge-session entry is `bridge` (noHistoryBackfill:true is a link that needs a relink). */
function transcript(w, n, bridge = { noHistoryBackfill: true }) {
  const dir = join(w.root, 'projects', 'proj');
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${sid(n)}.jsonl`);
  // 0.5.10: a noHistoryBackfill link is a gone-bounce only when a different non-empty link came before it
  const before = bridge.noHistoryBackfill ? `${JSON.stringify({ type: 'bridge-session', sessionId: sid(n), bridgeSessionId: 'cse_prev', lastSequenceNum: 3 })}\n` : '';
  writeFileSync(f, `${JSON.stringify({ type: 'user', text: 'hi' })}\n${before}${JSON.stringify({ type: 'bridge-session', sessionId: sid(n), bridgeSessionId: 'cse_old', lastSequenceNum: 3, ...bridge })}\n`);
  return f;
}

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

/* ------------------------------------------------------------------ a relink left owed by a quit with Windows */

const noDashes = (t) => !new RegExp(`${String.fromCharCode(0x2014)}|${String.fromCharCode(0x2013)}`).test(t);

test('O1 a session that still needs a relink and no restore pass ran for the last stop: the claiming prompt is told, once, and the owed state is recorded', () => {
  const w = world();
  put(w, 1, {}); put(w, 2, {});
  transcript(w, 1);                                   // random-name link: rcPlan would relink it
  transcript(w, 2, { bridgeSessionId: '' });          // already cleared: not counted
  const first = decide(w, 1);
  assert.equal(first.act, true);
  assert.equal(first.relinkOwed, 1);
  assert.ok(first.text.includes(RELINK_OWED_TEXT), 'the instruction carries the sentence');
  assert.match(first.text, /quit Claude once from the tray icon \(not a Windows restart\)/);
  assert.ok(first.text.includes(WAKE_MESSAGE), 'the wake itself is unchanged');
  assert.ok(noDashes(first.text));
  const rec = JSON.parse(readFileSync(relinkOwedFile(w.ctx), 'utf8'));
  assert.deepEqual([rec.count, rec.acct, rec.notified, rec.startedAt], [1, ME, true, lockStartedAtMs(w.ctx)]);
  // every later prompt of this app run: nothing, and the check does not run again (the claim is the fast path)
  for (const n of [1, 2]) assert.deepEqual([decide(w, n).act, decide(w, n).reason, decide(w, n).text], [false, 'claimed', undefined]);
});

test('O2 nothing owed (no relink needed): the instruction is the plain wake, no sentence, no record', () => {
  const w = world();
  put(w, 1, {});
  transcript(w, 1, { noHistoryBackfill: false, ownerAccountUuid: ME });   // a titled link of this account
  const d = decide(w, 1);
  assert.equal(d.act, true);
  assert.equal(d.relinkOwed, undefined);
  assert.equal(d.text.includes(RELINK_OWED_TEXT), false);
  assert.equal(d.text, wakeInstruction({ days: RC_DEFAULTS.days, max: RC_DEFAULTS.wakeMax }));
  assert.equal(existsSync(relinkOwedFile(w.ctx)), false);
});

test('O3 a restore pass ran for the last stop (rc-restore.json stamped just before the launch): not owed, even if a link is left', () => {
  const w = world();
  put(w, 1, {});
  transcript(w, 1);
  mkdirSync(w.acc, { recursive: true });
  const run = lockStartedAtMs(w.ctx);
  writeFileSync(join(w.acc, 'rc-restore.json'), JSON.stringify({ v: 1, at: new Date(run - 5 * 60_000).toISOString(), acct: ME, relinked: 1, status: 'partial' }));
  assert.equal(restorePassRanBefore(w.ctx, run), true);
  const d = decide(w, 1);
  assert.equal(d.act, true);
  assert.equal(d.text.includes(RELINK_OWED_TEXT), false);
  assert.equal(existsSync(relinkOwedFile(w.ctx)), false);
  // a pass from an earlier stop (older than the life of a marker) does not count
  assert.equal(restorePassRanBefore(w.ctx, run + 3 * 3600_000), false);
  assert.equal(restorePassRanBefore(w.ctx, run + 30_000), true);
  assert.equal(restorePassRanBefore(w.ctx, run - 3 * 3600_000), false, 'a stamp from after the launch of that run is not one for its stop');
});

test('O4 a stale pass stamp (an earlier stop) does not hide an owed relink', () => {
  const w = world();
  put(w, 1, {});
  transcript(w, 1);
  mkdirSync(w.acc, { recursive: true });
  writeFileSync(join(w.acc, 'rc-restore.json'), JSON.stringify({ v: 1, at: new Date(lockStartedAtMs(w.ctx) - 2 * 86400_000).toISOString(), status: 'ok' }));
  assert.equal(decide(w, 1).relinkOwed, 1);
});

test('O5 each app run is one owed state: a later restart with the relink still owed is told again; once settled the record is dropped', () => {
  const w = world();
  put(w, 1, {});
  const tp = transcript(w, 1);
  const run = lockStartedAtMs(w.ctx);
  writeFileSync(wakeClaimFile(w.ctx, run - 60_000), '');   // an earlier run's claim: not a baseline
  assert.equal(decide(w, 1).relinkOwed, 1);
  assert.equal(existsSync(relinkOwedFile(w.ctx)), true);
  // the quit step settles it (the clearing line appended by rcrestore, as the real step does) -> the record goes with the next check
  writeFileSync(tp, `${readFileSync(tp, 'utf8')}${JSON.stringify({ type: 'bridge-session', sessionId: sid(1), bridgeSessionId: '', lastSequenceNum: 0 })}\n`);
  unlinkSync(wakeClaimFile(w.ctx, run));
  const again = decide(w, 1);
  assert.equal(again.act, true);
  assert.equal(again.relinkOwed, undefined);
  assert.equal(existsSync(relinkOwedFile(w.ctx)), false, 'nothing owed any more: the record is dropped');
});

test('O6 rcQuitStep drops the record when it settles the relink (and when nothing is to relink)', async () => {
  const w = world({ lock: false });
  put(w, 1, {});
  const tp = transcript(w, 1);
  mkdirSync(w.acc, { recursive: true });
  writeFileSync(relinkOwedFile(w.ctx), JSON.stringify({ v: 1, count: 1, notified: true }));
  const r = await rcQuitStep(w.ctx, { acct: ME, now: w.now, projects: join(w.root, 'projects'), stopped: () => true });
  assert.equal(r.ran, true);
  assert.equal(r.res.relinked, 1);
  assert.equal(existsSync(relinkOwedFile(w.ctx)), false, 'relinked: the record is gone');
  assert.match(readFileSync(tp, 'utf8'), /"bridgeSessionId":"","lastSequenceNum":0\}\n$/);
  // a refused step (the app is running) keeps it
  writeFileSync(tp, `${JSON.stringify({ type: 'bridge-session', sessionId: sid(1), bridgeSessionId: 'cse_prev', lastSequenceNum: 3 })}\n${JSON.stringify({ type: 'bridge-session', sessionId: sid(1), bridgeSessionId: 'cse_x', noHistoryBackfill: true })}\n`);
  writeFileSync(relinkOwedFile(w.ctx), JSON.stringify({ v: 1, count: 1, notified: true }));
  const r2 = await rcQuitStep(w.ctx, { acct: ME, now: w.now, projects: join(w.root, 'projects'), stopped: () => false });
  assert.equal(r2.res.status, 'refused_app_running');
  assert.equal(existsSync(relinkOwedFile(w.ctx)), true, 'refused: still owed');
});

test('O7 the owed check never throws or fails the wake: an unreadable store and a missing transcripts folder give the plain wake', () => {
  const w = world();
  put(w, 1, {});
  const d = decide(w, 1, { projects: join(w.root, 'no-such-folder') });
  assert.equal(d.act, true);
  assert.equal(d.relinkOwed, undefined);
  assert.equal(checkRelinkOwed(w.ctx, { startedAt: undefined, acct: undefined }), null);
  assert.equal(checkRelinkOwed({}, {}), null);
});

test('O8 the baseline (a plugin installed into a long-running app) is not an owed state: no sentence, no record', () => {
  const w = world();
  put(w, 1, {});
  transcript(w, 1);
  const d = decide(w, 1, { now: w.now + WAKE_BASELINE_MS + 60_000 });
  assert.equal(d.reason, 'baseline');
  assert.equal(existsSync(relinkOwedFile(w.ctx)), false);
});

test('O9 the sentence is one plain sentence naming the tray icon and not a Windows restart, with no em dash', () => {
  assert.match(RELINK_OWED_TEXT, /tray icon/);
  assert.match(RELINK_OWED_TEXT, /not a Windows restart/);
  assert.equal(RELINK_OWED_TEXT.split(/[.!?]\s/).length, 1);
  assert.ok(noDashes(RELINK_OWED_TEXT));
  assert.match(wakeInstruction({ relinkOwed: true }), /beyond those three lines/);
  assert.match(wakeInstruction({ relinkOwed: false }), /beyond those two lines/);
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
  const t = wakeInstruction({ days: 5, max: 6 });
  assert.match(t, /Reconnecting Remote Control for your recent sessions/);
  assert.match(t, /Remote Control: N sessions reconnected, M still off\./);
  assert.match(t, /within the last 5 days/);
  assert.match(t, /at most 6 sessions, the most recently active first/);
  assert.match(wakeInstruction(), /at most 4 sessions/);
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
  assert.equal(h.timeout, 30, "the claiming prompt may run the live relink (up to three hidden process listings): not the old 10");
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
  // session 1 is on a random-name link (rcPlan would relink it) and no restore pass ran: the first instruction carries the owed sentence
  const projects = join(process.env.HOME, '.claude', 'projects', 'proj');
  mkdirSync(projects, { recursive: true });
  writeFileSync(join(projects, `${sid(1)}.jsonl`), `${JSON.stringify({ type: 'bridge-session', sessionId: sid(1), bridgeSessionId: 'cse_prev', lastSequenceNum: 3 })}\n${JSON.stringify({ type: 'bridge-session', sessionId: sid(1), bridgeSessionId: 'cse_old', noHistoryBackfill: true, lastSequenceNum: 1 })}\n`);
  const prompt = (n) => JSON.stringify({ session_id: sid(n), prompt: 'please continue', hook_event_name: 'UserPromptSubmit' });
  const sched = run(prompt(2));
  assert.equal(sched.status, 0, sched.stderr);
  assert.equal(sched.stdout, '', 'a scheduled task does not get it and does not use the claim');
  const first = run(prompt(1));
  assert.equal(first.status, 0, first.stderr);
  const out = JSON.parse(first.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.ok(out.hookSpecificOutput.additionalContext.includes(WAKE_MESSAGE));
  assert.ok(out.hookSpecificOutput.additionalContext.includes(RELINK_OWED_TEXT), 'the owed relink is flagged to the user');
  assert.equal(run(prompt(1)).stdout, '', 'one session per restart, the sentence once');
  // turned off in the config: even a fresh run of the app is not woken
  unlinkSync(join(userData, 'lockfile'));
  const cfgDir = join(process.env.HOME, '.claude', 'session-sync');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ rcRestore: { wake: false } }));
  writeFileSync(join(userData, 'lockfile'), '');
  assert.equal(run(prompt(1)).stdout, '');
});
