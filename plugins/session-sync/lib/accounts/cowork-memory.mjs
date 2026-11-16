/**
 * cowork-memory.mjs - file-level 3-way merge of Cowork memory (plan 5.10).
 *
 * `local-agent-mode-sessions/<acct>/<org>/agent/memory/**` is copied between the
 * group's folders, keyed by relative path, against `memory-base.json`
 * ({v, at, folders, files:{rel:{folderKey:sha256}}}). There is no evidence on
 * Cowork's read path, so this runs in FULL passes only: live and dry runs only
 * report whether a difference is owed. Copies are regular files (mtime kept),
 * never links. Every displaced or deleted file is copied to backup first.
 *
 * Per relative path:
 *   - a side whose content differs from its base (or that is new) is "changed";
 *     the changed content wins and is copied to every other side. Two different
 *     changes conflict: the newest mtime wins, a tie goes to the smallest folder
 *     key; the loser is backed up.
 *   - a side that lost the file is "removed"; with no change anywhere else the
 *     file is moved to backup on the other sides. An edit beats a delete.
 * File names and sizes are reported, never content.
 */

import { readFileSync, statSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { accPath, readJson, writeJsonAtomic, writeTextAtomic, tickMutation } from './state.mjs';
import { backupCopy, walkTree } from './backup.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export const memoryRoot = (ctx, F) => join(ctx.userData, 'local-agent-mode-sessions', F.acct, F.org, 'agent', 'memory');

/** key -> Map(rel -> {abs, sha, mtimeMs}) for each folder that has a readable memory dir. */
function scan(ctx, group) {
  const sides = {};
  for (const F of group) {
    const root = memoryRoot(ctx, F);
    const files = new Map();
    if (existsSync(root)) {
      for (const f of walkTree(root).files) {
        try {
          files.set(f.rel, { abs: f.abs, sha: sha256(readFileSync(f.abs)), mtimeMs: statSync(f.abs).mtimeMs });
        } catch { /* unreadable or gone: treated as absent */ }
      }
    }
    sides[F.key] = { F, root, files };
  }
  return sides;
}

const backupName = (rel) => `memory-${rel.split('/').join('__')}`;

/**
 * @param {Array}  group
 * @param {object} o  {mode:'full'|'live', dry, ctx, state, guard}
 */
export function mergeCoworkMemory(group, o) {
  const { mode = 'full', ctx, guard } = o;
  const dry = o.dry || mode !== 'full';
  const rep = { mode, dry, copied: [], deleted: [], conflicts: [], unchanged: 0, files: 0, pending: false };
  if (group.length < 2) return rep;

  const sides = scan(ctx, group);
  const keys = Object.keys(sides);
  const baseDoc = readJson(accPath(ctx, 'memory-base.json'), null);
  const baseFiles = baseDoc && typeof baseDoc.files === 'object' && baseDoc.files ? baseDoc.files : {};
  const rels = new Set(Object.keys(baseFiles));
  for (const k of keys) for (const rel of sides[k].files.keys()) rels.add(rel);

  const actions = [];
  const after = {};                                   // rel -> {key: sha} once the actions are applied
  for (const rel of [...rels].sort()) {
    const b = baseFiles[rel] ?? {};
    const cur = Object.fromEntries(keys.map((k) => [k, sides[k].files.get(rel)]));
    const present = keys.filter((k) => cur[k]);
    const changed = present.filter((k) => cur[k].sha !== b[k]);
    const removed = keys.filter((k) => !cur[k] && b[k] !== undefined);
    if (!present.length) continue;
    if (changed.length) {
      const distinct = new Set(changed.map((k) => cur[k].sha));
      let winner = changed[0];
      if (distinct.size > 1) {
        const ranked = [...changed].sort((x, y) => cur[y].mtimeMs - cur[x].mtimeMs || (x < y ? -1 : 1));
        winner = ranked[0];
        rep.conflicts.push({ rel, winner, losers: changed.filter((k) => cur[k].sha !== cur[winner].sha) });
      } else {
        winner = [...changed].sort((x, y) => cur[y].mtimeMs - cur[x].mtimeMs || (x < y ? -1 : 1))[0];
      }
      const src = cur[winner];
      after[rel] = {};
      for (const k of keys) {
        after[rel][k] = src.sha;
        if (cur[k]?.sha === src.sha) { rep.unchanged++; continue; }
        actions.push({ op: 'copy', rel, key: k, from: src, to: cur[k] ?? null });
      }
    } else if (removed.length) {
      // nothing changed anywhere: the removal spreads (the files are moved to backup)
      for (const k of present) actions.push({ op: 'delete', rel, key: k, at: cur[k] });
    } else {
      after[rel] = {};
      for (const k of keys) {
        if (cur[k]) { after[rel][k] = cur[k].sha; rep.unchanged++; continue; }
        // a side that never had the file (a folder that joined later) gets it
        actions.push({ op: 'copy', rel, key: k, from: cur[present[0]], to: null });
        after[rel][k] = cur[present[0]].sha;
      }
    }
  }
  rep.files = Object.keys(after).length;
  rep.pending = actions.length > 0;
  if (dry) {
    for (const a of actions) (a.op === 'copy' ? rep.copied : rep.deleted).push({ rel: a.rel, folder: a.key });
    return rep;
  }

  for (const a of actions) {
    const side = sides[a.key];
    const dst = join(side.root, ...a.rel.split('/'));
    if (a.op === 'copy') {
      if (a.to) {
        tickMutation();
        backupCopy(ctx, a.to.abs, { reason: 'memory-merge', folder: a.key, name: backupName(a.rel) });
      }
      tickMutation();
      mkdirSync(dirname(dst), { recursive: true });
      writeTextAtomic(dst, readFileSync(a.from.abs), { mtimeMs: a.from.mtimeMs, guard: () => guard?.('cowork-memory', a.key) });
      rep.copied.push({ rel: a.rel, folder: a.key });
    } else {
      tickMutation();
      backupCopy(ctx, a.at.abs, { reason: 'memory-delete', folder: a.key, name: backupName(a.rel) });
      tickMutation();
      guard?.('cowork-memory', a.key);
      unlinkSync(a.at.abs);
      rep.deleted.push({ rel: a.rel, folder: a.key });
    }
  }

  const files = {};
  for (const [rel, m] of Object.entries(after)) files[rel] = m;
  writeJsonAtomic(accPath(ctx, 'memory-base.json'), { v: 1, at: new Date(ctx.now()).toISOString(), folders: keys, files });
  return rep;
}
