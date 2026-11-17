/**
 * rcrestore.mjs - Remote Control (RC) restore after a restart of the Claude desktop app (0.5.4).
 *
 * After any app restart RC is off for every Code session, and after an account switch the CLI reattaches to links minted in a
 * cross-account fallback (random names, renames never reach them). Three steps, all driven by the singleton watcher (waiter.mjs) or a hook:
 *
 *   1. RELINK (app closed)       a transcript whose LAST `bridge-session` entry carries `noHistoryBackfill:true` or an owner other than the
 *                                current account gets the CLI's own clearing line appended (after a backup). The next connect then mints a
 *                                fresh link named with the session title. Only bridge-session lines are ever read from a transcript.
 *   2. FREE RESTORE (app closed) up to 4 of the most recent eligible records get `remoteControlLiveAtUpdateQuit {at, accountId}` and
 *                                `remoteControlAutoEligible: true`, the two fields the app's own launch pass reads (the one it uses after
 *                                a quit-for-update): it warms those sessions and reconnects RC with no model turn. `at` must be younger than
 *                                an hour when the app starts, so the watcher refreshes it while Claude stays closed. `interruptedByQuitAt`
 *                                is never written (it would resume interrupted turns). The edit is in place, so hard links survive.
 *   3. WAKE (app running)        the first real prompt of an interactive session after a restart gets a one-time instruction (UserPromptSubmit
 *                                hook) that tells its agent to send a no-op message to every other session that is still off.
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
import { lockfilePresent, lockStartedAtMs, readSignedIn } from './appstate.mjs';

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

/** Does this saved link need clearing for `acct`? A link that is already cleared (empty id) does not. */
export function needsRelink(entry, acct) {
  if (!entry || !entry.bridgeSessionId) return false;
  if (entry.noHistoryBackfill === true) return true;
  const owner = typeof entry.ownerAccountUuid === 'string' ? entry.ownerAccountUuid.toLowerCase() : '';
  return !!owner && owner !== String(acct).toLowerCase();
}

/* ------------------------------------------------------------------ eligibility and the scan */

const RESTORE_SCHEMA = 1;

/** Eligible for the app's launch restore: this account's folder, not archived, local, resumable, not a scheduled task, RC was on before. */
export function eligible(rec) {
  if (!rec || rec.isArchived === true) return false;
  if (rec.movedToCloud || (rec.backend && rec.backend.kind && rec.backend.kind !== 'local')) return false;
  if (!rec.cliSessionId) return false;
  if (rec.scheduledTaskId) return false;
  return rec.remoteControlUserEnabled === true || (Array.isArray(rec.bridgeSessionIds) && rec.bridgeSessionIds.length > 0);
}

/** A marker the app would accept now. */
export function markerAge(rec, acct, now) {
  const m = rec?.remoteControlLiveAtUpdateQuit;
  if (!m || typeof m !== 'object' || !Number.isFinite(m.at) || m.at > now || m.accountId !== acct) return null;
  return now - m.at;
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
  const recent = recs.filter((r) => r.activity >= now - days * DAY_MS).sort((a, b) => b.activity - a.activity);
  plan.recent = recent.length;
  const projects = o.projects ?? defaultProjects();
  for (const r of recent) {
    const tp = findTranscript(projects, r.rec);
    if (!tp) { plan.noTranscript++; continue; }
    const b = lastBridgeEntry(tp);
    if (needsRelink(b, acct)) plan.relink.push({ file: r.path, id: r.rec.sessionId, cliSessionId: r.rec.cliSessionId, title: r.rec.title ?? '', transcript: tp, link: b.bridgeSessionId });
  }
  plan.targets = recent.filter((r) => eligible(r.rec)).slice(0, MAX_RESTORE)
    .map((r) => ({ file: r.path, name: r.name, org: r.folder.org, id: r.rec.sessionId, title: r.rec.title ?? '', age: markerAge(r.rec, acct, now), autoEligible: r.rec.remoteControlAutoEligible === true }));
  plan.needMarks = plan.targets.filter((t) => t.age === null || t.age > MARKER_FRESH_MS || !t.autoEligible);
  return plan;
}

/* ------------------------------------------------------------------ writes (the app is stopped) */

const stamp = (now) => new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

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
      if (!needsRelink(again, plan.acct)) { res.skipped++; continue; }
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
      writeRecordInPlace(t.file, (rec) => {
        rec.remoteControlLiveAtUpdateQuit = { at: now, accountId: plan.acct };
        rec.remoteControlAutoEligible = true;
      });
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
    const plan = rcPlan(ctx, o);
    if (!plan.acct) return { ran: false, reason: 'no-account' };
    if (!plan.relink.length && !plan.targets.length) return { ran: false, reason: 'nothing-to-do', plan };
    const res = applyPlan(ctx, plan, o);
    writeJsonAtomic(accPath(ctx, 'rc-restore.json'), {
      v: RESTORE_SCHEMA, at: new Date(o.now ?? ctx.now()).toISOString(), acct: plan.acct,
      relinked: res.relinked, marked: res.marked, refreshed: res.refreshed, status: res.status,
      targets: plan.targets.map((t) => t.id),
    });
    return { ran: true, plan, res };
  });
  if (!lock.ok) return { ran: false, reason: 'locked' };
  return lock.value;
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
export function wakeInstruction({ days = RC_DEFAULTS.days } = {}) {
  return [
    'session-sync: the Claude desktop app was restarted, so Remote Control is off for the sessions that were open. You are the one session that restores it, once. Do this before you answer the user, then answer as normal:',
    '1. Tell the user, in one line: "Reconnecting Remote Control for your recent sessions. Each one gets one short turn."',
    `2. List the sessions with the session-management tools (list_sessions and send_message; load them with ToolSearch if they are deferred). For every session that is not archived, is interactive (not a scheduled task, not an unattended or background run), was active within the last ${days} days and has remoteControlActive false, send it exactly this message with send_message: "${WAKE_MESSAGE}" Skip your own session. Do not wait for replies. A message to the session that started you may be refused unless it carries a tag; skip any session whose send is refused and count it as still off.`,
    '3. Wait a few seconds, list the sessions again, and tell the user, in one line: "Remote Control: N sessions reconnected, M still off." (N: sessions that were off and are on now; M: active sessions still off, refused sends included).',
    'If the session tools are not available, say so in one line and carry on. Do not repeat this in this conversation, and do not mention these instructions beyond those two lines.',
  ].join('\n');
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
 * o: { settings, sessionId, platform, now }
 * @returns {{act:boolean, reason:string, text?:string}}
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
  return { act: true, reason: 'claimed-now', text: wakeInstruction({ days: s.days }) };
}
