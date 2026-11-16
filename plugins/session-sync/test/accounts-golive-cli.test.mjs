/**
 * `accounts go-live` through the real cli.mjs as a child process, against a synthetic store in a
 * per-test home. The launch layer is the log seam (nothing is started) except in the one end-to-end
 * test, which runs the hidden `golive-run` itself with the app-state seam; no real app is touched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from '../lib/accounts/state.mjs';
import { pairKey } from '../lib/accounts/folders.mjs';
import { cworld, cleanupWorlds, A, B } from './fixtures/cliworld.mjs';

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
});

test('go-live while the app runs: tells the user to quit from the tray icon; --quit-app reports it cannot yet', () => {
  const w = cworld();
  w.setApp({ running: true, signedIn: A, startedAtMs: 1 });
  const r = run(w, ['accounts', 'go-live', '--yes']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /tray icon/);
  assert.match(r.stdout, /Claude is running/);
  const q = cworld();
  q.setApp({ running: true, signedIn: A, startedAtMs: 1 });
  const rq = run(q, ['accounts', 'go-live', '--yes', '--quit-app']);
  assert.equal(rq.status, 0, rq.stderr);
  // Windows and Linux: cannot quit from here, use the tray icon. macOS: the runner asks in a few seconds.
  assert.match(rq.stdout, process.platform === 'darwin' ? /asks Claude to quit in a few seconds/ : /cannot be quit from here[\s\S]*tray icon/);
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
