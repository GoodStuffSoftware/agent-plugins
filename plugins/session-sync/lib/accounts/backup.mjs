/**
 * backup.mjs - the rectify backups (displaced files are COPIED, never lost) and
 * the one-time verified backup taken before the first link (plan 5.4, 5.14).
 *
 * Backups are copies, never hard links (invariant I1). The one-time backup
 * carries a copy of `rollback-standalone.mjs` as `rollback.mjs` so a restore
 * works with no plugin installed.
 */

import {
  readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, utimesSync, statSync, lstatSync,
  readdirSync, appendFileSync, rmSync, renameSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accPath, writeJsonAtomic, readJson, tickMutation } from './state.mjs';
import { OURTMP } from './folders.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROLLBACK_SRC = join(HERE, 'rollback-standalone.mjs');

/** Whole-file areas, copied as they are (no secret-bearing keys). */
export const GLOBAL_AREAS = ['ccd-session-presets.json', 'mcp-user-tool-toggles.json'];

export const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
export const sha256Buf = (b) => createHash('sha256').update(b).digest('hex');

function localDay(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function localStamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ---- rectify backups ---- */

const indexCache = new Map();   // index file -> Set("name\0sha")

/** Drop cached index contents (rectify calls this at the start of every pass). */
export function resetBackupCache() { indexCache.clear(); }

/** The backup file an index line points at, relative to the rectify-backups root (lines before 0.5.16 carry no `dst`: derived from the day, folder and name). */
function lineDst(o) {
  if (typeof o.dst === 'string' && o.dst) return o.dst;
  const t = Date.parse(o.at);
  if (Number.isNaN(t) || typeof o.name !== 'string') return null;
  return [localDay(t), ...String(o.folder ?? '_').split('/'), o.name].join('/');
}

/** key (name + sha) -> the backup files the index lists for it. */
function indexSet(file) {
  let map = indexCache.get(file);
  if (map) return map;
  map = new Map();
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        const k = `${o.name}\0${o.sha256}`;
        (map.get(k) ?? map.set(k, []).get(k)).push(lineDst(o));
      } catch { /* skip a torn line */ }
    }
  } catch { /* no index yet */ }
  indexCache.set(file, map);
  return map;
}

/**
 * Copy a file about to be displaced to
 * ACC/rectify-backups/<local day>/<acct>/<org>/<name>[.n] and log it in
 * index.jsonl. Skipped when the index already has the same (name, sha256).
 *
 * @param {object} meta {reason, folder:'<acct>/<org>', name?}
 * @returns {{skipped:boolean, dst?:string, sha256:string}}
 */
export function backupCopy(ctx, path, meta = {}) {
  const buf = readFileSync(path);
  const sha = sha256Buf(buf);
  const name = meta.name ?? path.split(/[\\/]/).pop();
  const index = accPath(ctx, 'rectify-backups', 'index.jsonl');
  const seen = indexSet(index);
  // 0.5.16: skipped only while an indexed copy of it still exists on disk (a line whose file was deleted must not block a real backup)
  const root = accPath(ctx, 'rectify-backups');
  if ((seen.get(`${name}\0${sha}`) ?? []).some((rel) => rel && existsSync(join(root, ...rel.split('/'))))) return { skipped: true, sha256: sha };
  tickMutation();
  const st = statSync(path, { bigint: true });
  const dir = accPath(ctx, 'rectify-backups', localDay(ctx.now()), ...String(meta.folder ?? '_').split('/'));
  mkdirSync(dir, { recursive: true });
  let dst = join(dir, name);
  for (let i = 1; existsSync(dst); i++) dst = join(dir, `${name}.${i}`);
  writeFileSync(dst, buf, { flag: 'wx' });
  const mtimeMs = Number(st.mtimeNs / 1000000n);
  try { utimesSync(dst, mtimeMs / 1000, mtimeMs / 1000); } catch { /* keep the copy even if the stamp fails */ }
  appendFileSync(index, JSON.stringify({
    at: new Date(ctx.now()).toISOString(), reason: meta.reason ?? null, folder: meta.folder ?? null,
    name, sha256: sha, size: buf.length, mtimeMs, ino: `${st.dev}:${st.ino}`, dst: relative(root, dst).split(sep).join('/'),
  }) + '\n');
  const k = `${name}\0${sha}`;
  (seen.get(k) ?? seen.set(k, []).get(k)).push(relative(root, dst).split(sep).join('/'));
  return { skipped: false, dst, sha256: sha };
}

/** The reasons of the backups a rectify pass makes of a displaced conversation copy; only these are ever pruned. */
export const PRUNABLE_REASONS = new Set(['split-loser', 'unlink-nonhome', 'tombstone-resurrect']);

function removeEmptyDirs(dir) {
  let left = 0;
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (d.isDirectory() && removeEmptyDirs(join(dir, d.name))) continue;
    left++;
  }
  if (left) return false;
  try { rmSync(dir, { recursive: false }); return true; } catch { return false; }
}

/**
 * Retention: delete the rectify backups of conversation copies (reasons in PRUNABLE_REASONS; never the delete, memory, tasks or settings
 * backups) whose WHOLE day ended more than `days` days ago, and their lines in index.jsonl. The index is rewritten atomically FIRST (the
 * lines of the files about to go dropped), then the files are deleted: a crash in between leaves an orphan file, never an index line for a
 * file that is gone. Day directories left empty are removed. Runs at most once a day (stamp file), only when the directory exists.
 * @returns {{pruned:string[], skipped?:boolean}}
 */
export function pruneBackups(ctx, { days = 14, force = false } = {}) {
  const root = accPath(ctx, 'rectify-backups');
  if (!existsSync(root)) return { pruned: [], skipped: true };
  const now = ctx.now();
  const stamp = join(root, '.pruned-at');
  if (!force) {
    const last = Number(readJson(stamp, 0)) || 0;
    if (now - last < 24 * 3600 * 1000 && now >= last) return { pruned: [], skipped: true };
  }
  const aged = (day) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
    return !!m && now - new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1).getTime() > days * 24 * 3600 * 1000;
  };
  const gone = new Set();
  const files = [];
  const index = join(root, 'index.jsonl');
  if (existsSync(index)) {
    const keep = [];
    for (const line of readFileSync(index, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let drop = false;
      try {
        const o = JSON.parse(line);
        const rel = lineDst(o);
        const day = rel ? rel.split('/')[0] : null;
        if (day && aged(day) && PRUNABLE_REASONS.has(o.reason)) { drop = true; files.push(rel); gone.add(day); }
      } catch { /* torn line: keep */ }
      if (!drop) keep.push(line);
    }
    if (files.length) {
      const tmp = `${index}.${process.pid}.tmp`;
      writeFileSync(tmp, keep.length ? `${keep.join('\n')}\n` : '');
      renameSync(tmp, index);   // a failure here throws before anything is deleted
      indexCache.clear();
      for (const rel of files) { try { rmSync(join(root, ...rel.split('/')), { force: true }); } catch { /* an orphan file, no index line */ } }
    }
  }
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (d.isDirectory() && aged(d.name)) { try { removeEmptyDirs(join(root, d.name)); } catch { /* left for the next run */ } }
  }
  writeFileSync(stamp, String(now));
  return { pruned: [...gone].sort() };
}

/* ---- the one-time backup ---- */

/** Every regular file under root: [{rel, abs}], plus directories [rel]. Links are not followed. */
export function walkTree(root) {
  const files = []; const dirs = [];
  const rec = (abs) => {
    let ents;
    try { ents = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(abs, e.name);
      if (e.isDirectory()) { dirs.push(relative(root, p).split(sep).join('/')); rec(p); }
      else if (e.isFile()) files.push({ rel: relative(root, p).split(sep).join('/'), abs: p });
    }
  };
  rec(root);
  return { files, dirs };
}

function copyWithMeta(abs, dst) {
  const buf = readFileSync(abs);
  const st = statSync(abs, { bigint: true });
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, buf);
  const ms = Number(st.mtimeNs / 1000000n);
  try { utimesSync(dst, ms / 1000, ms / 1000); } catch { /* ignore */ }
  return { sha256: sha256Buf(buf), size: buf.length, mtimeMs: ms, ino: `${st.dev}:${st.ino}` };
}

/**
 * Take the one-time backup. The app must be stopped (the caller's full-pass
 * precondition). Throws when verification finds a mismatch; the link must not
 * start in that case.
 *
 * @param {object}   ctx
 * @param {object}   [o]
 * @param {Array}    [o.group]      folder objects of the group (cowork memory)
 * @param {object}   [o.pathAreas]  path-level areas computed by the settings merge (stage 2)
 * @returns {{id:string, dir:string, manifest:object}}
 */
export function takeBackup(ctx, o = {}) {
  const base = accPath(ctx, 'backup');
  mkdirSync(base, { recursive: true });
  const stamp = localStamp(ctx.now());
  let id = stamp;
  for (let i = 1; existsSync(join(base, id)); i++) id = `${stamp}-${i}`;
  const dir = join(base, id);
  mkdirSync(dir, { recursive: true });

  const entries = [];
  const dirs = [];
  const inoCount = new Map();
  const pending = [];

  // store: every file under it, links and junctions not followed
  const tree = walkTree(ctx.store);
  dirs.push(...tree.dirs);
  for (const f of tree.files) {
    const dst = join(dir, 'files', 'claude-code-sessions', ...f.rel.split('/'));
    const m = copyWithMeta(f.abs, dst);
    inoCount.set(m.ino, (inoCount.get(m.ino) || 0) + 1);
    pending.push({ area: 'store', rel: f.rel, dest: f.abs, ...m });
  }

  // whole-file areas
  for (const name of GLOBAL_AREAS) {
    const abs = join(ctx.userData, name);
    if (!existsSync(abs)) continue;
    const m = copyWithMeta(abs, join(dir, 'files', 'global', name));
    pending.push({ area: 'global', rel: name, dest: abs, ...m });
  }

  // cowork memory of the group's folders
  for (const F of o.group ?? []) {
    const root = join(ctx.userData, 'local-agent-mode-sessions', F.acct, F.org, 'agent', 'memory');
    if (!existsSync(root)) continue;
    for (const f of walkTree(root).files) {
      if (OURTMP.test(f.rel.split('/').pop())) continue;   // a crashed write of ours is not a memory file (N4)
      const rel = `${F.key}/${f.rel}`;
      const m = copyWithMeta(f.abs, join(dir, 'files', 'cowork-memory', ...rel.split('/')));
      pending.push({ area: 'cowork-memory', rel, dest: f.abs, ...m });
    }
  }

  for (const p of pending) {
    const { ino, ...rest } = p;
    // The recorded inode group is only a label: names sharing a source inode share a group.
    entries.push({ ...rest, inodeGroup: p.area === 'store' && inoCount.get(ino) > 1 ? ino : null });
  }

  const manifest = {
    v: 1, id, createdAt: new Date(ctx.now()).toISOString(), store: ctx.store, userData: ctx.userData,
    group: (o.group ?? []).map((f) => f.key), entries, dirs, pathAreas: o.pathAreas ?? {}, verified: false,
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  copyFileSync(ROLLBACK_SRC, join(dir, 'rollback.mjs'));
  writeFileSync(join(dir, 'README.txt'), [
    'session-sync account link: backup taken before the first link.',
    '',
    'To restore the store exactly as it was at this moment:',
    '  1. Quit Claude from the tray icon (closing the window only hides it; on macOS use Cmd+Q).',
    `  2. node "${join(dir, 'rollback.mjs')}"`,
    '',
    'Options: --dry-run (change nothing), --exact (tasks restored byte for byte).',
    'A snapshot of the current state is written to pre-rollback-<stamp> before anything changes.',
    '',
  ].join('\n'));

  const v = verifyBackup(dir);
  if (!v.ok) throw new Error(`backup verification failed (${v.mismatches.length} mismatch): ${v.mismatches.slice(0, 3).join(', ')}`);
  return { id, dir, manifest: readJson(join(dir, 'manifest.json')) };
}

/** Re-hash every copy against the manifest, then write verified:true. */
export function verifyBackup(dir) {
  const mf = readJson(join(dir, 'manifest.json'), null);
  if (!mf) return { ok: false, mismatches: ['manifest.json missing or unreadable'] };
  const mismatches = [];
  for (const e of mf.entries) {
    const areaDir = e.area === 'store' ? 'claude-code-sessions' : e.area;
    const p = join(dir, 'files', areaDir, ...e.rel.split('/'));
    try {
      if (!lstatSync(p).isFile() || sha256File(p) !== e.sha256) mismatches.push(`${e.area}:${e.rel}`);
    } catch { mismatches.push(`${e.area}:${e.rel}`); }
  }
  if (!existsSync(join(dir, 'rollback.mjs'))) mismatches.push('rollback.mjs missing');
  const ok = mismatches.length === 0;
  if (ok) { mf.verified = true; writeJsonAtomic(join(dir, 'manifest.json'), mf); }
  return { ok, mismatches };
}
