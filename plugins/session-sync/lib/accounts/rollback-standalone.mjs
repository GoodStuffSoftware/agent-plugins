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
 * Steps: (1) refuse while the app runs; (2) snapshot the current state to
 * pre-rollback-<stamp>/; (3) find records created after the backup;
 * (4) restore the store from the backup; (5) put post-backup records back into
 * their home folder as single files; (6) task run-times (stage 2, see below);
 * (7) whole-file areas; (8) verify; (9) reset the account pairs to "no".
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
  unlinkSync, utimesSync, copyFileSync, openSync, writeSync, fsyncSync, closeSync,
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
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

function writeJsonAtomic(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  if (existsSync(file)) { try { copyFileSync(file, `${file}.bak`); } catch { /* ignore */ } }
  renameRetry(tmp, file);
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

  const storeEntries = manifest.entries.filter((e) => e.area === 'store');
  const manifestRels = new Set(storeEntries.map((e) => e.rel));
  const nowFiles = walk(store);

  // (2) snapshot of the current state
  const snapDir = join(acc, `pre-rollback-${stampNow()}`);
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
    // names the feature created and the backup does not list
    for (const f of nowFiles) {
      if (manifestRels.has(f.rel)) continue;
      if (isExcluded(f.rel)) { out.excluded++; continue; }
      if (!isRemovable(f.rel)) continue;
      out.removed++;
      if (!DRY) unlinkSync(f.abs);
    }

    // (5) post-backup records go back into their home folder as single files
    for (const pb of putBack) {
      if (DRY) continue;
      const dst = join(store, ...pb.home.split('/'), pb.name);
      restoreFile(pb.src, dst, pb.mtimeMs, tmpName);
    }

    // (6) tasks: run-time max-merge is part of stage 2 of the account link build. Stubbed here:
    // the task files were restored byte for byte, which is what --exact asks for.
    if (!EXACT) say('tasks: run-time max-merge is not in this build yet; task files were restored exactly.');

    // (7) whole-file areas (and cowork memory): byte restore
    for (const e of manifest.entries.filter((x) => x.area !== 'store')) {
      let cur = null;
      try { cur = shaFile(destOf(e)); } catch { /* missing */ }
      if (cur === e.sha256) { out.kept++; continue; }
      out.global++;
      if (!DRY) restoreFile(srcOf(e), destOf(e), e.mtimeMs, () => `${randomBytes(4).toString('hex')}.rollback.tmp`);
    }
    const pa = Object.keys(manifest.pathAreas ?? {});
    if (pa.length) say(`path-level areas (${pa.join(', ')}) are not restored by this build; they were not changed.`);

    // (8) verify
    if (!DRY) {
      const bad = [];
      for (const e of manifest.entries) {
        if (e.area === 'store' && isExcluded(e.rel)) continue;
        try { if (shaFile(destOf(e)) !== e.sha256) bad.push(`${e.area}:${e.rel}`); } catch { bad.push(`${e.area}:${e.rel}`); }
      }
      if (bad.length) { out.errors = bad; console.error(`rollback: ${bad.length} file(s) do not match the backup after restore: ${bad.slice(0, 5).join(', ')}`); }
    }
  } catch (e) {
    console.error(`rollback failed part way: ${e.message}${out.snapshot ? `\nThe state before this rollback is saved in ${out.snapshot}` : ''}`);
    return 1;
  }

  // (9) the pairs answer "no" again; the next link takes a new backup
  if (!DRY) {
    const s = state ?? { v: 1, records: {}, pairs: {} };
    const at = new Date().toISOString();
    s.linked = false;
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
  }

  if (JSON_OUT) console.log(JSON.stringify(out));
  else say(`${DRY ? 'dry run: would restore' : 'restored'} ${out.restored} file(s); kept ${out.kept}; excluded ${out.excluded} (left as they are); `
    + `removed ${out.removed}; post-backup records put back ${out.postBackup}; whole-file areas restored ${out.global}.${out.snapshot ? `\nSnapshot of the state before: ${out.snapshot}` : ''}`);
  return out.errors.length ? 1 : 0;
}

process.exitCode = main();
