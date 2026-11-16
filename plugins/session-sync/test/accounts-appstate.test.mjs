/**
 * T2 - app state: mocked S1/S2 combinations, the stale-lockfile rule, process
 * probe parsing, the live-folder set, and readSignedIn on a synthetic
 * config.json that carries fake oauth keys.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appState, evaluateRunning, readSignedIn, desktopProcesses, lockfilePresent, liveFolders, noteSignedIn,
  makeS1Guard, AppRunningError,
} from '../lib/accounts/appstate.mjs';
import { emptyState } from '../lib/accounts/state.mjs';
import { addFolder, putRecord, makeRoot, makeClock, setMtime, uuid } from './fixtures/store.mjs';
import { createSim } from './fixtures/appsim.mjs';

const MIN = 60 * 1000;
afterEach(() => { delete process.env.SESSION_SYNC_TEST_APP_STATE; });

test('T2 evaluateRunning: S1/S2 combinations', () => {
  const t = 1_000_000;
  const cases = [
    // s1, s2 -> running, fullAllowed
    [false, false, false, true],
    [false, true, true, false],
    [false, null, false, false],     // unknown process state never allows a full pass
    [true, true, true, false],
    [true, null, true, false],
    [true, false, true, false],      // not stale yet: a lockfile with no process, first sighting
  ];
  for (const [s1, s2, running, fullAllowed] of cases) {
    const r = evaluateRunning(s1, s2, null, t);
    assert.equal(r.running, running, `running for s1=${s1} s2=${s2}`);
    assert.equal(r.fullAllowed, fullAllowed, `fullAllowed for s1=${s1} s2=${s2}`);
  }
});

test('T2 stale lockfile rule: S1 true and S2 false on >=3 checks spanning >=3 minutes', () => {
  let rec = null; let r;
  r = evaluateRunning(true, false, rec, 0); rec = r.rec;           assert.equal(r.stale, false);
  r = evaluateRunning(true, false, rec, 2 * MIN); rec = r.rec;     assert.equal(r.stale, false);   // 2 checks
  r = evaluateRunning(true, false, rec, 2.5 * MIN); rec = r.rec;   assert.equal(r.stale, false);   // 3 checks, span < 3 min
  r = evaluateRunning(true, false, rec, 3 * MIN); rec = r.rec;
  assert.equal(r.stale, true);
  assert.equal(r.running, true, 'N1: a stale lockfile is reported, but still blocks a full pass (the S1 guard would abort at the first mutation)');
  assert.equal(r.fullAllowed, false);
  // an unknown process state neither counts nor resets
  r = evaluateRunning(true, null, rec, 4 * MIN); assert.equal(r.rec.count, rec.count);
  // a process appearing resets the counter
  r = evaluateRunning(true, true, rec, 5 * MIN); assert.equal(r.rec, null); assert.equal(r.running, true);
  // so does a vanished lockfile
  r = evaluateRunning(false, false, rec, 5 * MIN); assert.equal(r.rec, null);
});

test('T2 appState via the seam persists and clears lock-stale.json', () => {
  const r = makeRoot('app');
  const clock = makeClock();
  const sim = createSim({ clock, appFile: join(r.root, 'app.json') });
  sim.setApp({ s1: true, s2: false, signedIn: uuid('a', 1), startedAtMs: 5 });
  let st = appState({ ctx: r.ctx, now: 0 });
  assert.deepEqual([st.running, st.stale, st.signedIn, st.startedAtMs], [true, false, uuid('a', 1), 5]);
  appState({ ctx: r.ctx, now: 2 * MIN });
  appState({ ctx: r.ctx, now: 2.5 * MIN });
  st = appState({ ctx: r.ctx, now: 3 * MIN });
  assert.equal(st.stale, true);
  assert.equal(st.fullAllowed, false);
  sim.setApp({ running: true });
  st = appState({ ctx: r.ctx, now: 4 * MIN });
  assert.equal(st.running, true);
  sim.setApp({ running: false });
  st = appState({ ctx: r.ctx, now: 5 * MIN });
  assert.deepEqual([st.running, st.fullAllowed], [false, true]);
  sim.cleanup();
});

test('T2 the seam is re-read on every check', () => {
  const r = makeRoot('app');
  const sim = createSim({ clock: makeClock(), appFile: join(r.root, 'app.json') });
  sim.setApp({ running: false });
  assert.equal(appState({ ctx: r.ctx }).running, false);
  sim.setApp({ running: true });
  assert.equal(appState({ ctx: r.ctx }).running, true);
  assert.equal(lockfilePresent(r.ctx), true);
  sim.cleanup();
});

test('T2 lockfilePresent on the real marker: Windows lockfile, never opened', () => {
  const r = makeRoot('app');
  const ctx = { ...r.ctx, platform: 'win32' };
  assert.equal(lockfilePresent(ctx), false);
  writeFileSync(join(r.userData, 'lockfile'), '');
  assert.equal(lockfilePresent(ctx), true);
  assert.equal(appState({ ctx, probeProcesses: false }).s2, null, 'no process probe on the hook path');
});

test('T2 desktopProcesses: bundled CLI is ignored, the app path counts, an error is unknown', () => {
  const calls = [];
  const mk = (stdout, over = {}) => (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0, stdout, ...over }; };
  const win = (stdout, over) => desktopProcesses({ platform: 'win32', spawnFn: mk(stdout, over) });
  assert.equal(win('C:\\Program Files\\WindowsApps\\Claude_1.2.3_x64__abc\\app\\Claude.exe\r\n'), true);
  assert.equal(win('C:\\Users\\u\\AppData\\Local\\AnthropicClaude\\app-1.0.0\\claude.exe\n'), true);
  assert.equal(win('C:\\Users\\u\\AppData\\Roaming\\Claude\\claude-code\\2.1.321\\win32-x64\\claude.exe\n'), false);
  assert.equal(win(''), false);
  assert.equal(win('', { status: 1 }), null);
  assert.equal(win('', { error: new Error('timeout') }), null);
  assert.ok(calls.every((c) => c.cmd === 'powershell.exe' && c.opts.windowsHide === true && !c.opts.detached));
  const mac = (out) => desktopProcesses({ platform: 'darwin', spawnFn: () => ({ status: 0, stdout: out }) });
  assert.equal(mac('/Applications/Claude.app/Contents/MacOS/Claude\n/bin/zsh\n'), true);
  assert.equal(mac('/bin/zsh\n'), false);
});

/* ---- readSignedIn ---- */

function withConfig(text) {
  const r = makeRoot('cfg');
  writeFileSync(join(r.userData, 'config.json'), text);
  return r;
}

test('T2 readSignedIn returns only the uuid and never calls JSON.parse', () => {
  const who = uuid('a', 7);
  const secret = 'FAKE-OAUTH-SECRET-VALUE-DO-NOT-LEAK';
  const r = withConfig(`{"oauth:tokenCache":"${secret}","oauth:refresh":"${secret}-2","lastKnownAccountUuid":"${who}","dxt:x":"y"}`);
  const orig = JSON.parse; const seen = [];
  JSON.parse = (...a) => { seen.push(a[0]); return orig(...a); };
  let got;
  try { got = readSignedIn(r.userData); } finally { JSON.parse = orig; }
  assert.equal(got, who);
  assert.deepEqual(seen, [], 'readSignedIn must not parse the file');
  assert.ok(!/JSON\.parse/.test(readSignedIn.toString()), 'no JSON.parse in the function body');
  assert.equal(typeof got, 'string');
  assert.ok(!String(got).includes(secret));
});

test('T2 readSignedIn: key past the first chunk, across a chunk boundary, absent, and beyond 1 MiB', () => {
  const who = uuid('b', 2);
  const key = `"lastKnownAccountUuid": "${who}"`;
  const pad = (n) => `"pad":"${'x'.repeat(n)}",`;
  assert.equal(readSignedIn(withConfig(`{${pad(70 * 1024)}${key}}`).userData), who);            // second chunk
  const boundary = 64 * 1024 - 20;                                                              // key straddles the 64 KiB edge
  assert.equal(readSignedIn(withConfig(`{${pad(boundary - 10)}${key}}`).userData), who);
  assert.equal(readSignedIn(withConfig('{"other":1}').userData), null);
  assert.equal(readSignedIn(withConfig(`{${pad(1024 * 1024 + 10)}${key}}`).userData), null);    // bound: 1 MiB
  assert.equal(readSignedIn(join(makeRoot('none').root, 'does-not-exist')), null);
  assert.equal(readSignedIn(null), null);
});

test('T2 appstate.mjs never JSON.parses config.json (source check)', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../lib/accounts/appstate.mjs'), 'utf8');
  assert.ok(!/JSON\.parse/.test(src), 'appstate.mjs has no JSON.parse at all (the seam is read through readJson)');
});

/* ---- live folder set ---- */

test('T2 liveFolders: signed-in account, activity-based, sticky, unknown, not running', () => {
  const r = makeRoot('live');
  const A = uuid('a', 1); const B = uuid('b', 1); const C = uuid('c', 1);
  const fA = addFolder(r.store, A, uuid('1', 1));
  const fB = addFolder(r.store, B, uuid('1', 1));
  const fC = addFolder(r.store, C, uuid('1', 1));
  const all = [fA, fB, fC];
  const started = 1_800_000_100_000;
  const state = emptyState();

  // not running: nothing is live
  assert.equal(liveFolders({ running: false }, all, state).size, 0);

  // running, signed in as A; B holds only old, linked-looking files
  putRecord(fB.path, 1, {}, started - 5000);
  putRecord(fC.path, 1, {}, started - 5000);
  let live = liveFolders({ running: true, signedIn: A, startedAtMs: started }, all, state);
  assert.deepEqual([...live], [fA.key]);

  // a fresh single-link record in C (saved after the app started) makes C live
  putRecord(fC.path, 2, {}, started + 5000);
  live = liveFolders({ running: true, signedIn: A, startedAtMs: started }, all, state);
  assert.deepEqual([...live].sort(), [fA.key, fC.key].sort());

  // sticky for this app run, even if the evidence is gone
  const sticky = liveFolders({ running: true, signedIn: A, startedAtMs: started }, [fA, fB], state);
  assert.ok(state.live.folders.includes(fC.key));
  assert.ok(sticky.has(fA.key));

  // a new app run resets the sticky set
  live = liveFolders({ running: true, signedIn: A, startedAtMs: started + 10 * MIN }, all, state);
  assert.ok(!live.has(fB.key));
  assert.equal(state.live.startedAtMs, started + 10 * MIN);

  // a .json.tmp marks a folder live
  writeFileSync(join(fB.path, 'local_x.json.tmp'), '{');
  live = liveFolders({ running: true, signedIn: A, startedAtMs: started + 10 * MIN }, all, state);
  assert.ok(live.has(fB.key));

  // unknown signed-in account: everything is live
  const s2 = emptyState();
  assert.equal(liveFolders({ running: true, signedIn: null, startedAtMs: started }, all, s2).size, 3);
});

test('T2 noteSignedIn and the S1 guard', () => {
  const s = emptyState();
  noteSignedIn(s, uuid('a', 1), 1_800_000_000_000);
  assert.match(s.lastSignedIn[uuid('a', 1)], /^2027-/);
  noteSignedIn(s, null);
  assert.equal(Object.keys(s.lastSignedIn).length, 1);
  const r = makeRoot('guard');
  const sim = createSim({ clock: makeClock(), appFile: join(r.root, 'app.json') });
  const guard = makeS1Guard(r.ctx);
  sim.setApp({ running: false });
  guard();
  sim.setApp({ running: true });
  assert.throws(() => guard(), AppRunningError);
  sim.cleanup();
});
