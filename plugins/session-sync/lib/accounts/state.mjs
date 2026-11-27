/**
 * state.mjs - the account link's own bookkeeping under ACC
 * (`~/.claude/session-sync/accounts`): atomic JSON with a `.bak`, the journal,
 * the accounts lock, and the test-only mutation counter (plan section 4).
 *
 * Everything takes a `ctx` = { store, userData, acc, now }. Production callers
 * use makeCtx(); tests pass temp dirs. ACC is already excluded from push by
 * `excludeRootDirs:['session-sync']`.
 */

import {
  readFileSync, mkdirSync, existsSync, openSync, writeSync, fsyncSync, closeSync,
  renameSync, copyFileSync, unlinkSync, utimesSync, statSync, fchmodSync, readdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { STATE_DIR } from '../config.mjs';
import { sessionStores } from '../paths.mjs';
import { acquireLock } from '../lock.mjs';

export const ACC = join(STATE_DIR, 'accounts');
export const LOCK_TTL_MS = 30 * 60 * 1000;

/** Build a context. Any field can be overridden (tests do). */
export function makeCtx(over = {}) {
  const store = over.store ?? sessionStores()['claude-code-sessions'] ?? null;
  return {
    store,
    userData: over.userData ?? (store ? dirname(store) : null),
    acc: over.acc ?? ACC,
    now: over.now ?? (() => Date.now()),
    platform: over.platform ?? process.platform,
    ...('spawnFn' in over ? { spawnFn: over.spawnFn } : {}),
  };
}

export const accPath = (ctx, ...parts) => join(ctx.acc, ...parts);

export function emptyState(store = null) {
  return {
    v: 1, store, linked: false, group: [], pairs: {}, backupId: null, backups: [], records: {},
    live: { startedAtMs: 0, folders: [] }, tasksWritten: {}, lastSignedIn: {},
    lastRectify: null, lastFullPass: null, fullPassOwed: false, lastRemoteCheck: null,
    signed: null, loadedSnapshot: {}, conflicts: {}, held: {}, heldRun: 0,
  };
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** Best effort synchronous sleep (rename retries on Windows). */
export function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ignore */ }
}

export function renameRetry(from, to, tries = 4, delayMs = 100) {
  for (let i = 0; ; i++) {
    try { renameSync(from, to); return; } catch (e) {
      if (i + 1 >= tries || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      sleepSync(delayMs);
    }
  }
}

/**
 * Atomic JSON write: tmp in the same folder, fsync, previous file kept as `.bak`
 * (a copy, never a link), rename. fmt = { indent, eol, trailingNewline, bom }.
 */
export function writeJsonAtomic(file, obj, fmt = {}) {
  const { indent = 2, eol = '\n', trailingNewline = false, bom = false } = fmt;
  let text = JSON.stringify(obj, null, indent);
  if (eol !== '\n') text = text.replace(/\n/g, eol);
  if (trailingNewline) text += eol;
  if (bom) text = '﻿' + text;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w');
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  if (existsSync(file)) { try { copyFileSync(file, `${file}.bak`); } catch { /* a missing .bak is not fatal */ } }
  try { renameRetry(tmp, file); } catch (e) { try { unlinkSync(tmp); } catch { /* ignore */ } throw e; }
}

/* ---- formatted JSON text (guarded edits keep the file's own style) ---- */

/** Detect BOM, EOL, indent (tab, N spaces, or 0 = compact) and trailing newline of a JSON text. */
export function detectFormat(text) {
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

export function serializeJson(obj, fmt = {}) {
  const { indent = 2, eol = '\n', trailingNewline = false, bom = false } = fmt;
  let text = JSON.stringify(obj, null, indent);
  if (eol !== '\n') text = text.replace(/\n/g, eol);
  if (trailingNewline) text += eol;
  return bom ? '﻿' + text : text;
}

/**
 * Atomic text write with NO .bak (global files may hold secrets; a copy next to
 * them would be one more place for them to sit). The temp name matches OURTMP:
 * not a record name, not *.json.tmp, excluded from push, cleaned up after 1 h.
 */
export function writeTextAtomic(file, text, { guard, mtimeMs } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.session-sync-link-${randomBytes(6).toString('hex')}`);
  let mode = null;
  try { mode = statSync(file).mode & 0o777; } catch { /* new file: default mode */ }
  const fd = openSync(tmp, 'wx', mode ?? 0o666);
  try {
    // keep the old file's permissions (a 0600 config must not become 0644); umask applies to openSync, fchmod does not (N3)
    if (mode !== null && process.platform !== 'win32') { try { fchmodSync(fd, mode); } catch { /* best effort */ } }
    writeSync(fd, text); fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    if (mtimeMs !== undefined) utimesSync(tmp, mtimeMs / 1000, mtimeMs / 1000);
    guard?.(); renameRetry(tmp, file);
  } catch (e) { try { unlinkSync(tmp); } catch { /* ignore */ } throw e; }
}

const OUR_TMP = /^\.session-sync-link-[0-9a-f]{12}$/;

/**
 * Remove our own leftover temp names (a crash between the write and the rename) older than an hour from `dir`;
 * `recursive` also walks sub-folders (the Cowork memory roots). Returns how many were removed (N3).
 */
export function sweepOurTmp(dir, now, { recursive = false, maxAgeMs = 60 * 60 * 1000 } = {}) {
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  let n = 0;
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isFile() && OUR_TMP.test(e.name)) {
      try { if (now - statSync(p).mtimeMs > maxAgeMs) { unlinkSync(p); n++; } } catch { /* gone */ }
    } else if (recursive && e.isDirectory()) n += sweepOurTmp(p, now, { recursive, maxAgeMs });
  }
  return n;
}

export function loadState(ctx) {
  const file = accPath(ctx, 'state.json');
  let s = readJson(file, null) ?? readJson(`${file}.bak`, null);
  if (!s || typeof s !== 'object') s = emptyState(ctx.store);
  const base = emptyState(ctx.store);
  for (const k of Object.keys(base)) if (s[k] === undefined) s[k] = base[k];
  return s;
}

export function saveState(ctx, s) {
  writeJsonAtomic(accPath(ctx, 'state.json'), s);
}

/**
 * Run fn under accounts.lock. Returns {ok:true, value} or {ok:false, reason}
 * when the lock is busy. Not re-entrant: a nested call in the same process is
 * refused, so callers that already hold the lock pass `locked:true` downstream.
 */
export async function withAccountsLock(ctx, fn) {
  const lock = acquireLock(accPath(ctx, 'accounts.lock'), { ttlMs: LOCK_TTL_MS });
  if (!lock.acquired) return { ok: false, reason: lock.reason };
  try { return { ok: true, value: await fn() }; } finally { lock.release(); }
}

/* ---- journal: present only while a multi-step op runs ---- */

export const journalFile = (ctx) => accPath(ctx, 'journal.json');

export function journalStart(ctx, op, step = 'start', extra = {}) {
  writeJsonAtomic(journalFile(ctx), { op, startedAt: new Date(ctx.now()).toISOString(), step, pid: process.pid, ...extra });
}

export function journalStep(ctx, step) {
  const j = readJson(journalFile(ctx), null);
  if (!j) return;
  j.step = step;
  writeJsonAtomic(journalFile(ctx), j);
}

export const journalRead = (ctx) => readJson(journalFile(ctx), null);

/**
 * `rollback-active`: written by the standalone rollback before it changes anything and removed only when
 * it finished. While it exists no pass or unlink may run: a rollback that stopped half way must be
 * finished (run it again), never undone by a re-link.
 */
export const rollbackMarkerFile = (ctx) => accPath(ctx, 'rollback-active');
export const rollbackActive = (ctx) => existsSync(rollbackMarkerFile(ctx));

export function journalClear(ctx) {
  try { unlinkSync(journalFile(ctx)); } catch { /* none */ }
  try { unlinkSync(`${journalFile(ctx)}.bak`); } catch { /* none */ }
}

/* ---- test seam: SESSION_SYNC_TEST_FAIL_AFTER=<n> throws after n mutations ---- */

let mutations = 0;
export function resetMutations() { mutations = 0; }
export function tickMutation() {
  const n = process.env.SESSION_SYNC_TEST_FAIL_AFTER;
  if (n === undefined || n === '') return;
  mutations++;
  if (mutations > Number(n)) throw new Error(`SESSION_SYNC_TEST_FAIL_AFTER: injected failure after ${n} mutations`);
}

/* ---- own-links.json: the inode each link of ours actually got (a side file; state.json keeps its shape) ---- */

export const OWN_LINKS_MAX_AGE_MS = 6 * 3600 * 1000;
export const OWN_LINKS_CAP = 8;

/** {links: {id: [{ino, f, at}]}}; entries older than 6 h are dropped on load. The one-time hold reset marker is its own file (holds-reset.json). */
export function loadOwnLinks(ctx) {
  const o = readJson(accPath(ctx, 'own-links.json'), null);
  const own = o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  const links = {};
  const now = ctx.now();
  for (const [id, list] of Object.entries(own.links && typeof own.links === 'object' ? own.links : {})) {
    const keep = (Array.isArray(list) ? list : []).filter((x) => x && typeof x.ino === 'string' && now - (x.at || 0) < OWN_LINKS_MAX_AGE_MS).slice(-OWN_LINKS_CAP);
    if (keep.length) links[id] = keep;
  }
  return { links };
}

/** The inode keys of recent links of ours for one id (a Set); with a folder, only the names we linked IN that folder (the winner's own name shares the inode but is not ours). */
export function ownInos(own, id, folder = null) {
  return new Set((own?.links?.[id] ?? []).filter((x) => folder === null || x.f === folder).map((x) => x.ino));
}

export function saveOwnLinks(ctx, own) { writeJsonAtomic(accPath(ctx, 'own-links.json'), own); }

/** The one-time hold reset is done once this small file EXISTS (whatever it holds): a missing or corrupt own-links.json never repeats it. */
export const holdsResetDone = (ctx) => existsSync(accPath(ctx, 'holds-reset.json'));
/** Written atomically before any hold is dropped. Throws when it cannot be written (the caller then skips the reset). */
export function markHoldsReset(ctx) { writeJsonAtomic(accPath(ctx, 'holds-reset.json'), { at: new Date(ctx.now()).toISOString() }); }
