/**
 * tasks.mjs - the scheduled-task and backlog merges (plan 5.7, 5.8).
 *
 * `scheduled-tasks.json` and `backlog/tasks.json` are never linked (the app
 * replaces them by tmp + rename, and refuses multi-linked backlog files). They
 * are kept in step by a 3-way merge against a base written by the last FULL
 * pass. Run-times merge by max, so a switch never double-fires a catch-up and a
 * one-shot that ran is never fired again.
 *
 * Live pass: the live (signed-in) folder's file is never written; a delete is
 * deferred. Full pass: everything, deletes included (logged with full content).
 */

import { readFileSync, statSync, mkdirSync, appendFileSync, readdirSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  accPath, readJson, writeJsonAtomic, detectFormat, serializeJson, writeTextAtomic, tickMutation,
} from './state.mjs';
import { backupCopy } from './backup.mjs';
import { mergeKeyed, buildSide, toMs, isPlain } from './merge3.mjs';
import { RECORD } from './folders.mjs';

export const RUNTIME = ['lastRunAt', 'lastScheduledFor', 'missedRunScanFloor'];
export const IGNORE = ['filePath'];

const sha = (text) => createHash('sha256').update(text).digest('hex');

const TASK_SPEC = {
  name: 'tasks',
  fileOf: (F) => join(F.path, 'scheduled-tasks.json'),
  listKey: 'scheduledTasks',
  baseFile: 'tasks-base.json',
  baseKey: 'tasks',
  deletedLog: 'tasks-deleted.jsonl',
  runtime: RUNTIME,
  ignore: IGNORE,
  orTop: ['sundayAliasBoundaryStamped', 'dayFieldsOrBoundaryStamped'],
  maxTop: [],
  trackWritten: true,
  createDir: false,
};

const BACKLOG_SPEC = {
  name: 'backlog',
  fileOf: (F) => join(F.path, 'backlog', 'tasks.json'),
  listKey: 'items',
  baseFile: 'backlog-base.json',
  baseKey: 'items',
  deletedLog: 'backlog-deleted.jsonl',
  runtime: [],
  ignore: [],
  orTop: [],
  maxTop: ['version'],
  trackWritten: false,
  createDir: true,
};

/** Read one side's file. Missing = an empty list; unparseable = excluded (never overwritten). */
function readSide(F, spec) {
  const file = spec.fileOf(F);
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { exists: false, doc: {}, list: [], mtimeMs: 0, file };
    return { bad: `unreadable (${e.code})`, file };
  }
  let doc;
  try { doc = JSON.parse(text); } catch { return { bad: 'unparseable', file }; }
  if (!isPlain(doc) || (doc[spec.listKey] !== undefined && !Array.isArray(doc[spec.listKey]))) return { bad: `no ${spec.listKey} array`, file };
  let mtimeMs = 0;
  try { mtimeMs = statSync(file).mtimeMs; } catch { /* gone */ }
  return { exists: true, text, doc, fmt: detectFormat(text), list: doc[spec.listKey] ?? [], mtimeMs, file };
}

const rankOf = (e) => toMs(e?.createdAt);

/**
 * @param {Array}  group
 * @param {object} o  {mode:'live'|'full', ctx, state, live:Set, guard, dry}
 */
function mergeFiles(group, spec, o) {
  const { mode, ctx, state, guard, dry = false } = o;
  const live = o.live instanceof Set ? o.live : new Set(o.live ?? []);
  const full = mode === 'full';
  const rep = {
    mode, written: [], unchanged: 0, skipped: [], deleted: [], owed: [], conflicts: [], keptEdits: [], duplicates: [], bad: [], pending: false,
  };
  const files = {};
  for (const F of group) {
    const r = readSide(F, spec);
    if (r.bad) { rep.bad.push({ folder: F.key, why: r.bad }); continue; }
    files[F.key] = r;
  }
  const keys = Object.keys(files);
  if (keys.length < 2) return rep;
  const cur = Object.fromEntries(keys.map((k) => [k, files[k].list]));

  const baseDoc = readJson(accPath(ctx, spec.baseFile), null);
  let base = null; let covered;
  if (baseDoc && isPlain(baseDoc[spec.baseKey])) {
    const bm = new Map(Object.entries(baseDoc[spec.baseKey]));
    base = Object.fromEntries(keys.map((k) => [k, bm]));
    covered = new Set((baseDoc.folders ?? keys).filter((k) => keys.includes(k)));
  }
  const newest = (sides) => {
    const ranked = sides.map((s) => [s, files[s].mtimeMs]).sort((a, b) => b[1] - a[1]);
    return ranked.length === 1 || ranked[0][1] > ranked[1][1] ? ranked[0][0] : null;
  };
  const m = mergeKeyed({
    cur, base, covered, fieldwise: true, runtime: spec.runtime, ignore: spec.ignore, rank: rankOf, newest, full,
  });
  rep.deleted = m.removed.map((r) => r.id);
  rep.conflicts = m.conflicts;
  rep.keptEdits = m.keptEdits;
  rep.duplicates = m.duplicates;
  for (const id of m.owedDeletes) { rep.owed.push({ id, why: `${spec.name}-delete` }); rep.pending = true; }

  // top-level fields: OR flags and max numbers travel across files; every other key stays the file's own
  const orVal = {}; for (const k of spec.orTop) orVal[k] = keys.some((s) => files[s].doc[k] === true);
  const maxVal = {};
  for (const k of spec.maxTop) {
    const nums = keys.map((s) => files[s].doc[k]).filter((v) => typeof v === 'number');
    if (nums.length) maxVal[k] = Math.max(...nums);
  }

  const plan = [];
  for (const F of group) {
    const own = files[F.key];
    if (!own) continue;
    const list = buildSide(own.list, m.merged, { ignore: spec.ignore, rank: rankOf });
    const doc = {};
    if (own.exists) {
      for (const k of Object.keys(own.doc)) doc[k] = k === spec.listKey ? list : own.doc[k];
      if (!(spec.listKey in doc)) doc[spec.listKey] = list;
    } else {
      for (const k of spec.maxTop) if (k in maxVal) doc[k] = maxVal[k];
      doc[spec.listKey] = list;
    }
    for (const k of spec.orTop) if (orVal[k] && doc[k] !== true) doc[k] = true;
    for (const k of spec.maxTop) if (k in maxVal && own.exists && typeof doc[k] === 'number') doc[k] = maxVal[k];
    if (!own.exists && !list.length) continue;               // never create an empty file
    const text = serializeJson(doc, own.exists ? own.fmt : { indent: 2 });
    if (own.exists && text === own.text) {
      rep.unchanged++;
      if (spec.trackWritten) state.tasksWritten[F.key] = sha(text);
      continue;
    }
    plan.push({ F, own, text });
  }

  for (const p of plan) {
    if (dry) { rep.pending = true; continue; }
    if (!full && live.has(p.F.key)) { rep.skipped.push({ folder: p.F.key, why: 'live' }); rep.owed.push({ folder: p.F.key, why: `${spec.name}-write-live` }); rep.pending = true; continue; }
  }
  if (!dry && full && m.removed.length) {
    const log = accPath(ctx, spec.deletedLog);
    mkdirSync(ctx.acc, { recursive: true });
    for (const r of m.removed) {
      appendFileSync(log, `${JSON.stringify({ at: new Date(ctx.now()).toISOString(), id: r.id, entry: r.entry, removedIn: r.sides })}\n`);
    }
  }
  for (const p of plan) {
    if (dry) continue;
    if (!full && live.has(p.F.key)) continue;
    tickMutation();
    if (p.own.exists) backupCopy(ctx, p.own.file, { reason: `${spec.name}-merge`, folder: p.F.key, name: `${spec.name}-${p.F.acct}-${p.F.org}.json` });
    if (spec.createDir && !p.own.exists) mkdirSync(join(p.F.path, 'backlog'), { recursive: true });
    writeTextAtomic(p.own.file, p.text, { guard: () => guard?.(spec.name, p.F.key) });
    if (spec.trackWritten) state.tasksWritten[p.F.key] = sha(p.text);
    rep.written.push(p.F.key);
  }

  if (!dry && full) {
    const origin = {};
    for (const id of m.merged.keys()) origin[id] = baseDoc?.origin?.[id] ?? m.source.get(id);
    const doc = {
      v: 1, at: new Date(ctx.now()).toISOString(), folders: keys,
      [spec.baseKey]: Object.fromEntries(m.merged), origin,
    };
    if (spec.orTop.length) doc.top = Object.fromEntries(keys.map((k) => [k, Object.fromEntries(spec.orTop.map((t) => [t, files[k].doc[t] === true || orVal[t]]))]));
    writeJsonAtomic(accPath(ctx, spec.baseFile), doc);
  }
  rep.ids = m.merged.size;
  rep._merged = m.merged;
  return rep;
}

/** `scheduledTaskId` values in records that point to a task present in no file (count only). */
function countOrphanRefs(group, ids) {
  const seen = new Set();
  let orphan = 0;
  for (const F of group) {
    let names;
    try { names = readdirSync(F.path); } catch { continue; }
    for (const n of names) {
      if (!RECORD.test(n)) continue;
      const p = join(F.path, n);
      try {
        const st = lstatSync(p, { bigint: true });
        const k = `${st.dev}:${st.ino}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const t = JSON.parse(readFileSync(p, 'utf8'))?.scheduledTaskId;
        if (typeof t === 'string' && t && !ids.has(t)) orphan++;
      } catch { /* unreadable record */ }
    }
  }
  return orphan;
}

export function mergeTasks(group, o) {
  const rep = mergeFiles(group, TASK_SPEC, o);
  if (rep._merged && o.mode === 'full' && !o.dry) rep.orphanTaskRefs = countOrphanRefs(group, new Set(rep._merged.keys()));
  delete rep._merged;
  return rep;
}

export function mergeBacklog(group, o) {
  const rep = mergeFiles(group, BACKLOG_SPEC, o);
  delete rep._merged;
  return rep;
}

/**
 * Unlink step 4 and 5: each file keeps only the entries whose origin is that folder.
 * An entry with no recorded origin stays where it is. Run-times are already at their max.
 */
export function splitByOrigin(group, which, { ctx, state, guard }) {
  const spec = which === 'backlog' ? BACKLOG_SPEC : TASK_SPEC;
  const baseDoc = readJson(accPath(ctx, spec.baseFile), null);
  const rep = { written: [], removedEntries: 0 };
  if (!baseDoc?.origin) return rep;
  for (const F of group) {
    const side = readSide(F, spec);
    if (side.bad || !side.exists) continue;
    const keep = side.list.filter((e) => {
      const org = baseDoc.origin[e?.id];
      return org === undefined || org === F.key;
    });
    if (keep.length === side.list.length) continue;
    const doc = {};
    for (const k of Object.keys(side.doc)) doc[k] = k === spec.listKey ? keep : side.doc[k];
    const text = serializeJson(doc, side.fmt);
    tickMutation();
    backupCopy(ctx, side.file, { reason: `${spec.name}-unlink`, folder: F.key, name: `${spec.name}-${F.acct}-${F.org}.json` });
    writeTextAtomic(side.file, text, { guard: () => guard?.(`${spec.name}-unlink`, F.key) });
    if (spec.trackWritten) state.tasksWritten[F.key] = sha(text);
    rep.written.push(F.key);
    rep.removedEntries += side.list.length - keep.length;
  }
  return rep;
}

