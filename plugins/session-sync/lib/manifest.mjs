/**
 * manifest.mjs — remember what we last synced, so the next sync moves only what
 * actually changed.
 *
 * WHY: rclone can work out the delta itself, but only by walking the whole tree
 * and comparing against the remote — ~9,600 files and a rate-limited API on a
 * real ~/.claude. That made a sync of two changed files take minutes.
 *
 * A local manifest (path -> size+mtime) lets us answer "what changed?" from disk
 * in well under a second, then hand rclone an explicit --files-from list. The
 * common case — a session that touched one transcript — becomes a couple of
 * files instead of a full tree scan. And when NOTHING changed we skip the sync
 * entirely rather than paying for a scan to learn that.
 *
 * The manifest is a CACHE, never a source of truth. Lose it, or change remotes,
 * and we fall back to a full sync — correct, just slower.
 */

import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';

/** Walk a directory into { relativePath: "size:mtimeMs" }. */
export function scanTree(root, { excludeDirs = [], excludeFiles = [] } = {}) {
  const out = {};
  if (!existsSync(root)) return out;

  const skipDir = new Set(excludeDirs);
  const skipFile = new Set(excludeFiles);

  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (skipDir.has(e.name)) continue;
        walk(full);
      } else if (e.isFile()) {
        if (skipFile.has(e.name)) continue;
        try {
          const st = statSync(full);
          // size + mtime is what rclone itself compares by default. Hashing
          // 5 GB every sync to catch a same-size same-mtime edit would cost
          // far more than the rare miss it prevents.
          out[relative(root, full).split(sep).join('/')] = `${st.size}:${Math.floor(st.mtimeMs)}`;
        } catch { /* vanished mid-walk — next sync catches it */ }
      }
    }
  };
  walk(root);
  return out;
}

/** What changed between two scans of the same root. */
export function diffTrees(prev = {}, curr = {}) {
  const added = [], changed = [], removed = [];
  for (const [p, sig] of Object.entries(curr)) {
    if (!(p in prev)) added.push(p);
    else if (prev[p] !== sig) changed.push(p);
  }
  for (const p of Object.keys(prev)) if (!(p in curr)) removed.push(p);
  return { added, changed, removed };
}

/**
 * Manifest file layout — keyed by remote so pointing at a different backend
 * correctly forces a full sync rather than trusting a foreign delta.
 *
 *   { "<remote>": { "<source label>": { "<relpath>": "size:mtime" } } }
 */
export function loadManifest(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
}

export function saveManifest(file, data) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data));
    return true;
  } catch { return false; }
}

/**
 * Work out, per source, what needs sending.
 * Returns [{ label, local, remote, files, full, removed }]:
 *   files   relative paths to send (empty + full:false  => nothing to do)
 *   full    true when we have no usable baseline and must sync everything
 *   removed paths gone locally — REPORTED, never deleted remotely. A backup
 *           that deletes on your behalf is not a backup; a stale remote file
 *           costs storage, a wrongly-deleted one costs the data.
 */
export function planIncremental(map, manifestFile, remote, { excludeDirs, excludeFiles } = {}) {
  const all = loadManifest(manifestFile);
  const prevForRemote = all[remote] || {};
  const plan = [];
  const nextForRemote = {};

  for (const m of map) {
    const curr = scanTree(m.local, { excludeDirs, excludeFiles });
    nextForRemote[m.label] = curr;

    const prev = prevForRemote[m.label];
    if (!prev) {
      plan.push({ ...m, files: [], full: true, removed: [], counts: { total: Object.keys(curr).length } });
      continue;
    }
    const { added, changed, removed } = diffTrees(prev, curr);
    plan.push({
      ...m,
      files: [...added, ...changed],
      full: false,
      removed,
      counts: { added: added.length, changed: changed.length, removed: removed.length },
    });
  }
  return { plan, nextForRemote };
}

/** Commit the scan we just synced as the new baseline. */
export function commitManifest(manifestFile, remote, nextForRemote) {
  const all = loadManifest(manifestFile);
  all[remote] = nextForRemote;
  return saveManifest(manifestFile, all);
}
