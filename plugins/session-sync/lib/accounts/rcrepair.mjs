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
 * Test seams: o.listProcs (async () => [{pid, ids, resume}] | null), o.stopPids ((pids) => any), o.acct, o.projects, o.now.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { accPath, withAccountsLock } from './state.mjs';
import { readSignedIn } from './appstate.mjs';
import { accountRecords, bySession, findTranscript, lastBridgeEntry, appendClearLine, pruneBackups, stamp, defaultProjects } from './rcrestore.mjs';
import { liveCliProcs, stopPids as realStopPids } from './proc.mjs';

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
 * @param {{id:string, stopCli?:boolean, dryRun?:boolean, force?:boolean, verify?:boolean, acct?:string, projects?:string, now?:number,
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

  if (rec.isRunning === true) return refuse('mid-turn', 'That session is mid-turn. Wait until it is idle.', base);
  const entry = lastBridgeEntry(transcript);
  const stale = !!entry && !!entry.bridgeSessionId && entry.noHistoryBackfill === true;
  if (!stale && o.force !== true) {
    const why = !entry ? 'has no link line' : !entry.bridgeSessionId ? 'is already cleared' : 'is healthy (no noHistoryBackfill)';
    return refuse('not-stale', `The last link ${why}; nothing to repair. --force appends the clear line anyway.`, { ...base, link: entry?.bridgeSessionId ?? null });
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
  if (o.dryRun) {
    return { ok: true, status: 'dry-run', ...base, link: entry?.bridgeSessionId ?? null, wouldStop: toStop, wouldClear: true, forced: !stale,
      text: `Dry run: would ${toStop.length ? `stop pid ${toStop.join(', ')}, ` : ''}back up the transcript and append the clear line (last link ${entry?.bridgeSessionId || '(none)'}${stale ? ', noHistoryBackfill' : ', forced'}).` };
  }

  let stopped = [];
  if (live.length) {
    stopped = toStop.length ? (stopFn(toStop) ?? []) : [];
    procs = await list();
    if (procs == null) return refuse('unknown-processes', 'The process list could not be read after stopping the CLI. Nothing was written.', { ...base, stopped });
    live = mine(procs);
    if (live.length) return refuse('cli-still-live', `A CLI for that conversation is still listed after the stop (pid ${live.map((p) => p.pid).join(', ')}). Nothing was written.`, { ...base, stopped, pids: live.map((p) => p.pid) });
  }

  let result = null;
  const lock = await withAccountsLock(ctx, async () => {
    const again = lastBridgeEntry(transcript);
    if (again?.bridgeSessionId !== entry?.bridgeSessionId) { result = refuse('changed', 'The last link changed meanwhile. Nothing was written; run it again.', { ...base, stopped }); return; }
    const dir = accPath(ctx, 'rc-restore', 'backup', stamp(nowMs()));
    mkdirSync(dir, { recursive: true });
    const backup = join(dir, `${cli}.jsonl`);
    copyFileSync(transcript, backup);
    appendClearLine(transcript, cli);
    try { pruneBackups(ctx, nowMs()); } catch { /* best effort */ }
    log(`rc-repair: ${rec.sessionId}: cleared ${entry?.bridgeSessionId ?? '(none)'}; stopped ${stopped.length ? stopped.join(',') : 'none'}; backup ${dir}`);
    result = { ok: true, status: 'cleared', ...base, link: entry?.bridgeSessionId ?? null, stopped, backup,
      text: `Cleared the link ${entry?.bridgeSessionId || '(none)'}${stopped.length ? ` after stopping pid ${stopped.join(', ')}` : ''}; backup ${backup}. Next: wake the session and turn Remote Control on, then run rc-repair --verify.` };
  });
  if (!lock.ok) return refuse('locked', 'Another accounts pass holds the lock. Nothing was written; run it again.', { ...base, stopped });
  return result;
}
