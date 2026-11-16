/**
 * merge3.mjs - generic 3-way merge helpers (plan 5.7 to 5.9).
 *
 * A "side" is an account, a folder or a file. `base` holds each side's value at
 * the last full pass (null at the first link: no base). `cur` holds each side's
 * value now (undefined = absent). Nothing here touches the disk.
 *
 *   merge3(kind, base, cur, ctx) -> { result:{side:value}, changed:[side], conflicts:n }
 *
 * kinds: value, or, max, set, map (deep), keyed-array(id).
 *
 * ctx.newest(sides) returns the side that wins a conflict, or null on a tie
 * (a tie keeps the base). Results never create a trivial value (false, 0, empty
 * container) on a side that did not have the key.
 *
 * The keyed merge (mergeKeyed) is shared with the scheduled-task and backlog
 * merges, where the base is one merged result for every side.
 */

import { isDeepStrictEqual } from 'node:util';

export const deepEqual = (a, b) => isDeepStrictEqual(a, b);
export const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

/** Date.parse for strings, the number itself for finite numbers, -Infinity otherwise. */
export function toMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? -Infinity : t; }
  return -Infinity;
}

function uniq(vals) {
  const out = [];
  for (const v of vals) if (!out.some((x) => deepEqual(x, v))) out.push(v);
  return out;
}

const omit = (o, keys) => {
  const r = {};
  for (const k of Object.keys(o)) if (!keys.includes(k)) r[k] = o[k];
  return r;
};

const isTrivial = (v) => v === false || v === null || v === 0 || v === ''
  || (Array.isArray(v) && v.length === 0) || (isPlain(v) && Object.keys(v).length === 0);

/* ------------------------------------------------------------------ value */

/**
 * One changer gives its value; several give the value of ctx.newest(changers);
 * a tie keeps the base (or each side's own value when there is no base).
 */
export function mergeValue(base, cur, ctx = {}) {
  const sides = Object.keys(cur);
  const present = sides.filter((s) => cur[s] !== undefined);
  const res = {};
  for (const s of sides) res[s] = cur[s];
  if (!present.length) return { res, conflict: false };
  const distinct = uniq(present.map((s) => cur[s]));
  if (distinct.length === 1) { for (const s of sides) res[s] = clone(distinct[0]); return { res, conflict: false }; }
  const changers = base == null ? present : present.filter((s) => !deepEqual(cur[s], base[s]));
  if (!changers.length) return { res, conflict: false };
  const vals = uniq(changers.map((s) => cur[s]));
  let v; let conflict = false;
  if (vals.length === 1) v = vals[0];
  else {
    conflict = true;
    const w = ctx.newest?.(changers) ?? null;
    if (w != null) v = cur[w];
    else if (base != null) {
      const bs = sides.find((s) => base[s] !== undefined);
      if (bs === undefined) return { res, conflict };
      v = base[bs];
    } else return { res, conflict };
  }
  for (const s of sides) res[s] = clone(v);
  return { res, conflict };
}

/* ------------------------------------------------------------------ set */

const itemKey = (v) => JSON.stringify(v);

/** result_s = (cur_s ∪ added anywhere) − (removed anywhere and not re-added elsewhere). First link: union. */
export function mergeSet(base, cur) {
  const sides = Object.keys(cur);
  const own = Object.fromEntries(sides.map((s) => [s, Array.isArray(cur[s]) ? cur[s] : []]));
  const added = new Map();      // key -> value, in side order
  const removed = new Set();
  for (const s of sides) {
    const curKeys = new Set(own[s].map(itemKey));
    if (base == null) {
      for (const v of own[s]) added.set(itemKey(v), v);
    } else if (Array.isArray(base[s])) {
      const baseKeys = new Set(base[s].map(itemKey));
      for (const v of own[s]) if (!baseKeys.has(itemKey(v))) added.set(itemKey(v), v);
      for (const v of base[s]) if (!curKeys.has(itemKey(v))) removed.add(itemKey(v));
    } else {
      for (const v of own[s]) added.set(itemKey(v), v);   // a side with no base: all of it is new
    }
  }
  for (const k of added.keys()) removed.delete(k);
  const res = {};
  for (const s of sides) {
    const out = [];
    const seen = new Set();
    for (const v of own[s]) { const k = itemKey(v); if (!removed.has(k) && !seen.has(k)) { out.push(v); seen.add(k); } }
    for (const [k, v] of added) if (!removed.has(k) && !seen.has(k)) { out.push(clone(v)); seen.add(k); }
    res[s] = out;
  }
  return { res };
}

/* ------------------------------------------------------------------ map (deep) */

export function mergeMap(base, cur, ctx = {}) {
  const sides = Object.keys(cur);
  const present = sides.filter((s) => isPlain(cur[s]));
  const res = {};
  for (const s of sides) res[s] = isPlain(cur[s]) ? clone(cur[s]) : cur[s];
  let conflicts = 0;
  const keys = [];
  const seenKeys = new Set();
  for (const s of present) for (const k of Object.keys(cur[s])) if (!seenKeys.has(k)) { seenKeys.add(k); keys.push(k); }
  for (const k of keys) {
    const subCur = {}; const subBase = base == null ? null : {};
    for (const s of sides) {
      subCur[s] = isPlain(cur[s]) ? cur[s][k] : undefined;
      if (base != null) subBase[s] = isPlain(base[s]) ? base[s][k] : undefined;
    }
    const vals = sides.map((s) => subCur[s]).filter((v) => v !== undefined);
    let out;
    if (vals.length && vals.every(isPlain)) {
      const sub = mergeMap(subBase, subCur, ctx);
      conflicts += sub.conflicts;
      out = sub.res;
    } else {
      const removedSides = base == null ? [] : sides.filter((s) => isPlain(base[s]) && isPlain(cur[s]) && subBase[s] !== undefined && subCur[s] === undefined);
      const changers = base == null ? vals : sides.filter((s) => subCur[s] !== undefined && !deepEqual(subCur[s], subBase[s]));
      if (removedSides.length && !changers.length) {
        out = Object.fromEntries(sides.map((s) => [s, undefined]));
      } else {
        const m = mergeValue(subBase, subCur, ctx);
        if (m.conflict) conflicts++;
        out = m.res;
      }
    }
    for (const s of sides) {
      const v = out[s];
      if (v === undefined) { if (isPlain(res[s])) delete res[s][k]; continue; }
      if (isPlain(v) && !Object.keys(v).length && subCur[s] === undefined) continue;   // never create an empty container
      if (!isPlain(res[s])) res[s] = {};
      res[s][k] = v;
    }
  }
  return { res, conflicts };
}

/* ------------------------------------------------------------------ keyed arrays */

const cmpRank = (a, b) => {
  const x = Array.isArray(a) ? a : [a]; const y = Array.isArray(b) ? b : [b];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? -Infinity; const q = y[i] ?? -Infinity;
    if (p !== q) return p > q ? 1 : -1;
  }
  return 0;
};

/**
 * 3-way merge of keyed entries (scheduled tasks, backlog items, presets).
 *
 * @param {object} o
 * @param {object} o.cur        {side: entries[]|undefined}
 * @param {object|null} o.base  {side: Map(id -> entry)} or null (first link)
 * @param {Set}    [o.covered]  sides the base covers (default: the sides of o.base). A side outside it never "removed" anything.
 * @param {boolean}[o.fieldwise] merge per field (tasks, backlog) instead of whole entries
 * @param {string[]}[o.runtime] fields merged by max (kept in their original form)
 * @param {string[]}[o.ignore]  fields that are not compared; the merged entry takes the source side's value
 * @param {Function}[o.rank]    entry -> number | number[] (conflict order, higher wins)
 * @param {Function}[o.newest]  (sides) -> side | null
 * @param {boolean}[o.full]     a delete may happen (full pass); false keeps the entry and reports it owed
 */
export function mergeKeyed(o) {
  const {
    cur, base = null, idKey = 'id', fieldwise = false, runtime = [], ignore = [], rank = () => 0, newest = () => null, full = true,
  } = o;
  const sides = Object.keys(cur);
  const covered = o.covered ?? new Set(base ? Object.keys(base) : []);
  const maps = {};
  for (const s of sides) {
    maps[s] = new Map((cur[s] ?? []).filter((e) => isPlain(e) && e[idKey] !== undefined).map((e) => [e[idKey], e]));
  }
  const ids = [];
  const seen = new Set();
  for (const s of sides) for (const id of maps[s].keys()) if (!seen.has(id)) { seen.add(id); ids.push(id); }
  const baseSides = base ? Object.keys(base) : [];
  const firstBase = (id) => { for (const s of baseSides) if (base[s]?.has(id)) return base[s].get(id); return undefined; };
  const baseEntry = (s, id) => base?.[s]?.get(id) ?? firstBase(id);
  const strip = (e) => omit(e, [...runtime, ...ignore]);

  const out = { merged: new Map(), source: new Map(), removed: [], owedDeletes: [], keptEdits: [], conflicts: [], duplicates: [] };

  const best = (cands, entryOf) => {
    let top = [cands[0]];
    for (const s of cands.slice(1)) {
      const c = cmpRank(rank(entryOf(s)), rank(entryOf(top[0])));
      if (c > 0) top = [s]; else if (c === 0) top.push(s);
    }
    if (top.length === 1) return top[0];
    return newest(top) ?? top[0];
  };

  const maxRuntime = (entry, present, id) => {
    for (const f of runtime) {
      let bestV; let bestMs = -Infinity;
      const cands = present.map((s) => maps[s].get(id)[f]);
      for (const s of baseSides) cands.push(base[s]?.get(id)?.[f]);
      for (const v of cands) {
        if (v === undefined || v === null) continue;
        const ms = toMs(v);
        if (bestV === undefined || ms > bestMs) { bestV = v; bestMs = ms; }
      }
      if (bestV === undefined) delete entry[f]; else entry[f] = bestV;
    }
  };

  for (const id of ids) {
    const present = sides.filter((s) => maps[s].has(id));
    const inBase = !!base && baseSides.some((s) => base[s]?.has(id));
    let src; let entry;
    if (!inBase) {
      const distinct = uniq(present.map((s) => strip(maps[s].get(id))));
      if (distinct.length > 1) {
        out.duplicates.push(id);
        src = best(present, (s) => maps[s].get(id));
      } else src = present[0];
      entry = clone(maps[src].get(id));
    } else {
      const be = firstBase(id);
      const changers = present.filter((s) => !deepEqual(strip(maps[s].get(id)), strip(baseEntry(s, id))));
      const removedSides = sides.filter((s) => covered.has(s) && !maps[s].has(id));
      if (removedSides.length && !changers.length) {
        if (full) {
          const e = clone(maps[present[0]].get(id));
          maxRuntime(e, present, id);
          out.removed.push({ id, entry: e, sides: removedSides });
          continue;
        }
        out.owedDeletes.push(id);
      } else if (removedSides.length) out.keptEdits.push(id);
      src = changers[0] ?? present[0];
      entry = clone(maps[src].get(id));
      if (changers.length) {
        if (!fieldwise) {
          const distinct = uniq(changers.map((s) => strip(maps[s].get(id))));
          if (distinct.length > 1) { out.conflicts.push({ id }); src = best(changers, (s) => maps[s].get(id)); }
          else src = changers[0];
          entry = clone(maps[src].get(id));
        } else {
          const names = [];
          const addName = (k) => { if (!names.includes(k)) names.push(k); };
          Object.keys(entry).forEach(addName);
          Object.keys(be ?? {}).forEach(addName);
          for (const s of present) Object.keys(maps[s].get(id)).forEach(addName);
          const merged = {};
          for (const f of names) {
            if (runtime.includes(f) || ignore.includes(f)) { if (f in entry) merged[f] = entry[f]; continue; }
            const bv = be?.[f];
            const ch = present.filter((s) => !deepEqual(maps[s].get(id)[f], bv));
            let v = bv;
            if (ch.length) {
              const vals = uniq(ch.map((s) => maps[s].get(id)[f]));
              if (vals.length === 1) v = vals[0];
              else {
                out.conflicts.push({ id, field: f });
                const w = newest(ch);
                v = w != null ? maps[w].get(id)[f] : bv;
              }
            }
            if (v !== undefined) merged[f] = clone(v);
          }
          entry = merged;
        }
      }
    }
    maxRuntime(entry, present, id);
    out.merged.set(id, entry);
    out.source.set(id, src);
  }
  return out;
}

/**
 * The list a side should hold: its own entries first (in its own order, with its
 * own `ignore` field values), then entries it lacks, oldest rank first.
 */
export function buildSide(curArr, merged, { idKey = 'id', ignore = [], rank = () => 0 } = {}) {
  const own = new Map();
  for (const e of curArr ?? []) if (isPlain(e) && e[idKey] !== undefined) own.set(e[idKey], e);
  const list = [];
  for (const [id, e] of own) {
    const m = merged.get(id);
    if (!m) continue;
    const cand = {};
    for (const k of Object.keys(e)) if (k in m) cand[k] = clone(m[k]);
    for (const k of Object.keys(m)) if (!(k in cand)) cand[k] = clone(m[k]);
    for (const k of ignore) { if (k in e) cand[k] = clone(e[k]); }
    list.push(deepEqual(cand, e) ? e : cand);
  }
  const fresh = [...merged.keys()].filter((id) => !own.has(id));
  fresh.sort((a, b) => cmpRank(rank(merged.get(a)), rank(merged.get(b))));
  for (const id of fresh) list.push(clone(merged.get(id)));
  return list;
}

function mergeKeyedArray(base, cur, ctx) {
  const idKey = ctx.idKey ?? 'id';
  const rank = ctx.rank ?? ((e) => [toMs(e.lastUsedAt), toMs(e.createdAt)]);
  const sides = Object.keys(cur);
  const b = base == null ? null : Object.fromEntries(sides.filter((s) => Array.isArray(base[s]))
    .map((s) => [s, new Map(base[s].filter((e) => isPlain(e) && e[idKey] !== undefined).map((e) => [e[idKey], e]))]));
  const m = mergeKeyed({ cur, base: b, idKey, rank, newest: ctx.newest, full: true, fieldwise: false });
  const res = {};
  for (const s of sides) {
    const list = buildSide(cur[s], m.merged, { idKey, rank });
    res[s] = cur[s] === undefined && !list.length ? undefined : list;
  }
  return { res, conflicts: m.conflicts.length };
}

/* ------------------------------------------------------------------ entry */

/**
 * @param {'value'|'or'|'max'|'set'|'map'|'keyed-array'} kind
 * @param {object|null} base   {side: value} or null at the first link
 * @param {object}      cur    {side: value|undefined}
 * @param {object}      [ctx]  {newest, idKey, rank}
 */
export function merge3(kind, base, cur, ctx = {}) {
  const sides = Object.keys(cur);
  const present = sides.filter((s) => cur[s] !== undefined);
  let res = {}; let conflicts = 0;
  switch (kind) {
    case 'value': { const m = mergeValue(base, cur, ctx); res = m.res; conflicts = m.conflict ? 1 : 0; break; }
    case 'or': {
      for (const s of sides) res[s] = cur[s];
      if (present.length) { const v = present.some((s) => !!cur[s]); for (const s of sides) res[s] = v; }
      break;
    }
    case 'max': {
      for (const s of sides) res[s] = cur[s];
      const nums = present.map((s) => cur[s]).filter((v) => typeof v === 'number' && Number.isFinite(v));
      if (nums.length) { const v = Math.max(...nums); for (const s of sides) res[s] = v; }
      break;
    }
    case 'set': res = mergeSet(base, cur).res; break;
    case 'map': { const m = mergeMap(base, cur, ctx); res = m.res; conflicts = m.conflicts; break; }
    case 'keyed-array': { const m = mergeKeyedArray(base, cur, ctx); res = m.res; conflicts = m.conflicts; break; }
    default: throw new Error(`merge3: unknown kind ${kind}`);
  }
  for (const s of sides) if (cur[s] === undefined && res[s] !== undefined && isTrivial(res[s])) res[s] = undefined;
  const changed = sides.filter((s) => !deepEqual(res[s], cur[s]));
  return { result: res, changed, conflicts };
}
