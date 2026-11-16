#!/usr/bin/env node
/**
 * rollback.mjs - restore the Claude desktop app's session store to the state
 * saved by the one-time backup taken before the account link (plan 5.16).
 *
 * THIS FILE IS COPIED INTO THE BACKUP FOLDER AND RUNS FROM THERE. It uses Node
 * builtins only and imports nothing from the plugin, so it works with no plugin
 * installed.
 *
 *   node rollback.mjs [--dry-run] [--exact] [--json]
 *                     [--ignore-stale-lockfile] [--acc <dir>] [--store <dir>] [--user-data <dir>]
 *
 * It takes accounts.lock (refused with exit 3 while a pass holds it) and writes ACC/rollback-active, which
 * stays until the rollback has finished: no pass or unlink runs while it exists, so a rollback that
 * stopped half way is finished by running it again. A dry run takes neither.
 *
 * Steps: (1) refuse while the app runs; (2) snapshot the current state to
 * pre-rollback-<stamp>/; (3) find records created after the backup;
 * (4) restore the store from the backup; (5) put post-backup records back into
 * their home folder as single files; (6) task run-times (max-merge; --exact skips it);
 * (7) whole-file areas and path-level areas (only the saved allow-listed paths of
 * claude_desktop_config.json and remote-control-state.json); (8) verify;
 * (9) reset the account pairs to "no".
 *
 * Never restored or removed, left exactly as they are now: waiting-input/**,
 * owed-bridge-delete_*, archived-sessions.idx (the app's live queues and hints:
 * restoring them could deliver a queued message twice), plus *.tmp, *.bak-*,
 * imported-staging and *.partial (written by the app or other tools).
 *
 * Exit codes: 0 done, 3 refused (the app is running), 1 failed.
 */

import {
  readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, lstatSync, linkSync, renameSync,
  unlinkSync, utimesSync, copyFileSync, openSync, writeSync, fsyncSync, closeSync, fchmodSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const DRY = flag('--dry-run');
const EXACT = flag('--exact');
const JSON_OUT = flag('--json');
const HERE = dirname(fileURLToPath(import.meta.url));

const RECORD = /^local_([0-9a-f-]{36})\.json$/i;
const OURTMP = /^\.session-sync-link-[0-9a-f]{12}$/;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const shaFile = (p) => sha(readFileSync(p));
const say = (s) => { if (!JSON_OUT) console.log(s); };

/* ------------------------------------------------------------ app running (S1, S2 inlined) */

function appRunning(userData) {
  let s1; let s2;
  const seamFile = process.env.SESSION_SYNC_TEST_APP_STATE;   // test seam; production never sets it
  if (seamFile) {
    try {
      const o = JSON.parse(readFileSync(seamFile, 'utf8'));
      s1 = 's1' in o ? !!o.s1 : !!o.running;
      s2 = 's2' in o ? o.s2 : !!o.running;
    } catch { s1 = true; s2 = null; }
    return { s1, s2 };
  }
  const win = process.platform === 'win32';
  if (win) {
    s1 = existsSync(join(userData, 'lockfile'));
    try {
      const r = spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        'Get-Process -Name claude -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }',
      ], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
      if (r.error || r.status !== 0) s2 = null;
      else {
        const paths = String(r.stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
        s2 = paths.some((p) => !/\\Claude\\claude-code\\/i.test(p)
          && (/\\WindowsApps\\Claude_[^\\]+\\app\\Claude\.exe$/i.test(p) || /\\AnthropicClaude\\(app-[^\\]+\\)?claude\.exe$/i.test(p)));
      }
    } catch { s2 = null; }
    return { s1, s2 };
  }
  try {
    const l = join(userData, 'SingletonLock');
    s1 = lstatSync(l).isSymbolicLink();
  } catch { s1 = false; }
  if (process.platform === 'darwin') {
    try {
      const r = spawnSync('ps', ['-axo', 'comm='], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
      s2 = r.status === 0 ? String(r.stdout).split('\n').some((l) => /\/Claude\.app\/Contents\/MacOS\/Claude$/.test(l.trim())) : null;
    } catch { s2 = null; }
  } else s2 = s1;   // Linux: the SingletonLock is the only signal
  return { s1, s2 };
}

/* ------------------------------------------------------------ helpers */

const toPosix = (p) => p.split(sep).join('/');

function walk(root) {
  const files = [];
  const rec = (abs) => {
    let ents;
    try { ents = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(abs, e.name);
      if (e.isDirectory()) rec(p);
      else if (e.isFile()) files.push({ rel: toPosix(relative(root, p)), abs: p });
    }
  };
  rec(root);
  return files;
}

function isExcluded(rel) {
  return /(^|\/)waiting-input(\/|$)/.test(rel)
    || /(^|\/)owed-bridge-delete_[^/]*$/.test(rel)
    || /(^|\/)archived-sessions\.idx$/.test(rel)
    || /\.tmp$/.test(rel) || /\.bak-/.test(rel) || /\.partial$/.test(rel)
    || /(^|\/)imported-staging(\/|$)/.test(rel);
}

/** Names the feature itself creates, safe to remove when the backup does not list them. */
function isRemovable(rel) {
  const parts = rel.split('/');
  const name = parts[parts.length - 1];
  if (parts.length === 3 && (RECORD.test(name) || /^deleted_/.test(name) || OURTMP.test(name))) return true;
  return parts.length === 4 && parts[2] === 'backlog' && name === 'tasks.json';
}

function copyKeep(src, dst) {
  const buf = readFileSync(src);
  const st = statSync(src, { bigint: true });
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, buf);
  const ms = Number(st.mtimeNs / 1000000n);
  try { utimesSync(dst, ms / 1000, ms / 1000); } catch { /* ignore */ }
}

/** Write `src` content to `dst` through a temp name and a rename, then stamp mtime. */
function restoreFile(src, dst, mtimeMs, tmpName) {
  mkdirSync(dirname(dst), { recursive: true });
  const tmp = join(dirname(dst), tmpName());
  const buf = readFileSync(src);
  const fd = openSync(tmp, 'w');
  try { writeSync(fd, buf); fsyncSync(fd); } finally { closeSync(fd); }
  try { utimesSync(tmp, mtimeMs / 1000, mtimeMs / 1000); } catch { /* ignore */ }
  renameRetry(tmp, dst);
}

function renameRetry(a, b) {
  for (let i = 0; ; i++) {
    try { renameSync(a, b); return; } catch (e) {
      if (i >= 3 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    }
  }
}

function relinkTo(primary, dst) {
  const tmp = join(dirname(dst), `.session-sync-link-${randomBytes(6).toString('hex')}`);
  mkdirSync(dirname(dst), { recursive: true });
  linkSync(primary, tmp);
  try { renameRetry(tmp, dst); } catch (e) { try { unlinkSync(tmp); } catch { /* ignore */ } throw e; }
}

const inoOf = (p) => { try { const s = statSync(p, { bigint: true }); return `${s.dev}:${s.ino}`; } catch { return null; } };
const stampNow = () => {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
};

/* ------------------------------------------------------------ accounts.lock and the rollback-active marker (B2) */

const LOCK_TTL_MS = 30 * 60 * 1000;   // the same rule as the plugin's lock.mjs
const pidAlive = (pid) => {
  if (!pid) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

/**
 * Take ACC/accounts.lock (`{pid, at}`, created with `wx`; the plugin's passes use the same file and rule).
 * Returns a release function, or null when a live process holds it. A lock of a dead pid or older than the
 * TTL is taken over; an unreadable one younger than 5 s is a writer mid-write and counts as held.
 */
function takeLock(acc) {
  const file = join(acc, 'accounts.lock');
  mkdirSync(acc, { recursive: true });
  for (let i = 0; i < 3; i++) {
    try {
      const fd = openSync(file, 'wx');
      try { writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), by: 'rollback' })); } finally { closeSync(fd); }
      return () => {
        try { if (JSON.parse(readFileSync(file, 'utf8')).pid === process.pid) unlinkSync(file); } catch { /* gone */ }
      };
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
    let cur = null;
    try { cur = JSON.parse(readFileSync(file, 'utf8')); } catch { /* unreadable */ }
    if (cur) { if (pidAlive(cur.pid) && Date.now() - (cur.at || 0) < LOCK_TTL_MS) return null; }
    else { try { if (Date.now() - statSync(file).mtimeMs < 5000) return null; } catch { /* gone: retry */ } }
    try { unlinkSync(file); } catch { /* retry */ }
  }
  return null;
}

function writeJsonAtomic(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  if (existsSync(file)) { try { copyFileSync(file, `${file}.bak`); } catch { /* ignore */ } }
  renameRetry(tmp, file);
}

/* ------------------------------------------------------------ JSON text helpers (formatting kept) */

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function detectFormat(text) {
  const bom = text.charCodeAt(0) === 0xFEFF;
  const t = bom ? text.slice(1) : text;
  const eol = t.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = /\r?\n$/.test(t);
  let indent = 0;
  for (const line of t.split(/\r?\n/)) {
    const m = /^(\t+| +)\S/.exec(line);
    if (m) { indent = m[1][0] === '\t' ? '\t' : m[1].length; break; }
  }
  return { bom, eol, trailingNewline, indent };
}

function serializeJson(obj, fmt = {}) {
  const { indent = 2, eol = '\n', trailingNewline = false, bom = false } = fmt;
  let text = JSON.stringify(obj, null, indent);
  if (eol !== '\n') text = text.replace(/\n/g, eol);
  if (trailingNewline) text += eol;
  return bom ? '﻿' + text : text;
}

const getAt = (obj, path) => {
  let cur = obj;
  for (const k of path) { if (!isPlain(cur) || !(k in cur)) return undefined; cur = cur[k]; }
  return cur;
};
const setAt = (obj, path, value) => {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (cur[path[i]] === undefined) cur[path[i]] = {};
    if (!isPlain(cur[path[i]])) throw new Error('a container on the path is not an object');
    cur = cur[path[i]];
  }
  cur[path[path.length - 1]] = value;
};
const delAt = (obj, path) => { const p = getAt(obj, path.slice(0, -1)); if (isPlain(p)) delete p[path[path.length - 1]]; };

/** Write text through a temp name and a rename (no .bak: path-level files may hold secrets). */
function writeTextAtomic(file, text, tmpName) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), tmpName());
  let mode = null;
  try { mode = statSync(file).mode & 0o777; } catch { /* new file */ }
  const fd = openSync(tmp, 'w', mode ?? 0o666);
  try {
    if (mode !== null && process.platform !== 'win32') { try { fchmodSync(fd, mode); } catch { /* best effort */ } }   // keep a 0600 file 0600
    writeSync(fd, text); fsyncSync(fd);
  } finally { closeSync(fd); }
  try { renameRetry(tmp, file); } catch (e) { try { unlinkSync(tmp); } catch { /* ignore */ } throw e; }
}

/**
 * Path-level restore (D5): put back the saved value of every recorded path of a
 * file that also holds secrets, leaving every other key untouched. A file that
 * does not round-trip, or a change that would reach outside the recorded paths,
 * is refused and left alone. Only counts are ever printed, never values.
 */
function restorePathArea(file, area, tmpName, dry) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return { status: 'absent', n: 0 }; }
  let obj;
  try { obj = JSON.parse(text); } catch { return { status: 'refused', reason: 'unparseable', n: 0 }; }
  if (!isPlain(obj)) return { status: 'refused', reason: 'not an object', n: 0 };
  const fmt = detectFormat(text);
  if (serializeJson(obj, fmt) !== text) return { status: 'refused', reason: 'not round-trippable', n: 0 };
  const entries = Object.entries(area.paths ?? {}).map(([k, want]) => ({ p: JSON.parse(k), want }));
  const before = structuredClone(obj);
  let n = 0;
  for (const { p, want } of entries) {
    const cur = getAt(obj, p);
    if (want.absent) { if (cur !== undefined) { delAt(obj, p); n++; } }
    else if (JSON.stringify(cur) !== JSON.stringify(want.value)) { setAt(obj, p, structuredClone(want.value)); n++; }
  }
  for (const k of area.absentContainers ?? []) {
    const c = getAt(obj, JSON.parse(k));
    if (isPlain(c) && !Object.keys(c).length) delAt(obj, JSON.parse(k));
  }
  if (!n) return { status: 'unchanged', n: 0 };
  const strip = (o) => {
    const c = structuredClone(o);
    for (const { p } of entries) delAt(c, p);
    for (const k of area.absentContainers ?? []) { const x = getAt(c, JSON.parse(k)); if (isPlain(x) && !Object.keys(x).length) delAt(c, JSON.parse(k)); }
    return JSON.stringify(c);
  };
  if (strip(before) !== strip(obj)) return { status: 'refused', reason: 'would change a path outside the backup', n: 0 };
  if (dry) return { status: 'would-restore', n };
  writeTextAtomic(file, serializeJson(obj, fmt), tmpName);
  let again;
  try { again = JSON.parse(readFileSync(file, 'utf8')); } catch { again = undefined; }
  if (JSON.stringify(again) !== JSON.stringify(obj)) return { status: 'failed', reason: 'read back differently', n };
  return { status: 'restored', n };
}

/** The current value (or absence) of each recorded path, for the pre-rollback snapshot. */
function currentPathValues(file, area) {
  let obj;
  try { obj = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  const out = {};
  for (const k of Object.keys(area.paths ?? {})) { const v = getAt(obj, JSON.parse(k)); out[k] = v === undefined ? { absent: true } : { value: v }; }
  return out;
}

/* ------------------------------------------------------------ tasks (step 6) */

const TASK_FILE = /^([^/]+\/[^/]+)\/scheduled-tasks\.json$/;
const RUNTIME = ['lastRunAt', 'lastScheduledFor', 'missedRunScanFloor'];
const toMs = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : -Infinity);

/** The task files of the state before the rollback: folder key -> {list, mtimeMs}. */
function readTaskFiles(files) {
  const out = new Map();
  for (const f of files) {
    const m = TASK_FILE.exec(f.rel);
    if (!m) continue;
    try {
      const doc = JSON.parse(readFileSync(f.abs, 'utf8'));
      if (Array.isArray(doc?.scheduledTasks)) out.set(m[1], { list: doc.scheduledTasks, mtimeMs: statSync(f.abs).mtimeMs });
    } catch { /* unreadable: ignored */ }
  }
  return out;
}

/**
 * Step 6. `pre` is readTaskFiles() of the state before the rollback. For every
 * task file the backup lists (read from the backup copy, i.e. what step 4
 * restored): each run-time field becomes the max of the restored value and the
 * value in any file of the state before. A task that exists only in the state
 * before is appended to its origin file (tasks-base.json) or, without a recorded
 * origin, to the folder it was found in. A task file the backup does not list
 * (created by the link) is removed unless a post-backup task is appended to it.
 */
function planTasks({ pre, taskEntries, srcOf, destOf, origin, store }) {
  const maxes = new Map();       // id -> field -> {ms, raw}
  const newest = new Map();      // id -> {task, mtimeMs, folder}
  for (const [folder, side] of [...pre].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    for (const t of side.list) {
      if (!t || typeof t.id !== 'string') continue;
      if (!maxes.has(t.id)) maxes.set(t.id, {});
      for (const f of RUNTIME) {
        const ms = toMs(t[f]);
        const cur = maxes.get(t.id)[f];
        if (ms > -Infinity && (!cur || ms > cur.ms)) maxes.get(t.id)[f] = { ms, raw: t[f] };
      }
      const n = newest.get(t.id);
      if (!n || side.mtimeMs > n.mtimeMs) newest.set(t.id, { task: t, mtimeMs: side.mtimeMs, folder });
    }
  }
  const files = new Map();       // folder -> {path, doc, list, fmt, changed, isNew}
  const restoredIds = new Set();
  let updated = 0;
  for (const e of taskEntries) {
    const folder = TASK_FILE.exec(e.rel)[1];
    let text; let doc;
    try { text = readFileSync(srcOf(e), 'utf8'); doc = JSON.parse(text); } catch { continue; }
    if (!Array.isArray(doc?.scheduledTasks)) continue;
    const entry = { path: destOf(e), doc, list: doc.scheduledTasks, fmt: detectFormat(text), changed: false, isNew: false };
    for (const t of doc.scheduledTasks) {
      if (!t || typeof t.id !== 'string') continue;
      restoredIds.add(t.id);
      const mx = maxes.get(t.id);
      if (!mx) continue;
      for (const f of RUNTIME) if (mx[f] && mx[f].ms > toMs(t[f])) { t[f] = mx[f].raw; entry.changed = true; updated++; }
    }
    files.set(folder, entry);
  }
  let appended = 0;
  for (const [id, n] of newest) {
    if (restoredIds.has(id)) continue;
    const target = origin[id] ?? n.folder;
    let entry = files.get(target);
    if (!entry) {
      entry = { path: join(store, ...target.split('/'), 'scheduled-tasks.json'), doc: { scheduledTasks: [] }, list: [], fmt: { indent: 2 }, changed: true, isNew: true };
      entry.list = entry.doc.scheduledTasks;
      files.set(target, entry);
    }
    const task = structuredClone(n.task);
    for (const f of RUNTIME) { const mx = maxes.get(id)?.[f]; if (mx) task[f] = mx.raw; }
    entry.list.push(task);
    entry.changed = true;
    appended++;
  }
  return { files, updated, appended };
}

/* ------------------------------------------------------------ main */

function main() {
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(HERE, 'manifest.json'), 'utf8')); } catch {
    console.error('rollback: manifest.json missing or unreadable next to this script'); return 1;
  }
  const store = resolve(opt('--store') ?? manifest.store);
  const userData = resolve(opt('--user-data') ?? manifest.userData);
  const acc = resolve(opt('--acc') ?? join(HERE, '..', '..'));
  const out = { restored: 0, kept: 0, excluded: 0, removed: 0, postBackup: 0, global: 0, dryRun: DRY, snapshot: null, errors: [] };

  // (1) the app must be stopped
  const app = appRunning(userData);
  const stale = app.s1 && app.s2 === false && flag('--ignore-stale-lockfile');
  if (app.s2 !== false || (app.s1 && !stale)) {
    console.error('rollback refused: the Claude desktop app looks like it is running (or its state is unknown).\n'
      + 'Quit Claude from the tray icon (macOS: Cmd+Q), then run this again.\n'
      + (app.s1 && app.s2 === false ? 'If a stale lockfile is all that is left, add --ignore-stale-lockfile.\n' : ''));
    return 3;
  }

  // the backup copies must still match the manifest before anything changes
  const destOf = (e) => (e.area === 'store' ? join(store, ...e.rel.split('/')) : e.dest);
  const filesDir = (e) => join(HERE, 'files', e.area === 'store' ? 'claude-code-sessions' : e.area);
  const srcOf = (e) => join(filesDir(e), ...e.rel.split('/'));
  for (const e of manifest.entries) {
    let ok = false;
    try { ok = shaFile(srcOf(e)) === e.sha256; } catch { /* missing */ }
    if (!ok) { console.error(`rollback aborted: the backup copy of ${e.area}:${e.rel} is missing or damaged. Nothing was changed.`); return 1; }
  }

  // Exclusive from here on: accounts.lock (no pass can run, and none can save a stale state.json over ours) and
  // the rollback-active marker, which stays until the rollback has finished so that a half-done rollback is
  // finished by running it again and never undone by a re-link. A dry run changes nothing and takes neither.
  if (!DRY) {
    const release = takeLock(acc);
    if (!release) {
      console.error('rollback refused: an account pass holds accounts.lock right now. Wait a minute and run this again.');
      return 3;
    }
    process.on('exit', release);
    writeFileSync(join(acc, 'rollback-active'), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), backupId: manifest.id ?? null }));
  }

  const storeEntries = manifest.entries.filter((e) => e.area === 'store');
  const manifestRels = new Set(storeEntries.map((e) => e.rel));
  const nowFiles = walk(store);
  const preTasks = readTaskFiles(nowFiles);

  // (2) snapshot of the current state
  let snapDir = join(acc, `pre-rollback-${stampNow()}`);
  for (let i = 1; existsSync(snapDir); i++) snapDir = join(acc, `pre-rollback-${stampNow()}-${i}`);   // never overwrite an earlier snapshot
  if (!DRY) {
    out.snapshot = snapDir;
    const snapEntries = [];
    for (const f of nowFiles) { copyKeep(f.abs, join(snapDir, 'files', 'claude-code-sessions', ...f.rel.split('/'))); snapEntries.push({ area: 'store', rel: f.rel }); }
    for (const e of manifest.entries.filter((x) => x.area === 'global')) {
      if (existsSync(destOf(e))) { copyKeep(destOf(e), join(snapDir, 'files', 'global', e.rel)); snapEntries.push({ area: 'global', rel: e.rel }); }
    }
    for (const e of manifest.entries.filter((x) => x.area === 'cowork-memory')) {
      if (existsSync(destOf(e))) { copyKeep(destOf(e), join(snapDir, 'files', 'cowork-memory', ...e.rel.split('/'))); snapEntries.push({ area: 'cowork-memory', rel: e.rel }); }
    }
    for (const b of ['tasks-base.json', 'backlog-base.json', 'settings-base.json', 'memory-base.json']) {
      if (existsSync(join(acc, b))) copyFileSync(join(acc, b), join(snapDir, b));
    }
    // path-level areas: only the recorded (allow-listed) paths of the current files, never the whole file
    for (const [name, area] of Object.entries(manifest.pathAreas ?? {})) {
      const vals = currentPathValues(join(userData, name), area);
      if (!vals) continue;
      mkdirSync(join(snapDir, 'paths'), { recursive: true });
      writeFileSync(join(snapDir, 'paths', name), JSON.stringify(vals, null, 2));
      snapEntries.push({ area: 'paths', rel: name });
    }
    writeFileSync(join(snapDir, 'snapshot.json'), JSON.stringify({ createdAt: new Date().toISOString(), store, entries: snapEntries }, null, 2));
  }

  // (3) records created after the backup
  const manifestIds = new Set();
  for (const e of storeEntries) {
    const p = e.rel.split('/');
    if (p.length === 3 && RECORD.test(p[2])) manifestIds.add(p[2]);
  }
  const state = (() => { try { return JSON.parse(readFileSync(join(acc, 'state.json'), 'utf8')); } catch { return null; } })();
  const postBackup = new Map();   // file name -> [{folder, rel, mtimeMs}]
  for (const f of nowFiles) {
    const p = f.rel.split('/');
    if (p.length !== 3 || !RECORD.test(p[2]) || manifestIds.has(p[2])) continue;
    if (!postBackup.has(p[2])) postBackup.set(p[2], []);
    postBackup.get(p[2]).push({ folder: `${p[0]}/${p[1]}`, rel: f.rel, abs: f.abs, mtimeMs: statSync(f.abs).mtimeMs });
  }
  const putBack = [];
  for (const [name, copies] of postBackup) {
    const newest = copies.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
    const id = `local_${RECORD.exec(name)[1]}`;
    const stHome = state?.records?.[id]?.home;
    const home = stHome ?? (copies.length === 1 ? copies[0].folder : copies.map((c) => c.folder).sort()[0]);
    putBack.push({ name, home, src: DRY ? newest.abs : join(snapDir, 'files', 'claude-code-sessions', ...newest.rel.split('/')), mtimeMs: newest.mtimeMs });
  }
  out.postBackup = putBack.length;

  const tmpName = () => `.session-sync-link-${randomBytes(6).toString('hex')}`;
  try {
    // (4) store restore
    const partitions = new Map();   // group label -> entries; null group = one partition per entry
    for (const e of storeEntries) {
      if (isExcluded(e.rel)) { out.excluded++; continue; }
      const k = e.inodeGroup ?? `solo:${e.rel}`;
      if (!partitions.has(k)) partitions.set(k, []);
      partitions.get(k).push(e);
    }
    const inoNames = new Map();     // current ino -> Set(dest) over manifest store names
    for (const e of storeEntries) {
      if (isExcluded(e.rel)) continue;
      const i = inoOf(destOf(e)); if (!i) continue;
      if (!inoNames.has(i)) inoNames.set(i, new Set());
      inoNames.get(i).add(destOf(e));
    }
    for (const list of partitions.values()) {
      const dests = new Set(list.map((e) => destOf(e)));
      let ok = true;
      let ino0 = null;
      for (const e of list) {
        let cur = null;
        try { cur = shaFile(destOf(e)); } catch { /* missing */ }
        const ino = inoOf(destOf(e));
        if (cur !== e.sha256 || !ino) { ok = false; break; }
        if (ino0 === null) ino0 = ino; else if (ino !== ino0) { ok = false; break; }
        const names = inoNames.get(ino);
        if (names.size !== dests.size || [...names].some((n) => !dests.has(n))) { ok = false; break; }
      }
      if (ok) { out.kept += list.length; continue; }
      out.restored += list.length;
      if (DRY) continue;
      const [primary, ...rest] = list;
      restoreFile(srcOf(primary), destOf(primary), primary.mtimeMs, tmpName);
      for (const e of rest) relinkTo(destOf(primary), destOf(e));
    }
    for (const d of manifest.dirs ?? []) if (!DRY) mkdirSync(join(store, ...d.split('/')), { recursive: true });
    // (5) post-backup records go back into their home folder as single files. This comes BEFORE the removal
    // below, and the removal skips these home names, so a post-backup record never has zero names: a rollback
    // that stops half way loses nothing, and running it again finishes the job (S3).
    for (const pb of putBack) {
      if (DRY) continue;
      const dst = join(store, ...pb.home.split('/'), pb.name);
      restoreFile(pb.src, dst, pb.mtimeMs, tmpName);
    }
    const putBackRels = new Set(putBack.map((pb) => `${pb.home}/${pb.name}`));

    // names the feature created and the backup does not list
    for (const f of nowFiles) {
      if (manifestRels.has(f.rel) || putBackRels.has(f.rel)) continue;
      if (isExcluded(f.rel)) { out.excluded++; continue; }
      if (!isRemovable(f.rel)) continue;
      out.removed++;
      if (!DRY) unlinkSync(f.abs);
    }

    // (6) tasks: the files were restored byte for byte (what --exact asks for). By default the run-time
    // fields then move to the max of the restored and the pre-rollback values, and tasks created after
    // the backup are appended to their origin file, so a rollback never makes a task run twice or vanish.
    const taskEntries = storeEntries.filter((e) => TASK_FILE.test(e.rel));
    let plan = null;
    if (!EXACT) {
      const origin = (() => { try { return JSON.parse(readFileSync(join(acc, 'tasks-base.json'), 'utf8')).origin ?? {}; } catch { return {}; } })();
      plan = planTasks({ pre: preTasks, taskEntries, srcOf, destOf, origin, store });
      out.tasks = { runtimeUpdated: plan.updated, appended: plan.appended, removedFiles: 0 };
      for (const entry of plan.files.values()) {
        if (!entry.changed) continue;
        if (!DRY) writeTextAtomic(entry.path, serializeJson(entry.doc, entry.fmt), tmpName);
      }
    }
    // A task file the backup does not list was created by the link; its tasks are in the snapshot. It goes in
    // both modes (--exact means the backup's state, and a leftover file would run its tasks under both accounts),
    // except where the default mode just appended a post-backup task to it.
    out.tasks ??= { removedFiles: 0 };
    const listedTasks = new Set(taskEntries.map((e) => e.rel));
    for (const f of nowFiles) {
      const m = TASK_FILE.exec(f.rel);
      if (!m || listedTasks.has(f.rel) || plan?.files.has(m[1])) continue;
      out.tasks.removedFiles++;
      if (!DRY) unlinkSync(f.abs);
    }

    // (7) whole-file areas (and cowork memory): byte restore
    for (const e of manifest.entries.filter((x) => x.area !== 'store')) {
      let cur = null;
      try { cur = shaFile(destOf(e)); } catch { /* missing */ }
      if (cur === e.sha256) { out.kept++; continue; }
      out.global++;
      if (!DRY) restoreFile(srcOf(e), destOf(e), e.mtimeMs, () => `${randomBytes(4).toString('hex')}.rollback.tmp`);
    }
    out.paths = {};
    for (const [name, area] of Object.entries(manifest.pathAreas ?? {})) {
      const r = restorePathArea(join(userData, name), area, () => `.session-sync-link-${randomBytes(6).toString('hex')}`, DRY);
      out.paths[name] = r.status === 'refused' || r.status === 'failed' ? { status: r.status, reason: r.reason } : { status: r.status, paths: r.n };
      if (r.status === 'refused' || r.status === 'failed') say(`path-level area ${name} was NOT restored (${r.reason}); the file is unchanged.`);
    }

    // (8) verify
    if (!DRY) {
      const bad = [];
      for (const e of manifest.entries) {
        if (e.area === 'store' && isExcluded(e.rel)) continue;
        if (e.area === 'store' && !EXACT && TASK_FILE.test(e.rel)) continue;   // step 6 may have merged run-times
        try { if (shaFile(destOf(e)) !== e.sha256) bad.push(`${e.area}:${e.rel}`); } catch { bad.push(`${e.area}:${e.rel}`); }
      }
      if (bad.length) { out.errors = bad; console.error(`rollback: ${bad.length} file(s) do not match the backup after restore: ${bad.slice(0, 5).join(', ')}`); }
    }
  } catch (e) {
    console.error(`rollback failed part way: ${e.message}${out.snapshot ? `\nThe state before this rollback is saved in ${out.snapshot}` : ''}`
      + '\nNo account pass runs until a rollback has finished: fix the cause, then run this rollback again (it picks up where it stopped).');
    return 1;
  }

  // (9) the pairs answer "no" again; the next link takes a new backup
  if (!DRY) {
    const s = state ?? { v: 1, records: {}, pairs: {} };
    const at = new Date().toISOString();
    s.linked = false;
    s.group = [];
    s.fullPassOwed = false;
    s.backupId = null;
    s.lastRolledBackId = manifest.id ?? null;
    s.records = {};
    s.live = { startedAtMs: 0, folders: [] };
    s.tasksWritten = {};
    s.pairs = s.pairs || {};
    for (const k of Object.keys(s.pairs)) s.pairs[k] = { ...s.pairs[k], answer: 'no', at, via: 'rollback' };
    writeJsonAtomic(join(acc, 'state.json'), s);
    for (const b of ['tasks-base.json', 'backlog-base.json', 'settings-base.json', 'memory-base.json']) {
      try { unlinkSync(join(acc, b)); } catch { /* none */ }
    }
    // an interrupted link or unlink left a journal; the store is no longer in that state
    for (const j of ['journal.json', 'journal.json.bak']) { try { unlinkSync(join(acc, j)); } catch { /* none */ } }
    // finished: passes may run again (the lock is released at exit)
    try { unlinkSync(join(acc, 'rollback-active')); } catch { /* none */ }
  }

  if (JSON_OUT) console.log(JSON.stringify(out));
  else say(`${DRY ? 'dry run: would restore' : 'restored'} ${out.restored} file(s); kept ${out.kept}; excluded ${out.excluded} (left as they are); `
    + `removed ${out.removed}; post-backup records put back ${out.postBackup}; whole-file areas restored ${out.global}.`
    + `${out.tasks?.runtimeUpdated !== undefined ? ` Tasks: ${out.tasks.runtimeUpdated} run-time field(s) kept at their max, ${out.tasks.appended} added back, ${out.tasks.removedFiles} link-created file(s) removed.`
      : out.tasks?.removedFiles ? ` Tasks: ${out.tasks.removedFiles} link-created file(s) removed.` : ''}`
    + `${Object.keys(out.paths ?? {}).length ? ` Path-level areas: ${Object.entries(out.paths).map(([n, r]) => `${n} ${r.status}${r.paths ? ` (${r.paths} paths)` : ''}`).join(', ')}.` : ''}${out.snapshot ? `\nSnapshot of the state before: ${out.snapshot}` : ''}`);
  return out.errors.length ? 1 : 0;
}

process.exitCode = main();
