/**
 * rcrestore.mjs - Remote Control (RC) restore after a restart of the Claude desktop app (0.5.4).
 *
 * After any app restart RC is off for every Code session, and after an account switch the CLI reattaches to links minted in a
 * cross-account fallback (random names, renames never reach them). Three steps, all driven by the singleton watcher (waiter.mjs) or a hook:
 *
 *   1. RELINK (app closed)       a transcript whose LAST `bridge-session` entry carries `noHistoryBackfill:true` or was minted under another
 *                                account (rclinks.mjs: the ledger and the switch history; never the `ownerAccountUuid` stamp, which is the
 *                                CLI's cached identity) gets the CLI's own clearing line appended (after a backup). The next connect then
 *                                mints a fresh link named with the session title. Of a transcript only bridge-session lines are read, plus
 *                                (to date a link) the `timestamp` token of the lines next to the first one that names it, and its mtime.
 *   2. FREE RESTORE (app closed) up to 4 of the most recent eligible records get `remoteControlLiveAtUpdateQuit {at, accountId}` and
 *                                `remoteControlAutoEligible: true`, the two fields the app's own launch pass reads (the one it uses after
 *                                a quit-for-update): it warms those sessions and reconnects RC with no model turn. `at` must be younger than
 *                                an hour when the app starts, so the watcher refreshes it while Claude stays closed. `interruptedByQuitAt`
 *                                is never written (it would resume interrupted turns). The edit is in place, so hard links survive.
 *   3. WAKE (app running)        the first real prompt of an interactive session after a restart gets a one-time instruction (UserPromptSubmit
 *                                hook) that tells its agent to send a no-op message to every other session that is still off.
 *   4. LIVE RELINK (app running) step 1 for one session at a time, while the app runs: only a session whose CLI is not running, quiet for
 *                                2 minutes and not mid-turn (liveRelinkPass). Run by the wake hook, the watcher and an account switch.
 *
 * Everything here is plain file work with injected paths; the callers decide when the app is stopped.
 */

import {
  readFileSync, readdirSync, existsSync, mkdirSync, copyFileSync, appendFileSync, openSync, readSync, closeSync,
  fstatSync, writeSync, ftruncateSync, fsyncSync, statSync, unlinkSync, rmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { RC_DEFAULTS, rcSettings } from '../config.mjs';
import { accPath, readJson, writeJsonAtomic, detectFormat, serializeJson, withAccountsLock } from './state.mjs';
import { listFolders, RECORD } from './folders.mjs';
import { lockfilePresent, lockStartedAtMs, readSignedIn, appState } from './appstate.mjs';
import { makeForeign } from './rclinks.mjs';
import { liveCliIds } from './proc.mjs';
import { spawnFixCore, spawnFixMode, spawnPlan, spawnFixStep } from './rcspawn.mjs';

export const DAY_MS = 24 * 3600 * 1000;
/** The app's launch pass accepts a marker younger than this (qz = 36e5 in the app bundle). */
export const MARKER_MAX_AGE_MS = 60 * 60 * 1000;
/** While Claude stays closed the marker is rewritten this often, so it is still young when a late relaunch happens. */
export const MARKER_REFRESH_MS = 20 * 60 * 1000;
/** A marker older than this would be rejected by the app: writing it again is a new restore, not a refresh. */
export const MARKER_FRESH_MS = 55 * 60 * 1000;
/** The app's launch pass restores at most this many sessions (GrowthBook default, sorted by last activity). */
export const MAX_RESTORE = 4;
export const BACKUP_KEEP_MS = 14 * DAY_MS;

export { RC_DEFAULTS, rcSettings };   // the settings live in config.mjs

/** `%LOCALAPPDATA%\Claude\logs\main.log` on Windows (the app writes its log there, not under the roaming folder). */
export function defaultAppLog(platform = process.platform, env = process.env) {
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Claude', 'logs', 'main.log');
  if (platform === 'darwin') return join(homedir(), 'Library', 'Logs', 'Claude', 'main.log');
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Claude', 'logs', 'main.log');
}
export const defaultProjects = () => join(homedir(), '.claude', 'projects');

const msOf = (v) => (typeof v === 'number' ? v : Date.parse(v) || 0);

/* ------------------------------------------------------------------ records and transcripts */

/** The records of one account (every org folder), parsed: [{path, name, file, rec, activity}]. Unparseable files are skipped. */
export function accountRecords(ctx, acct, { sinceMs = 0 } = {}) {
  const out = [];
  if (!ctx.store || !acct) return out;
  for (const f of listFolders(ctx.store)) {
    if (f.acct !== acct) continue;
    let names; try { names = readdirSync(f.path); } catch { continue; }
    for (const name of names) {
      if (!RECORD.test(name)) continue;
      const path = join(f.path, name);
      let rec; try { rec = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); } catch { continue; }
      if (!rec || typeof rec !== 'object') continue;
      const activity = msOf(rec.lastActivityAt);
      if (activity < sinceMs) continue;
      out.push({ path, name, folder: f, rec, activity });
    }
  }
  return out;
}

const SAFE_ID = /^[0-9a-f-]{36}$/i;

/** `<projects>/<project key>/<cliSessionId>.jsonl`: the derived key first, then every project folder. */
export function findTranscript(projects, rec) {
  const id = rec?.cliSessionId;
  if (!SAFE_ID.test(id ?? '')) return null;
  const key = typeof rec.cwd === 'string' ? rec.cwd.replace(/[^a-zA-Z0-9]/g, '-') : null;
  if (key) { const p = join(projects, key, `${id}.jsonl`); if (existsSync(p)) return p; }
  let dirs; try { dirs = readdirSync(projects); } catch { return null; }
  for (const d of dirs) { const p = join(projects, d, `${id}.jsonl`); if (existsSync(p)) return p; }
  return null;
}

const BRIDGE_MARK = Buffer.from('"type":"bridge-session"');
const CHUNK = 256 * 1024;

/**
 * The LAST `{"type":"bridge-session", ...}` entry of a transcript, or null. Reads the file backwards in blocks and decodes only the
 * line that holds the marker; no other line is ever decoded or parsed (the CLI re-appends the entry every turn, so it is near the end).
 */
export function lastBridgeEntry(file) {
  let fd;
  try { fd = openSync(file, 'r'); } catch { return null; }
  try {
    let pos = fstatSync(fd).size;
    let carry = Buffer.alloc(0);
    while (pos > 0) {
      const n = Math.min(CHUNK, pos); pos -= n;
      const b = Buffer.alloc(n); readSync(fd, b, 0, n, pos);
      const data = carry.length ? Buffer.concat([b, carry]) : b;
      let end = data.length;
      let unresolved = false;
      for (;;) {
        const i = end > 0 ? data.lastIndexOf(BRIDGE_MARK, end - 1) : -1;
        if (i < 0) break;
        const ls = data.lastIndexOf(10, i) + 1;
        if (ls === 0 && pos > 0) { unresolved = true; break; }          // the line starts in an earlier block
        let le = data.indexOf(10, i); if (le < 0) le = data.length;
        try { const o = JSON.parse(data.subarray(ls, le).toString('utf8')); if (o && o.type === 'bridge-session') return o; } catch { /* a partial line */ }
        end = ls > 0 ? ls - 1 : 0;
      }
      if (unresolved) { carry = data; continue; }
      const nl = data.indexOf(10);
      carry = nl < 0 ? data : data.subarray(0, nl);                      // the head of a line that began in an earlier block
    }
    return null;
  } finally { try { closeSync(fd); } catch { /* ignore */ } }
}

/**
 * Why does this saved link need clearing? 'noHistoryBackfill' (a random-name bounce link), 'foreign' (minted under another account, per
 * `foreign(bridgeSessionId)`, which comes from the link ledger and the switch history), or null. A link that is already cleared (empty
 * id) needs nothing. The entry's `ownerAccountUuid` is never read: the CLI stamps it from its own cached identity, so on a machine that
 * switched accounts every link carries the old account's uuid, healthy ones included.
 */
export function relinkReason(entry, foreign = () => false) {
  if (!entry || !entry.bridgeSessionId) return null;
  if (entry.noHistoryBackfill === true) return 'noHistoryBackfill';
  return foreign(entry.bridgeSessionId) === true ? 'foreign' : null;
}

export function needsRelink(entry, foreign = () => false) {
  return relinkReason(entry, foreign) !== null;
}

/* ------------------------------------------------------------------ eligibility and the scan */

const RESTORE_SCHEMA = 1;

/** Eligible for the app's launch restore: this account's folder, not archived, local, resumable, not a scheduled task, RC was on before. */
export function eligible(rec) {
  if (!rec || rec.isArchived === true) return false;
  if (rec.movedToCloud || (rec.backend && rec.backend.kind && rec.backend.kind !== 'local')) return false;
  if (!rec.cliSessionId) return false;
  if (rec.scheduledTaskId) return false;
  if (rec.remoteControlUserEnabled === false) return false;           // the user turned it off: never switch it back on
  return rec.remoteControlUserEnabled === true || (Array.isArray(rec.bridgeSessionIds) && rec.bridgeSessionIds.length > 0);
}

/** A marker the app would accept now. */
export function markerAge(rec, acct, now) {
  const m = rec?.remoteControlLiveAtUpdateQuit;
  if (!m || typeof m !== 'object' || !Number.isFinite(m.at) || m.at > now || m.accountId !== acct) return null;
  return now - m.at;
}

/** A linked account keeps each conversation once per org folder (hard links): one conversation, one entry (newest activity first), every path kept. */
export function bySession(recs) {
  const map = new Map();
  for (const r of [...recs].sort((a, b) => b.activity - a.activity)) {
    const k = r.rec.sessionId ?? r.path;
    const g = map.get(k);
    if (g) g.files.push(r.path); else map.set(k, { ...r, files: [r.path] });
  }
  return [...map.values()];
}

/**
 * Read-only plan: what the step would do now.
 * @returns {{acct, records:number, recent:number, relink:object[], targets:object[], needMarks:object[], noTranscript:number}}
 */
export function rcPlan(ctx, o = {}) {
  const acct = (o.acct ?? readSignedIn(ctx.userData)) || null;
  const now = o.now ?? ctx.now();
  const days = o.days ?? RC_DEFAULTS.days;
  const plan = { acct, records: 0, recent: 0, relink: [], targets: [], needMarks: [], noTranscript: 0 };
  if (!acct) return plan;
  const recs = accountRecords(ctx, acct);
  plan.records = recs.length;
  const recent = bySession(recs.filter((x) => x.activity >= now - days * DAY_MS));
  plan.recent = recent.length;
  const projects = o.projects ?? defaultProjects();
  const fc = o.foreignCheck ?? makeForeign(ctx, acct, o);
  Object.defineProperty(plan, 'foreignCheck', { value: fc, enumerable: false });   // applyPlan asks it again right before each write
  for (const r of recent) {
    const tp = findTranscript(projects, r.rec);
    if (!tp) { plan.noTranscript++; continue; }
    const b = lastBridgeEntry(tp);
    const why = relinkReason(b, (id) => fc.foreign(id, tp));
    if (why) plan.relink.push({ file: r.path, id: r.rec.sessionId, cliSessionId: r.rec.cliSessionId, title: r.rec.title ?? '', transcript: tp, link: b.bridgeSessionId, why });
  }
  if (o.persist) fc.flush();   // only a pass that writes keeps the ledger: a plan read (dry run, logon check) changes nothing on disk
  const elig = recent.filter((r) => eligible(r.rec));
  const ranked = [...elig.filter((r) => r.rec.remoteControlUserEnabled === true), ...elig.filter((r) => r.rec.remoteControlUserEnabled !== true)];   // RC switched on for sure first, then link history only
  plan.targets = ranked.slice(0, MAX_RESTORE)
    .map((r) => ({ file: r.path, files: r.files, name: r.name, org: r.folder.org, id: r.rec.sessionId, title: r.rec.title ?? '', age: markerAge(r.rec, acct, now), autoEligible: r.rec.remoteControlAutoEligible === true }));
  plan.needMarks = plan.targets.filter((t) => t.age === null || t.age > MARKER_FRESH_MS || !t.autoEligible);
  return plan;
}

/* ------------------------------------------------------------------ writes (the app is stopped) */

export const stamp = (now) => new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/** Delete backup folders older than BACKUP_KEEP_MS. Never throws. */
export function pruneBackups(ctx, now = ctx.now()) {
  const root = accPath(ctx, 'rc-restore', 'backup');
  let names; try { names = readdirSync(root); } catch { return 0; }
  let n = 0;
  for (const d of names) {
    try {
      const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(d);   // the folder name is the stamp of the run; the clock of the run, not the file system's
      const at = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : statSync(join(root, d)).mtimeMs;
      if (now - at > BACKUP_KEEP_MS) { rmSync(join(root, d), { recursive: true, force: true }); n++; }
    } catch { /* ignore */ }
  }
  return n;
}

/** Append the CLI's own clearing line (what its `clearBridgeSession` writes), keeping the file's newline style. */
export function appendClearLine(file, cliSessionId) {
  const fd = openSync(file, 'r');
  let tail = '';
  let size = 0;
  try {
    size = fstatSync(fd).size;
    const len = Math.min(size, 65536); const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    tail = buf.toString('utf8');
  } finally { closeSync(fd); }
  const nl = tail.includes('\r\n') ? '\r\n' : '\n';
  const endsNl = size === 0 || tail.endsWith('\n');
  const line = `{"type":"bridge-session","sessionId":"${cliSessionId}","bridgeSessionId":"","lastSequenceNum":0}`;
  appendFileSync(file, (endsNl ? '' : nl) + line + nl);
  return line;
}

/**
 * Edit a record file in place (open r+, write, truncate): the inode stays, so the hard links the account link made survive.
 * The format (indent, newline, BOM) is kept. Not atomic, so the callers only use it while the app is stopped, after a backup.
 */
export function writeRecordInPlace(file, mutate) {
  const text = readFileSync(file, 'utf8');
  const fmt = detectFormat(text);
  const obj = JSON.parse(fmt.bom ? text.slice(1) : text);
  mutate(obj);
  const out = serializeJson(obj, fmt);
  const fd = openSync(file, 'r+');
  try { writeSync(fd, out, 0); ftruncateSync(fd, Buffer.byteLength(out)); try { fsyncSync(fd); } catch { /* best effort */ } } finally { closeSync(fd); }
}

/**
 * The quit-time step: relink, then free restore, for a plan. `o`: { acct, now, stopped() (the app is still stopped; checked before every
 * write), log(line), onStart(info) (fires once, before the first write, with the counts that are about to change) }.
 * @returns {{status, relinked, relinkFailed, marked, refreshed, skipped, acct}}  status ok | partial | refused_app_running
 */
export function applyPlan(ctx, plan, o = {}) {
  const log = o.log ?? (() => {});
  const now = o.now ?? ctx.now();
  const stopped = o.stopped ?? (() => !lockfilePresent(ctx));
  const res = { status: 'ok', acct: plan.acct, relinked: 0, relinkFailed: 0, marked: 0, refreshed: 0, skipped: 0 };
  const freshOnly = plan.relink.length === 0 && plan.needMarks.length === 0;
  const due = plan.targets.filter((t) => t.age === null || t.age >= (o.refreshMs ?? MARKER_REFRESH_MS) || !t.autoEligible);
  if (!plan.relink.length && !due.length) return res;
  if (!stopped()) { res.status = 'refused_app_running'; log('rc-restore: refused, the app is not stopped'); return res; }
  if (!freshOnly) { try { o.onStart?.({ relink: plan.relink.length, marks: plan.needMarks.length }); } catch { /* the notice is never worth failing the step */ } }
  const backupDir = accPath(ctx, 'rc-restore', 'backup', stamp(now));
  const ensureBackupDir = () => mkdirSync(backupDir, { recursive: true });

  for (const a of plan.relink) {
    if (!stopped()) { res.status = 'partial'; res.skipped++; log(`rc-restore: ${a.id}: not cleared, the app started`); break; }
    try {
      const again = lastBridgeEntry(a.transcript);                     // verified right before the write
      if (!needsRelink(again, (id) => plan.foreignCheck?.foreign(id, a.transcript) === true)) { res.skipped++; continue; }
      ensureBackupDir();
      copyFileSync(a.transcript, join(backupDir, `${a.cliSessionId}.jsonl`));
      appendClearLine(a.transcript, a.cliSessionId);
      res.relinked++;
      log(`rc-restore: ${a.id} (${a.title}): cleared ${a.link}; backup ${backupDir}`);
    } catch (e) { res.relinkFailed++; res.status = 'partial'; log(`rc-restore: ${a.id}: relink FAILED ${e?.message ?? e}`); }
  }

  for (const t of due) {
    if (!stopped()) { res.status = 'partial'; res.skipped++; log(`rc-restore: ${t.id}: no marker, the app started`); break; }
    try {
      const first = t.age === null || t.age > MARKER_FRESH_MS || !t.autoEligible;
      if (first) { ensureBackupDir(); copyFileSync(t.file, join(backupDir, `${t.org.slice(0, 8)}-${t.name}`)); }
      for (const file of t.files ?? [t.file]) {   // every folder copy of the conversation (one inode when hard-linked: the second write changes nothing)
        writeRecordInPlace(file, (rec) => {
          rec.remoteControlLiveAtUpdateQuit = { at: now, accountId: plan.acct };
          rec.remoteControlAutoEligible = true;
        });
      }
      if (first) res.marked++; else res.refreshed++;
    } catch (e) { res.status = 'partial'; res.skipped++; log(`rc-restore: ${t.id}: marker FAILED ${e?.message ?? e}`); }
  }
  pruneBackups(ctx, now);
  return res;
}

/**
 * plan + apply under accounts.lock. `{ran:false, reason}` when there is nothing to do or the lock is busy.
 * @returns {Promise<{ran:boolean, reason?:string, plan?, res?}>}
 */
export async function rcQuitStep(ctx, o = {}) {
  const lock = await withAccountsLock(ctx, () => {
    const plan = rcPlan(ctx, { ...o, persist: true });
    if (!plan.acct) return { ran: false, reason: 'no-account' };
    // sessions started from claude.ai under another account: detached at this stop (rcspawn.mjs; not gated by rcRestore.enabled, only by spawnFix)
    const spawn = spawnFixCore(ctx, { ...o, acct: plan.acct, apply: true });
    if (!plan.relink.length) clearRelinkOwed(ctx);
    if (!plan.relink.length && !plan.targets.length) return { ran: false, reason: 'nothing-to-do', plan, spawn };
    const res = applyPlan(ctx, plan, o);
    if (res.status === 'ok') clearRelinkOwed(ctx);   // every relink of the plan is done (or no longer needed): nothing is owed
    writeJsonAtomic(accPath(ctx, 'rc-restore.json'), {
      v: RESTORE_SCHEMA, at: new Date(o.now ?? ctx.now()).toISOString(), acct: plan.acct,
      relinked: res.relinked, marked: res.marked, refreshed: res.refreshed, status: res.status,
      targets: plan.targets.map((t) => t.id),
    });
    return { ran: true, plan, res, spawn };
  });
  if (!lock.ok) return { ran: false, reason: 'locked' };
  return lock.value;
}

/* ------------------------------------------------------------------ the logon-time relink (the app quit with Windows) */

/**
 * `accounts rc-restore --if-app-stopped`, run by the "At log on" task (logontask.mjs) before Claude starts. When the app is stopped and a
 * relink is owed per rcPlan, it runs the same quit step the waiter runs (rcQuitStep: relink, then free restore, each write checked against
 * the app's lock marker and made after a backup). When the app is running, or starts mid-way, nothing is written past that point and the
 * relink stays owed. Nothing owed: returns quietly, no log line.
 * 0.5.9: the foreign Remote Control spawn fix (rcspawn.mjs) is owed work too, and is not gated by `rcRestore.enabled`, only by
 * `rcRestore.spawnFix`: with rc restore off it runs alone (spawnFixStep); with it on, rcQuitStep runs it after the relink planning.
 * o: { settings (rcSettings), platform, readApp(): the appState object (tests), tries/retryMs (an unknown process probe is retried), sleep,
 *      log(line), + the options of rcPlan / rcQuitStep: acct, now, days, projects, stopped; spawnFix overrides settings.spawnFix }
 * @returns {Promise<{ran:boolean, reason?:string, res?, plan?, spawn?}>}
 *   spawn: the spawnFixCore / spawnFixStep result (found, fixed, failed, pending, skipped) when the spawn fix looked at the store
 *   reason: platform | disabled (rc restore and the spawn fix are both off) | no-account | app-running | app-unknown | nothing-owed | locked
 */
export async function rcLogonStep(ctx, o = {}) {
  const log = o.log ?? (() => {});
  if ((o.platform ?? ctx.platform ?? process.platform) !== 'win32') return { ran: false, reason: 'platform' };
  const rcOn = !(o.settings && !o.settings.enabled);
  const spawnOn = spawnFixMode(o) !== 'off';   // the spawn fix (rcspawn.mjs) is not gated by rcRestore.enabled
  if (!rcOn && !spawnOn) return { ran: false, reason: 'disabled' };
  if (!ctx.store || !ctx.userData) return { ran: false, reason: 'no-store' };
  const po = { ...o, days: o.days ?? o.settings?.days };   // rcRestore.days is the window, as for the waiter's quit step
  const plan = rcOn ? rcPlan(ctx, po) : { acct: (o.acct ?? readSignedIn(ctx.userData)) || null, relink: [] };   // read only, and before the process probe: with nothing owed (the usual logon) no PowerShell is started
  if (!plan.acct) return { ran: false, reason: 'no-account' };
  const spawnOwed = spawnOn && spawnPlan(ctx, { ...po, acct: plan.acct }).flagged.length > 0;
  if (!plan.relink.length && !spawnOwed) { clearRelinkOwed(ctx); return { ran: false, reason: 'nothing-owed', plan }; }
  const readApp = o.readApp ?? (() => appState({ ctx, probeProcesses: true, now: ctx.now() }));
  const tries = Math.max(1, o.tries ?? 3);
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let app = null;
  for (let i = 0; i < tries; i++) {   // the process probe can fail while the machine is still busy logging on: unknown is retried, running is not
    app = readApp();
    if (app.fullAllowed || app.running) break;
    if (i + 1 < tries) await sleep(o.retryMs ?? 5000);
  }
  if (!app.fullAllowed) {
    const reason = app.running ? 'app-running' : 'app-unknown';
    log(`rc-restore: logon relink skipped, ${app.running ? 'the app is running' : 'the app state is unknown'}`);
    return { ran: false, reason };
  }
  const detail = [];   // the per-session lines of the quit step: one summary line is logged, the details only when the step did not finish
  const stepLog = (l) => { if (l.startsWith('rc-spawn:')) log(l); else detail.push(l); };   // the spawn fix has its own line
  if (!rcOn) {   // rc restore is off: only the spawn fix is owed (it takes the lock itself and checks the lock marker before every write)
    const spawn = await spawnFixStep(ctx, { ...po, acct: plan.acct, apply: true, log: stepLog });
    return { ran: spawn.ran, reason: spawn.ran ? undefined : (spawn.reason ?? 'nothing-owed'), spawn };
  }
  const r = await rcQuitStep(ctx, { ...po, log: stepLog });   // re-plans under accounts.lock and checks the lock marker before every write
  if (!r.ran) {
    if (r.reason === 'locked') log('rc-restore: logon relink skipped, another pass holds the accounts lock');
    return { ran: false, reason: r.reason ?? 'nothing-owed', ...(r.spawn ? { spawn: r.spawn } : {}) };
  }
  const x = r.res;
  log(`rc-restore: logon relink: ${x.relinked} relinked, ${x.marked} marked, ${x.refreshed} refreshed, status ${x.status}${x.status === 'refused_app_running' ? ' (the app started)' : ''}`);
  if (x.status !== 'ok') for (const l of detail) log(l);
  return r;
}

/* ------------------------------------------------------------------ a relink that stayed owed (the app quit with Windows) */

/**
 * When Windows restarts or shuts down, the app quits with the OS and the waiter cannot run its quit step (new processes fail to start
 * while the session ends), so a relink that rcPlan selects stays owed and the sessions reconnect on their old random-name links.
 * Only an ordinary app quit (the tray icon) gives the waiter the time. The record says so; the wake instruction tells the user once.
 */
export const RELINK_OWED_TEXT = 'Your Remote Control session names were not restored after that restart: quit Claude once from the tray icon (not a Windows restart) and reopen it to get them back.';
export const relinkOwedFile = (ctx) => accPath(ctx, 'rc-relink-owed.json');

/** The relink is settled (done, or no longer needed): drop the record. Never throws. */
export function clearRelinkOwed(ctx) {
  try { unlinkSync(relinkOwedFile(ctx)); } catch { /* none */ }
}

/**
 * Did a restore pass run for the stop that ended before this app run? rc-restore.json is rewritten by every quit step that did work
 * (the waiter's marker refresh too, every 20 minutes while Claude is closed), so its stamp is close to the launch when one ran. A
 * stamp older than the life of a marker (an hour) belongs to an earlier stop.
 */
export function restorePassRanBefore(ctx, startedAtMs) {
  const at = Date.parse(readJson(accPath(ctx, 'rc-restore.json'), null)?.at ?? '');
  return Number.isFinite(at) && at <= startedAtMs + 60_000 && startedAtMs - at <= MARKER_MAX_AGE_MS;
}

/**
 * Called once per app run, by the session that claims the wake: are relinks owed because no restore pass ran for the last stop? If
 * so the record is written and `{count}` returned; otherwise the record (if any) is dropped and null returned. Never throws.
 * o: { startedAt (the app run), acct, now, days, projects }
 */
export function checkRelinkOwed(ctx, o = {}) {
  try {
    if (restorePassRanBefore(ctx, o.startedAt)) { clearRelinkOwed(ctx); return null; }
    const plan = rcPlan(ctx, { acct: o.acct, now: o.now, days: o.days, projects: o.projects });
    if (!plan.relink.length) { clearRelinkOwed(ctx); return null; }
    try { writeJsonAtomic(relinkOwedFile(ctx), { v: 1, at: new Date(o.now ?? ctx.now()).toISOString(), startedAt: o.startedAt, acct: plan.acct, count: plan.relink.length, notified: true }); } catch { /* the notice matters more than the record */ }
    return { count: plan.relink.length };
  } catch { return null; }
}

/** The words of the balloons (no em dashes; counts, not ids). */
export const RC_START_TEXT = 'Preparing Remote Control for the next start of Claude.';
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
export function rcDoneText(res) {
  const parts = [];
  if (res.relinked) parts.push(`${plural(res.relinked, 'stale link', 'stale links')} reset`);
  if (res.marked) parts.push(`${plural(res.marked, 'session', 'sessions')} will reconnect when Claude opens`);
  if (!parts.length) return 'Remote Control is ready for the next start of Claude.';
  return `Remote Control: ${parts.join(', ')}.`;
}

/* ------------------------------------------------------------------ what the app did at the next launch */

const LAUNCH_LINE = /Remote Control restore after update|trigger=launch_remote_control_restore/i;
const LOG_TS = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/;

/**
 * The lines of the app's main log, written at or after `sinceMs`, that tell what its launch restore did (the pass summary with its
 * `outcome`: ran, gate_off, flags_not_fetched, ..., and the per-session auto-enable verdicts). Reads the last 3 MB only.
 * @returns {{found:boolean, outcome:string|null, lines:string[]}}
 */
export function readLaunchOutcome(logFile, sinceMs) {
  const out = { found: false, outcome: null, lines: [] };
  let fd; try { fd = openSync(logFile, 'r'); } catch { return out; }
  try {
    const size = fstatSync(fd).size; const len = Math.min(size, 3 * 1024 * 1024);
    const buf = Buffer.alloc(len); readSync(fd, buf, 0, len, size - len);
    for (const line of buf.toString('utf8').split(/\r?\n/)) {
      if (!LAUNCH_LINE.test(line)) continue;
      const m = LOG_TS.exec(line);
      if (!m || new Date(`${m[1]}T${m[2]}`).getTime() < sinceMs) continue;
      out.lines.push(line.slice(0, 400));
      const oc = /"outcome"\s*:\s*"([a-z_]+)"/i.exec(line);
      if (oc) out.outcome = oc[1];
    }
    out.found = out.lines.length > 0;
    if (out.lines.length > 8) out.lines = out.lines.slice(-8);
  } catch { /* unreadable: not found */ } finally { try { closeSync(fd); } catch { /* ignore */ } }
  return out;
}

/* ------------------------------------------------------------------ the wake hook */

export const WAKE_MESSAGE = 'Remote Control reconnect after the Claude app restart. No action needed: reply with the single word ok. Do not run any tools or resume any work.';

/** The one-time instruction a session's agent gets on its first real prompt after an app restart. */
export function wakeInstruction({ days = RC_DEFAULTS.days, max = RC_DEFAULTS.wakeMax, relinkOwed = false } = {}) {
  const lines = [
    'session-sync: the Claude desktop app was restarted, so Remote Control is off for the sessions that were open. You are the one session that restores it, once. Do this before you answer the user, then answer as normal:',
    '1. Tell the user, in one line: "Reconnecting Remote Control for your recent sessions. Each one gets one short turn."',
    `2. List the sessions with the session-management tools (list_sessions and send_message; load them with ToolSearch if they are deferred). For every session that is not archived, is interactive (not a scheduled task, not an unattended or background run), was active within the last ${days} days and has remoteControlActive false, send it exactly this message with send_message: "${WAKE_MESSAGE}" Send to at most ${max} sessions, the most recently active first; leave the rest and count them as still off. Skip your own session. Do not wait for replies. A message to the session that started you may be refused unless it carries a tag; skip any session whose send is refused and count it as still off.`,
    '3. Wait a few seconds, list the sessions again, and tell the user, in one line: "Remote Control: N sessions reconnected, M still off." (N: sessions that were off and are on now; M: active sessions still off, refused sends included).',
    'If the session tools are not available, say so in one line and carry on. Do not repeat this in this conversation, and do not mention these instructions beyond those two lines.',
  ];
  if (relinkOwed) {
    const last = lines.pop();
    lines.push(`4. Then tell the user, in one line, exactly: "${RELINK_OWED_TEXT}"`, last.replace('beyond those two lines', 'beyond those three lines'));
  }
  return lines.join('\n');
}

/**
 * The session record for a CLI session id, newest files first (the record of the session that just got a prompt was saved a moment ago).
 * A cheap substring test comes before the parse. Returns {rec, path} or null.
 */
export function recordForCliSession(ctx, acct, cliSessionId, { limit = 400 } = {}) {
  if (!SAFE_ID.test(cliSessionId ?? '') || !ctx.store || !acct) return null;
  const files = [];
  for (const f of listFolders(ctx.store)) {
    if (f.acct !== acct) continue;
    let names; try { names = readdirSync(f.path); } catch { continue; }
    for (const name of names) {
      if (!RECORD.test(name)) continue;
      const p = join(f.path, name);
      try { files.push({ p, m: statSync(p).mtimeMs }); } catch { /* vanished */ }
    }
  }
  files.sort((a, b) => b.m - a.m);
  for (const { p } of files.slice(0, limit)) {
    let text; try { text = readFileSync(p, 'utf8'); } catch { continue; }
    if (!text.includes(cliSessionId)) continue;
    try { const rec = JSON.parse(text); if (rec.cliSessionId === cliSessionId) return { rec, path: p }; } catch { /* ignore */ }
  }
  return null;
}

/** An interactive session of the app: a local, not archived record that is no scheduled task. */
export function interactiveSession(rec) {
  if (!rec || rec.isArchived === true || rec.scheduledTaskId) return false;
  if (rec.movedToCloud || (rec.backend && rec.backend.kind && rec.backend.kind !== 'local')) return false;
  return true;
}

/** The very first claim on a machine, made by an app run older than this, is a baseline: the plugin was installed into a long-running app, not after a restart. */
export const WAKE_BASELINE_MS = 6 * 3600 * 1000;

export const wakeClaimFile = (ctx, startedAtMs) => accPath(ctx, `rc-wake-${startedAtMs}`);

/**
 * Should this prompt carry the wake instruction? Claimed with an exclusive create keyed to the app run (the creation time of the
 * lock marker), so exactly one session acts per restart. The claim is taken only by a session that qualifies: a scheduled task or an
 * unattended run that happens to prompt first must not use it up.
 * The claiming prompt also checks, once, whether a relink stayed owed (checkRelinkOwed); if so the instruction carries one more line for
 * the user (RELINK_OWED_TEXT). The check is not on the fast path: every later prompt returns at the claim.
 * o: { settings, sessionId, platform, now, projects (the transcripts folder, tests) }
 * @returns {{act:boolean, reason:string, text?:string, relinkOwed?:number}}
 */
export function decideWake(ctx, o = {}) {
  const platform = o.platform ?? ctx.platform ?? process.platform;
  const s = o.settings ?? RC_DEFAULTS;
  if (platform !== 'win32') return { act: false, reason: 'platform' };
  if (!s.enabled || !s.wake) return { act: false, reason: 'disabled' };
  if (!ctx.store || !ctx.userData) return { act: false, reason: 'no-store' };
  if (!lockfilePresent(ctx)) return { act: false, reason: 'app-not-running' };
  const startedAt = lockStartedAtMs(ctx);
  if (!startedAt) return { act: false, reason: 'no-latch' };
  const claim = wakeClaimFile(ctx, startedAt);
  if (existsSync(claim)) return { act: false, reason: 'claimed' };
  const acct = readSignedIn(ctx.userData);
  if (!acct) return { act: false, reason: 'no-account' };
  const found = recordForCliSession(ctx, acct, o.sessionId);
  if (!found) return { act: false, reason: 'no-record' };
  if (!interactiveSession(found.rec)) return { act: false, reason: 'not-interactive' };
  const now = o.now ?? ctx.now();
  let first = true; try { first = !readdirSync(ctx.acc).some((n) => /^rc-wake-\d+$/.test(n)); } catch { /* no folder yet */ }
  try { mkdirSync(ctx.acc, { recursive: true }); closeSync(openSync(claim, 'wx')); } catch { return { act: false, reason: 'claimed' }; }
  try {   // keep the last few markers only
    const olds = readdirSync(ctx.acc).filter((n) => /^rc-wake-\d+$/.test(n) && n !== basename(claim)).sort();
    for (const n of olds.slice(0, Math.max(0, olds.length - 4))) { try { unlinkSync(join(ctx.acc, n)); } catch { /* ignore */ } }
  } catch { /* ignore */ }
  if (first && now - startedAt > WAKE_BASELINE_MS) return { act: false, reason: 'baseline' };
  // once per app run (this claim): are relinks owed because the last stop was the OS ending the session, not an app quit?
  const owed = checkRelinkOwed(ctx, { startedAt, acct, now, days: s.days, projects: o.projects });
  return { act: true, reason: 'claimed-now', text: wakeInstruction({ days: s.days, max: s.wakeMax, relinkOwed: !!owed }), ...(owed ? { relinkOwed: owed.count } : {}) };
}

/* ------------------------------------------------------------------ the live relink (the app keeps running) */

/** A transcript written to within this long may belong to a session that is working or has just finished: not cleared. */
export const LIVE_QUIET_MS = 120 * 1000;

const lc = (s) => String(s ?? '').toLowerCase();

/**
 * Read-only: the sessions of `acct` whose last saved link needs clearing, newest activity first. A session counts when its record is not
 * archived, is local, has a CLI session id and a transcript, and its last `bridge-session` entry is a `noHistoryBackfill` link or one
 * minted under another account (relinkReason). Which of them may be cleared NOW is the live gate (liveRelinkPass).
 * o: { acct, now, days, all (every record, not only the recent ones), projects, foreignCheck, rcLog }
 * @returns {{acct, records:number, noTranscript:number, candidates:object[], foreignCheck}}
 */
export function liveRelinkCandidates(ctx, o = {}) {
  const acct = (o.acct ?? readSignedIn(ctx.userData)) || null;
  const out = { acct, records: 0, noTranscript: 0, candidates: [], foreignCheck: null };
  if (!acct) return out;
  const now = o.now ?? ctx.now();
  const days = o.days ?? RC_DEFAULTS.days;
  const recs = accountRecords(ctx, acct, o.all ? {} : { sinceMs: now - days * DAY_MS });
  const groups = bySession(recs);
  out.records = groups.length;
  const projects = o.projects ?? defaultProjects();
  const fc = o.foreignCheck ?? makeForeign(ctx, acct, o);
  out.foreignCheck = fc;
  for (const r of groups) {
    const rec = r.rec;
    if (rec.isArchived === true || rec.movedToCloud || (rec.backend && rec.backend.kind && rec.backend.kind !== 'local') || !rec.cliSessionId) continue;
    const tp = findTranscript(projects, rec);
    if (!tp) { out.noTranscript++; continue; }
    const b = lastBridgeEntry(tp);
    const why = relinkReason(b, (id) => fc.foreign(id, tp));
    if (!why) continue;
    out.candidates.push({ file: r.path, id: rec.sessionId, cliSessionId: rec.cliSessionId, title: rec.title ?? '', transcript: tp, link: b.bridgeSessionId, why, running: rec.isRunning === true });
  }
  return out;
}

/** The one log line of a live pass: `rc-live: cleared N (ids...), skipped live M, quiet Q, raced R` and the rest only when not zero. */
export function liveLine(res) {
  const extra = ['running', 'unknown', 'self', 'deferred', 'failed', 'stale'].filter((k) => res[k]).map((k) => `${k} ${res[k]}`);
  return `rc-live: cleared ${res.cleared.length}${res.cleared.length ? ` (${res.cleared.map((c) => c.id.replace(/^local_/, '').slice(0, 8)).join(', ')})` : ''}, skipped live ${res.skippedLive}, quiet ${res.quiet}, raced ${res.raced}${extra.length ? `, ${extra.join(', ')}` : ''}`;
}

/**
 * Clear the stale link of every session whose conversation has no CLI running, while the app runs (the CLI keeps the link in memory,
 * so a clear line appended while it runs does nothing, and one appended while it does not makes the next cold resume mint a titled link).
 * A session is cleared only when ALL hold, in this order:
 *   1 candidate (liveRelinkCandidates)  2 not the session this hook runs in  3 no live CLI for that conversation (liveCliIds; unknown
 *   clears nothing)  4 transcript untouched for LIVE_QUIET_MS  5 record not mid-turn (isRunning is not "no CLI": 3 is the real check)
 *   6 right before the write: the list of CLIs read again, the last entry and the age read again, the transcript backed up, the CLI's own
 *   clear line appended, then the list read once more: a CLI that appeared meanwhile is logged `raced` (benign: retried next pass).
 * No process is ever stopped. At most `liveMax` sessions per pass.
 * o: { settings (rcSettings), dryRun (read only; runs even when the feature is off), all, days, max, quietMs, now, acct, projects, rcLog,
 *      hookCliSessionId, liveCliIds (function, Set or null; tests), cimTimeoutMs, log(line) }
 * @returns {Promise<{ran:boolean, reason?:string, dryRun:boolean, acct, candidates:number, cleared:object[], wouldClear:object[],
 *   skippedLive:number, quiet:number, running:number, unknown:number, self:number, raced:number, deferred:number, failed:number, stale:number,
 *   undated:number (links the history could not date: left alone)}>}
 */
export async function liveRelinkPass(ctx, o = {}) {
  const s = o.settings ?? RC_DEFAULTS;
  const dry = o.dryRun === true;
  const log = o.log ?? (() => {});
  const res = { ran: false, dryRun: dry, acct: null, candidates: 0, cleared: [], wouldClear: [], skippedLive: 0, quiet: 0, running: 0, unknown: 0, self: 0, raced: 0, deferred: 0, failed: 0, stale: 0, undated: 0 };
  if (!dry && (s.enabled === false || s.liveRelink !== 'idle-only')) return { ...res, reason: 'disabled' };
  if (!ctx.store || !ctx.userData) return { ...res, reason: 'no-store' };
  const nowMs = () => o.now ?? ctx.now();
  const quietMs = o.quietMs ?? LIVE_QUIET_MS;
  const max = o.max ?? s.liveMax ?? RC_DEFAULTS.liveMax;
  const readLive = async () => {
    const f = 'liveCliIds' in o ? o.liveCliIds : (() => liveCliIds({ platform: o.platform ?? ctx.platform, timeoutMs: o.cimTimeoutMs }));
    const v = typeof f === 'function' ? await f() : f;
    return v == null ? null : new Set([...v].map(lc));
  };
  const scan = liveRelinkCandidates(ctx, { acct: o.acct, now: nowMs(), days: o.days ?? s.days, all: o.all === true, projects: o.projects, rcLog: o.rcLog });
  res.acct = scan.acct;
  if (!scan.acct) return { ...res, reason: 'no-account' };
  res.ran = true;
  let cands = scan.candidates;
  if (o.hookCliSessionId) cands = cands.filter((c) => (c.cliSessionId === o.hookCliSessionId ? (res.self++, false) : true));
  res.candidates = cands.length;
  res.undated = scan.foreignCheck.undated;
  // the ledger and the history are a cache of what this pass just learned (atomic, add-only): kept by every pass that may write, so a
  // link seen now is dated by when it was first seen even when nothing is cleared this time. A dry run keeps nothing.
  if (!dry) scan.foreignCheck.flush();
  if (!cands.length) return res;   // nothing to look at: the OS is not asked

  const live = await readLive();
  if (live === null) { res.unknown = cands.length; if (!dry) log(liveLine(res)); return res; }
  const todo = [];
  for (const c of cands) {
    if (live.has(lc(c.cliSessionId))) { res.skippedLive++; continue; }
    let m = null; try { m = statSync(c.transcript).mtimeMs; } catch { /* gone */ }
    if (m === null) { res.stale++; continue; }
    if (nowMs() - m < quietMs) { res.quiet++; continue; }
    if (c.running) { res.running++; continue; }
    todo.push(c);
  }
  const batch = todo.slice(0, Math.max(0, max));
  res.deferred = todo.length - batch.length;
  const summary = (c) => ({ id: c.id, cliSessionId: c.cliSessionId, title: c.title, why: c.why, link: c.link });
  if (dry) { res.wouldClear = todo.map(summary); return res; }   // the whole list; a real pass clears the first `max` of it (res.deferred is the rest)
  if (!batch.length) { log(liveLine(res)); return res; }

  const lock = await withAccountsLock(ctx, async () => {
    const live2 = await readLive();                                      // right before the writes
    if (live2 === null) { res.unknown += batch.length; return; }
    const backupDir = accPath(ctx, 'rc-restore', 'backup', stamp(nowMs()));
    const written = [];
    for (const c of batch) {
      if (live2.has(lc(c.cliSessionId))) { res.skippedLive++; continue; }
      try {
        const again = lastBridgeEntry(c.transcript);
        if (!again || again.bridgeSessionId !== c.link || !needsRelink(again, (id) => scan.foreignCheck.foreign(id, c.transcript))) { res.stale++; continue; }
        if (nowMs() - statSync(c.transcript).mtimeMs < quietMs) { res.quiet++; continue; }
        mkdirSync(backupDir, { recursive: true });
        copyFileSync(c.transcript, join(backupDir, `${c.cliSessionId}.jsonl`));
        appendClearLine(c.transcript, c.cliSessionId);
        written.push(c); res.cleared.push(summary(c));
      } catch (e) { res.failed++; log(`rc-live: ${c.id}: relink FAILED ${e?.message ?? e}`); }
    }
    if (written.length) {
      const after = await readLive();                                    // a CLI that loaded the pointer before or after the write
      if (after) for (const c of written) if (after.has(lc(c.cliSessionId))) res.raced++;
      pruneBackups(ctx, nowMs());
    }
  });
  if (!lock.ok) { log('rc-live: skipped, another pass holds the accounts lock'); return { ...res, ran: false, reason: 'locked' }; }
  log(liveLine(res));
  return res;
}

/**
 * The wake hook with the live relink in front of it: the prompt that claims the restart (the instruction case and the baseline case) first
 * clears the stale links of the sessions that have no CLI yet (right after an app start none runs), so the sessions the wake then
 * reconnects load the cleared pointer. The session the hook runs in is never touched. Never throws.
 * o: the options of decideWake + { log, liveCliIds, now, ... } for liveRelinkPass
 */
export async function wakeWithRelink(ctx, o = {}) {
  const d = decideWake(ctx, o);
  const s = o.settings ?? RC_DEFAULTS;
  if ((d.act || d.reason === 'baseline') && s.liveRelink === 'idle-only') {
    try { d.live = await liveRelinkPass(ctx, { ...o, hookCliSessionId: o.sessionId, days: s.days, settings: s }); }
    catch (e) { o.log?.(`rc-live failed: ${e?.message ?? e}`); }
  }
  return d;
}
