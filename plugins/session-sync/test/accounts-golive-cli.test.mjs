/**
 * `accounts go-live` through the real cli.mjs as a child process, against a synthetic store in a
 * per-test home. The launch layer is the log seam (nothing is started) except in the one end-to-end
 * test, which runs the hidden `golive-run` itself with the app-state seam; no real app is touched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
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
  assert.match(rq.stdout, /cannot be quit from here yet/);
  assert.match(rq.stdout, /tray icon/);
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
