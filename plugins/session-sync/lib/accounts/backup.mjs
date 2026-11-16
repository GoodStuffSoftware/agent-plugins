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
  readdirSync, appendFileSync,
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

function indexSet(file) {
  let set = indexCache.get(file);
  if (set) return set;
  set = new Set();
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); set.add(`${o.name}\0${o.sha256}`); } catch { /* skip a torn line */ }
    }
  } catch { /* no index yet */ }
  indexCache.set(file, set);
  return set;
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
  if (seen.has(`${name}\0${sha}`)) return { skipped: true, sha256: sha };
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
    name, sha256: sha, size: buf.length, mtimeMs, ino: `${st.dev}:${st.ino}`,
  }) + '\n');
  seen.add(`${name}\0${sha}`);
  return { skipped: false, dst, sha256: sha };
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
