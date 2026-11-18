/**
 * The Remote Control relink at Windows logon (0.5.6): the command (`rcLogonStep`), the launcher's version resolution, the logon task's
 * install, removal and opt-out. The scheduler is always a mock or the SESSION_SYNC_TEST_SCHTASKS log: no test registers a real task.
 * Synthetic stores, temp dirs and a temp home only; nothing here touches the live store or ~/.claude/session-sync.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, symlinkSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { makeRoot, addFolder, putRecord, uuid } from './fixtures/store.mjs';
import { cworld, cleanupWorlds, A } from './fixtures/cliworld.mjs';
import { rcLogonStep, relinkOwedFile, RC_DEFAULTS } from '../lib/accounts/rcrestore.mjs';
import { rcSettings } from '../lib/config.mjs';
import { resolveCli, parseVersion, compareVersions, NEEDS, main as launcherMain } from '../lib/accounts/rc-logon-launcher.mjs';
import {
  installLogonTask, uninstallLogonTask, ensureLogonTask, taskXml, shimText, TASK_NAME, LAUNCHER_NAME, SHIM_NAME, STAMP_NAME, VERIFY_EVERY_MS,
} from '../lib/accounts/logontask.mjs';
import { writeJsonAtomic } from '../lib/accounts/state.mjs';

const temps = [];
const tmp = (label) => { const d = mkdtempSync(join(tmpdir(), `ss-${label}-`)); temps.push(d); return d; };
after(() => { cleanupWorlds(); for (const d of temps) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ } } });

/* ------------------------------------------------------------------ the command */

const ME = uuid('a', 1);
const ORG = uuid('f', 1);
const NOW = 1_800_000_500_000;
const iso = (ms) => new Date(ms).toISOString();
const keyOf = (n) => `C:\\synthetic\\project-${n}`.replace(/[^a-zA-Z0-9]/g, '-');

/** One signed-in account, one session whose last saved link is a stale fallback one (so a relink is owed). */
function world({ owed = true } = {}) {
  const r = makeRoot('rclogon');
  temps.push(r.root);
  writeFileSync(join(r.userData, 'config.json'), JSON.stringify({ lastKnownAccountUuid: ME }));
  const projects = join(r.root, 'projects');
  const folder = addFolder(r.store, ME, ORG);
  r.ctx.platform = 'win32';
  r.ctx.setNow(NOW);
  putRecord(folder.path, 1, { lastActivityAt: iso(NOW - 3600_000), remoteControlUserEnabled: true, bridgeSessionIds: ['session_1'], remoteControlAutoEligible: false });
  const tp = join(projects, keyOf(1), `${uuid('d', 1)}.jsonl`);
  mkdirSync(join(projects, keyOf(1)), { recursive: true });
  const link = owed ? { bridgeSessionId: 'cse_stale', noHistoryBackfill: true, ownerAccountUuid: ME } : { bridgeSessionId: 'cse_good', ownerAccountUuid: ME };
  writeFileSync(tp, [JSON.stringify({ type: 'user', message: 'hi' }), JSON.stringify({ type: 'bridge-session', sessionId: uuid('d', 1), lastSequenceNum: 3, ...link }), ''].join('\n'));
  return { ...r, projects, folder, tp };
}

const STOPPED = { running: false, fullAllowed: true, s1: false, s2: false };
const RUNNING = { running: true, fullAllowed: false, s1: true, s2: true };
const UNKNOWN = { running: false, fullAllowed: false, s1: false, s2: null };
const noSleep = () => Promise.resolve();
const lastLine = (tp) => JSON.parse(readFileSync(tp, 'utf8').trim().split('\n').pop());

test('L1 stopped app, relink owed: the stale link is cleared after a backup, one log line, the owed record is dropped', async () => {
  const w = world();
  writeJsonAtomic(relinkOwedFile(w.ctx), { v: 1, count: 1 });
  const lines = [];
  const r = await rcLogonStep(w.ctx, { projects: w.projects, readApp: () => STOPPED, log: (l) => lines.push(l) });
  assert.equal(r.ran, true);
  assert.equal(r.res.relinked, 1);
  assert.equal(r.res.status, 'ok');
  assert.equal(lastLine(w.tp).bridgeSessionId, '', 'the CLI clearing line was appended');
  assert.ok(existsSync(join(w.acc, 'rc-restore', 'backup')), 'a backup came first');
  assert.equal(existsSync(relinkOwedFile(w.ctx)), false, 'nothing is owed any more');
  assert.equal(lines.length, 1, `one log line, got ${JSON.stringify(lines)}`);
  assert.match(lines[0], /logon relink: 1 relinked/);
});

test('L2 nothing owed: quiet (no log line, no write), the stale owed record is dropped', async () => {
  const w = world({ owed: false });
  writeJsonAtomic(relinkOwedFile(w.ctx), { v: 1, count: 1 });
  const before = readFileSync(w.tp, 'utf8');
  const lines = [];
  const r = await rcLogonStep(w.ctx, { projects: w.projects, readApp: () => STOPPED, log: (l) => lines.push(l) });
  assert.deepEqual({ ran: r.ran, reason: r.reason }, { ran: false, reason: 'nothing-owed' });
  assert.deepEqual(lines, []);
  assert.equal(readFileSync(w.tp, 'utf8'), before);
  assert.equal(existsSync(join(w.acc, 'rc-restore')), false, 'no backup folder, no result file');
  assert.equal(existsSync(relinkOwedFile(w.ctx)), false);
});

test('L3 the app is running: nothing is written, the relink stays owed', async () => {
  const w = world();
  writeJsonAtomic(relinkOwedFile(w.ctx), { v: 1, count: 1 });
  const before = readFileSync(w.tp, 'utf8');
  const lines = [];
  const r = await rcLogonStep(w.ctx, { projects: w.projects, readApp: () => RUNNING, log: (l) => lines.push(l), sleep: noSleep });
  assert.deepEqual({ ran: r.ran, reason: r.reason }, { ran: false, reason: 'app-running' });
  assert.equal(readFileSync(w.tp, 'utf8'), before);
  assert.equal(existsSync(join(w.acc, 'rc-restore')), false);
  assert.equal(existsSync(relinkOwedFile(w.ctx)), true, 'still owed');
  assert.equal(lines.length, 1);
});

test('L4 the app starts mid-way: the first write is refused, nothing half-written, still owed', async () => {
  const w = world();
  writeJsonAtomic(relinkOwedFile(w.ctx), { v: 1, count: 1 });
  const before = readFileSync(w.tp, 'utf8');
  const lines = [];
  // the check at the start says stopped; by the first write the lock marker is back
  const r = await rcLogonStep(w.ctx, { projects: w.projects, readApp: () => STOPPED, stopped: () => false, log: (l) => lines.push(l) });
  assert.equal(r.ran, true);
  assert.equal(r.res.status, 'refused_app_running');
  assert.equal(r.res.relinked, 0);
  assert.equal(readFileSync(w.tp, 'utf8'), before, 'the transcript is untouched');
  assert.equal(existsSync(join(w.acc, 'rc-restore', 'backup')), false, 'not even a backup was started');
  assert.equal(existsSync(relinkOwedFile(w.ctx)), true, 'still owed');
  assert.match(lines[0], /status refused_app_running \(the app started\)/);
});

test('L4b the app starts between two relinks: the done one stays done, the rest is skipped and stays owed', async () => {
  const w = world();
  // a second owed session
  putRecord(w.folder.path, 2, { lastActivityAt: iso(NOW - 7200_000), remoteControlUserEnabled: true, bridgeSessionIds: ['session_2'], remoteControlAutoEligible: false });
  const tp2 = join(w.projects, keyOf(2), `${uuid('d', 2)}.jsonl`);
  mkdirSync(join(w.projects, keyOf(2)), { recursive: true });
  writeFileSync(tp2, [JSON.stringify({ type: 'bridge-session', sessionId: uuid('d', 2), lastSequenceNum: 1, bridgeSessionId: 'cse_stale2', noHistoryBackfill: true, ownerAccountUuid: ME }), ''].join('\n'));
  const before2 = readFileSync(tp2, 'utf8');
  let calls = 0;
  const lines = [];
  const r = await rcLogonStep(w.ctx, { projects: w.projects, readApp: () => STOPPED, stopped: () => ++calls <= 2, log: (l) => lines.push(l) });
  assert.equal(r.res.status, 'partial');
  assert.equal(r.res.relinked, 1);
  assert.equal(lastLine(w.tp).bridgeSessionId, '', 'the first session was relinked whole');
  assert.equal(readFileSync(tp2, 'utf8'), before2, 'the second one was not touched');
  assert.ok(lines.length >= 2, 'a partial run also logs its details');
});

test('L5 an unknown process probe is retried, then gives up without writing', async () => {
  const w = world();
  let n = 0;
  const r = await rcLogonStep(w.ctx, { projects: w.projects, readApp: () => { n++; return UNKNOWN; }, sleep: noSleep, tries: 3, log: () => {} });
  assert.equal(n, 3);
  assert.deepEqual({ ran: r.ran, reason: r.reason }, { ran: false, reason: 'app-unknown' });
  let m = 0;
  const ok = await rcLogonStep(w.ctx, { projects: w.projects, readApp: () => (++m < 2 ? UNKNOWN : STOPPED), sleep: noSleep, log: () => {} });
  assert.equal(ok.ran, true, 'a second look that finds the app stopped goes ahead');
});

test('L6 off Windows and with rcRestore disabled: no-op, the app state is not even read', async () => {
  const w = world();
  const boom = () => { throw new Error('must not be read'); };
  assert.equal((await rcLogonStep(w.ctx, { platform: 'linux', readApp: boom })).reason, 'platform');
  assert.equal((await rcLogonStep(w.ctx, { platform: 'darwin', readApp: boom })).reason, 'platform');
  assert.equal((await rcLogonStep(w.ctx, { settings: { ...RC_DEFAULTS, enabled: false }, readApp: boom })).reason, 'disabled');
});

/* ------------------------------------------------------------------ the launcher */

function fakeHome(versions, { market = false, skipNeeds = [] } = {}) {
  const home = tmp('rchome');
  const cache = join(home, '.claude', 'plugins', 'cache', 'goodstuff', 'session-sync');
  const put = (root) => { mkdirSync(join(root, 'lib', 'accounts'), { recursive: true }); writeFileSync(join(root, 'lib', 'cli.mjs'), '//'); };
  for (const v of versions) {
    mkdirSync(join(cache, v), { recursive: true });
    if (v.match(/^\d/)) { put(join(cache, v)); if (!skipNeeds.includes(v)) writeFileSync(join(cache, v, NEEDS), '//'); }
  }
  if (market) { const m = join(home, '.claude', 'plugins', 'marketplaces', 'goodstuff', 'plugins', 'session-sync'); put(m); writeFileSync(join(m, NEEDS), '//'); }
  return home;
}
const cliOf = (home, v) => join(home, '.claude', 'plugins', 'cache', 'goodstuff', 'session-sync', v, 'lib', 'cli.mjs');

test('L7 launcher: the newest version dir wins by number, not by text (0.5.10 over 0.5.9)', () => {
  const home = fakeHome(['0.5.4', '0.5.9', '0.5.10', '0.4.0', 'tmp-copy', 'latest']);
  const r = resolveCli({ home });
  assert.equal(r.version, '0.5.10');
  assert.equal(r.cli, cliOf(home, '0.5.10'));
  assert.equal(r.source, 'cache');
  assert.deepEqual(parseVersion('1.2.3-beta.1'), [1, 2, 3]);
  assert.equal(parseVersion('latest'), null);
  assert.ok(compareVersions([0, 5, 10], [0, 5, 9]) > 0);
});

test('L8 launcher: a version without the logon command is skipped, then the marketplace clone, then nothing', () => {
  const home = fakeHome(['0.5.5', '0.5.6'], { skipNeeds: ['0.5.5', '0.5.6'] });
  assert.equal(resolveCli({ home }), null, 'neither copy has the command, no marketplace clone: nothing to run');
  const withMarket = fakeHome(['0.5.5'], { market: true, skipNeeds: ['0.5.5'] });
  const m = resolveCli({ home: withMarket });
  assert.equal(m.source, 'marketplace');
  assert.ok(m.cli.includes('marketplaces'));
  const mixed = fakeHome(['0.5.5', '0.5.6'], { skipNeeds: ['0.5.6'] });
  writeFileSync(join(mixed, '.claude', 'plugins', 'cache', 'goodstuff', 'session-sync', '0.5.5', NEEDS), '//');
  assert.equal(resolveCli({ home: mixed }).version, '0.5.5', 'the newest copy that has the command');
  assert.equal(resolveCli({ home: tmp('empty') }), null);
});

test('L9 launcher main: runs the resolved CLI with the logon arguments, hidden; no copy installed exits 0 and logs once', () => {
  const home = fakeHome(['0.5.6']);
  const calls = [];
  const code = launcherMain({ home, run: (exe, args, opts) => { calls.push({ exe, args, opts }); return { status: 0 }; } });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [cliOf(home, '0.5.6'), 'accounts', 'rc-restore', '--if-app-stopped']);
  assert.equal(calls[0].opts.windowsHide, true);
  const bare = tmp('bare');
  mkdirSync(join(bare, '.claude', 'session-sync'), { recursive: true });
  assert.equal(launcherMain({ home: bare, run: () => { throw new Error('nothing to run'); } }), 0);
  assert.match(readFileSync(join(bare, '.claude', 'session-sync', 'sync.log'), 'utf8'), /no installed session-sync copy/);
});

/* ------------------------------------------------------------------ install, uninstall, opt-out */

/** A scheduler mock that remembers whether the task exists. */
function mockScheduler() {
  const calls = [];
  let present = false;
  const run = (exe, args, opts) => {
    const op = args[0];
    calls.push({ exe, args, opts });
    if (op === '/Query') return { status: present ? 0 : 1 };
    if (op === '/Create') { present = true; return { status: 0 }; }
    if (op === '/Delete') { if (!present) return { status: 1, stderr: 'not found' }; present = false; return { status: 0 }; }
    return { status: 1 };
  };
  return { run, calls, ops: () => calls.map((c) => c.args[0]), get present() { return present; } };
}
const opts = (dir, s, extra = {}) => ({ dir, platform: 'win32', run: s.run, nodePath: 'C:\\node\\node.exe', user: 'HOST\\tester', env: { SystemRoot: 'C:\\Windows' }, ...extra });

test('L10 install: writes the launcher and a window-style-0 shim, registers an At-log-on task for the user from an XML file, hidden by wscript //B', () => {
  const dir = tmp('rctask');
  const s = mockScheduler();
  let xml = null;
  const run = (exe, args, o) => { if (args[0] === '/Create') xml = readFileSync(args[args.indexOf('/XML') + 1]); return s.run(exe, args, o); };
  const r = installLogonTask(opts(dir, s, { run }));
  assert.equal(r.ok, true);
  assert.equal(r.action, 'installed');
  assert.ok(existsSync(join(dir, LAUNCHER_NAME)) && existsSync(join(dir, SHIM_NAME)));
  assert.equal(readFileSync(join(dir, LAUNCHER_NAME), 'utf8'), readFileSync(new URL('../lib/accounts/rc-logon-launcher.mjs', import.meta.url), 'utf8'), 'the launcher is a copy of the plugin file');
  const shim = readFileSync(join(dir, SHIM_NAME)).toString('utf16le');
  assert.match(shim, /sh\.Run .*, 0, True/, 'window style 0');
  assert.match(shim, /node = "C:\\node\\node\.exe"/);
  assert.match(shim, /rc-restore-logon\.mjs/);
  const create = s.calls.find((c) => c.args[0] === '/Create');
  assert.deepEqual(create.args.slice(0, 3), ['/Create', '/TN', TASK_NAME]);
  assert.ok(create.args.includes('/F'));
  assert.equal(create.opts.windowsHide, true);
  const text = xml.toString('utf16le');
  assert.equal(xml[0], 0xff, 'UTF-16 LE with a BOM');
  assert.match(text, /<LogonTrigger>[\s\S]*<UserId>HOST\\tester<\/UserId>/);
  assert.match(text, /<Command>C:\\Windows\\System32\\wscript\.exe<\/Command>/);
  assert.match(text, /<Arguments>\/\/B \/\/Nologo "[^"]*rc-restore-logon\.vbs"<\/Arguments>/);
  assert.match(text, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.equal(existsSync(join(dir, `${STAMP_NAME}.task.xml`)), false, 'the temporary XML is removed');
  assert.equal(TASK_NAME, 'session-sync RC restore');
});

test('L11 install twice changes nothing; uninstall twice is a success each time', () => {
  const dir = tmp('rctask');
  const s = mockScheduler();
  const first = installLogonTask(opts(dir, s));
  const files1 = [LAUNCHER_NAME, SHIM_NAME].map((n) => readFileSync(join(dir, n)));
  const stat1 = readdirSync(dir).sort();
  const second = installLogonTask(opts(dir, s));
  assert.deepEqual([first.ok, second.ok, first.hash === second.hash], [true, true, true]);
  assert.deepEqual([LAUNCHER_NAME, SHIM_NAME].map((n) => readFileSync(join(dir, n))), files1);
  assert.deepEqual(readdirSync(dir).sort(), stat1);
  assert.equal(s.present, true);
  const u1 = uninstallLogonTask(opts(dir, s));
  assert.deepEqual([u1.ok, u1.action], [true, 'removed']);
  assert.equal(s.present, false);
  assert.deepEqual(readdirSync(dir), [], 'launcher, shim and stamp are gone');
  const u2 = uninstallLogonTask(opts(dir, s));
  assert.deepEqual([u2.ok, u2.action], [true, 'not-installed']);
  assert.equal(s.ops().filter((o) => o === '/Delete').length, 1, 'the second removal never calls Delete');
});

test('L12 a failing scheduler is reported, not thrown', () => {
  const dir = tmp('rctask');
  const r = installLogonTask(opts(dir, { run: () => ({ status: 5, stderr: 'ERROR: Access is denied.' }) }));
  assert.equal(r.ok, false);
  assert.match(r.error, /Access is denied/);
  assert.equal(existsSync(join(dir, STAMP_NAME)), false, 'no stamp: nothing is recorded as installed');
});

test('L13 non-Windows: install, uninstall and ensure are no-ops that never touch the scheduler or the disk', () => {
  const dir = tmp('rctask');
  const s = mockScheduler();
  for (const platform of ['linux', 'darwin']) {
    for (const f of [installLogonTask, uninstallLogonTask, ensureLogonTask]) {
      const r = f({ ...opts(dir, s), platform });
      assert.deepEqual([r.ok, r.action], [true, 'skipped']);
    }
  }
  assert.deepEqual(s.calls, []);
  assert.deepEqual(readdirSync(dir), []);
});

test('L14 ensure: installs by default, then costs no scheduler call until a day has passed; a changed install is re-registered', () => {
  const dir = tmp('rctask');
  const s = mockScheduler();
  let t = 1_000_000;
  const o = opts(dir, s, { now: () => t, settings: rcSettings({}) });
  assert.equal(ensureLogonTask(o).action, 'installed');
  const n = s.calls.length;
  assert.equal(ensureLogonTask(o).action, 'unchanged');
  assert.equal(s.calls.length, n, 'no scheduler call');
  t += VERIFY_EVERY_MS + 1;
  assert.equal(ensureLogonTask(o).action, 'unchanged');
  assert.deepEqual(s.ops().slice(n), ['/Query'], 'a day on: one query, task still there');
  // the task was deleted by hand: found missing a day later and put back
  t += VERIFY_EVERY_MS + 1;
  uninstallLogonTask({ ...o, dir: tmp('other') });   // the mock scheduler forgets the task (another dir: this dir's stamp stays)
  assert.equal(s.present, false);
  assert.equal(ensureLogonTask(o).action, 'installed');
  assert.equal(s.present, true);
  // a different node path changes the shim, so the task is registered again at once
  assert.equal(ensureLogonTask({ ...o, nodePath: 'D:\\other\\node.exe' }).action, 'installed');
});

test('L15 opt-out: rcRestore.logonTask false (or rcRestore.enabled false) installs nothing and removes what an earlier run installed', () => {
  const dir = tmp('rctask');
  const s = mockScheduler();
  const off = opts(dir, s, { settings: rcSettings({ rcRestore: { logonTask: false } }) });
  assert.equal(off.settings.logonTask, false);
  assert.deepEqual([ensureLogonTask(off).action, s.calls.length], ['none', 0], 'opted out from the start: not even a scheduler call');
  assert.equal(ensureLogonTask(opts(dir, s, { settings: rcSettings({}) })).action, 'installed');
  assert.equal(s.present, true);
  const gone = ensureLogonTask(off);
  assert.equal(gone.action, 'removed');
  assert.equal(s.present, false);
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(ensureLogonTask(off).action, 'none');
  // enabled false switches the whole feature off, the task with it
  ensureLogonTask(opts(dir, s, { settings: rcSettings({}) }));
  assert.equal(ensureLogonTask(opts(dir, s, { settings: rcSettings({ rcRestore: { enabled: false } }) })).action, 'removed');
  assert.equal(s.present, false);
});

test('L16 the setting: default on, only an explicit false turns it off, shown with the other rcRestore settings', () => {
  assert.equal(RC_DEFAULTS.logonTask, true);
  assert.equal(rcSettings({}).logonTask, true);
  assert.equal(rcSettings({ rcRestore: { logonTask: false } }).logonTask, false);
  assert.equal(rcSettings({ rcRestore: { logonTask: 'no' } }).logonTask, true);
  assert.equal(rcSettings({ rcRestore: { days: 5 } }).logonTask, true);
});

test('L17 the XML and the shim escape what they carry', () => {
  const x = taskXml({ user: 'DOM\\a&b<c>', shimPath: 'C:\\x y\\a&b.vbs', wscript: 'C:\\Windows\\System32\\wscript.exe' });
  assert.match(x, /<UserId>DOM\\a&amp;b&lt;c&gt;<\/UserId>/);
  assert.match(x, /a&amp;b\.vbs/);
  assert.doesNotMatch(shimText('C:\\n"ode\\node.exe'), /n"ode/);
});

/* ------------------------------------------------------------------ the CLI, with the scheduler log seam */

const CLI = fileURLToPath(new URL('../lib/cli.mjs', import.meta.url));
function cliHome() {
  const home = tmp('rccli');
  mkdirSync(join(home, '.claude', 'session-sync'), { recursive: true });
  writeFileSync(join(home, '.claude', 'session-sync', 'config.json'), JSON.stringify({ notifications: false }));
  const sched = join(home, 'schtasks.log');
  const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, USERPROFILE: home, HOME: home, APPDATA: join(home, 'AppData', 'Roaming'), XDG_CONFIG_HOME: join(home, '.config'), SESSION_SYNC_TEST_SCHTASKS: sched, ...env },
    encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  const ops = () => (existsSync(sched) ? readFileSync(sched, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).op) : []);
  return { home, run, ops, dir: join(home, '.claude', 'session-sync') };
}

test('L18 CLI: install-logon-task and uninstall-logon-task are idempotent; --if-app-stopped with nothing owed exits 0 quietly', { skip: process.platform !== 'win32' }, () => {
  const c = cliHome();
  const i1 = c.run(['accounts', 'rc-restore', 'install-logon-task']);
  assert.equal(i1.status, 0, i1.stderr);
  assert.match(i1.stdout, /installed/);
  assert.ok(existsSync(join(c.dir, LAUNCHER_NAME)) && existsSync(join(c.dir, SHIM_NAME)));
  assert.equal(c.run(['accounts', 'rc-restore', 'install-logon-task']).status, 0);
  assert.equal(c.ops().filter((o) => o === 'create').length, 2, '/Create /F twice');
  const q = c.run(['accounts', 'rc-restore', '--if-app-stopped']);
  assert.deepEqual([q.status, q.stdout, q.stderr], [0, '', ''], 'quiet when there is no store or nothing is owed');
  assert.equal(c.run(['accounts', 'rc-restore']).status, 2, 'a bare rc-restore is refused');
  const u1 = c.run(['accounts', 'rc-restore', 'uninstall-logon-task']);
  assert.equal(u1.status, 0, u1.stderr);
  assert.match(u1.stdout, /removed/);
  const u2 = c.run(['accounts', 'rc-restore', 'uninstall-logon-task']);
  assert.equal(u2.status, 0);
  assert.match(u2.stdout, /not-installed/);
  assert.equal(c.ops().filter((o) => o === 'delete').length, 1);
});

test('L19 CLI: config rcRestore.logonTask false removes the task, true puts it back', { skip: process.platform !== 'win32' }, () => {
  const c = cliHome();
  assert.equal(c.run(['accounts', 'rc-restore', 'install-logon-task']).status, 0);
  const off = c.run(['config', 'rcRestore.logonTask', 'false']);
  assert.equal(off.status, 0, off.stderr);
  assert.equal(JSON.parse(off.stdout).logonTask, 'removed');
  assert.equal(JSON.parse(readFileSync(join(c.dir, 'config.json'), 'utf8')).rcRestore.logonTask, false);
  assert.equal(existsSync(join(c.dir, SHIM_NAME)), false);
  const on = c.run(['config', 'rcRestore.logonTask', 'true']);
  assert.equal(JSON.parse(on.stdout).logonTask, 'installed');
  assert.ok(existsSync(join(c.dir, SHIM_NAME)));
});

/* ------------------------------------------------------------------ review round: the window setting, the junction, the hook, the failure stamp */

test('L20 rcRestore.days is the window of the logon relink, as for the quit step', async () => {
  const w = world();
  w.ctx.setNow(NOW + 4 * 24 * 3600_000);   // the one session was last active 4 days + 1 hour ago
  const before = readFileSync(w.tp, 'utf8');
  const narrow = await rcLogonStep(w.ctx, { projects: w.projects, settings: { ...RC_DEFAULTS, days: 3 }, readApp: () => STOPPED, log: () => {} });
  assert.deepEqual({ ran: narrow.ran, reason: narrow.reason }, { ran: false, reason: 'nothing-owed' }, '3 days: out of the window');
  assert.equal(readFileSync(w.tp, 'utf8'), before);
  const wide = await rcLogonStep(w.ctx, { projects: w.projects, settings: { ...RC_DEFAULTS, days: 7 }, readApp: () => STOPPED, log: () => {} });
  assert.equal(wide.ran, true, '7 days: inside');
  assert.equal(wide.res.relinked, 1);
});

test('L21 launcher: started through a junction it still runs (the entry check compares real paths)', { skip: process.platform !== 'win32' }, () => {
  const home = tmp('rcjunc');
  mkdirSync(join(home, '.claude', 'session-sync'), { recursive: true });
  const real = join(home, '.claude', 'session-sync');
  const link = join(home, 'linked');
  symlinkSync(real, link, 'junction');
  copyFileSync(fileURLToPath(new URL('../lib/accounts/rc-logon-launcher.mjs', import.meta.url)), join(real, LAUNCHER_NAME));
  const r = spawnSync(process.execPath, [join(link, LAUNCHER_NAME)], { env: { ...process.env, USERPROFILE: home, HOME: home }, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(join(real, 'sync.log'), 'utf8'), /no installed session-sync copy/, 'main ran: it found no copy in the empty home and said so');
});

test('L22 a failed install is not reported as unchanged: skipped for a day, retried when forced or a day on', () => {
  const dir = tmp('rctask');
  let fail = true;
  const calls = [];
  const run = (exe, args) => { calls.push(args[0]); return args[0] === '/Create' ? { status: fail ? 5 : 0, stderr: 'ERROR: Access is denied.' } : { status: 1 }; };
  let t = 5_000_000;
  const o = opts(dir, { run }, { now: () => t, settings: rcSettings({}) });
  const first = ensureLogonTask(o);
  assert.equal(first.ok, false);
  const n = calls.length;
  const again = ensureLogonTask(o);
  assert.deepEqual([again.action, again.reason, calls.length], ['skipped', 'failed-recently', n], 'not asked again within a day, and not "unchanged"');
  fail = false;
  assert.equal(ensureLogonTask({ ...o, force: true }).action, 'installed', 'config rcRestore.logonTask true forces a retry');
  rmSync(dir, { recursive: true, force: true });
  fail = true;
  assert.equal(ensureLogonTask(o).ok, false);
  t += VERIFY_EVERY_MS + 1;
  fail = false;
  assert.equal(ensureLogonTask(o).action, 'installed', 'a day on it tries again');
});

test('L23 CLI: the session-start hook installs the task once, costs no scheduler call after that, and removes it on opt-out', { skip: process.platform !== 'win32' }, () => {
  const c = cliHome();
  writeFileSync(join(c.dir, 'config.json'), JSON.stringify({ notifications: false, enabled: false }));   // enabled false: the hook step runs, then nothing syncs
  mkdirSync(join(c.home, 'AppData', 'Roaming', 'Claude', 'claude-code-sessions'), { recursive: true });
  const hook = () => c.run(['auto-pull', '--from-hook']);
  assert.equal(hook().status, 0);
  assert.deepEqual(c.ops().filter((o) => o !== 'query'), ['create'], 'first session start registers the task');
  const n = c.ops().length;
  hook();
  assert.equal(c.ops().length, n, 'second session start: stamp hit, no scheduler call');
  assert.match(readFileSync(join(c.dir, 'sync.log'), 'utf8'), /logon task installed/);
  writeFileSync(join(c.dir, 'config.json'), JSON.stringify({ notifications: false, enabled: false, rcRestore: { logonTask: false } }));
  hook();
  assert.ok(c.ops().includes('delete'), 'opted out: removed at the next session start');
  assert.equal(existsSync(join(c.dir, SHIM_NAME)), false);
  const m = c.ops().length;
  hook();
  assert.equal(c.ops().length, m, 'and nothing more afterwards');
});

test('L24 CLI end to end: an owed relink is cleared with the app stopped and left alone with the app running', { skip: process.platform !== 'win32' }, () => {
  const w = cworld({ accounts: 1, records: 1 });
  writeFileSync(join(w.userData, 'config.json'), JSON.stringify({ lastKnownAccountUuid: A }));
  putRecord(w.fA.path, 7, { lastActivityAt: iso(Date.now() - 3600_000), remoteControlUserEnabled: true, bridgeSessionIds: ['session_7'] });
  const tp = join(w.home, '.claude', 'projects', 'C--synthetic-project-7', `${uuid('d', 7)}.jsonl`);
  mkdirSync(join(w.home, '.claude', 'projects', 'C--synthetic-project-7'), { recursive: true });
  writeFileSync(tp, `${JSON.stringify({ type: 'bridge-session', sessionId: uuid('d', 7), lastSequenceNum: 2, bridgeSessionId: 'cse_stale', noHistoryBackfill: true, ownerAccountUuid: A })}\n`);
  const before = readFileSync(tp, 'utf8');
  w.setApp({ running: true });
  const running = w.run(['accounts', 'rc-restore', '--if-app-stopped']);
  assert.deepEqual([running.status, running.stdout], [0, '']);
  assert.equal(readFileSync(tp, 'utf8'), before, 'the app is running: untouched');
  assert.match(readFileSync(join(w.stateDir, 'sync.log'), 'utf8'), /logon relink skipped, the app is running/);
  w.setApp({ running: false });
  const stopped = w.run(['accounts', 'rc-restore', '--if-app-stopped']);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, /1 relinked/);
  assert.equal(JSON.parse(readFileSync(tp, 'utf8').trim().split('\n').pop()).bridgeSessionId, '', 'the CLI clearing line was appended');
  assert.match(readFileSync(join(w.stateDir, 'sync.log'), 'utf8'), /logon relink: 1 relinked/);
  const again = w.run(['accounts', 'rc-restore', '--if-app-stopped']);
  assert.deepEqual([again.status, again.stdout], [0, ''], 'idempotent: nothing is owed now');
});
