/**
 * appstate.mjs - is the desktop app running, which account is signed in, and
 * which folders may the running app still write (plan sections 5.2 and 5.3).
 *
 * Signals (Windows): S1 = USERDATA/lockfile exists (never opened); S2 = a
 * desktop process exists. macOS and Linux use the SingletonLock symlink and
 * `ps`; they are INFERRED and mocked in tests.
 *
 * The ONE read of USERDATA/config.json is readSignedIn(): a bounded scan for
 * the `lastKnownAccountUuid` key. The file is never parsed, copied, logged or
 * written (plan invariant I2).
 *
 * TEST SEAM: SESSION_SYNC_TEST_APP_STATE=<json file> with
 * {running, signedIn, startedAtMs, s1, s2}; re-read on every check. Production
 * never sets it.
 */

import {
  existsSync, readFileSync, statSync, unlinkSync, lstatSync, readlinkSync, readdirSync, openSync, readSync, closeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pidAlive } from '../lock.mjs';
import { accPath, readJson, writeJsonAtomic } from './state.mjs';

export class AppRunningError extends Error {
  constructor(msg = 'the Claude desktop app is running') { super(msg); this.name = 'AppRunningError'; }
}

const STALE_MIN_CHECKS = 3;
const STALE_MIN_SPAN_MS = 3 * 60 * 1000;
const SIGNED_IN_RE = /"lastKnownAccountUuid"\s*:\s*"([0-9a-f-]{36})"/;
const WIN_APP_PATHS = [
  /\\WindowsApps\\Claude_[^\\]+\\app\\Claude\.exe$/i,
  /\\AnthropicClaude\\(app-[^\\]+\\)?claude\.exe$/i,
];
const WIN_CLI_PATH = /\\Claude\\claude-code\\/i;

/** The test seam, or null. */
export function testSeam() {
  const f = process.env.SESSION_SYNC_TEST_APP_STATE;
  if (!f) return null;
  const o = readJson(f, null);
  if (!o) return null;
  const running = !!o.running;
  return {
    s1: 's1' in o ? o.s1 : running,
    s2: 's2' in o ? o.s2 : running,
    signedIn: o.signedIn ?? null,
    startedAtMs: o.startedAtMs ?? 0,
  };
}

/** S1: the app's single-instance marker. Never opens the file. */
export function lockfilePresent(ctx) {
  const seam = testSeam();
  if (seam) return !!seam.s1;
  const ud = ctx.userData;
  if (!ud) return false;
  if ((ctx.platform ?? process.platform) === 'win32') return existsSync(join(ud, 'lockfile'));
  try {
    const st = lstatSync(join(ud, 'SingletonLock'));
    if (!st.isSymbolicLink()) return false;
    const m = /^(.*)-(\d+)$/.exec(readlinkSync(join(ud, 'SingletonLock')));
    if (!m) return true;
    return m[1] === hostname() ? pidAlive(Number(m[2])) : true;
  } catch { return false; }
}

/** Birth time of the lock marker = start of the running app. 0 when unknown. */
export function lockStartedAtMs(ctx) {
  const ud = ctx.userData;
  if (!ud) return 0;
  const name = (ctx.platform ?? process.platform) === 'win32' ? 'lockfile' : 'SingletonLock';
  try {
    const st = lstatSync(join(ud, name));
    return Math.round(st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs);
  } catch { return 0; }
}

/**
 * S2: desktop process present. true / false / null (unknown). Never detached,
 * always hidden (plan I5).
 */
export function desktopProcesses(ctx = {}) {
  const platform = ctx.platform ?? process.platform;
  const spawnFn = ctx.spawnFn ?? spawnSync;
  try {
    if (platform === 'win32') {
      const r = spawnFn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        'Get-Process -Name claude -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }',
      ], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
      if (!r || r.error || r.status !== 0) return null;
      const paths = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      return paths.some((p) => !WIN_CLI_PATH.test(p) && WIN_APP_PATHS.some((re) => re.test(p)));
    }
    if (platform === 'darwin') {
      const r = spawnFn('ps', ['-axo', 'comm='], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
      if (!r || r.error || r.status !== 0) return null;
      return String(r.stdout || '').split('\n').some((l) => /\/Claude\.app\/Contents\/MacOS\/Claude$/.test(l.trim()));
    }
    // Linux: the SingletonLock pid is the only signal.
    return lockfilePresent(ctx);
  } catch { return null; }
}

/**
 * The signed-in account uuid from USERDATA/config.json, or null.
 * Bounded scan: 64 KB chunks, 1 MB at most, first match wins. The file is not
 * parsed, and every chunk buffer is zeroed after use. Only the uuid leaves.
 */
export function readSignedIn(userData) {
  if (!userData) return null;
  let fd;
  try { fd = openSync(join(userData, 'config.json'), 'r'); } catch { return null; }
  const CHUNK = 64 * 1024;
  const MAX = 1024 * 1024;
  const buf = Buffer.alloc(CHUNK);
  let total = 0;
  let carry = '';
  let found = null;
  try {
    while (total < MAX) {
      const n = readSync(fd, buf, 0, CHUNK, null);
      if (n <= 0) break;
      total += n;
      const text = carry + buf.toString('latin1', 0, n);
      const m = SIGNED_IN_RE.exec(text);
      if (m) { found = m[1].toLowerCase(); break; }
      carry = text.slice(-120);
    }
  } catch { /* unreadable: unknown */ } finally {
    buf.fill(0);
    try { closeSync(fd); } catch { /* ignore */ }
  }
  carry = '';
  return found;
}

/**
 * Pure decision rule for "running" (plan 5.2). `rec` is lock-stale.json
 * ({firstSeenAt, count}) or null; returns the new record to persist.
 * stale: S1 true and S2 false on >= 3 checks spanning >= 3 minutes.
 */
export function evaluateRunning(s1, s2, rec, now) {
  let next = rec ? { ...rec } : null;
  if (s2 === true || !s1) next = null;
  else if (s2 === false) {
    next = next ? { firstSeenAt: next.firstSeenAt, count: next.count + 1 } : { firstSeenAt: now, count: 1 };
  }
  const stale = !!(s1 && s2 === false && next && next.count >= STALE_MIN_CHECKS && now - next.firstSeenAt >= STALE_MIN_SPAN_MS);
  const running = s2 === true || (!!s1 && !stale);
  const fullAllowed = (!s1 || stale) && s2 === false;
  return { running, stale, fullAllowed, rec: next };
}

/**
 * Current app state. `probeProcesses:false` skips the process probe (hook
 * path: no PowerShell), leaving S2 unknown unless the seam supplies it.
 * Persists lock-stale.json when the stale counter changes.
 */
export function appState(opts = {}) {
  const { probeProcesses = false, ctx } = opts;
  const now = opts.now ?? ctx.now();
  const seam = testSeam();
  let s1; let s2; let signedIn; let startedAtMs;
  if (seam) {
    ({ s1, s2, signedIn, startedAtMs } = seam);
  } else {
    s1 = lockfilePresent(ctx);
    s2 = probeProcesses ? desktopProcesses(ctx) : null;
    signedIn = readSignedIn(ctx.userData);
    startedAtMs = s1 ? lockStartedAtMs(ctx) : 0;
  }
  const staleFile = accPath(ctx, 'lock-stale.json');
  const prev = readJson(staleFile, null);
  const ev = evaluateRunning(!!s1, s2, prev, now);
  const changed = JSON.stringify(prev) !== JSON.stringify(ev.rec);
  if (changed) {
    try {
      if (ev.rec) writeJsonAtomic(staleFile, ev.rec);
      else unlinkSync(staleFile);
    } catch { /* best effort */ }
  }
  return {
    running: ev.running, stale: ev.stale, fullAllowed: ev.fullAllowed,
    s1: !!s1, s2, signedIn, startedAtMs: startedAtMs || 0,
  };
}

/** Remember when an account was last seen signed in (the "newest" proxy for settings conflicts). */
export function noteSignedIn(state, acct, now = Date.now()) {
  if (!acct) return;
  state.lastSignedIn ||= {};
  state.lastSignedIn[acct] = new Date(now).toISOString();
}

/** A guard for full passes: aborts when the app's lock marker appears mid-pass. */
export function makeS1Guard(ctx, { allowStale = false } = {}) {
  return () => {
    if (lockfilePresent(ctx) && !allowStale) throw new AppRunningError('the Claude desktop app started during the pass');
  };
}

const sha = (p) => { try { return createHash('sha256').update(readFileSync(p)).digest('hex'); } catch { return null; } };

/**
 * Folders the running app may write (plan 5.3). Returns a Set of folder keys
 * and persists the sticky set into state.live. Empty when the app is not
 * running; every folder when the signed-in account is unknown.
 */
export function liveFolders(app, folders, state) {
  if (!app.running) return new Set();
  if (!state.live || state.live.startedAtMs !== app.startedAtMs) state.live = { startedAtMs: app.startedAtMs, folders: [] };
  if (!app.signedIn) {
    state.live.folders = folders.map((f) => f.key);
    return new Set(state.live.folders);
  }
  const live = new Set(folders.filter((f) => f.acct === app.signedIn).map((f) => f.key));
  for (const k of state.live.folders) live.add(k);
  for (const f of folders) {
    if (live.has(f.key)) continue;
    if (folderLooksLive(f, app.startedAtMs, state.tasksWritten?.[f.key])) live.add(f.key);
  }
  state.live.folders = [...live].sort();
  return live;
}

function folderLooksLive(f, startedAtMs, tasksSha) {
  let names;
  try { names = readdirSync(f.path); } catch { return false; }
  for (const n of names) {
    if (/^local_.*\.json$/i.test(n)) {
      try {
        const st = statSync(join(f.path, n));
        if (st.nlink === 1 && st.mtimeMs >= startedAtMs) return true;
      } catch { /* vanished */ }
    } else if (n.endsWith('.json.tmp')) {
      return true;
    } else if (n === 'archived-sessions.idx') {
      try { if (statSync(join(f.path, n)).mtimeMs >= startedAtMs) return true; } catch { /* ignore */ }
    } else if (n === 'scheduled-tasks.json') {
      try {
        const p = join(f.path, n);
        if (statSync(p).mtimeMs >= startedAtMs && sha(p) !== tasksSha) return true;
      } catch { /* ignore */ }
    }
  }
  return false;
}
