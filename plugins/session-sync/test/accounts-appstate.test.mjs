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
import { spawnSync } from 'node:child_process';
import {
  appState, evaluateRunning, readSignedIn, desktopProcesses, probeDesktop, parseWinProbe, PROBE_MARK, WIN_PROBE_SCRIPT, createStopWatch,
  lockfilePresent, liveFolders, noteSignedIn, makeS1Guard, AppRunningError,
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

test('T2 desktopProcesses: bundled CLI is ignored, the app path counts, only a missing end marker is unknown', () => {
  const calls = [];
  const mk = (stdout, over = {}) => (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0, stdout, ...over }; };
  const win = (stdout, over) => desktopProcesses({ platform: 'win32', spawnFn: mk(stdout, over) });
  const M = `${PROBE_MARK}\r\n`;
  assert.equal(win(`P|10|C:\\Program Files\\WindowsApps\\Claude_1.2.3_x64__abc\\app\\Claude.exe\r\n${M}`), true);
  assert.equal(win(`P|10|C:\\Users\\u\\AppData\\Local\\AnthropicClaude\\app-1.0.0\\claude.exe\n${M}`), true);
  assert.equal(win(`P|11|C:\\Users\\u\\AppData\\Roaming\\Claude\\claude-code\\2.1.321\\win32-x64\\claude.exe\n${M}`), false);
  // 0.5.1 bug: no claude process at all is the normal answer after the app quits, and it must read as "not running"
  assert.equal(win(M), false);
  assert.equal(win(`${PROBE_MARK}\n`, { status: 1 }), false, 'the marker decides, not the exit status');
  // unknown: no marker (the script never finished), a timeout or spawn error, or a claude process whose path is unreadable
  assert.equal(win(''), null);
  assert.equal(win('', { status: 1 }), null);
  assert.equal(win('P|10|C:\\x\\claude.exe\n'), null, 'a list that never reached the marker is incomplete');
  assert.equal(win('', { error: new Error('timeout') }), null);
  assert.equal(win(`P|12|\r\n${M}`), null, 'an unreadable path is unknown, never absent');
  assert.equal(win(`P|11|C:\\Users\\u\\AppData\\Roaming\\Claude\\claude-code\\2.1.321\\win32-x64\\claude.exe\nP|12|\n${M}`), null);
  assert.match(probeDesktop({ platform: 'win32', spawnFn: mk('', { status: 1, stderr: 'boom' }) }).detail, /marker is missing.*status 1.*boom/);
  assert.ok(calls.every((c) => c.cmd === 'powershell.exe' && c.opts.windowsHide === true && !c.opts.detached));
  const mac = (out) => desktopProcesses({ platform: 'darwin', spawnFn: () => ({ status: 0, stdout: out }) });
  assert.equal(mac('/Applications/Claude.app/Contents/MacOS/Claude\n/bin/zsh\n'), true);
  assert.equal(mac('/bin/zsh\n'), false);
});

const winOnly = { skip: process.platform !== 'win32' ? 'Windows PowerShell only' : false };

test('T2 real PowerShell probe: a process name that does not exist reads as "not running" (the 0.5.1 bug)', winOnly, () => {
  const ghost = `ss-absent-${Math.random().toString(36).slice(2, 10)}`;
  assert.ok(WIN_PROBE_SCRIPT.includes('-Name claude'), 'the probe names the claude process');
  const seen = [];
  const spawnFn = (cmd, args, opts) => {
    const r = spawnSync(cmd, args.map((a) => a.replace('-Name claude', `-Name ${ghost}`)), opts);
    seen.push({ status: r.status, stdout: r.stdout, stderr: r.stderr });
    return r;
  };
  const got = probeDesktop({ platform: 'win32', spawnFn });
  assert.equal(got.value, false, `expected false, got ${JSON.stringify(got)} ${JSON.stringify(seen)}`);
  assert.equal(seen[0].status, 0, 'the probe exits 0 even though Get-Process found nothing');
  assert.equal(seen[0].stdout.trim(), PROBE_MARK);
  // the shell's own behaviour that caused the bug, pinned: a bare Get-Process for an absent name exits 1
  const bare = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-Process -Name ${ghost} -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }`], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  assert.equal(bare.status, 1, 'Get-Process exits 1 when no process has the name');
});

test('T2 real PowerShell probe: the unmodified command reports a present claude process and ends with the marker', winOnly, () => {
  // probe this very node process instead of "claude" so a process whose path is readable is certainly there
  // (other node.exe processes on the box can be elevated, with an unreadable path, which correctly reads as unknown)
  const spawnFn = (cmd, args, opts) => spawnSync(cmd, args.map((a) => a.replace('-Name claude', `-Id ${process.pid}`)), opts);
  const r = spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_PROBE_SCRIPT], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0);
  const lines = r.stdout.trim().split(/\r?\n/);
  assert.equal(lines.at(-1), PROBE_MARK);
  assert.ok(lines.some((l) => /^P\|\d+\|.*node(\.exe)?$/i.test(l)), `a P| line for a running process: ${r.stdout}`);
  const p = parseWinProbe(r.stdout);
  assert.equal(p.value, false, 'a node.exe is not the desktop app');
});

test('T2 stop watch: logs the marker going and coming, an unknown probe with its reason, a WARN after 10 s, and a restart', () => {
  const r = makeRoot('watch');
  const lines = [];
  let t = 0;
  let status = { s1: true, s2: null, startedAtMs: 1000, fullAllowed: false };
  const w = createStopWatch(r.ctx, { log: (l) => lines.push(l), clock: () => t, status: () => status });
  w.read();                                              // up
  status = { s1: false, s2: null, s2Detail: 'the probe end marker is missing (status 1, stderr "")', startedAtMs: 0, fullAllowed: false };
  t += 500; w.read({ probeProcesses: true });
  assert.ok(lines.some((l) => /S1 true -> false/.test(l)));
  assert.equal(lines.filter((l) => /S2 \(process probe\) is unknown/.test(l)).length, 1);
  assert.match(lines.find((l) => /S2 \(process probe\) is unknown/.test(l)), /marker is missing/);
  for (let i = 0; i < 5; i++) { t += 500; w.read({ probeProcesses: true }); }
  assert.equal(lines.filter((l) => /S2 \(process probe\) is unknown/.test(l)).length, 1, 'one line, not one per poll');
  assert.equal(lines.filter((l) => /WARN/.test(l)).length, 0, 'not yet 10 s');
  t += 8000; w.read({ probeProcesses: true });
  const warn = lines.filter((l) => /WARN/.test(l));
  assert.equal(warn.length, 1);
  assert.match(warn[0], /status 1/);
  t += 500; w.read({ probeProcesses: true });
  assert.equal(lines.filter((l) => /WARN/.test(l)).length, 1, 'the WARN is once');
  // a new lock marker: the app restarted while the watch was waiting
  status = { s1: true, s2: true, startedAtMs: 2000, fullAllowed: false };
  t += 500; w.read();
  assert.ok(lines.some((l) => /S1 false -> true/.test(l)));
  assert.ok(lines.some((l) => /app restarted/.test(l) && /the stop lasted/.test(l)), lines.join('\n'));
  // a restart between two readings (the marker never seen gone): the creation time alone gives it away
  status = { s1: true, s2: true, startedAtMs: 3000, fullAllowed: false };
  t += 500; w.read();
  assert.ok(lines.filter((l) => /app restarted/.test(l)).length === 2);
  assert.ok(lines.some((l) => /less than one reading/.test(l)));
  // an injected status with no signals says nothing
  const quiet = [];
  const w2 = createStopWatch(r.ctx, { log: (l) => quiet.push(l), status: () => ({ fullAllowed: true }) });
  assert.equal(w2.read().fullAllowed, true);
  assert.deepEqual(quiet, []);
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
