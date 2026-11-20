/**
 * rcrepair.mjs - `accounts rc-repair` (0.5.8): the file-side steps of the standing fix for a Remote Control session that shows a random
 * name while its Claude process runs. The app-side steps (set_remote_control off, wake, set_remote_control on) are the skill's.
 *
 *   stop that conversation's CLI (only with --stop-cli), back up the transcript, append the CLI's own clear line, and later verify the
 *   last link is a fresh `cse_` id without `noHistoryBackfill`.
 *
 * An explicit manual action: it works whatever rcRestore.enabled is. Refuses (writes and stops nothing) when the record is mid-turn, when
 * the last link is already cleared or healthy (unless force), when a CLI is live without stopCli, and whenever the process list is unknown
 * or a stopped CLI is still listed. Only pids and ids are ever kept or printed, never a command line.
 *
 * 0.5.10: "stale" is wider than noHistoryBackfill: a link minted before the current sign-in began (any owner) is dead too (rcrestore.mjs
 * linkReason), and `--at-turn-end` queues the repair for the end of the session's own turn (a Stop hook picks the request up; see the
 * bottom of this file).
 *
 * Test seams: o.listProcs (async () => [{pid, ids, resume}] | null), o.stopPids ((pids) => any), o.acct, o.projects, o.now, o.rcLog.
 */
import { copyFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { accPath, withAccountsLock, readJson, writeJsonAtomic } from './state.mjs';
import { readSignedIn } from './appstate.mjs';
import { accountRecords, bySession, findTranscript, lastBridgeEntry, appendClearLine, pruneBackups, stamp, defaultProjects, linkReason } from './rcrestore.mjs';
import { makeForeign } from './rclinks.mjs';
import { liveCliProcs, stopPids as realStopPids } from './proc.mjs';
import { launchViaHelper } from './launcher.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const refuse = (reason, text, extra = {}) => ({ ok: false, status: 'refused', reason, text, ...extra });

/** The record (newest copy) of a local session id (`local_<uuid>`) or a CLI session id, or null. */
export function resolveSession(ctx, acct, id) {
  const want = String(id ?? '').trim().toLowerCase();
  const groups = bySession(accountRecords(ctx, acct));
  return groups.find((g) => String(g.rec.sessionId ?? '').toLowerCase() === want || String(g.rec.cliSessionId ?? '').toLowerCase() === want) ?? null;
}

const fresh = (b) => !!b && typeof b.bridgeSessionId === 'string' && b.bridgeSessionId.startsWith('cse_') && b.noHistoryBackfill !== true;

/** Read-only check of the last link of a transcript. */
export function verifyLink(transcript) {
  const b = lastBridgeEntry(transcript);
  return { link: b?.bridgeSessionId ?? null, noHistoryBackfill: b?.noHistoryBackfill === true, pass: fresh(b) };
}

/**
 * @param {object} ctx
 * @param {{id:string, stopCli?:boolean, dryRun?:boolean, force?:boolean, verify?:boolean, atTurnEnd?:boolean, acct?:string, projects?:string, now?:number, rcLog?:string|null,
 *   listProcs?:Function, stopPids?:Function, platform?:string, log?:Function}} o
 * @returns {Promise<{ok:boolean, status:string, reason?:string, text:string, [k:string]:any}>}
 */
export async function rcRepair(ctx, o = {}) {
  const log = o.log ?? (() => {});
  const id = String(o.id ?? '').trim().replace(/^local_/i, '');
  if (!UUID_RE.test(id) && !UUID_RE.test(String(o.id ?? '').trim())) return refuse('bad-id', 'Give a local session id (local_<uuid>) or a CLI session id (a uuid).');
  if (!ctx.store || !ctx.userData) return refuse('no-store', 'The Claude desktop session store was not found on this machine.');
  const acct = (o.acct ?? readSignedIn(ctx.userData)) || null;
  if (!acct) return refuse('no-account', 'No signed-in account was found.');
  const g = resolveSession(ctx, acct, o.id);
  if (!g) return refuse('no-record', 'No session of the signed-in account has that id.');
  const rec = g.rec;
  const cli = String(rec.cliSessionId ?? '').toLowerCase();
  if (!UUID_RE.test(cli)) return refuse('no-cli-session', 'That session has no CLI conversation id yet.');
  const transcript = findTranscript(o.projects ?? defaultProjects(), rec);
  if (!transcript) return refuse('no-transcript', 'The transcript of that session was not found.');
  const base = { session: rec.sessionId, cliSessionId: cli, title: rec.title ?? '' };
  const nowMs = () => o.now ?? ctx.now();

  if (o.verify) {
    const v = verifyLink(transcript);
    return { ok: v.pass, status: v.pass ? 'verified' : 'verify-failed', ...base, ...v,
      text: `Last link ${v.link === null ? '(none)' : v.link === '' ? '(cleared)' : v.link}, noHistoryBackfill ${v.noHistoryBackfill ? 'yes' : 'no'}: ${v.pass ? 'PASS' : 'FAIL'}.` };
  }

  if (rec.isRunning === true && o.atTurnEnd !== true) return refuse('mid-turn', 'That session is mid-turn. Wait until it is idle.', base);   // a request for the end of the turn is made mid-turn by definition
  const entry = lastBridgeEntry(transcript);
  // stale: noHistoryBackfill, minted under another account, or minted before this sign-in began (read only: nothing is kept). An explicit
  // repair does not apply the automatic passes' gone-bounce guard (isGoneBounce): the user asked for this session.
  const reason = entry?.bridgeSessionId ? linkReason(makeForeign(ctx, acct, { rcLog: o.rcLog }), entry, transcript, { guard: false }) : null;
  const stale = reason !== null;
  if (!stale && o.force !== true) {
    const why = !entry ? 'has no link line' : !entry.bridgeSessionId ? 'is already cleared' : 'is healthy (not noHistoryBackfill, not minted before this sign-in)';
    return refuse('not-stale', `The last link ${why}; nothing to repair. --force appends the clear line anyway.`, { ...base, link: entry?.bridgeSessionId ?? null });
  }
  if (o.atTurnEnd) {
    const w = writeTurnEndRequest(ctx, { cliSessionId: cli, session: rec.sessionId, force: o.force === true, now: nowMs() });
    return { ok: true, status: 'queued', ...base, link: entry?.bridgeSessionId ?? null, why: reason, request: w.file,
      text: `Queued: when this session's turn ends, its CLI is stopped and the stale link (${entry?.bridgeSessionId || '(none)'}${reason ? `, ${reason}` : ', forced'}) is cleared after a backup. The session comes back on your next message and Remote Control reconnects then, named with the session title. Needs the session-sync Stop hook (installed with the plugin).` };
  }

  const list = o.listProcs ?? (() => liveCliProcs({ platform: o.platform ?? ctx.platform }));
  const stopFn = o.stopPids ?? ((pids) => realStopPids(pids));
  const mine = (procs) => procs.filter((p) => p.ids.includes(cli));
  let procs = await list();
  if (procs == null) return refuse('unknown-processes', 'The process list could not be read, so a live CLI cannot be ruled out. Nothing was changed.', base);
  let live = mine(procs);
  if (live.length && o.stopCli !== true) {
    return refuse('cli-live', `A CLI is running for that conversation (pid ${live.map((p) => p.pid).join(', ')}). Re-run with --stop-cli to stop it.`, { ...base, pids: live.map((p) => p.pid) });
  }
  const toStop = live.filter((p) => p.resume.includes(cli)).map((p) => p.pid);
  if (live.length && toStop.length < live.length) {
    return refuse('cli-not-stoppable', `A CLI for that conversation (pid ${live.filter((p) => !p.resume.includes(cli)).map((p) => p.pid).join(', ')}) does not name it with --resume, so it is not stopped here. Nothing was changed.`, { ...base, pids: live.map((p) => p.pid) });
  }
  if (o.dryRun) {
    return { ok: true, status: 'dry-run', ...base, link: entry?.bridgeSessionId ?? null, why: reason, wouldStop: toStop, wouldClear: true, forced: !stale,
      text: `Dry run: would ${toStop.length ? `stop pid ${toStop.join(', ')}, ` : ''}back up the transcript and append the clear line (last link ${entry?.bridgeSessionId || '(none)'}${stale ? `, ${reason}` : ', forced'}).` };
  }

  // the lock is taken before the stop, so a held lock leaves the CLI running; a stop is always reported, whatever follows
  let result = null;
  let stopped = [];
  const lock = await withAccountsLock(ctx, async () => {
    try {
      const g2 = resolveSession(ctx, acct, o.id);
      if (g2?.rec.isRunning === true) { result = refuse('mid-turn', 'That session became active meanwhile. Nothing was changed.', base); return; }
      if (live.length) {
        stopped = stopFn(toStop) ?? [];
        procs = await list();
        if (procs == null) { result = refuse('unknown-processes', `The process list could not be read after stopping the CLI (stopped pid ${stopped.join(', ') || 'none'}). Nothing was written.`, { ...base, stopped }); return; }
        live = mine(procs);
        if (live.length) { result = refuse('cli-still-live', `A CLI for that conversation is still listed after the stop (pid ${live.map((p) => p.pid).join(', ')}). Nothing was written.`, { ...base, stopped, pids: live.map((p) => p.pid) }); return; }
      }
      const again = lastBridgeEntry(transcript);
      if (again?.bridgeSessionId !== entry?.bridgeSessionId) { result = refuse('changed', `The last link changed meanwhile${stopped.length ? ` (the CLI was already stopped, pid ${stopped.join(', ')})` : ''}. Nothing was written; run it again.`, { ...base, stopped }); return; }
      const dir = accPath(ctx, 'rc-restore', 'backup', stamp(nowMs()));
      mkdirSync(dir, { recursive: true });
      const backup = join(dir, `${cli}.jsonl`);
      copyFileSync(transcript, backup);
      appendClearLine(transcript, cli);
      try { pruneBackups(ctx, nowMs()); } catch { /* best effort */ }
      log(`rc-repair: ${rec.sessionId}: cleared ${entry?.bridgeSessionId ?? '(none)'}; stopped ${stopped.length ? stopped.join(',') : 'none'}; backup ${dir}`);
      result = { ok: true, status: 'cleared', ...base, link: entry?.bridgeSessionId ?? null, stopped, backup,
        text: `Cleared the link ${entry?.bridgeSessionId || '(none)'}${stopped.length ? ` after stopping pid ${stopped.join(', ')}` : ''}; backup ${backup}. Next: wake the session and turn Remote Control on, then run rc-repair --verify.` };
    } catch (err) {
      result = refuse('failed', `The repair failed: ${String(err?.message ?? err).slice(0, 200)}${stopped.length ? ` (the CLI was already stopped, pid ${stopped.join(', ')})` : ''}.`, { ...base, stopped });
    }
  });
  if (!lock.ok) return refuse('locked', 'Another accounts pass holds the lock. Nothing was written; run it again.', { ...base, stopped });
  return result;
}

/* ------------------------------------------------------------------ relink at the end of the session's own turn (0.5.10) */

/**
 * A session cannot clear its own link: its CLI holds the link in memory and appends to the transcript. `accounts rc-repair <id>
 * --at-turn-end` therefore only RECORDS a request (accounts/rc-turn-end/<cliSessionId>.json). The Stop hook (`rc-turn-end --from-hook`)
 * of that session sees the request when the turn ends and starts one hidden, detached helper (launcher.mjs launchViaHelper: the hook's
 * own node exits at once; the real process is started outside the app's job) that waits about 2 s, runs the rc-repair --stop-cli path
 * above, and deletes the request. No polling and no quiet window. The session comes back on its next message (the app resumes it), and
 * Remote Control reconnects then with a fresh link named after the session title.
 */
export const TURN_END_DELAY_MS = 2000;
/** A request older than this was never served (the session ended some other way): dropped, never acted on. */
export const TURN_END_MAX_AGE_MS = 6 * 3600 * 1000;
/** The hook starts the helper at most this many times per request, and not again within TURN_END_GAP_MS (a helper that is still working). */
export const TURN_END_MAX_LAUNCHES = 3;
export const TURN_END_GAP_MS = 60 * 1000;
const SAFE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const turnEndDir = (ctx) => accPath(ctx, 'rc-turn-end');
export const turnEndFile = (ctx, cliSessionId) => join(turnEndDir(ctx), `${String(cliSessionId).toLowerCase()}.json`);

/** Record the request. Atomic; a second request for the same conversation replaces the first. */
export function writeTurnEndRequest(ctx, { cliSessionId, session, force = false, now }) {
  const file = turnEndFile(ctx, cliSessionId);
  writeJsonAtomic(file, { v: 1, cliSessionId: String(cliSessionId).toLowerCase(), session: session ?? null, force: force === true, at: now ?? ctx.now(), launches: 0, launchedAt: 0 });
  return { file };
}

/** Delete the request (and the `.bak` the atomic writer leaves). Never throws. */
export function removeTurnEndRequest(ctx, cliSessionId) {
  const file = turnEndFile(ctx, cliSessionId);
  for (const f of [file, `${file}.bak`]) { try { unlinkSync(f); } catch { /* none */ } }
}

/**
 * The Stop hook: is there a request for THIS session? If so, start the helper and return at once. Never throws, never waits.
 * input: the hook's stdin JSON ({session_id, ...}). o: { now, launch(args) (test seam; default launchViaHelper), log(line) }
 * @returns {{launched:boolean, reason:string}}  reason: none | bad-session | expired | in-flight | launched | launch-failed
 */
export function turnEndHook(ctx, input, o = {}) {
  try {
    const id = String(input?.session_id ?? '').toLowerCase();
    if (!SAFE_ID.test(id)) return { launched: false, reason: 'bad-session' };
    if (!ctx?.acc || !existsSync(turnEndFile(ctx, id))) return { launched: false, reason: 'none' };   // the usual turn: one stat
    const now = o.now ?? ctx.now();
    const req = readJson(turnEndFile(ctx, id), null);
    if (!req || req.cliSessionId !== id || !(now - req.at < TURN_END_MAX_AGE_MS) || (req.launches ?? 0) >= TURN_END_MAX_LAUNCHES) {
      removeTurnEndRequest(ctx, id);
      return { launched: false, reason: 'expired' };
    }
    if (now - (req.launchedAt ?? 0) < TURN_END_GAP_MS) return { launched: false, reason: 'in-flight' };
    writeJsonAtomic(turnEndFile(ctx, id), { ...req, launches: (req.launches ?? 0) + 1, launchedAt: now });
    const r = (o.launch ?? ((args) => launchViaHelper(args, { ctx })))(['accounts', 'rc-turn-end-run', id]);
    o.log?.(`rc-turn-end: ${id.slice(0, 8)}: ${r.ok ? 'helper started' : `helper NOT started (${r.error ?? 'unknown'})`}`);
    return { launched: r.ok === true, reason: r.ok ? 'launched' : 'launch-failed' };
  } catch (e) {
    try { o.log?.(`rc-turn-end failed: ${e?.message ?? e}`); } catch { /* never fail a turn */ }
    return { launched: false, reason: 'error' };
  }
}

/** Refusals that leave the request in place, so the next Stop hook tries again (bounded by TURN_END_MAX_LAUNCHES). */
const RETRY_REASONS = new Set(['locked', 'unknown-processes', 'cli-still-live', 'failed', 'changed', 'mid-turn']);

/**
 * The helper: wait, then the existing `--stop-cli` repair for the request's conversation, then delete the request. A mid-turn refusal (the
 * app has not yet marked the turn as ended) is retried a few times, TURN_END_DELAY_MS apart.
 * o: { cliSessionId, delayMs, midTurnTries (5), sleep(ms), log(line), + rcRepair's seams: listProcs, stopPids, acct, projects, now, rcLog, platform }
 * @returns {Promise<{ran:boolean, reason?:string, result?:object}>}
 */
export async function runTurnEnd(ctx, o = {}) {
  const id = String(o.cliSessionId ?? '').toLowerCase();
  const log = o.log ?? (() => {});
  if (!SAFE_ID.test(id)) return { ran: false, reason: 'bad-session' };
  const req = readJson(turnEndFile(ctx, id), null);
  if (!req || req.cliSessionId !== id) return { ran: false, reason: 'no-request' };
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  await sleep(o.delayMs ?? TURN_END_DELAY_MS);
  const { cliSessionId: _a, delayMs: _b, midTurnTries: _c, sleep: _d, ...seams } = o;
  let r = null;
  for (let i = 0; i < Math.max(1, o.midTurnTries ?? 5); i++) {
    r = await rcRepair(ctx, { ...seams, id, stopCli: true, force: req.force === true, log });
    if (r.reason !== 'mid-turn') break;
    await sleep(o.delayMs ?? TURN_END_DELAY_MS);
  }
  const keep = !r.ok && RETRY_REASONS.has(r.reason);
  if (!keep) removeTurnEndRequest(ctx, id);
  log(`rc-turn-end: ${id.slice(0, 8)}: ${r.ok ? r.status : `refused (${r.reason})`}${keep ? ', request kept for the next turn' : ''}`);
  return { ran: true, result: r, kept: keep };
}
