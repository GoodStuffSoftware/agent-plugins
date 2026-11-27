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
 * The Windows S2 probe. It ends with a marker line and ALWAYS exits 0: Get-Process exits 1 when no process has the
 * name, and "no claude process" is the normal answer once the app has quit, not a failure. Output: one `P|<id>|<path>`
 * line per `claude` process, then the marker. A missing marker (error, timeout, a shell that never ran the script) is the
 * only way S2 becomes unknown.
 */
export const PROBE_MARK = 'SS-PROBE-OK';
export const WIN_PROBE_SCRIPT = `$p = @(Get-Process -Name claude -ErrorAction SilentlyContinue); foreach ($x in $p) { 'P|' + $x.Id + '|' + $x.Path }; '${PROBE_MARK}'; exit 0`;

/** Parse the probe output. {value: true|false|null, detail}; detail says why a null is unknown. */
export function parseWinProbe(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.includes(PROBE_MARK)) return { value: null, detail: 'the probe end marker is missing' };
  const paths = [];
  for (const l of lines) {
    const m = /^P\|(\d+)\|(.*)$/.exec(l);
    if (!m) continue;
    // a claude process whose path cannot be read is unknown, never absent (a path miss must not make a running app look stopped)
    if (!m[2].trim()) return { value: null, detail: `claude process ${m[1]} has no readable path` };
    paths.push(m[2].trim());
  }
  return { value: paths.some((p) => !WIN_CLI_PATH.test(p) && WIN_APP_PATHS.some((re) => re.test(p))), detail: null };
}

/**
 * S2: desktop process present, with the reason when unknown: {value: true|false|null, detail}.
 * Never detached, always hidden (plan I5).
 */
export function probeDesktop(ctx = {}) {
  const platform = ctx.platform ?? process.platform;
  const spawnFn = ctx.spawnFn ?? spawnSync;
  try {
    if (platform === 'win32') {
      const r = spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_PROBE_SCRIPT],
        { windowsHide: true, encoding: 'utf8', timeout: 15000 });
      if (!r || r.error) return { value: null, detail: `the probe did not run: ${String(r?.error?.message ?? 'no result').slice(0, 120)}` };
      const p = parseWinProbe(r.stdout);
      if (p.value === null) p.detail = `${p.detail} (status ${r.status}, stderr ${JSON.stringify(String(r.stderr ?? '').trim().slice(0, 200))})`;
      return p;
    }
    if (platform === 'darwin') {
      const r = spawnFn('ps', ['-axo', 'comm='], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
      if (!r || r.error || r.status !== 0) return { value: null, detail: `ps failed (status ${r?.status ?? 'none'})` };
      return { value: String(r.stdout || '').split('\n').some((l) => /\/Claude\.app\/Contents\/MacOS\/Claude$/.test(l.trim())), detail: null };
    }
    // Linux: the SingletonLock pid is the only signal.
    return { value: lockfilePresent(ctx), detail: null };
  } catch (e) { return { value: null, detail: `the probe threw: ${String(e?.message ?? e).slice(0, 120)}` }; }
}

/** S2 as true / false / null (unknown). */
export const desktopProcesses = (ctx = {}) => probeDesktop(ctx).value;

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

/** The signed-in account right now (config.json, or the test seam), or null when unknown. A pass re-reads it right before it acts. */
export function signedInNow(ctx) {
  const seam = testSeam();
  return seam ? seam.signedIn : readSignedIn(ctx.userData);
}

/**
 * Pure decision rule for "running" (plan 5.2). `rec` is lock-stale.json
 * ({firstSeenAt, count}) or null; returns the new record to persist.
 * stale: S1 true and S2 false on >= 3 checks spanning >= 3 minutes. It is INFORMATIONAL only (N1): a lock marker
 * with no process (crash, power loss) still counts as running and still blocks a full pass, because the S1 guard
 * aborts at the first mutation while the marker exists and a path-regex miss on S2 must never make a running app look
 * stopped. `status` tells the user to start Claude once and quit it from the tray icon, which clears the marker.
 */
export function evaluateRunning(s1, s2, rec, now) {
  let next = rec ? { ...rec } : null;
  if (s2 === true || !s1) next = null;
  else if (s2 === false) {
    next = next ? { firstSeenAt: next.firstSeenAt, count: next.count + 1 } : { firstSeenAt: now, count: 1 };
  }
  const stale = !!(s1 && s2 === false && next && next.count >= STALE_MIN_CHECKS && now - next.firstSeenAt >= STALE_MIN_SPAN_MS);
  const running = s2 === true || !!s1;
  const fullAllowed = !s1 && s2 === false;
  return { running, stale, fullAllowed, rec: next };
}

/**
 * Current app state. `probeProcesses:false` skips the process probe (hook
 * path: no PowerShell), leaving S2 unknown unless the seam supplies it.
 * Persists lock-stale.json when the stale counter changes.
 */
export function appState(opts = {}) {
  const { probeProcesses = false, ctx, readOnly = false } = opts;   // readOnly: the stale-lock record is read, never written (a dry run)
  const now = opts.now ?? ctx.now();
  const seam = testSeam();
  let s1; let s2; let signedIn; let startedAtMs; let s2Detail = null;
  if (seam) {
    ({ s1, s2, signedIn, startedAtMs } = seam);
  } else {
    s1 = lockfilePresent(ctx);
    s2 = null;
    if (probeProcesses) ({ value: s2, detail: s2Detail } = probeDesktop(ctx));
    signedIn = readSignedIn(ctx.userData);
    startedAtMs = s1 ? lockStartedAtMs(ctx) : 0;
  }
  const staleFile = accPath(ctx, 'lock-stale.json');
  const prev = readJson(staleFile, null);
  const ev = evaluateRunning(!!s1, s2, prev, now);
  const changed = JSON.stringify(prev) !== JSON.stringify(ev.rec);
  if (changed && !readOnly) {
    try {
      if (ev.rec) writeJsonAtomic(staleFile, ev.rec);
      else unlinkSync(staleFile);
    } catch { /* best effort */ }
  }
  return {
    running: ev.running, stale: ev.stale, fullAllowed: ev.fullAllowed,
    s1: !!s1, s2, s2Detail, signedIn, startedAtMs: startedAtMs || 0,
  };
}

/** After this long with the lock marker gone and S2 still unknown, the watch logs a WARN that names the probe's own words. */
export const S2_WARN_AFTER_MS = 10 * 1000;

/**
 * One watcher for every "wait until the app has stopped" loop (the go-live runner's three waits and the waiter), so they
 * read the app the same way and say what they see. `read()` returns the appState and, as a side effect, logs (once per
 * change, never per poll):
 *   - the lock marker going away and coming back (S1 true -> false -> true);
 *   - S2 unknown while S1 is false: the first time, every 60th reading, and a WARN after S2_WARN_AFTER_MS that names the probe's
 *     status and stderr (the line that would have exposed a probe that always fails);
 *   - the restart latch: the lock marker's creation time changed (or the marker went away and came back) since the last
 *     reading, so the app quit and started again. A stop too short to link in is no longer silent.
 * It never decides anything: fullAllowed still comes from appState.
 *
 * o: { log(line), clock(), probeEveryMs, status(ctx) } - `status` replaces appState (the go-live tests' appStatus dependency).
 */
export function createStopWatch(ctx, o = {}) {
  const log = o.log ?? (() => {});
  const clock = o.clock ?? Date.now;
  const probeEveryMs = o.probeEveryMs ?? 10 * 60 * 1000;
  let lastProbe = -Infinity;
  let prevS1 = null; let downAt = 0; let nulls = 0; let nullSince = 0; let warned = false;
  let birth = 0;
  return {
    /** @param {{probeProcesses?: boolean, now?: number}} [opts] force a probe (true) or none (false); a caller's own reading of the clock */
    read(opts = {}) {
      const now = opts.now ?? clock();
      // By default a reading with the lock marker gone probes (a hidden PowerShell on Windows), because the stop is being
      // confirmed. A loop that has already settled on "closed" passes probeProcesses:false and probes only now and then (S4).
      const probe = opts.probeProcesses ?? (!lockfilePresent(ctx) || now - lastProbe >= probeEveryMs);
      if (probe) lastProbe = now;
      const app = o.status ? o.status(ctx, { probeProcesses: probe }) : appState({ ctx, probeProcesses: probe, now: ctx.now() });
      if (typeof app.s1 !== 'boolean') return app;   // an injected status with no signals: nothing to say
      if (prevS1 === true && !app.s1) { downAt = now; log('app lock marker gone (S1 true -> false)'); }
      if (prevS1 === false && app.s1) {
        log(`app lock marker is back (S1 false -> true) after ${now - downAt} ms`);
        nulls = 0; nullSince = 0; warned = false;
      }
      if (app.s1 && app.startedAtMs) {
        if (birth && app.startedAtMs !== birth) log(`app restarted (lock marker created ${new Date(app.startedAtMs).toISOString()}); the stop lasted ${prevS1 === false ? `${now - downAt} ms` : 'less than one reading'}`);
        birth = app.startedAtMs;
      }
      if (!app.s1 && probe) {
        if (app.s2 === null) {
          if (!nulls) nullSince = now;
          nulls++;
          if (nulls === 1 || nulls % 60 === 0) log(`S2 (process probe) is unknown while the lock marker is gone (${nulls} time(s)): ${app.s2Detail ?? 'no detail'}`);
          if (!warned && now - nullSince >= S2_WARN_AFTER_MS) { warned = true; log(`WARN: the process probe has been unknown for ${now - nullSince} ms with the lock marker gone, so the stop cannot be confirmed: ${app.s2Detail ?? 'no detail'}`); }
        } else { nulls = 0; nullSince = 0; warned = false; }
      }
      prevS1 = app.s1;
      return app;
    },
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

/* ------------------------------------------------------------------ folder roles (account switches) */

/**
 * The app reads an account's folder when it LOADS it (that account signs in) and holds every record in memory from then on,
 * so what may be written depends on what the app has loaded, not on what it ever wrote:
 *   loaded   the signed-in account's folders (all its orgs; the current org is not visible): ADD only
 *   cooling  the account that was signed in a moment ago: its sessions still flush and tear down into its folder for a few
 *            seconds after the switch, so it is ADD only until `G_SWITCH_MS` has passed
 *   free     every other folder of the group: the app does not hold it, so it can be kept fully current
 * An unknown signed-in account makes every folder loaded (the old rule). A stopped app loads nothing.
 */
export const G_SWITCH_MS = 15 * 1000;

/** The record names in a folder as `{id: dev:ino}`: what the app most likely loads when it opens the folder. */
export function snapshotFolder(path) {
  const out = {};
  let names;
  try { names = readdirSync(path); } catch { return out; }
  for (const n of names) {
    const m = /^(local_[0-9a-f-]{36})\.json$/i.exec(n);
    if (!m) continue;
    try { const s = statSync(join(path, n), { bigint: true }); out[m[1].toLowerCase()] = `${s.dev}:${s.ino}`; } catch { /* vanished */ }
  }
  return out;
}

/**
 * Note the signed-in account in `state.signed` = {acct, at, prev, cooling: {acct: untilMs}, unloadedAt: {acct: ms}}.
 * Returns {changed, prev}. An unknown account changes nothing; the first sight of an account is not a switch.
 */
export function noteSwitch(state, signedIn, now) {
  if (!signedIn) return { changed: false, prev: null };
  const cur = state.signed;
  if (!cur?.acct) { state.signed = { acct: signedIn, at: now, prev: null, cooling: {}, unloadedAt: {} }; return { changed: false, prev: null }; }
  if (cur.acct === signedIn) return { changed: false, prev: cur.prev ?? null };
  const cooling = {};
  for (const [a, until] of Object.entries(cur.cooling ?? {})) if (until > now && a !== signedIn) cooling[a] = until;
  cooling[cur.acct] = now + G_SWITCH_MS;
  const unloadedAt = { ...(cur.unloadedAt ?? {}), [cur.acct]: now };
  delete unloadedAt[signedIn];
  state.signed = { acct: signedIn, at: now, prev: cur.acct, cooling, unloadedAt };
  return { changed: true, prev: cur.acct };
}

/**
 * Roles of the group's folders for a pass (call noteSwitch first). `gainedKeys` are group folders that no full pass has
 * covered yet (a newly linked account): they stay ADD only until the full pass has taken its safety backup.
 * @returns {{loaded:Set<string>, cooling:Set<string>}} folder keys; a key in neither set is free
 */
export function folderRoles(app, folders, state, now, gainedKeys = []) {
  const loaded = new Set(); const cooling = new Set();
  if (!app.running) return { loaded, cooling };
  if (!app.signedIn) { for (const f of folders) loaded.add(f.key); return { loaded, cooling }; }
  for (const f of folders) {
    if (f.acct === app.signedIn) loaded.add(f.key);
    else if ((state.signed?.cooling?.[f.acct] ?? 0) > now) cooling.add(f.key);
  }
  for (const k of gainedKeys) if (!loaded.has(k)) cooling.add(k);
  return { loaded, cooling };
}

/**
 * From when a name in an unloaded folder counts as written by a PARKED session (a session of that account that is still running):
 * only from an unload this watcher saw during THIS app run (`state.signed.unloadedAt`). An unknown unload time means nothing is held:
 * every write the app made earlier in the run is then field drift, which must converge to the newest copy (B1). A parked session only
 * exists after a switch away from its account, and a restart of the app ends every parked session.
 * @returns {number} ms, or Infinity (never held)
 */
export function heldSinceOf(state, acct, appStartedAtMs = 0) {
  const t = state.signed?.unloadedAt?.[acct];
  // 0.5.16: counted from the END of the cooling window. The app's own save at the switch (about 3 s after it) lands inside the
  // window and is drift that converges to the newest copy, not a parked session's write.
  return typeof t === 'number' && t >= appStartedAtMs ? t + G_SWITCH_MS : Infinity;
}

/**
 * Is this record name (in a folder that is neither loaded nor cooling) a parked session's file? Pure.
 *   - `state.held[id][folder] === ino`: seen as held before (S3: a link another folder took to it does not end the hold, nlink is not used);
 *   - else not an inode a pass of ours left there (`state.records[id].ino`), alone (nlink 1) and written after the folder was unloaded.
 * 0.5.16: an inode that a link of ours produced (`own`: the inodes rectify recorded at the moment of each link) is never a parked
 * session's, whatever its link count; and a recorded hold ends when the write is no later than the start of held time (a switch-time save).
 * @param {{id:string, folder:string, inoKey:string, nlink:number, mtimeMs:number}} e
 * @param {Iterable<string>} [own] inode keys of recent links of ours for this id
 */
export function nameIsHeld(state, e, appStartedAtMs = 0, own = null) {
  if (own && (own instanceof Set ? own.has(e.inoKey) : [...own].includes(e.inoKey))) return false;
  const since = heldSinceOf(state, String(e.folder).split('/')[0], appStartedAtMs);
  if (state.held?.[e.id]?.[e.folder] === e.inoKey) return e.mtimeMs > since;
  const ours = state.records?.[e.id]?.ino;
  return ours !== e.inoKey && e.nlink === 1 && e.mtimeMs > since;
}

/** When the next cooling period ends (ms), or 0 when none is running. */
export function coolingEndsAt(state, now) {
  let t = 0;
  for (const until of Object.values(state.signed?.cooling ?? {})) if (until > now && (!t || until < t)) t = until;
  return t;
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
