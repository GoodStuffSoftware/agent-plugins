#!/usr/bin/env node
/**
 * rehearse-go-live.mjs - run the REAL `accounts go-live` (command, launcher, detached runner, every
 * phase) end to end against a scratch COPY of a real Code-tab store. By hand only (never CI, never
 * `npm test`).
 *
 *   node scripts/rehearse-go-live.mjs [--source <claude-code-sessions dir or its parent>] [--scratch <new dir>]
 *
 * Sandbox: only `claude-code-sessions` is copied (into <scratch>/home/<app-data folder>/Claude); a
 * synthetic `config.json` names the signed-in account; USERPROFILE, HOME, APPDATA and XDG_CONFIG_HOME,
 * the rclone remote (a local folder) and rclone's config (an empty file) all point into the scratch, and
 * the app-state seam is <scratch>/app.json: the "app" is running or stopped by rewriting that file, and
 * the runner's relaunch flips it to running instead of starting anything. A synthetic desktop copy of
 * session-sync that cannot filter mirrored records is planted so the push pause and unpause run too.
 *
 * It uses the real launcher: on Windows the runner is started through CIM Win32_Process.Create (hidden,
 * outside this process's tree), so this also proves the sandbox environment reaches that child.
 *
 * It asserts the LIVE store (names, sizes, mtimes), the live session-sync folder (config, state) and the
 * live app config were not touched, and prints a PASS/FAIL table. Exit 0 only when every check passed.
 * The scratch folder is kept for inspection; delete it by hand.
 */

import {
  existsSync, mkdirSync, readdirSync, statSync, lstatSync, readFileSync, writeFileSync, cpSync, realpathSync, mkdtempSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, platform, tmpdir } from 'node:os';
import { dirname, join, resolve, relative, sep, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { desktopDataRoots } from '../lib/paths.mjs';
import { findRclone } from '../lib/rclone.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'lib', 'cli.mjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECORD = /^local_([0-9a-f-]{36})\.json$/i;
const APP_TMP = /\.json\.tmp$/;

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('Usage: node scripts/rehearse-go-live.mjs [--source <claude-code-sessions dir or its parent>] [--scratch <new dir>]');
  process.exit(0);
}

const norm = (p) => (platform() === 'win32' ? resolve(p).toLowerCase() : resolve(p));
const isInside = (child, parent) => { const r = relative(norm(parent), norm(child)); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
function realish(p) {
  let cur = resolve(p); const rest = [];
  while (!existsSync(cur)) { rest.unshift(basename(cur)); const up = dirname(cur); if (up === cur) break; cur = up; }
  let base = cur; try { base = realpathSync(cur); } catch { /* keep */ }
  return join(base, ...rest);
}

// Captured BEFORE the environment is redirected: the live locations that must never be touched.
const REAL_HOME = homedir();
const LIVE_STATE_DIR = join(REAL_HOME, '.claude', 'session-sync');
const FORBIDDEN = [join(REAL_HOME, '.claude'), ...desktopDataRoots(), process.env.APPDATA ? join(process.env.APPDATA, 'Claude') : null].filter(Boolean);

let SOURCE = opt('--source');
if (!SOURCE) {
  const root = desktopDataRoots().find((r) => existsSync(join(r, 'claude-code-sessions')));
  if (!root) { console.error('Refusing: no live claude-code-sessions folder found; pass --source.'); process.exit(2); }
  SOURCE = join(root, 'claude-code-sessions');
} else {
  SOURCE = resolve(SOURCE);
  if (basename(SOURCE) !== 'claude-code-sessions') SOURCE = join(SOURCE, 'claude-code-sessions');
}
if (!existsSync(SOURCE) || !statSync(SOURCE).isDirectory()) { console.error(`Refusing: no claude-code-sessions folder at ${SOURCE}.`); process.exit(2); }
const SCRATCH = resolve(opt('--scratch') ?? mkdtempSync(join(tmpdir(), 'ss-golive-rehearsal-')));
for (const f of FORBIDDEN) {
  if (isInside(SCRATCH, f) || isInside(realish(SCRATCH), f)) { console.error(`Refusing: the scratch dir is inside ${f}.`); process.exit(2); }
}
if (existsSync(SCRATCH) && readdirSync(SCRATCH).length) { console.error('Refusing: the scratch dir exists and is not empty.'); process.exit(2); }
if (isInside(SCRATCH, SOURCE) || isInside(SOURCE, SCRATCH)) { console.error('Refusing: the scratch dir and the source overlap.'); process.exit(2); }

/* ------------------------------------------------------------------ helpers */

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: String(detail) });
const info = (name, detail = '') => results.push({ name, ok: true, level: 'INFO', detail: String(detail) });
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function walk(root) {
  const out = [];
  const rec = (abs) => {
    let ents; try { ents = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of ents) { const p = join(abs, e.name); if (e.isDirectory()) rec(p); else if (e.isFile()) out.push(p); }
  };
  rec(root);
  return out;
}
const rel = (root, p) => relative(root, p).split(sep).join('/');
function treeShape(root) {
  const m = new Map();
  for (const p of walk(root)) { const s = lstatSync(p); m.set(rel(root, p), { size: s.size, mtimeMs: s.mtimeMs, nlink: s.nlink }); }
  return m;
}
/** Failures are changes this script could have made; an app rewrite (mtime forward) is only a warning. */
function compareShape(before, after) {
  const fails = []; const warns = [];
  for (const [k, b] of before) {
    const a = after.get(k);
    if (!a) { (APP_TMP.test(k) ? warns : fails).push(`gone: ${k}`); continue; }
    if (a.nlink > b.nlink) { fails.push(`linked: ${k}`); continue; }
    if (a.size === b.size && a.mtimeMs === b.mtimeMs) continue;
    if (a.mtimeMs > b.mtimeMs) warns.push(`rewritten by the app: ${k}`); else fails.push(`changed: ${k}`);
  }
  for (const k of after.keys()) if (!before.has(k)) (APP_TMP.test(k) ? warns : fails).push(`new: ${k}`);
  return { fails, warns };
}
function listFolders(store) {
  const out = [];
  for (const a of readdirSync(store, { withFileTypes: true })) {
    if (!a.isDirectory() || !UUID.test(a.name)) continue;
    for (const o of readdirSync(join(store, a.name), { withFileTypes: true })) {
      if (o.isDirectory() && UUID.test(o.name)) out.push({ acct: a.name, org: o.name, key: `${a.name}/${o.name}`, path: join(store, a.name, o.name) });
    }
  }
  return out;
}
const idsIn = (f) => new Set(readdirSync(f.path).map((n) => RECORD.exec(n)?.[1]?.toLowerCase()).filter(Boolean));
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

/** A snapshot of the live things that must not change: the store shape, config and state files. */
function liveSnapshot() {
  const files = {};
  for (const n of ['config.json', 'sender-registered.txt']) {
    const p = join(LIVE_STATE_DIR, n);
    files[n] = existsSync(p) ? sha(readFileSync(p)) : null;
  }
  const accDir = join(LIVE_STATE_DIR, 'accounts');
  // a runner or waiter that is really alive on this machine beats its claim and state; those files are its own, not ours
  const HEARTBEAT = /^(go-live\.claim|waiter\.claim|waiter\.json(\.bak)?)$/;
  const acc = existsSync(accDir) ? new Map([...treeShape(accDir)].filter(([k]) => !HEARTBEAT.test(k)).map(([k, v]) => [k, `${v.size}:${v.mtimeMs}`])) : new Map();
  return { store: treeShape(SOURCE), files, acc };
}

/* ------------------------------------------------------------------ sandbox */

const HOME = join(SCRATCH, 'home');
const USERDATA = platform() === 'win32' ? join(HOME, 'AppData', 'Roaming', 'Claude')
  : platform() === 'darwin' ? join(HOME, 'Library', 'Application Support', 'Claude')
    : join(HOME, '.config', 'Claude');
const STORE = join(USERDATA, 'claude-code-sessions');
const STATE_DIR = join(HOME, '.claude', 'session-sync');
const ACC = join(STATE_DIR, 'accounts');
const REMOTE = join(SCRATCH, 'remote');
const APP = join(SCRATCH, 'app.json');
const EMPTY_CONF = join(SCRATCH, 'empty.conf');
const CONFIG = join(STATE_DIR, 'config.json');

const liveBefore = liveSnapshot();
mkdirSync(join(HOME, '.claude'), { recursive: true });
mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(REMOTE, { recursive: true });
mkdirSync(USERDATA, { recursive: true });
writeFileSync(EMPTY_CONF, '');
writeFileSync(join(HOME, '.claude', 'CLAUDE.md'), 'scratch rules\n');
writeFileSync(CONFIG, JSON.stringify({ notifications: false }, null, 2));
writeFileSync(join(STATE_DIR, 'sender-registered.txt'), new Date().toISOString());
cpSync(SOURCE, STORE, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });

const folders0 = listFolders(STORE);
const accounts = [...new Set(folders0.map((f) => f.acct))];
if (accounts.length < 2) { console.error('Refusing: the source store has fewer than two accounts; nothing to rehearse.'); process.exit(2); }
const countOf = (a) => folders0.filter((f) => f.acct === a).reduce((n, f) => n + idsIn(f).size, 0);
const SIGNED_IN = [...accounts].sort((a, b) => countOf(a) - countOf(b))[0];
writeFileSync(join(USERDATA, 'config.json'), JSON.stringify({ lastKnownAccountUuid: SIGNED_IN }));
const setApp = (running) => writeFileSync(APP, JSON.stringify({ running, signedIn: SIGNED_IN, startedAtMs: running ? Date.now() - 600000 : 0 }));
setApp(true);

// a desktop copy of session-sync that cannot filter mirrored records yet: go-live must pause push for it
const COPY = join(USERDATA, 'rpm', 'rehearsal-acct', 'rehearsal-org', 'plugin_rehearsal');
mkdirSync(join(COPY, '.claude-plugin'), { recursive: true });
mkdirSync(join(COPY, 'lib', 'accounts'), { recursive: true });
writeFileSync(join(COPY, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'session-sync', version: '0.3.0' }));
writeFileSync(join(COPY, 'lib', 'sync.mjs'), 'export function push() {}\n');
const makeCopyCapable = () => {
  for (const f of ['pass', 'waiter', 'folders']) writeFileSync(join(COPY, 'lib', 'accounts', `${f}.mjs`), '// capable\n');
  writeFileSync(join(COPY, 'lib', 'sync.mjs'), 'export function accountsPushFilter() {}\n');
};

const CHILD_ENV = {
  ...process.env,
  USERPROFILE: HOME, HOME, APPDATA: join(HOME, 'AppData', 'Roaming'), XDG_CONFIG_HOME: join(HOME, '.config'),
  CLAUDE_SESSION_SYNC_REMOTE: REMOTE, RCLONE_CONFIG: EMPTY_CONF, SESSION_SYNC_TEST_APP_STATE: APP, SESSION_SYNC_TEST_POLL_MS: '500',
};
for (const k of ['CLAUDE_PLUGIN_OPTION_ACCOUNTLINK', 'SESSION_SYNC_TEST_FAIL_AFTER', 'SESSION_SYNC_TEST_LAUNCH', 'SESSION_SYNC_TEST_LAUNCH_LOG']) delete CHILD_ENV[k];

function cli(args, timeout = 120000) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: CHILD_ENV, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  let json = null; try { json = JSON.parse(r.stdout); } catch { /* not json */ }
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '', json };
}
const result = () => readJson(join(ACC, 'go-live-result.json'));
const glState = () => readJson(join(ACC, 'go-live.json'));
const pushOn = () => readJson(CONFIG)?.enabled !== false;
async function waitFor(pred, ms, every = 250) { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(every); } return pred(); }

/* ------------------------------------------------------------------ the rehearsal */

const idsBefore = new Set(folders0.flatMap((f) => [...idsIn(f)]));
info('scratch', SCRATCH);
info('source (read only)', SOURCE);
info('accounts / folders / conversations', `${accounts.length} / ${folders0.length} / ${idsBefore.size}`);
let runnerPid = null;
try {
  const plan = cli(['accounts', 'status', '--json']);
  check('status sees at least 2 accounts, nothing linked', plan.json && plan.json.accounts.length >= 2 && plan.json.linked === false, plan.json ? `${plan.json.accounts.length} accounts` : `exit ${plan.code}`);

  // a user who is about to go live has pushed before: seed the scratch remote the same way (real rclone, local folder)
  const hasRclone = !!findRclone();
  if (hasRclone) {
    const seed = cli(['push', '--strict'], 600000);
    check('seed: a push to the scratch remote before go-live succeeds', seed.code === 0, `exit ${seed.code} ${seed.err.trim().split(/\r?\n/)[0]}`);
  } else info('seed push', 'SKIPPED: rclone not found; the remote duplicate check will be reported as not run');

  // the app is "running": go-live records consent and starts ONE runner, which must wait
  const gl = cli(['accounts', 'go-live', '--yes', '--json']);
  check('go-live --yes exits 0 and starts a runner', gl.code === 0 && gl.json?.started === true, gl.json ? JSON.stringify(gl.json.runner) : `exit ${gl.code} ${gl.err.trim().split('\n')[0]}`);
  runnerPid = gl.json?.runner?.pid ?? null;
  info('runner launch', gl.json ? `${gl.json.runner?.method} pid ${runnerPid}` : '');
  check('push paused for the stale desktop copy', pushOn() === false, `config enabled=${readJson(CONFIG)?.enabled}`);
  check('consent recorded (pair answered yes)', Object.values(readJson(join(ACC, 'state.json'))?.pairs ?? {}).some((p) => p.answer === 'yes'));
  const waiting = await waitFor(() => glState()?.phase === 'wait-stop' && result()?.status === 'waiting' && existsSync(join(ACC, 'go-live.claim')), 60000);
  check('the runner is alive and waiting for the app to stop', waiting, `phase ${glState()?.phase}`);
  const claim = readJson(join(ACC, 'go-live.claim'));
  if (claim?.pid) { try { process.kill(claim.pid, 0); check('the runner pid is a live process, not a child of this script', true, `pid ${claim.pid}`); } catch { check('the runner pid is alive', false, `pid ${claim.pid}`); } }
  const waitStatus = cli(['accounts', 'status']);
  check('`accounts status` leads with the one restart line while waiting', /Restart Claude to sync your accounts/.test(waitStatus.out.split('\n').slice(0, 3).join('\n')), waitStatus.out.split('\n')[0].slice(0, 100));
  await sleep(2000);
  check('still waiting 2 s later (no link while the app runs)', existsSync(join(ACC, 'go-live.claim')) && !readJson(join(ACC, 'state.json'))?.linked);

  // quit the "app": the runner links, verifies, relaunches (seam), waits for the copy, rectifies, checks the remote
  setApp(false);
  const gotCap = await waitFor(() => ['wait-start', 'wait-capability'].includes(glState()?.phase) || !!result()?.finishedAt, 240000);
  check('the runner linked and verified after the app stopped', gotCap, `phase ${glState()?.phase}`);
  check('the "app" was started again by the runner (seam)', await waitFor(() => readJson(APP)?.running === true, 60000));
  await waitFor(() => glState()?.phase === 'wait-capability' || !!result()?.finishedAt, 120000);
  check('push still paused while the copy is stale', pushOn() === false);
  makeCopyCapable();
  const finished = await waitFor(() => ['ok', 'attention', 'rolled_back', 'failed'].includes(result()?.status), 300000);
  const res = result();
  check('the runner reached a final result', finished, res ? `${res.status}, phase ${res.phase}` : 'no result file');
  if (res) {
    info('go-live result', `${res.status}; counts ${JSON.stringify(res.counts)}`);
    for (const m of res.messages ?? []) info('message', m);
    if (hasRclone) check('the remote duplicate check ran and found 0', res.counts?.remoteDuplicates === 0, `ids ${res.counts?.remoteIds}, duplicates ${res.counts?.remoteDuplicates}`);
    check('result is ok (or attention only for the optional remote check)', res.status === 'ok' || (res.status === 'attention' && !(res.messages ?? []).some((m) => /PROBLEM|rolled/i.test(m))), res.status);
    check('the finished result does not ask for a restart again', !(res.messages ?? []).some((m) => /Restart Claude to sync/.test(m)), '');
    check('result: split 0, missing 0', res.counts?.split === 0 && res.counts?.missing === 0, `split ${res.counts?.split}, missing ${res.counts?.missing}`);
    check('result names a backup and its rollback script', !!res.backupId && !!res.rollbackScript && existsSync(res.rollbackScript), res.backupId ?? '');
    check('push was switched back on once the copy could filter', res.push?.reEnabled === true && pushOn() === true, JSON.stringify(res.push));
    check('the log exists and ends with the result', existsSync(res.log) && /result: /.test(readFileSync(res.log, 'utf8')));
  }
  check('the accounts are linked', readJson(join(ACC, 'state.json'))?.linked === true);

  // every account folder holds every conversation
  const folders1 = listFolders(STORE);
  const missing = folders1.map((f) => ({ f, miss: [...idsBefore].filter((i) => !idsIn(f).has(i)).length })).filter((x) => x.miss);
  check('every folder holds every conversation of the source', missing.length === 0, missing.map((x) => `${x.f.acct.slice(0, 8)} lacks ${x.miss}`).join('; ') || `${folders1.length} folders x ${idsBefore.size}`);
  // the runner has left (no stray process holding the claim)
  check('the runner released its claim', await waitFor(() => !existsSync(join(ACC, 'go-live.claim')), 30000));
  const status = cli(['accounts', 'status']);
  check('`accounts status` shows the go-live result', /Go-live: (ok|attention)/.test(status.out), (status.out.match(/Go-live:[^\n]*/) ?? [''])[0].slice(0, 120));
} catch (e) {
  check('rehearsal ran without an exception', false, e?.stack ?? e);
}

// the live things were not touched
const liveAfter = liveSnapshot();
const cmp = compareShape(liveBefore.store, liveAfter.store);
check('LIVE store unchanged (names, sizes, mtimes)', cmp.fails.length === 0, cmp.fails.slice(0, 5).join('; '));
if (cmp.warns.length) info('LIVE store: the running app rewrote files meanwhile (not the rehearsal)', `${cmp.warns.length}`);
check('LIVE session-sync config.json and sender marker unchanged', JSON.stringify(liveBefore.files) === JSON.stringify(liveAfter.files));
check('LIVE session-sync accounts folder unchanged', JSON.stringify([...liveBefore.acc]) === JSON.stringify([...liveAfter.acc]), '');

const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`${r.level ?? (r.ok ? 'PASS' : 'FAIL')}  ${r.name.padEnd(width)}${r.detail ? `  ${r.detail}` : ''}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? `FAILED: ${failed.length} check(s)` : 'ALL CHECKS PASSED'}  (scratch kept at ${SCRATCH})`);
process.exit(failed.length ? 1 : 0);
