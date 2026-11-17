/**
 * `accounts go-live` through the real cli.mjs as a child process, against a synthetic store in a
 * per-test home. The launch layer is the log seam (nothing is started) except in the one end-to-end
 * test, which runs the hidden `golive-run` itself with the app-state seam; no real app is touched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { readJson } from '../lib/accounts/state.mjs';
import { pairKey, answerPairs } from '../lib/accounts/folders.mjs';
import { PLUGIN_VERSION } from '../lib/accounts/golive.mjs';
import { cworld, cleanupWorlds, A, B } from './fixtures/cliworld.mjs';
import { addFolder, putRecord, uuid } from './fixtures/store.mjs';

test.after(() => cleanupWorlds());

const launchLog = (w) => join(w.home, 'launch.log');
const launched = (w) => (existsSync(launchLog(w)) ? readFileSync(launchLog(w), 'utf8').trim().split('\n').map((l) => JSON.parse(l).args) : []);
const run = (w, args, env = {}) => w.run(args, { SESSION_SYNC_TEST_LAUNCH_LOG: launchLog(w), ...env });

test('go-live without --yes and without a terminal changes nothing and says to pass --yes', () => {
  const w = cworld();
  const r = run(w, ['accounts', 'go-live']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stdout, /--yes/);
  assert.equal(w.state()?.pairs?.[pairKey(A, B)]?.answer, undefined);
  assert.deepEqual(launched(w), []);
  assert.equal(existsSync(join(w.acc, 'go-live.json')), false);
});

test('go-live --yes (app stopped): consent recorded, state and result saved, ONE detached runner launched', () => {
  const w = cworld();
  const r = run(w, ['accounts', 'go-live', '--yes', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.started, true);
  assert.equal(out.runner.method, 'test-log');
  assert.deepEqual(launched(w), [['accounts', 'golive-run']]);
  assert.equal(w.state().pairs[pairKey(A, B)].answer, 'yes');
  const res = readJson(join(w.acc, 'go-live-result.json'));
  assert.equal(res.status, 'waiting');
  assert.equal(res.counts.expected, 4);
  assert.ok(readJson(join(w.acc, 'go-live.json')).expected.length === 4);
  // status shows it
  const st = run(w, ['accounts', 'status']);
  assert.match(st.stdout, /Go-live: waiting \(phase wait-stop\)/);
  assert.match(st.stdout.split('\n')[0], /^Restart Claude to sync your accounts/, 'status leads with the one line while a go-live waits');
});

test('go-live while the app runs: tells the user to quit from the tray icon; --quit-app reports it cannot yet', () => {
  const w = cworld();
  w.setApp({ running: true, signedIn: A, startedAtMs: 1 });
  const r = run(w, ['accounts', 'go-live', '--yes']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.split('\n')[0], /^Restart Claude to sync your accounts: quit Claude from the tray icon or app menu, the sync starts right away and Claude reopens by itself when it is done\./, 'the one line leads');
  assert.match(r.stdout, /no time limit/);
  assert.match(r.stdout, /Closing the window only hides it/);
  assert.match(r.stdout, /Claude is running/);
  const q = cworld();
  q.setApp({ running: true, signedIn: A, startedAtMs: 1 });
  const rq = run(q, ['accounts', 'go-live', '--yes', '--quit-app']);
  assert.equal(rq.status, 0, rq.stderr);
  // Windows and Linux: cannot quit from here, use the tray icon. macOS: the runner asks in a few seconds.
  assert.match(rq.stdout, process.platform === 'darwin' ? /asks Claude to quit in a few seconds/ : /Restart Claude to sync your accounts[\s\S]*cannot be quit from here/);
});

test('go-live refuses an already linked store and a single account', () => {
  const w = cworld();
  w.putState((s) => { s.linked = true; });
  const r = run(w, ['accounts', 'go-live', '--yes', '--json']);
  assert.equal(r.status, 3);
  assert.equal(JSON.parse(r.stdout).reason, 'already-linked');
  const one = cworld({ accounts: 1 });
  const r1 = run(one, ['accounts', 'go-live', '--yes', '--json']);
  assert.equal(r1.status, 3);
  assert.equal(JSON.parse(r1.stdout).reason, 'one-account');
  assert.deepEqual(launched(w), []);
});

test('go-live while a go-live is in progress with no live runner resumes it (one new runner, no new consent)', () => {
  const w = cworld();
  assert.equal(run(w, ['accounts', 'go-live', '--yes']).status, 0);
  const again = run(w, ['accounts', 'go-live', '--yes', '--json']);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).resumed, true);
  assert.deepEqual(launched(w), [['accounts', 'golive-run'], ['accounts', 'golive-run']]);
});

test('end to end: the hidden runner links, verifies, relaunches through the seam and writes an ok result', () => {
  const w = cworld();
  assert.equal(run(w, ['accounts', 'go-live', '--yes']).status, 0);
  const r = run(w, ['accounts', 'golive-run']);
  assert.equal(r.status, 0, r.stderr);
  const res = readJson(join(w.acc, 'go-live-result.json'));
  assert.ok(['ok', 'attention'].includes(res.status), JSON.stringify(res));
  assert.equal(res.counts.split, 0);
  assert.equal(res.counts.missing, 0);
  assert.equal(res.counts.ids, 4);
  assert.equal(w.state().linked, true);
  assert.equal(readJson(w.appFile).running, true, 'the relaunch seam started the (fake) app');
  assert.ok(existsSync(res.rollbackScript));
  const log = readFileSync(join(w.acc, 'go-live.log'), 'utf8');
  assert.match(log, /phase: wait-stop/);
  assert.match(log, /result: (ok|attention)/);
  // a second run is a no-op
  assert.equal(run(w, ['accounts', 'golive-run']).status, 0);
  // the status line
  assert.match(run(w, ['accounts', 'status']).stdout, /Go-live: (ok|attention)/);
});

test('SessionStart hook: a final go-live result is added to the context once, in the same single JSON object as an ask', () => {
  const w = cworld();
  mkdirSync(w.acc, { recursive: true });
  writeFileSync(join(w.acc, 'go-live-result.json'), JSON.stringify({
    v: 1, id: 'gl-9', status: 'ok', phase: 'done', resumable: false, counts: { expected: 4, folders: 2, remoteDuplicates: 0 },
    messages: [], attention: [], log: join(w.acc, 'go-live.log'),
  }));
  const a = w.run(['auto-pull', '--from-hook']);
  assert.equal(a.status, 0, a.stderr);
  const obj = JSON.parse(a.stdout.trim());                 // one JSON value only
  assert.equal(obj.hookSpecificOutput.hookEventName, 'SessionStart');
  const text = obj.hookSpecificOutput.additionalContext;
  assert.match(text, /go-live finished/);
  assert.match(text, /4 conversation\(s\) in 2 folder\(s\)/);
  assert.match(text, /accounts answer yes/, 'the pending-pair ask rides along in the same object');
  assert.match(text, /Restart Claude to sync your accounts/, 'the ask leads with the one line');
  const b = w.run(['auto-pull', '--from-hook']);
  assert.equal(b.stdout, '', 'reported once; the ask is also once a day');
});

test('hidden launch-detached (the helper the SessionStart hook starts) launches only the waiter or the go-live runner', () => {
  const w = cworld();
  const ok = run(w, ['accounts', 'launch-detached', 'accounts', 'wait', '--reason', 'link']);
  assert.equal(ok.status, 0, ok.stderr);
  const rn = run(w, ['accounts', 'launch-detached', 'accounts', 'golive-run']);
  assert.equal(rn.status, 0, rn.stderr);
  assert.deepEqual(launched(w), [['accounts', 'wait', '--reason', 'link'], ['accounts', 'golive-run']]);
  const bad = run(w, ['accounts', 'launch-detached', 'push']);
  assert.equal(bad.status, 1);
  const bad2 = run(w, ['accounts', 'launch-detached', 'accounts', 'rollback']);
  assert.equal(bad2.status, 1);
  assert.equal(launched(w).length, 2, 'nothing else was launched');
});

/* ------------------------------------------------------------------ 0.5.1 */

/** A stand-in for a runner: an idle, hidden node process. Only it is ever ended by these tests. */
const fakeRunner = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const runners = (w) => launched(w).filter((a) => a[1] === 'golive-run').length;
const claimOf = (w, pid, extra = {}) => writeFileSync(join(w.acc, 'go-live.claim'), JSON.stringify({ pid, at: Date.now(), beatAt: Date.now(), ...extra }));

test('go-live run again while a runner waits in wait-stop replaces a runner of another version (same id and state); one of this version is left alone', () => {
  const w = cworld();
  w.setApp({ running: true, signedIn: A, startedAtMs: 1 });
  assert.equal(run(w, ['accounts', 'go-live', '--yes']).status, 0);
  const id = readJson(join(w.acc, 'go-live.json')).id;
  const old = fakeRunner(); const cur = fakeRunner();
  try {
    claimOf(w, old.pid);                                         // a 0.5.0 runner: no version in its claim
    const r = run(w, ['accounts', 'go-live', '--yes', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.replaced, true);
    assert.equal(out.toVersion, PLUGIN_VERSION);
    assert.equal(alive(old.pid), false, 'the old runner was ended');
    assert.equal(runners(w), 2, 'one new runner was launched');
    const gl = readJson(join(w.acc, 'go-live.json'));
    assert.equal(gl.id, id);
    assert.equal(gl.phase, 'wait-stop');
    assert.equal(readJson(join(w.acc, 'go-live-result.json')).status, 'waiting');
    // a runner of this version: not touched, and the text says it waits without a limit
    claimOf(w, cur.pid, { version: PLUGIN_VERSION });
    const again = run(w, ['accounts', 'go-live', '--yes']);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /already running/);
    assert.match(again.stdout, /no time limit/);
    assert.equal(alive(cur.pid), true);
    assert.equal(runners(w), 2);
  } finally { for (const c of [old, cur]) { try { c.kill(); } catch { /* gone */ } } }
});

test('go-live run again in any other phase than wait-stop does not touch the runner', () => {
  const w = cworld();
  w.setApp({ running: true, signedIn: A, startedAtMs: 1 });
  assert.equal(run(w, ['accounts', 'go-live', '--yes']).status, 0);
  const gl = readJson(join(w.acc, 'go-live.json'));
  writeFileSync(join(w.acc, 'go-live.json'), JSON.stringify({ ...gl, phase: 'verify' }));
  const busy = fakeRunner();
  try {
    claimOf(w, busy.pid);
    const r = run(w, ['accounts', 'go-live', '--yes']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /already running/);
    assert.equal(alive(busy.pid), true);
    assert.equal(runners(w), 1);
  } finally { try { busy.kill(); } catch { /* gone */ } }
});

test('SessionStart hook: a go-live in wait-stop whose runner is gone gets ONE runner through the launcher, never a second', () => {
  const w = cworld();
  w.setApp({ running: true, signedIn: A, startedAtMs: 1 });
  assert.equal(run(w, ['accounts', 'go-live', '--yes']).status, 0);   // its launch is only logged: no runner holds the claim
  assert.equal(runners(w), 1);
  assert.equal(run(w, ['auto-pull', '--from-hook']).status, 0);
  assert.equal(runners(w), 2, 'the hook launched the runner again');
  assert.equal(run(w, ['auto-pull', '--from-hook']).status, 0);
  assert.equal(runners(w), 2, 'not twice in a row');
});

test('SessionStart hook: a failed go-live is not restarted', () => {
  const w = cworld();
  w.setApp({ running: true, signedIn: A, startedAtMs: 1 });
  assert.equal(run(w, ['accounts', 'go-live', '--yes']).status, 0);
  const res = join(w.acc, 'go-live-result.json');
  writeFileSync(res, JSON.stringify({ ...readJson(res), status: 'failed', resumable: true }));
  assert.equal(run(w, ['auto-pull', '--from-hook']).status, 0);
  assert.equal(runners(w), 1);
});

test('scope: once the accounts are linked nothing asks the user to restart or quit; owed work waits silently', () => {
  const w = cworld();
  w.setApp({ running: true, signedIn: A, startedAtMs: 1 });
  w.putState((s) => { answerPairs(s, [pairKey(A, B)], 'yes', 'cli', Date.now()); s.linked = true; s.fullPassOwed = true; });
  mkdirSync(w.acc, { recursive: true });
  writeFileSync(join(w.acc, 'hook-rectify.stamp'), String(Date.now()));   // the hook does not start a rectify of its own here
  const hook = run(w, ['auto-pull', '--from-hook']);
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(hook.stdout, '', 'the session start adds no notice');
  const st = run(w, ['accounts', 'status']);
  assert.equal(st.status, 0, st.stderr);
  assert.match(st.stdout, /Linked: yes/);
  assert.doesNotMatch(st.stdout, /Restart Claude|tray icon|quit/i);
  const rect = run(w, ['accounts', 'link']);   // a link when already linked prints nothing that asks for a quit either
  assert.doesNotMatch(rect.stdout, /Restart Claude/);
});

test('scope: the restart prompt appears once per new unlinked account, never after the link', () => {
  const w = cworld();
  const ask = (r) => { assert.equal(r.status, 0, r.stderr); return r.stdout.trim() ? JSON.parse(r.stdout.trim()).hookSpecificOutput.additionalContext : ''; };
  // the first sign-in of a second account: asked once
  const first = ask(run(w, ['auto-pull', '--from-hook']));
  assert.match(first, /^session-sync: Restart Claude to sync your accounts: quit Claude from the tray icon or app menu/);
  assert.equal(ask(run(w, ['auto-pull', '--from-hook'])), '', 'not asked again');
  // yes, and the link is done
  w.putState((s) => { answerPairs(s, [pairKey(A, B)], 'yes', 'cli', Date.now()); s.linked = true; });
  writeFileSync(join(w.acc, 'hook-rectify.stamp'), String(Date.now()));
  assert.equal(ask(run(w, ['auto-pull', '--from-hook'])), '', 'no prompt once linked');
  // a third account appears later: it is asked once
  const C = uuid('c', 7);
  putRecord(addFolder(w.store, C, uuid('3', 3)).path, 9, { title: 'C 9' }, 1_800_000_000_000);
  const third = ask(run(w, ['auto-pull', '--from-hook']));
  assert.match(third, /Restart Claude to sync your accounts/);
  assert.ok(third.includes(C.slice(0, 8)), 'it names the new account');
  assert.equal(ask(run(w, ['auto-pull', '--from-hook'])), '', 'once per new account');
});
