/**
 * settings.mjs - guarded 3-way merge of per-account settings (plan 5.9).
 *
 * Shared by default, with an explicit allow-list (S1 to S11). Everything runs in
 * FULL passes only; a live pass only reports whether a difference is owed.
 *
 * SECURITY (invariant I2). `claude_desktop_config.json` and
 * `remote-control-state.json` also hold device and auth material. They are
 * parsed and rewritten IN-PROCESS by guardedJsonEdit, which:
 *   - refuses a file that does not round-trip byte for byte (BOM, EOL, indent,
 *     trailing newline are detected and kept);
 *   - lets the mutation touch allow-listed paths only (a leaf-level diff of the
 *     object before and after must fall inside the allow-list, else no write);
 *   - writes through a temp name in the same folder (no `.bak` copy of secrets);
 *   - re-reads and deep-compares after the write;
 *   - reports changed path NAMES only, with account ids cut to 8 characters.
 * No value is ever logged, printed or copied except the allow-listed values the
 * path-level backup keeps (booleans, counts, folder maps, tool lists).
 *
 * `config.json`, `ant-device-registry.json` and the app's sign-in are never read
 * here and never written.
 */

import { readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  accPath, readJson, writeJsonAtomic, detectFormat, serializeJson, writeTextAtomic, tickMutation, sweepOurTmp,
} from './state.mjs';
import { backupCopy } from './backup.mjs';
import { merge3, deepEqual, isPlain } from './merge3.mjs';

export const CFG = 'claude_desktop_config.json';
export const PRESETS = 'ccd-session-presets.json';
export const TOGGLES = 'mcp-user-tool-toggles.json';
export const RC = 'remote-control-state.json';
/** Files that also hold auth or device material: path-level backup, in-process rewrite. */
export const PATH_LEVEL = [CFG, RC];
export const FILES = [CFG, PRESETS, TOGGLES, RC];

const EP = ['preferences', 'epitaxyPrefs'];
const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** epitaxyPrefs keys of the form `<base>.<acct>`: slot, merge kind, value type. */
export const EPITAXY = {
  'epitaxy-auto-mode-denial-count': { slot: 'S3', kind: 'max', type: 'number' },
  'epitaxy-auto-default-nudge-seen': { slot: 'S4', kind: 'or', type: 'boolean' },
  'epitaxy-auto-entry-warning-seen': { slot: 'S4', kind: 'or', type: 'boolean' },
  'epitaxy-auto-setup-band-seen': { slot: 'S4', kind: 'or', type: 'boolean' },
  'epitaxy-auto-reinvite-first-block-seen': { slot: 'S4', kind: 'or', type: 'boolean' },
  'epitaxy-folder-permission-mode-v2': { slot: 'S5', kind: 'map', type: 'object' },
  'epitaxy-perm-mode-acks-v2': { slot: 'S6', kind: 'set', type: 'array' },
};

/** Documentation of the allow-list (plan 5.9). The code below is the authority. */
export const ALLOW = [
  { id: 'S1', file: CFG, path: 'preferences.bypassPermissionsOptInByAccount[<acct>]', kind: 'value (first link: or)' },
  { id: 'S2', file: CFG, path: 'preferences.coworkModelAutoFallbackByAccount[<acct>]', kind: 'value (first link: or)' },
  { id: 'S3', file: CFG, path: 'preferences.epitaxyPrefs["epitaxy-auto-mode-denial-count.<acct>"]', kind: 'max' },
  { id: 'S4', file: CFG, path: 'preferences.epitaxyPrefs[<4 seen-flag names>.<acct>]', kind: 'or' },
  { id: 'S5', file: CFG, path: 'preferences.epitaxyPrefs["epitaxy-folder-permission-mode-v2.<acct>"]', kind: 'map' },
  { id: 'S6', file: CFG, path: 'preferences.epitaxyPrefs["epitaxy-perm-mode-acks-v2.<acct>"]', kind: 'set' },
  { id: 'S7', file: CFG, path: 'preferences.epitaxyPrefs["dframe-code-sections" | "dframe-group-scopes"]["<acct>/<org>"]', kind: 'map (deep)' },
  { id: 'S8', file: PRESETS, path: 'byAccount[<acct>].presets', kind: 'keyed-array(id)' },
  { id: 'S9', file: PRESETS, path: 'byAccount[<acct>].builtIns, .seededFromDraft', kind: 'map / or' },
  { id: 'S10', file: TOGGLES, path: 'owners[<acct>]', kind: 'set (first link seeds the base, no union)' },
  { id: 'S11', file: RC, path: 'identities["<org>:<acct>"].serve, .folders', kind: 'value / map, update-only' },
];

/** Keys under `preferences` that hold per-account data and are deliberately NOT shared (plan 5.9 exceptions). */
const EXCLUDED_PREF_KEYS = new Set([
  'bypassPermissionsGateByAccount', 'remoteChatFolderGrants', 'remoteChatFolderAccessReports', 'chromeExtension',
]);

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const lower = (s) => String(s).toLowerCase();
const mask = (s) => String(s).replace(UUID_G, (m) => m.slice(0, 8));
const maskPath = (p) => mask(p.map((x) => (typeof x === 'number' ? `[${x}]` : String(x))).join('.'));
const pathKey = (p) => JSON.stringify(p);

/* ------------------------------------------------------------------ path helpers */

export function getPath(obj, path) {
  let cur = obj;
  for (const k of path) {
    if (!isPlain(cur) || !(k in cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

export function setPath(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (cur[k] === undefined) cur[k] = {};
    if (!isPlain(cur[k])) throw new Error(`settings: ${maskPath(path.slice(0, i + 1))} is not an object`);
    cur = cur[k];
  }
  cur[path[path.length - 1]] = value;
}

export function deletePath(obj, path) {
  const parent = getPath(obj, path.slice(0, -1));
  if (isPlain(parent)) delete parent[path[path.length - 1]];
}

function addedLeaves(v, path, out) {
  if (isPlain(v) && Object.keys(v).length) { for (const k of Object.keys(v)) addedLeaves(v[k], [...path, k], out); } else out.push(path);
}

/** Leaf-level difference: the paths whose value was added, removed or replaced. Arrays and scalars count as one leaf. */
export function diffPaths(a, b, path = [], out = []) {
  if (deepEqual(a, b)) return out;
  if (isPlain(a) && isPlain(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const k of keys) {
      if (!(k in a)) addedLeaves(b[k], [...path, k], out);
      else if (!(k in b)) out.push([...path, k]);
      else diffPaths(a[k], b[k], [...path, k], out);
    }
  } else out.push(path);
  return out;
}

/* ------------------------------------------------------------------ the allow-list as a predicate */

const IDENTITY = /^([0-9a-f-]{36}):([0-9a-f-]{36})$/i;

function groupSets(group) {
  return { accts: new Set(group.map((f) => lower(f.acct))), folderKeys: new Set(group.map((f) => lower(f.key))) };
}

/** Is this leaf path inside the allow-list for this file? */
export function isAllowedPath(file, p, group) {
  const { accts, folderKeys } = groupSets(group);
  if (file === CFG) {
    if (p[0] !== 'preferences') return false;
    if (p[1] === 'bypassPermissionsOptInByAccount' || p[1] === 'coworkModelAutoFallbackByAccount') return typeof p[2] === 'string' && accts.has(lower(p[2]));
    if (p[1] === 'epitaxyPrefs') {
      const k = p[2];
      if (typeof k !== 'string') return false;
      if (k === 'dframe-code-sections' || k === 'dframe-group-scopes') return p.length >= 4 && typeof p[3] === 'string' && folderKeys.has(lower(p[3]));
      const m = /^(.+)\.([0-9a-f-]{36})$/i.exec(k);
      return !!m && m[1] in EPITAXY && accts.has(lower(m[2]));
    }
    return false;
  }
  if (file === PRESETS) {
    return p[0] === 'byAccount' && typeof p[1] === 'string' && accts.has(lower(p[1])) && ['presets', 'builtIns', 'seededFromDraft'].includes(p[2]);
  }
  if (file === TOGGLES) return p[0] === 'owners' && typeof p[1] === 'string' && accts.has(lower(p[1]));
  if (file === RC) {
    const m = IDENTITY.exec(String(p[1] ?? ''));
    return p[0] === 'identities' && !!m && accts.has(lower(m[2])) && (p[2] === 'serve' || p[2] === 'folders');
  }
  return false;
}

/* ------------------------------------------------------------------ slots */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isKeyedArray = (v) => Array.isArray(v) && v.every((e) => isPlain(e) && e.id !== undefined);

/**
 * The slots of one file: [{id, kind, firstLinkKind?, seed?, validate, sides:[{side, acct, path}]}].
 * `side` is an account, a group folder key, or an identity key, as the plan says per slot.
 */
export function buildSlots(file, obj, group) {
  const accts = [...new Set(group.map((f) => lower(f.acct)))].sort();
  const slots = [];
  if (file === CFG) {
    const acctSides = (path) => accts.map((a) => ({ side: a, acct: a, path: [...path, a] }));
    slots.push({ id: 'S1', kind: 'value', firstLinkKind: 'or', validate: (v) => typeof v === 'boolean', sides: acctSides(['preferences', 'bypassPermissionsOptInByAccount']) });
    slots.push({ id: 'S2', kind: 'value', firstLinkKind: 'or', validate: (v) => typeof v === 'boolean', sides: acctSides(['preferences', 'coworkModelAutoFallbackByAccount']) });
    const types = { number: isNum, boolean: (v) => typeof v === 'boolean', object: isPlain, array: Array.isArray };
    for (const [base, spec] of Object.entries(EPITAXY)) {
      slots.push({
        id: `${spec.slot}:${base}`, kind: spec.kind, validate: types[spec.type],
        sides: accts.map((a) => ({ side: a, acct: a, path: [...EP, `${base}.${a}`] })),
      });
    }
    for (const name of ['dframe-code-sections', 'dframe-group-scopes']) {
      slots.push({
        id: `S7:${name}`, kind: 'map', validate: isPlain,
        sides: group.map((F) => ({ side: F.key, acct: lower(F.acct), path: [...EP, name, F.key] })),
      });
    }
  } else if (file === PRESETS) {
    slots.push({ id: 'S8', kind: 'keyed-array', validate: isKeyedArray, sides: accts.map((a) => ({ side: a, acct: a, path: ['byAccount', a, 'presets'] })) });
    slots.push({ id: 'S9:builtIns', kind: 'map', validate: isPlain, sides: accts.map((a) => ({ side: a, acct: a, path: ['byAccount', a, 'builtIns'] })) });
    slots.push({ id: 'S9:seededFromDraft', kind: 'or', validate: (v) => typeof v === 'boolean', sides: accts.map((a) => ({ side: a, acct: a, path: ['byAccount', a, 'seededFromDraft'] })) });
  } else if (file === TOGGLES) {
    slots.push({ id: 'S10', kind: 'set', seed: true, validate: Array.isArray, sides: accts.map((a) => ({ side: a, acct: a, path: ['owners', a] })) });
  } else if (file === RC) {
    const ids = isPlain(obj?.identities) ? Object.keys(obj.identities).filter((k) => { const m = IDENTITY.exec(k); return m && accts.includes(lower(m[2])); }) : [];
    if (ids.length) {
      const sides = (leaf) => ids.map((k) => ({ side: k, acct: lower(IDENTITY.exec(k)[2]), path: ['identities', k, leaf] }));
      slots.push({ id: 'S11:serve', kind: 'value', validate: (v) => typeof v === 'string', sides: sides('serve') });
      slots.push({ id: 'S11:folders', kind: 'map', validate: isPlain, sides: sides('folders') });
    }
  }
  // account keys of the object are matched case-sensitively as written in the file
  return slots.map((s) => ({ ...s, sides: s.sides.map((x) => resolveCase(obj, x)) }));
}

/** The file may write account ids in another case than the folder names; use the file's own spelling. */
function resolveCase(obj, side) {
  const path = side.path.slice();
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (!isPlain(cur)) return side;
    const k = Object.keys(cur).find((x) => lower(x) === lower(path[i]));
    if (k !== undefined) path[i] = k;
    cur = cur[path[i]];
  }
  if (isPlain(cur)) {
    const last = path[path.length - 1];
    const k = Object.keys(cur).find((x) => lower(x) === lower(last));
    if (k !== undefined) path[path.length - 1] = k;
  }
  return { ...side, path };
}

/* ------------------------------------------------------------------ the guard */

function loadForEdit(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { status: 'absent' } : { status: 'refused', reason: `unreadable (${e.code})` }; }
  let obj;
  try { obj = JSON.parse(text); } catch { return { status: 'refused', reason: 'unparseable' }; }
  if (!isPlain(obj)) return { status: 'refused', reason: 'not an object' };
  const fmt = detectFormat(text);
  if (serializeJson(obj, fmt) !== text) return { status: 'refused', reason: 'not round-trippable' };
  return { status: 'ok', text, obj, fmt };
}

/**
 * Parse, mutate in memory, check the diff against the allow-list, write atomically.
 *
 * @param {string}   file
 * @param {Function} mutate     (obj) => void; may touch allow-listed paths only
 * @param {object}   o          {allowed:(path)=>bool, guard, dry, beforeWrite:(before, diffs)=>void}
 * @returns {{status:'absent'|'refused'|'unchanged'|'pending'|'written', reason?:string, changed:string[]}}
 */
export function guardedJsonEdit(file, mutate, o = {}) {
  const { allowed = () => false, guard, dry = false } = o;
  const l = loadForEdit(file);
  if (l.status !== 'ok') return { ...l, changed: [] };
  const before = structuredClone(l.obj);
  const obj = l.obj;
  mutate(obj);
  const diffs = diffPaths(before, obj);
  if (!diffs.length) return { status: 'unchanged', changed: [] };
  const outside = diffs.filter((p) => !allowed(p));
  if (outside.length) return { status: 'refused', reason: 'a change outside the allow-list; nothing written', changed: outside.slice(0, 10).map(maskPath) };
  const names = diffs.map(maskPath);
  if (dry) return { status: 'pending', changed: names };
  const text = serializeJson(obj, l.fmt);
  tickMutation();
  o.beforeWrite?.(before, diffs);
  writeTextAtomic(file, text, { guard: () => guard?.('settings-write', file) });
  let again;
  try { again = JSON.parse(readFileSync(file, 'utf8')); } catch { again = undefined; }
  if (!deepEqual(again, obj)) return { status: 'failed', reason: 'the file read back differently after the write', changed: names };
  return { status: 'written', changed: names };
}

/* ------------------------------------------------------------------ unknown per-account keys */

/**
 * Per-account keys under `preferences` that are neither allow-listed nor on the
 * exclusion list. Names only, account ids cut to 8 characters. Never descends
 * into excluded keys (so `chromeExtension` and friends are never visited), and
 * never looks at `mcpServers` (outside `preferences`).
 */
export function unknownAccountKeys(obj, group) {
  const accts = [...new Set(group.map((f) => lower(f.acct)))];
  const out = [];
  const has = (name) => { const m = String(name).match(UUID_G); return !!m && m.some((x) => accts.includes(lower(x))); };
  const walk = (node, path, depth) => {
    if (!isPlain(node) || depth > 5) return;
    for (const k of Object.keys(node)) {
      const p = [...path, k];
      if (path.length === 1 && EXCLUDED_PREF_KEYS.has(k)) continue;
      if (path.length === 2 && path[1] === 'epitaxyPrefs' && /^ultrathinkAvailable\./.test(k)) continue;
      if (isAllowedPath(CFG, p, group)) continue;
      if (has(k)) { out.push(maskPath(p)); continue; }
      walk(node[k], p, depth + 1);
    }
  };
  walk(obj?.preferences, ['preferences'], 0);
  return out;
}

/* ------------------------------------------------------------------ path-level backup areas */

/**
 * The original value of every allow-listed path of the path-level files (or
 * "absent"), plus the sha256 of the whole original file. Nothing else is read
 * into the result, so `mcpServers` env, device ids and the salt never reach a
 * backup (invariant I2, decision D5).
 */
export function computePathAreas(ctx, group) {
  const areas = {};
  for (const name of PATH_LEVEL) {
    const file = join(ctx.userData, name);
    let buf;
    try { buf = readFileSync(file); } catch { continue; }
    const area = { sha256: sha(buf), paths: {}, absentContainers: [] };
    areas[name] = area;
    let obj;
    try { obj = JSON.parse(buf.toString('utf8')); } catch { continue; }
    if (!isPlain(obj)) continue;
    const absent = new Set();
    for (const slot of buildSlots(name, obj, group)) {
      for (const s of slot.sides) {
        const v = getPath(obj, s.path);
        area.paths[pathKey(s.path)] = v === undefined ? { absent: true } : { value: structuredClone(v) };
        for (let i = 1; i < s.path.length; i++) {
          const anc = s.path.slice(0, i);
          if (getPath(obj, anc) === undefined) absent.add(pathKey(anc));
        }
      }
    }
    area.absentContainers = [...absent].sort((a, b) => JSON.parse(b).length - JSON.parse(a).length);
  }
  return areas;
}

/** Before every later overwrite of a path-level file: the old values of the changed paths only. */
function pathBackup(ctx, name, before, diffs) {
  const day = new Date(ctx.now()).toISOString().slice(0, 10);
  const dir = accPath(ctx, 'rectify-backups', day, 'paths');
  mkdirSync(dir, { recursive: true });
  const lines = diffs.map((p) => {
    const v = getPath(before, p);
    return JSON.stringify({ at: new Date(ctx.now()).toISOString(), path: p, ...(v === undefined ? { absent: true } : { value: v }) });
  });
  appendFileSync(join(dir, `${name}.jsonl`), `${lines.join('\n')}\n`);
}

/* ------------------------------------------------------------------ the merge */

/**
 * @param {Array}  group
 * @param {object} o  {mode:'full'|'live', dry, ctx, state, guard, signedIn}
 *   live mode (and dry) never writes: it reports `pending` when a difference is owed.
 */
export function mergeSettings(group, o) {
  const { mode = 'full', ctx, state, guard, signedIn = null } = o;
  const dry = o.dry || mode !== 'full';
  const rep = { mode, dry, files: {}, slots: {}, unknown: [], pending: false, refused: [], conflicts: 0 };
  const baseDoc = readJson(accPath(ctx, 'settings-base.json'), null);
  const oldSlots = isPlain(baseDoc?.slots) ? baseDoc.slots : {};
  const newSlots = structuredClone(oldSlots);

  const rank = (acct) => Date.parse(state?.lastSignedIn?.[acct] ?? '') || 0;
  if (!dry && ctx.userData) rep.sweptTmp = sweepOurTmp(ctx.userData, ctx.now());   // a crashed write leaves a full copy here (N3)

  for (const name of FILES) {
    const file = join(ctx.userData, name);
    const outcomes = {};
    const mutate = (obj) => {
      if (name === CFG) rep.unknown = unknownAccountKeys(obj, group);
      for (const slot of buildSlots(name, obj, group)) {
        const acctOf = Object.fromEntries(slot.sides.map((s) => [s.side, s.acct]));
        const cur = {};
        let invalid = false;
        for (const s of slot.sides) {
          const v = getPath(obj, s.path);
          if (v !== undefined && !slot.validate(v)) invalid = true;
          cur[s.side] = v;
        }
        if (invalid) { rep.slots[slot.id] = { skipped: 'unexpected value type' }; continue; }
        if (Object.values(cur).every((v) => v === undefined) && !oldSlots[slot.id]) { outcomes[slot.id] = { base: {} }; continue; }
        const baseSlot = oldSlots[slot.id];
        if (slot.seed && !baseSlot) { outcomes[slot.id] = { base: structuredClone(Object.fromEntries(Object.entries(cur).filter(([, v]) => v !== undefined))), seeded: true }; rep.slots[slot.id] = { seeded: true }; continue; }
        const kind = !baseSlot && slot.firstLinkKind ? slot.firstLinkKind : slot.kind;
        // A conflict goes to the account signed in most recently (strictly); a tie keeps the base. Every side of a
        // slot lives in one file, so file mtimes always tie. With an unknown signed-in account only that tie applies.
        const newest = (changers) => {
          if (!signedIn) return null;
          const ranked = changers.map((s) => [s, rank(acctOf[s])]).sort((a, b) => b[1] - a[1]);
          return ranked[0][1] > 0 && (ranked.length === 1 || ranked[0][1] > ranked[1][1]) ? ranked[0][0] : null;
        };
        const m = merge3(kind, baseSlot ?? null, cur, { newest });
        rep.conflicts += m.conflicts;
        for (const side of m.changed) {
          const s = slot.sides.find((x) => x.side === side);
          if (m.result[side] === undefined) deletePath(obj, s.path); else setPath(obj, s.path, structuredClone(m.result[side]));
        }
        outcomes[slot.id] = { base: Object.fromEntries(Object.entries(m.result).filter(([, v]) => v !== undefined).map(([k, v]) => [k, structuredClone(v)])) };
        if (m.changed.length) rep.slots[slot.id] = { changedSides: m.changed.map(mask), conflicts: m.conflicts };
      }
    };
    const r = guardedJsonEdit(file, mutate, {
      allowed: (p) => isAllowedPath(name, p, group),
      guard, dry,
      beforeWrite: PATH_LEVEL.includes(name) ? (before, diffs) => pathBackup(ctx, name, before, diffs)
        : () => { backupCopy(ctx, file, { reason: 'settings-merge', folder: '_', name }); },
    });
    rep.files[name] = { status: r.status, ...(r.reason ? { reason: r.reason } : {}), changed: r.changed.slice(0, 20) };
    if (r.status === 'pending') rep.pending = true;
    if (r.status === 'refused' || r.status === 'failed') rep.refused.push({ file: name, reason: r.reason });
    if (!dry && (r.status === 'written' || r.status === 'unchanged')) {
      for (const [id, oc] of Object.entries(outcomes)) newSlots[id] = oc.base;
    }
  }
  if (!dry) writeJsonAtomic(accPath(ctx, 'settings-base.json'), { v: 1, at: new Date(ctx.now()).toISOString(), slots: newSlots });
  return rep;
}

