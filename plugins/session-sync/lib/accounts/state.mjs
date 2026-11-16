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
  renameSync, copyFileSync, unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
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
    v: 1, store, linked: false, group: [], pairs: {}, backupId: null, records: {},
    live: { startedAtMs: 0, folders: [] }, tasksWritten: {}, lastSignedIn: {},
    lastRectify: null, lastFullPass: null, fullPassOwed: false, lastRemoteCheck: null,
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

export function journalStart(ctx, op, step = 'start') {
  writeJsonAtomic(journalFile(ctx), { op, startedAt: new Date(ctx.now()).toISOString(), step, pid: process.pid });
}

export function journalStep(ctx, step) {
  const j = readJson(journalFile(ctx), null);
  if (!j) return;
  j.step = step;
  writeJsonAtomic(journalFile(ctx), j);
}

export const journalRead = (ctx) => readJson(journalFile(ctx), null);

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
