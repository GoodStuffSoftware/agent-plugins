/**
 * rcspawn.mjs - sessions that were STARTED FROM claude.ai or the phone under another account (0.5.9).
 *
 * The desktop app treats a Code session as "started via Remote Control" when its record has `remoteControlSpawn` and that has no
 * `detachedAt` (`startedViaRemoteControl = spawn !== undefined && spawn.detachedAt === undefined`, a derived value, never stored). On every
 * resume of such a session the app sets `CLAUDE_BRIDGE_REATTACH_SESSION=<ccrSessionId>` and attaches to that cloud session. When the id was
 * minted under the account that was signed in BEFORE an account switch, the attach reaches the old account's org and the app stops the session.
 * The record keeps the old id for good: only the app's own detach (`dropMismatchedRemoteControlBridge`, which writes
 * `remoteControlSpawn = {...spawn, detachedAt: Date.now()}`) clears it, and that never fires for this case.
 *
 * What this module does, for the signed-in account's non-archived local records:
 *   DETECT   (read only, safe while the app runs) a record is flagged when its live spawn carries a `ccrSessionId` minted under another
 *            account, and/or its `bridgeSessionIds` hold such `cse_` ids. "Minted under another account" is rclinks.mjs: the ledger, else
 *            the first sighting in the transcript dated against the switch history; only for the spawn id, when that cannot tell either,
 *            the account that was signed in when the record was created (`createdAt`, against the same history). Whatever cannot be told is
 *            skipped ("undated"), never flagged: a session started under the CURRENT account is never touched.
 *   REPAIR   (only with the app stopped) back the record up, then edit it IN PLACE (open r+, write, truncate: one inode, so every hard link
 *            sees the edit): the spawn gets `detachedAt` exactly as the app writes it, and the foreign ids leave `bridgeSessionIds`. The
 *            other bytes, the key order and the formatting stay; a record whose unedited round trip is not byte-identical is left alone.
 *
 * The app reads records from disk only at startup or account init, and an app save would overwrite an edit made while it runs: so
 * the callers repair at a stop (the account pass, the quit step, the logon step, `accounts rc-spawn-fix`) and only detect and report
 * while the app runs ("pending, fixed at the next quit or switch").
 *
 * Account-bound record fields checked (the research of the app's record handling): `remoteControlSpawn` and `bridgeSessionIds` are trusted
 * blindly on load and carry the old ids (fixed here); `remoteControlLiveAtUpdateQuit.accountId` and `remoteControlAwaitsSignIn.accountId` are
 * compared with the signed-in account by the app and skipped on a mismatch (nothing to fix); `remoteControlAutoEligible`,
 * `remoteControlUserEnabled`, `remoteControlKeptServerCopyId`, `steeredByRemoteClient`, `startedFromEnvironmentId`, `envScopeId` are not
 * account-bound (the record has no account or org field the app filters on).
 *
 * Circular import with rcrestore.mjs (its quit step calls this); both only use the other's exports inside functions, never at load.
 */

import { readFileSync, readdirSync, statSync, openSync, closeSync, writeSync, ftruncateSync, fsyncSync, copyFileSync, mkdirSync, existsSync, constants as FS } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, rcSettings } from '../config.mjs';
import { accPath, readJson, writeJsonAtomic, detectFormat, serializeJson, withAccountsLock } from './state.mjs';
import { listFolders, RECORD } from './folders.mjs';
import { readSignedIn, lockfilePresent } from './appstate.mjs';
import { makeForeign, acctAt } from './rclinks.mjs';
import { findTranscript, defaultProjects, stamp, pruneBackups } from './rcrestore.mjs';

const lc = (s) => (typeof s === 'string' ? s.toLowerCase() : '');
const msOf = (v) => (typeof v === 'number' ? v : Date.parse(v));
const isCse = (id) => typeof id === 'string' && id.startsWith('cse_');
const short = (id) => String(id ?? '').replace(/^local_/, '').slice(0, 8);

export const spawnFile = (ctx) => accPath(ctx, 'rc-spawn.json');
const FIXED_KEEP = 20;

/** The mode: an explicit option, else the settings object the caller holds, else the config file. 'auto' | 'off'. */
export function spawnFixMode(o = {}) {
  const m = o.spawnFix ?? o.settings?.spawnFix ?? rcSettings(loadConfig()).spawnFix;
  return m === 'off' ? 'off' : 'auto';
}

/** The app's own test: started via Remote Control = a spawn with no `detachedAt` (K.h). */
export const liveSpawn = (rec) => !!rec && typeof rec.remoteControlSpawn === 'object' && rec.remoteControlSpawn !== null && rec.remoteControlSpawn.detachedAt === undefined;

/* ------------------------------------------------------------------ detect */

/** 'foreign' | 'own' | 'undated': the account that was signed in when the record was created, against the switch history. */
function byCreation(rec, history, cur) {
  const t = msOf(rec.createdAt);
  if (!Number.isFinite(t) || !history.length) return 'undated';
  const a = acctAt(history, t, cur);
  if (a) return a === cur ? 'own' : 'foreign';
  return 'undated';   // older than the history (its first entry is only the oldest log line left) or after an unrecorded switch: never guessed
}

/** What is wrong with one parsed record: { spawnId, spawnForeign, foreignIds, undated }. */
function decide(rec, fc, tp, cur) {
  const out = { spawnId: null, spawnForeign: false, foreignIds: [], undated: false };
  if (rec.remoteControlSpawn && typeof rec.remoteControlSpawn === 'object' && rec.remoteControlSpawn.detachedAt !== undefined) return out;   // already detached (by the app or by this module): never touched again
  const spawn = liveSpawn(rec) ? rec.remoteControlSpawn : null;
  if (spawn) {
    out.spawnId = typeof spawn.ccrSessionId === 'string' ? spawn.ccrSessionId : null;
    let k = out.spawnId ? fc.classify(out.spawnId, tp) : 'undated';
    if (k === 'undated') k = byCreation(rec, fc.history, cur);
    if (k === 'foreign') out.spawnForeign = true; else if (k === 'undated') out.undated = true;
  }
  const ids = Array.isArray(rec.bridgeSessionIds) ? rec.bridgeSessionIds.filter(isCse) : [];
  for (const id of ids) {
    let k = fc.classify(id, tp);
    if (k === 'undated' && id === out.spawnId && out.spawnForeign) k = 'foreign';   // the spawn's own id: the same verdict as the spawn
    if (k === 'foreign') out.foreignIds.push(id);
    else if (k === 'undated') out.undated = true;
  }
  return out;
}

const statKey = (p) => { try { const s = statSync(p, { bigint: true }); return { key: `${s.dev}:${s.ino}`, nlink: Number(s.nlink) }; } catch { return null; } };

/** Every path under the store that is this record file's inode (any account folder): the links the edit must show on. */
function linksOf(folders, name, key) {
  const out = [];
  for (const f of folders) { const p = join(f.path, name); const k = statKey(p); if (k && k.key === key) out.push(p); }
  return out;
}

/**
 * Read-only: the sessions of the signed-in account whose record carries an account-bound Remote Control field of another account.
 * o: { acct, projects, rcLog, foreignCheck }
 * @returns {{acct, scanned:number, flagged:{id,title,targets:{path,name,org,key,nlink,links:string[],detach:boolean,spawnId,removeIds:string[]}[],spawn:boolean,ids:string[]}[],
 *   skipped:{id,title,reason:string}[]}}  (`foreignCheck` is a hidden property)
 */
export function spawnPlan(ctx, o = {}) {
  const acct = lc(o.acct ?? readSignedIn(ctx.userData)) || null;
  const plan = { acct, scanned: 0, flagged: [], skipped: [] };
  if (!acct || !ctx.store) return plan;
  const folders = listFolders(ctx.store);
  const cands = [];
  for (const f of folders) {
    if (f.acct !== acct) continue;
    let names; try { names = readdirSync(f.path); } catch { continue; }
    for (const name of names) {
      if (!RECORD.test(name)) continue;
      const path = join(f.path, name);
      let text; try { text = readFileSync(path, 'utf8'); } catch { continue; }
      plan.scanned++;
      if (!text.includes('"remoteControlSpawn"') && !text.includes('"cse_')) continue;   // cheap: nothing to look at without one of the two
      let rec; try { rec = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { continue; }
      if (!rec || typeof rec !== 'object' || rec.isArchived === true) continue;
      if (rec.movedToCloud || (rec.backend && rec.backend.kind && rec.backend.kind !== 'local')) continue;
      if (!liveSpawn(rec) && !(Array.isArray(rec.bridgeSessionIds) && rec.bridgeSessionIds.some(isCse))) continue;
      cands.push({ f, name, path, rec, text });
    }
  }
  if (!cands.length) return plan;
  const fc = o.foreignCheck ?? makeForeign(ctx, acct, o);
  Object.defineProperty(plan, 'foreignCheck', { value: fc, enumerable: false });
  const projects = o.projects ?? defaultProjects();
  const bySid = new Map();
  const seenInos = new Set();
  for (const c of cands) {
    const sk = statKey(c.path);
    if (!sk) continue;
    if (seenInos.has(sk.key)) continue;   // another link of an inode already looked at: one inode, one decision
    seenInos.add(sk.key);
    const id = c.rec.sessionId ?? c.name.replace(/\.json$/, '');
    const title = c.rec.title ?? '';
    const d = decide(c.rec, fc, findTranscript(projects, c.rec), acct);
    const s = bySid.get(id) ?? { id, title, targets: [], spawn: false, ids: [], undated: false, format: false };
    bySid.set(id, s);
    if (d.undated) s.undated = true;
    if (!d.spawnForeign && !d.foreignIds.length) continue;
    // the repair edits only what it names: a record whose unedited round trip is not byte-identical is left alone, and said so up front
    if (!roundTrips(c.text)) { s.format = true; continue; }
    s.spawn ||= d.spawnForeign;
    for (const x of d.foreignIds) if (!s.ids.includes(x)) s.ids.push(x);
    s.targets.push({ path: c.path, name: c.name, org: c.f.org, key: sk.key, nlink: sk.nlink, links: linksOf(folders, c.name, sk.key), detach: d.spawnForeign, spawnId: d.spawnId, removeIds: d.foreignIds });
  }
  for (const s of bySid.values()) {
    if (s.targets.length) plan.flagged.push({ id: s.id, title: s.title, targets: s.targets, spawn: s.spawn, ids: s.ids });
    else if (s.format) plan.skipped.push({ id: s.id, title: s.title, reason: 'format' });
    else if (s.undated) plan.skipped.push({ id: s.id, title: s.title, reason: 'undated' });
  }
  return plan;
}

/* ------------------------------------------------------------------ repair (the app is stopped) */

/** Write bytes over a file in place: open r+, write at 0, truncate. The inode, and so every hard link, stays. */
export function overwriteInPlace(file, buf) {
  const fd = openSync(file, 'r+');
  try { writeSync(fd, buf, 0, buf.length, 0); ftruncateSync(fd, buf.length); try { fsyncSync(fd); } catch { /* best effort */ } } finally { closeSync(fd); }
}

const parseText = (text) => JSON.parse(text.replace(/^\uFEFF/, ''));

/** True when parsing and writing the record back (in its own format) gives the same text: the only kind of record the edit touches. */
function roundTrips(text) { try { return serializeJson(parseText(text), detectFormat(text)) === text; } catch { return false; } }

/**
 * One inode: back it up, edit it in place, check it. Never throws.
 * @returns {{status:'edited'|'nothing'|'skipped'|'failed', detail?:string}}
 */
function editTarget(t, o) {
  let raw;
  try {
    raw = readFileSync(t.path);
    const text = raw.toString('utf8');
    const fmt = detectFormat(text);
    const rec = parseText(text);
    // the edit may change only what it names: an unedited round trip that is not byte-identical would shift the format as well
    if (serializeJson(rec, fmt) !== text) return { status: 'skipped', detail: 'an unedited round trip is not byte-identical' };
    let changed = false;
    if (t.detach && liveSpawn(rec) && rec.remoteControlSpawn.ccrSessionId === t.spawnId) {
      rec.remoteControlSpawn = { ...rec.remoteControlSpawn, detachedAt: o.now };   // what the app's own detach writes
      changed = true;
    }
    if (t.removeIds.length && Array.isArray(rec.bridgeSessionIds)) {
      const keep = rec.bridgeSessionIds.filter((x) => !t.removeIds.includes(x));
      if (keep.length !== rec.bridgeSessionIds.length) { rec.bridgeSessionIds = keep; changed = true; }
    }
    if (!changed) return { status: 'nothing' };
    const before = statKey(t.path);
    mkdirSync(o.backupDir, { recursive: true });
    // a name space of its own ("spawn-"): the rc restore backs the same record up as <org8>-<name> in the same stamp folder, and neither may
    // replace the other (the first copy is the only one of the record as it was); never overwrite an existing file
    const base = `spawn-${t.org.slice(0, 8)}-${t.name}`;
    let backupFile = join(o.backupDir, base);
    for (let i = 2; ; i++) {
      if (!o.used.has(backupFile) && !existsSync(backupFile)) { try { copyFileSync(t.path, backupFile, FS.COPYFILE_EXCL); break; } catch (e) { if (e?.code !== 'EEXIST') throw e; } }
      backupFile = join(o.backupDir, `spawn-${t.org.slice(0, 8)}-${i}-${t.name}`);
      if (i > 50) return { status: 'failed', detail: 'no free backup name; nothing was changed' };
    }
    o.used.add(backupFile);
    if (!readFileSync(backupFile).equals(raw)) return { status: 'failed', detail: `the backup ${backupFile} does not match the record; nothing was changed` };
    if (!o.stopped()) return { status: 'failed', detail: `the app started; nothing was written (backup ${backupFile})` };
    const out = Buffer.from(serializeJson(rec, fmt), 'utf8');
    try { overwriteInPlace(t.path, out); }
    catch (e) {   // a write that threw may have left a partial record: put the backup bytes back
      let restored = 'restored from the backup';
      try { overwriteInPlace(t.path, raw); } catch (e2) { restored = `RESTORE FAILED (${e2.message}): copy ${backupFile} over ${t.path} by hand`; }
      return { status: 'failed', detail: `the write failed (${e?.message ?? e}); ${restored}` };
    }
    const problems = [];
    const after = statKey(t.path);
    if (!after || !before || after.key !== before.key) problems.push('inode changed');
    if (after && before && after.nlink !== before.nlink) problems.push(`link count changed ${before.nlink} -> ${after.nlink}`);
    for (const l of new Set([t.path, ...t.links])) {
      try {
        const buf = readFileSync(l);
        parseText(buf.toString('utf8'));   // valid JSON
        if (!buf.equals(out)) problems.push(`${l}: bytes differ from what was written`);
      } catch (e) { problems.push(`${l}: ${e.message}`); }
    }
    if (problems.length) {
      let restored = 'restored from the backup';
      try { overwriteInPlace(t.path, raw); } catch (e) { restored = `RESTORE FAILED (${e.message}): copy ${backupFile} over ${t.path} by hand`; }
      return { status: 'failed', detail: `${problems.join('; ')}; ${restored}` };
    }
    return { status: 'edited' };
  } catch (e) { return { status: 'failed', detail: String(e?.message ?? e) }; }
}

/**
 * Repair a plan. `o`: { now, stopped() (checked before every write; default: the app's lock marker is absent), log }.
 * @returns {{status:'ok'|'partial'|'refused_app_running', fixed:{id,title}[], failed:{id,title,detail}[], pending:{id,title}[], backupDir}}
 */
export function applySpawnFix(ctx, plan, o = {}) {
  const log = o.log ?? (() => {});
  const now = o.now ?? ctx.now();
  const stopped = o.stopped ?? (() => !lockfilePresent(ctx));
  const res = { status: 'ok', fixed: [], failed: [], pending: [], backupDir: null };
  if (!plan.flagged.length) return res;
  if (!stopped()) { res.status = 'refused_app_running'; res.pending = plan.flagged.map((s) => ({ id: s.id, title: s.title })); log('rc-spawn: refused, the app is not stopped'); return res; }
  const backupDir = accPath(ctx, 'rc-restore', 'backup', stamp(now));
  const used = new Set();
  let appStarted = false;
  for (const s of plan.flagged) {
    if (appStarted || !stopped()) { appStarted = true; res.status = 'partial'; res.pending.push({ id: s.id, title: s.title }); continue; }
    let bad = null; let edited = 0;
    for (const t of s.targets) {
      if (!stopped()) { appStarted = true; bad = 'the app started'; break; }
      const r = editTarget(t, { now, backupDir, used, stopped });
      if (r.status === 'failed' || r.status === 'skipped') { bad = r.detail ?? r.status; log(`rc-spawn: ${short(s.id)}: ${r.status}: ${r.detail}`); break; }
      if (r.status === 'edited') edited++;
    }
    if (appStarted) { res.status = 'partial'; res.pending.push({ id: s.id, title: s.title }); }
    else if (bad) { res.status = 'partial'; res.failed.push({ id: s.id, title: s.title, detail: bad }); }
    else if (edited) { res.fixed.push({ id: s.id, title: s.title }); if (res.backupDir === null) res.backupDir = backupDir; }   // none edited: it was already clean when read again
  }
  if (res.fixed.length) pruneBackups(ctx, now);
  return res;
}

/* ------------------------------------------------------------------ one pass (detect, and repair when asked) */

/** `rc-spawn: found N, fixed M (ids), pending P, skipped S (reasons)` (+ `, failed F` when not zero). */
export function spawnLine(r) {
  const fixed = r.fixed.length ? ` (${r.fixed.map((f) => short(f.id)).join(', ')})` : '';
  const why = {}; for (const s of r.skipped) why[s.reason] = (why[s.reason] ?? 0) + 1;
  const reasons = Object.entries(why).map(([k, n]) => `${k} ${n}`).join(', ');
  return `rc-spawn: found ${r.found}, fixed ${r.fixed.length}${fixed}, pending ${r.pending.length}, skipped ${r.skipped.length}${reasons ? ` (${reasons})` : ''}${r.failed.length ? `, failed ${r.failed.length}` : ''}`;
}

/**
 * Detect, and repair when `apply` is true and the app is stopped. No lock of its own (the account pass and the quit step hold accounts.lock;
 * `spawnFixStep` is the locked one). Mode 'off' does nothing at all. Never throws.
 * o: { apply, dryRun (never writes), spawnFix | settings, acct, now, projects, rcLog, stopped, log }
 * @returns {{mode, ran, apply, acct, scanned, found, fixed, failed, pending, skipped, status, backupDir}}
 *   found = flagged sessions; pending = flagged and not repaired (detect only, or the app runs)
 */
export function spawnFixCore(ctx, o = {}) {
  const mode = spawnFixMode(o);
  const apply = o.apply === true && o.dryRun !== true;
  const res = { mode, ran: false, apply, acct: null, scanned: 0, found: 0, fixed: [], failed: [], pending: [], skipped: [], status: 'ok', backupDir: null };
  if (mode === 'off') return res;
  try {
    const plan = spawnPlan(ctx, o);
    res.ran = true; res.acct = plan.acct; res.scanned = plan.scanned; res.found = plan.flagged.length; res.skipped = plan.skipped;
    if (!plan.flagged.length) { if (apply) plan.foreignCheck?.flush(); return res; }
    if (!apply) { res.pending = plan.flagged.map((s) => ({ id: s.id, title: s.title })); }
    else {
      plan.foreignCheck?.flush();   // a link first seen now is dated by when it was first seen (a cache; never on a read-only pass)
      const a = applySpawnFix(ctx, plan, { now: o.now, stopped: o.stopped, log: o.log });
      Object.assign(res, { status: a.status, fixed: a.fixed, failed: a.failed, pending: a.pending, backupDir: a.backupDir });
      if (a.fixed.length) recordFixed(ctx, a.fixed, o.now ?? ctx.now());
    }
    if (o.log && (res.found || res.failed.length)) o.log(spawnLine(res));   // not for skipped alone: an undated session never resolves, so it would log at every pass
  } catch (e) { res.status = 'failed'; o.log?.(`rc-spawn: failed ${e?.message ?? e}`); }
  return res;
}

/** The locked variant, for a caller that holds no lock (`accounts rc-spawn-fix`, the waiter's stop step). */
export async function spawnFixStep(ctx, o = {}) {
  if (o.apply !== true || o.dryRun === true) return spawnFixCore(ctx, o);
  const lock = await withAccountsLock(ctx, () => spawnFixCore(ctx, o));
  return lock.ok ? lock.value : { mode: spawnFixMode(o), ran: false, apply: true, reason: 'locked', acct: null, scanned: 0, found: 0, fixed: [], failed: [], pending: [], skipped: [], status: 'locked', backupDir: null };
}

/**
 * Detect and report only, for a caller that runs while the app does (the wake hook): at most one pass per `everyMs` (default 10 minutes, the
 * time of the last pass is kept in rc-spawn-look.json), and a log line only when something is flagged. Never writes a record. Never throws.
 * @returns {{ran:boolean, reason?:string, result?}}
 */
export function spawnLook(ctx, o = {}) {
  try {
    if (spawnFixMode(o) === 'off') return { ran: false, reason: 'off' };
    const now = o.now ?? ctx.now();
    const file = accPath(ctx, 'rc-spawn-look.json');
    const last = Number(readJson(file, null)?.at);
    if (Number.isFinite(last) && now - last >= 0 && now - last < (o.everyMs ?? 10 * 60 * 1000)) return { ran: false, reason: 'recent' };
    try { writeJsonAtomic(file, { v: 1, at: now }); } catch { /* the throttle is a courtesy */ }
    const r = spawnFixCore(ctx, { ...o, log: undefined, apply: false });
    if (o.log && r.pending.length) o.log(`${spawnLine(r)}; fixed at the next quit of Claude or account switch`);
    return { ran: true, result: r };
  } catch { return { ran: false, reason: 'failed' }; }
}

/** What `status` shows: the sessions fixed earlier (rc-spawn.json) and the ones flagged now. */
function recordFixed(ctx, fixed, now) {
  try {
    const cur = readJson(spawnFile(ctx), null);
    const list = Array.isArray(cur?.fixed) ? cur.fixed : [];
    for (const f of fixed) list.push({ id: f.id, title: f.title, at: new Date(now).toISOString() });
    writeJsonAtomic(spawnFile(ctx), { v: 1, fixed: list.slice(-FIXED_KEEP) });
  } catch { /* a status note: never worth failing a repair */ }
}

/**
 * Read-only facts for `accounts status`: { mode, acct, pending: [{id,title}], skipped: number, fixed: [{id,title,at}] }. Never throws.
 * Mode 'off' still lists what is flagged (it is only the automatic repair that is off).
 */
export function spawnStatus(ctx, o = {}) {
  const out = { mode: spawnFixMode(o), acct: null, pending: [], skipped: 0, fixed: [] };
  try {
    const f = readJson(spawnFile(ctx), null)?.fixed;
    if (Array.isArray(f)) out.fixed = f.slice(-5);
    const plan = spawnPlan(ctx, o);
    out.acct = plan.acct;
    out.pending = plan.flagged.map((s) => ({ id: s.id, title: s.title }));
    out.skipped = plan.skipped.length;
  } catch { /* a status line is never worth failing the command */ }
  return out;
}
