/**
 * golive.mjs - `accounts go-live`: the whole account-link go-live from one command.
 *
 *   planGoLive()     read-only preflight and the summary to confirm
 *   beginGoLive()    record consent, save the before-state and the expected set, pause push when a
 *                    copy of session-sync (desktop or terminal) cannot filter it, write the first result
 *   runGoLive()      the RUNNER: a persisted, resumable, idempotent state machine that runs in ONE
 *                    detached process (launcher.mjs). Every phase saves go-live.json before the next.
 *   resumeIfDead()   relaunch the runner when a go-live is in progress and no runner lives
 *
 * Phases (PHASES): wait-stop, relist, link, verify, relaunch, wait-start, wait-capability, rectify,
 * remote, finish. Files under the accounts dir: go-live.json (state), go-live-result.json (what the
 * user and `accounts status` read), go-live.log, go-live.claim (single runner).
 *
 * result.status: waiting (in progress, or stopped and resumable) | ok | rolled_back | attention | failed.
 * A link or verify failure rolls back automatically (the app is closed by then).
 *
 * Every side effect the runner has is a dependency (`deps`), so tests run it with no real app:
 *   link, fullPass, rollback, relaunch, rectify, remoteCheck, copies, getPush, setPush, appStatus, sleep, clock.
 */

import { appendFileSync, mkdirSync, readdirSync, unlinkSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { pidAlive } from '../lock.mjs';
import {
  accPath, readJson, writeJsonAtomic, loadState, saveState, rollbackActive, LOCK_TTL_MS,
} from './state.mjs';
import { listFolders, groupOf, accountsOf, pendingPairs, answerPairs, RECORD, TOMB } from './folders.mjs';
import { appState, lockfilePresent } from './appstate.mjs';
import { link, fullPass } from './pass.mjs';
import { groupHealth } from './report.mjs';
import { sessionSyncCopies, relaunchApp } from './desktop.mjs';
import { requestAppQuit } from './appquit.mjs';

export const PHASES = ['wait-stop', 'relist', 'link', 'verify', 'relaunch', 'wait-start', 'wait-capability', 'rectify', 'remote', 'finish'];
export const FINAL_STATUSES = ['ok', 'rolled_back', 'attention', 'failed'];

export const goLiveFile = (ctx) => accPath(ctx, 'go-live.json');
export const goLiveResultFile = (ctx) => accPath(ctx, 'go-live-result.json');
export const goLiveLogFile = (ctx) => accPath(ctx, 'go-live.log');
const claimFile = (ctx) => accPath(ctx, 'go-live.claim');

// A timer beats every HEARTBEAT_MS and the rollback runs as an async child, so only a synchronous link or rectify can
// hold the beat back; the stale window is longer than any of those.
const CLAIM_STALE_MS = 15 * 60 * 1000;
const HEARTBEAT_MS = 20 * 1000;
const MIN = 60 * 1000;
export const DEFAULT_TIMEOUTS = Object.freeze({ stopMs: 30 * MIN, startMs: 10 * MIN, startNoRelaunchMs: 30 * MIN, capabilityMs: 20 * MIN, lockMs: 15 * MIN });

const id8 = (s) => String(s).slice(0, 8);

/** "2 desktop copy(ies) and 1 installed terminal copy(ies)" for a list of session-sync copies. */
export function copyWords(list) {
  const cli = list.filter((c) => c.kind === 'cli').length;
  const desk = list.length - cli;
  return [desk ? `${desk} desktop copy(ies)` : null, cli ? `${cli} installed terminal copy(ies)` : null].filter(Boolean).join(' and ');
}

/** What to do about copies that cannot filter: the desktop app refreshes its own at start; the terminal one needs an update. */
function copyHints(list) {
  const h = [];
  if (list.some((c) => c.kind !== 'cli')) h.push('Disable and enable session-sync in the app plugin manager');
  const cli = list.filter((c) => c.kind === 'cli');
  if (cli.length) h.push(`Update the terminal copy: claude plugin update session-sync@${cli[0].marketplace ?? '<marketplace>'} --scope user`);
  return h.join('. ');
}

/* ------------------------------------------------------------------ listings and the expected set */

/** Per folder: the record ids and tombstone ids it holds. */
export function readListing(ctx) {
  const out = [];
  for (const f of listFolders(ctx.store)) {
    const records = []; const tombs = [];
    let names = [];
    try { names = readdirSync(f.path); } catch { /* unreadable: empty */ }
    for (const n of names) {
      let m = RECORD.exec(n);
      if (m) { records.push(m[1].toLowerCase()); continue; }
      m = TOMB.exec(n);
      if (m) tombs.push(m[1].toLowerCase());
    }
    out.push({ key: f.key, path: f.path, records, tombs });
  }
  return out;
}

/**
 * What the link must leave in every folder: the union of record ids minus any id with a tombstone
 * (a tombstone means the link may delete or restore it, so it is not a hard expectation).
 */
export function expectedSet(listing) {
  const union = new Set(); const tomb = new Set();
  for (const f of listing) { for (const i of f.records) union.add(i); for (const t of f.tombs) tomb.add(t); }
  const expected = [...union].filter((i) => !tomb.has(i)).sort();
  return { union: union.size, expected, undetermined: union.size - expected.length, folders: listing.length };
}

/** The post-link check: every folder holds every expected id, split 0, missing 0, all in the group. */
export function verifyLinked(ctx, expected, folderCount) {
  const problems = [];
  const st = loadState(ctx);
  const listing = readListing(ctx);
  const group = groupOf(st, listFolders(ctx.store));
  const groupKeys = new Set(group.map((f) => f.key));
  const health = group.length >= 2 ? groupHealth(group) : null;
  if (!st.linked) problems.push('the accounts are not marked as linked');
  if (rollbackActive(ctx)) problems.push('a rollback marker is present');
  if (!health) problems.push('no link group was found');
  else {
    if (health.split !== 0) problems.push(`${health.split} conversation(s) are split`);
    if (health.missing !== 0) problems.push(`${health.missing} conversation(s) are missing a name in some folder`);
  }
  if (listing.length !== folderCount) problems.push(`expected ${folderCount} account folders, found ${listing.length}`);
  const present = new Map();
  for (const f of listing) {
    if (!groupKeys.has(f.key)) problems.push(`folder ${id8(f.key)} is not part of the link group`);
    const have = new Set(f.records);
    for (const i of have) present.set(i, (present.get(i) ?? 0) + 1);
    const missing = expected.filter((i) => !have.has(i));
    if (missing.length) problems.push(`folder ${id8(f.key)} lacks ${missing.length} expected conversation(s), first: ${missing.slice(0, 3).join(', ')}`);
  }
  const partial = [...present].filter(([, n]) => n !== listing.length).map(([i]) => i);
  if (partial.length) problems.push(`${partial.length} conversation(s) exist in only some folders, first: ${partial.slice(0, 3).join(', ')}`);
  return { problems, ids: present.size, folders: listing.length, health };
}

/* ------------------------------------------------------------------ files */

export const readGoLive = (ctx) => readJson(goLiveFile(ctx), null);
export const readGoLiveResult = (ctx) => readJson(goLiveResultFile(ctx), null);

function glog(ctx, line) {
  try { mkdirSync(dirname(goLiveLogFile(ctx)), { recursive: true }); appendFileSync(goLiveLogFile(ctx), `${new Date(ctx.now()).toISOString()}  ${line}\n`); } catch { /* best effort */ }
}

function writeResult(ctx, gl, status, extra = {}) {
  const now = new Date(ctx.now()).toISOString();
  const final = FINAL_STATUSES.includes(status);
  const backupId = gl.backupId ?? null;
  writeJsonAtomic(goLiveResultFile(ctx), {
    v: 1, id: gl.id, status, phase: gl.phase, resumable: status === 'waiting' || status === 'failed',
    startedAt: gl.createdAt, updatedAt: now, finishedAt: final ? now : null,
    counts: gl.counts ?? {}, backupId,
    rollbackScript: backupId ? accPath(ctx, 'backup', backupId, 'rollback.mjs') : null,
    push: { pausedByGoLive: !!gl.pausedPush, reEnabled: !!gl.pushReEnabled, enabledBefore: gl.before?.pushEnabled ?? null },
    relaunch: gl.relaunch ?? null,
    messages: gl.messages ?? [], attention: gl.attention ?? [], log: goLiveLogFile(ctx),
    ...extra,
  });
}

function saveGoLive(ctx, gl) { writeJsonAtomic(goLiveFile(ctx), gl); }

/* ------------------------------------------------------------------ runner claim (single runner) */

export function runnerAlive(ctx) {
  const c = readJson(claimFile(ctx), null);
  return !!c && pidAlive(c.pid) && ctx.now() - (c.beatAt ?? c.at ?? 0) < CLAIM_STALE_MS;
}

function claimRunner(ctx) {
  const file = claimFile(ctx);
  mkdirSync(dirname(file), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(file, 'wx');
      try { writeSync(fd, JSON.stringify({ pid: process.pid, at: ctx.now(), beatAt: ctx.now() })); } finally { closeSync(fd); }
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (runnerAlive(ctx)) return false;
      try { unlinkSync(file); } catch { /* raced */ }
    }
  }
  return false;
}
/** Refresh the claim, but only while it is ours: a runner that lost its claim must not overwrite the new holder's. */
const beatClaim = (ctx) => {
  try {
    const c = readJson(claimFile(ctx), null);
    if (!c || c.pid !== process.pid) return;
    writeFileSync(claimFile(ctx), JSON.stringify({ pid: process.pid, at: c.at ?? ctx.now(), beatAt: ctx.now() }));
  } catch { /* best effort */ }
};
const releaseClaim = (ctx) => { const c = readJson(claimFile(ctx), null); if (!c || c.pid === process.pid) { try { unlinkSync(claimFile(ctx)); } catch { /* none */ } } };

/* ------------------------------------------------------------------ preflight, consent and the first state */

/** Read-only. {ok:false, reason, text} or {ok:true, ...summary}. */
export function planGoLive(ctx, deps = {}) {
  const folders = listFolders(ctx.store);
  const accts = accountsOf(folders);
  const st = loadState(ctx);
  if (accts.length < 2) return { ok: false, reason: 'one-account', text: 'Only one account is on this machine; there is nothing to link.' };
  if (st.linked) return { ok: false, reason: 'already-linked', text: 'The accounts are already linked. Check with: accounts status. Undo with: accounts rollback (app closed).' };
  if (rollbackActive(ctx)) return { ok: false, reason: 'rollback-active', text: 'A rollback was interrupted. Quit Claude from the tray icon and run: accounts rollback' };
  const listing = readListing(ctx);
  const exp = expectedSet(listing);
  if (exp.expected.length === 0) return { ok: false, reason: 'empty', text: 'The store holds no conversations; nothing to link.' };
  const copies = (deps.copies ?? sessionSyncCopies)(ctx);
  return {
    ok: true, accounts: accts.length, folders: folders.length, conversations: exp.union, expected: exp.expected.length,
    undetermined: exp.undetermined, copies, stale: copies.filter((c) => !c.capable), listing, exp,
  };
}

/**
 * Record consent (same effect as `accounts answer yes`), pause push when a copy of session-sync lacks the
 * capability, save the before-state and the expected set, write the first result (`waiting`).
 */
export function beginGoLive(ctx, plan, opts = {}, deps = {}) {
  const getPush = deps.getPush ?? (() => true);
  const setPush = deps.setPush ?? (() => {});
  const now = ctx.now();
  const pushEnabled = !!getPush();
  let pausedPush = false;
  if (plan.stale.length && pushEnabled) { setPush(false); pausedPush = true; }
  const st = loadState(ctx);
  const folders = listFolders(ctx.store);
  const pend = pendingPairs(st, accountsOf(folders), { includeNo: true });
  if (pend.length) answerPairs(st, pend, 'yes', 'go-live', now);
  saveState(ctx, st);
  const gl = {
    v: 1, id: `gl-${now}`, createdAt: new Date(now).toISOString(),
    opts: { noRelaunch: !!opts.noRelaunch, quitApp: !!opts.quitApp },
    phase: PHASES[0], deadlines: {}, messages: [], flags: {}, pausedPush, pushReEnabled: false,
    before: {
      at: new Date(now).toISOString(), accounts: accountsOf(folders).map(id8), pairs: Object.keys(st.pairs ?? {}).length,
      pushEnabled, folders: plan.listing.map((f) => ({ key: f.key, records: f.records.length, tombstones: f.tombs.length })),
      copies: plan.copies.map((c) => ({ path: c.path, version: c.version, capable: c.capable })),
    },
    expected: plan.exp.expected,
    counts: { accounts: plan.accounts, folders: plan.folders, conversations: plan.conversations, expected: plan.expected },
  };
  if (pausedPush) gl.messages.push(`Push is paused: ${copyWords(plan.stale)} of session-sync cannot filter mirrored records. It is switched back on when every copy has the capability.`);
  // reports of earlier go-lives are not needed any more
  try { for (const n of readdirSync(dirname(goLiveFile(ctx)))) if (n.startsWith('go-live-reported-') && !n.startsWith(`go-live-reported-${gl.id}-`)) unlinkSync(accPath(ctx, n)); } catch { /* best effort */ }
  saveGoLive(ctx, gl);
  writeResult(ctx, gl, 'waiting');
  glog(ctx, `go-live begun: ${plan.accounts} accounts, ${plan.folders} folders, ${plan.conversations} conversations, ${plan.expected} expected; push ${pausedPush ? 'paused by go-live' : pushEnabled ? 'left on' : 'already off'}`);
  return gl;
}

/** An unfinished go-live (status waiting, or failed with a resumable phase), else null. */
export function goLiveInProgress(ctx) {
  const gl = readGoLive(ctx); const res = readGoLiveResult(ctx);
  if (!gl || !res || gl.id !== res.id) return null;
  if (res.status === 'waiting' || res.status === 'failed') return { gl, result: res };
  return null;
}

/** For the SessionStart step: an unfinished go-live with no live runner gets one launched. */
export function resumeIfDead(ctx, launch) {
  const p = goLiveInProgress(ctx);
  if (!p || runnerAlive(ctx) || p.result.status !== 'waiting') return { resumed: false };
  const r = launch(['accounts', 'golive-run']);
  glog(ctx, `runner was not alive; relaunched (${r?.method ?? 'unknown'}, ok ${!!r?.ok})`);
  return { resumed: !!r?.ok, launch: r };
}

/* ------------------------------------------------------------------ the SessionStart report */

const MID_RUN_PHASES = ['relaunch', 'wait-start', 'wait-capability', 'rectify', 'remote', 'finish'];

/** Claim "tell a session about <key>" once across sessions that start together (`wx`). */
function claimReport(ctx, key) {
  const file = accPath(ctx, `go-live-reported-${key}`);
  try { mkdirSync(dirname(file), { recursive: true }); closeSync(openSync(file, 'wx')); return true; } catch { return false; }
}

/** One or two plain lines for a go-live result. Pure. */
export function goLiveReportText(res) {
  const c = res.counts ?? {};
  const facts = [
    Number.isFinite(c.expected) ? `${c.expected} conversation(s) in ${c.folders ?? '?'} folder(s)` : null,
    Number.isFinite(c.remoteDuplicates) ? `${c.remoteDuplicates} remote duplicate(s)` : null,
  ].filter(Boolean).join(', ');
  const paused = res.status !== 'ok' && res.push?.pausedByGoLive && !res.push?.reEnabled ? 'Push is paused by go-live and stays off until it finishes or you run: config enabled true.' : '';
  const log = `${paused ? `${paused} ` : ''}Log: ${res.log}`;
  const first = (list, n) => list.slice(0, n).join(' ');
  if (res.status === 'failed' && res.resumable) {
    return `session-sync: the account go-live stopped at phase "${res.phase}". ${first((res.messages ?? []).slice(-1), 1)} Run: accounts go-live (it resumes). ${log}`.replace(/\s+/g, ' ');
  }
  if (!FINAL_STATUSES.includes(res.status)) {
    return `session-sync: the account go-live is still running (phase "${res.phase}", after the restart). Its result is shown at the next session start. Follow it with: accounts status. ${log}`;
  }
  if (res.status === 'ok') return `session-sync: the account go-live finished. The accounts are linked${facts ? ` (${facts})` : ''}. No action needed here; the after-go-live checklist in /session-sync:accounts lists what is left to do by hand. ${log}`;
  if (res.status === 'attention') return `session-sync: the account go-live finished but needs you${facts ? ` (${facts})` : ''}. ${first(res.attention?.length ? res.attention : (res.messages ?? []).slice(-1), 2)} ${log}`.replace(/\s+/g, ' ');
  if (res.status === 'rolled_back') return `session-sync: the account go-live was rolled back; nothing is linked. ${first((res.messages ?? []).slice(-2), 2)} ${log}`.replace(/\s+/g, ' ');
  return `session-sync: the account go-live failed. ${first((res.messages ?? []).slice(-1), 1)} ${log}`.replace(/\s+/g, ' ');
}

/**
 * For the SessionStart step: text for a go-live result no session has been told about yet (a final
 * result once; a mid-run notice once per phase after the app restarts), else null. Cheap: one JSON read
 * and at most one `wx` file create. It never throws.
 */
export function takeGoLiveReport(ctx) {
  try {
    const res = readGoLiveResult(ctx);
    if (!res?.id) return null;
    if (FINAL_STATUSES.includes(res.status)) {
      return claimReport(ctx, `${res.id}-${res.status}`) ? goLiveReportText(res) : null;
    }
    if (res.status === 'waiting' && MID_RUN_PHASES.includes(res.phase) && runnerAlive(ctx)) {
      return claimReport(ctx, `${res.id}-mid-${res.phase}`) ? goLiveReportText(res) : null;
    }
    return null;
  } catch { return null; }
}

/* ------------------------------------------------------------------ the runner */

const END = Symbol('end');

/**
 * Run (or resume) the go-live. Returns {exit, status?}. exit: done | already-running | no-go-live | halted | failed.
 * `deps.haltAfter` (tests only) stops after that phase and leaves everything as persisted.
 */
export async function runGoLive(ctx, deps = {}) {
  const T = { ...DEFAULT_TIMEOUTS, ...(deps.timeouts ?? {}) };
  const testPoll = Number(process.env.SESSION_SYNC_TEST_POLL_MS) || 0;
  const pollMs = deps.pollMs ?? (testPoll || 30 * 1000);
  const gapMs = deps.gapMs ?? (testPoll || 10 * 1000);
  const probeEveryMs = deps.probeEveryMs ?? (testPoll || 10 * MIN);
  const clock = deps.clock ?? Date.now;
  const realSleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
  const sleep = deps.sleep ?? realSleep;
  const doLink = deps.link ?? link;
  const doRollback = deps.rollback ?? defaultRollback;
  const doRelaunch = deps.relaunch ?? ((c) => relaunchApp(c));
  const getPush = deps.getPush ?? (() => true);
  const setPush = deps.setPush ?? (() => {});
  const copies = deps.copies ?? sessionSyncCopies;
  const doFullPass = deps.fullPass ?? fullPass;

  let gl = readGoLive(ctx);
  if (!gl) return { exit: 'no-go-live' };
  const prev = readGoLiveResult(ctx);
  if (prev && prev.id === gl.id && FINAL_STATUSES.includes(prev.status) && prev.status !== 'failed') return { exit: 'done', status: prev.status };
  if (!claimRunner(ctx)) return { exit: 'already-running' };

  // true only when THIS process ran the link and has not seen the app since; a resume or a link by another pass
  // (the waiter) means the app may have saved a record since, so the verify step runs a pass first
  let linkedThisRun = false;
  const log = (line) => glog(ctx, line);
  const note = (msg) => { gl.messages.push(msg); log(msg); };
  const save = () => saveGoLive(ctx, gl);
  const beat = () => beatClaim(ctx);
  let lastProbe = -Infinity;
  const stopped = () => {
    const now = clock();
    const probe = !lockfilePresent(ctx) || now - lastProbe >= probeEveryMs;
    if (probe) lastProbe = now;
    if (deps.appStatus) return !!deps.appStatus(ctx).fullAllowed;
    return !!appState({ ctx, probeProcesses: probe, now: ctx.now() }).fullAllowed;
  };
  const running = () => (deps.appStatus ? !!deps.appStatus(ctx).running : !!appState({ ctx, probeProcesses: true, now: ctx.now() }).running);
  const deadline = (name, ms) => { gl.deadlines[name] ??= clock() + ms; return gl.deadlines[name]; };
  const finalize = (status, msg) => {
    if (msg) note(msg);
    if (status === 'ok' && gl.flags.attention) status = 'attention';
    gl.phase = status === 'failed' ? gl.phase : 'done';
    save();
    writeResult(ctx, gl, status);
    log(`result: ${status}`);
    return END;
  };
  const attention = (msg) => { gl.flags.attention = true; (gl.attention ||= []).push(msg); note(msg); };

  /** Wait until the app is stopped on two readings a gap apart. 'ok' | 'timeout'. */
  async function waitStopped(name, ms) {
    const dl = deadline(name, ms);
    let neg = 0; let firstNeg = 0;
    for (;;) {
      beat();
      const now = clock();
      if (now >= dl) { delete gl.deadlines[name]; save(); return 'timeout'; }
      if (stopped()) { if (!neg) firstNeg = now; neg++; } else neg = 0;
      if (neg >= 2 && now - firstNeg >= gapMs) { delete gl.deadlines[name]; save(); return 'ok'; }
      await sleep(pollMs);
    }
  }

  /** Wait while another process holds accounts.lock (and lives). 'free' | 'timeout'. */
  async function waitLockFree(lockDl) {
    for (;;) {
      beat();
      const h = readJson(accPath(ctx, 'accounts.lock'), null);
      const alive = !!h && h.pid !== process.pid && pidAlive(h.pid) && Date.now() - (h.at ?? 0) < LOCK_TTL_MS; // the lock file is stamped with the real clock (lock.mjs)
      if (!alive) return 'free';
      if (clock() >= lockDl) return 'timeout';
      await sleep(pollMs);
    }
  }

  async function rollbackFlow(why) {
    note(`PROBLEM: ${why}. Rolling back.`);
    const st = loadState(ctx);
    if (!st.backupId) return finalize('failed', 'There is no backup to roll back to. Nothing more was done.');
    gl.backupId = st.backupId; save();
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (!stopped()) gl.appSeenSinceLink = true;
      const w = await waitStopped('rollback-stop', T.stopMs);
      if (w === 'timeout') return finalize('failed', `The app did not stop, so the rollback did not run. Quit Claude from the tray icon, then run: accounts rollback`);
      let r;
      // --exact (task files byte for byte, checked) whenever the app has not run since the link
      try { r = await doRollback(ctx, { exact: !gl.appSeenSinceLink }); } catch (e) { r = { ok: false, error: String(e?.message ?? e) }; }
      log(`rollback attempt ${attempt}: ${r.ok ? 'ok' : `failed (${r.code ?? r.error ?? 'unknown'})`}`);
      if (r.ok) {
        note('Rollback finished. The store is back to its pre-link state; nothing is linked.');
        if (gl.pausedPush) { try { setPush(true); gl.pushReEnabled = true; note('Push is back on (nothing is linked).'); } catch (e) { attention(`Could not switch push back on: ${e?.message ?? e}. Run: config enabled true`); } }
        if (!gl.opts.noRelaunch) {
          const rl = await doRelaunch(ctx);
          gl.relaunch = rl; note(rl?.ok ? 'Claude was started again.' : `Could not start Claude (${rl?.error ?? 'unknown'}). Open it yourself.`);
        }
        return finalize('rolled_back', null);
      }
      if (r.errors?.length) {
        // the script finished and reset its state, so another run cannot help: say what does not match
        return finalize('failed', `The rollback finished, but ${r.errors.length} file(s) do not match the backup (first: ${r.errors.slice(0, 3).join(', ')}). The state before the rollback is saved${r.snapshot ? ` in ${r.snapshot}` : ''}. Nothing more was done; look at those files before anything else.`);
      }
      // a run that stopped part way keeps its state and a second run finishes it; once the state is reset it cannot
      if (!loadState(ctx).backupId) break;
    }
    return finalize('failed', `The rollback did not finish. Quit Claude from the tray icon, then run: accounts rollback  (standalone copy: ${accPath(ctx, 'backup', gl.backupId, 'rollback.mjs')})`);
  }

  const steps = {
    async 'wait-stop'() {
      if (gl.opts.quitApp && !gl.quitRequested && running()) {
        // the runner asks, a few seconds in, so the go-live command has already returned to the agent that ran it
        await sleep(deps.quitDelayMs ?? (testPoll || 5000));
        let q;
        try { q = await (deps.requestQuit ?? requestAppQuit)(); } catch (e) { q = { supported: true, requested: false, reason: String(e?.message ?? e) }; }
        gl.quitRequested = true; save();
        if (q?.requested) note(q.slow ? 'Asked Claude to quit; it is still closing down.' : 'Asked Claude to quit.');
        else note(`Claude could not be asked to quit (${q?.reason ?? 'unknown'}). Quit it from the tray icon or the app menu. Closing the window only hides it.`);
      } else note('Waiting for the Claude app to stop. Quit it from the tray icon or the app menu.');
      const r = await waitStopped('wait-stop', T.stopMs);
      if (r === 'timeout') {
        return finalize('failed', 'Timed out waiting for the app to stop. Your answer is still recorded. Quit Claude, then run: accounts go-live (it resumes).');
      }
      return 'relist';
    },

    async relist() {
      const exp = expectedSet(readListing(ctx));
      if (exp.expected.length !== gl.expected.length) note(`The store changed since the summary: ${gl.expected.length} -> ${exp.expected.length} expected conversations. Using the new list.`);
      gl.expected = exp.expected;
      gl.counts = { ...gl.counts, folders: exp.folders, conversations: exp.union, expected: exp.expected.length };
      return 'link';
    },

    async link() {
      const lockDl = clock() + T.lockMs;
      for (;;) {
        beat();
        const st0 = loadState(ctx);
        if (st0.linked) {
          gl.backupId = st0.backupId; gl.appSeenSinceLink = true; save();
          note('The accounts are already linked (another pass did it); verifying.');
          return 'verify';
        }
        let res;
        try { res = await doLink(ctx, { reasons: ['go-live'] }); } catch (e) { return rollbackFlow(`the link threw: ${e?.message ?? e}`); }
        beat();
        if (res.ok) {
          linkedThisRun = true; gl.appSeenSinceLink = false;
          gl.backupId = res.backupId ?? loadState(ctx).backupId; save();
          log(`linked (backup ${gl.backupId})`);
          await deps.afterLink?.(ctx);
          return 'verify';
        }
        const why = res.reason ?? (res.aborted ? 'aborted' : 'unknown');
        if (why === 'app-running' || why === 'app-started') { note('The app came back during the link; waiting for it to stop again.'); return 'wait-stop'; }
        if (why === 'locked') {
          log('another pass holds the accounts lock; waiting while its holder lives');
          if (await waitLockFree(lockDl) === 'timeout') return finalize('failed', 'Another pass held the accounts lock for too long. Run: accounts go-live (it resumes).');
          continue;
        }
        if (why === 'rollback-active') return finalize('failed', 'A rollback is active or was interrupted. Quit Claude and run: accounts rollback');
        if (why === 'no-group') return finalize('failed', 'No account pair is answered yes, so there is nothing to link.');
        return rollbackFlow(`the link did not finish (${why})`);
      }
    },

    async verify() {
      // The app's own save breaks a hard link, so a split seen while the app runs says nothing about the link. Judge (and
      // roll back) only with the app stopped, after one full pass when the app may have run since the link (a resume,
      // or another pass such as the waiter did the link).
      if (!linkedThisRun) gl.appSeenSinceLink = true;
      let needPass = !!gl.appSeenSinceLink;
      const lockDl = clock() + T.lockMs;
      let v;
      for (let round = 0; ; round++) {
        beat();
        if (round > 5) return finalize('failed', 'The app kept starting while the link was being checked. The link is in place and was not rolled back. Quit Claude, then run: accounts go-live (it resumes).');
        if (!stopped()) {
          gl.appSeenSinceLink = true; needPass = true; save();
          note('The app is running; the check waits until it has stopped.');
          if (await waitStopped('verify-stop', T.stopMs) === 'timeout') return finalize('failed', 'Timed out waiting for the app to stop before the check. The link is in place and was not rolled back. Quit Claude, then run: accounts go-live (it resumes).');
          continue;
        }
        if (needPass) {
          let p;
          try { p = await doFullPass(ctx, { reasons: ['go-live'] }); } catch (e) { p = { ok: false, reason: String(e?.message ?? e) }; }
          beat();
          log(`verify: pass ${p?.ok ? 'ok' : `did not finish (${p?.reason ?? 'unknown'})`}`);
          if (!p?.ok && (p?.reason === 'app-running' || p?.reason === 'app-started')) { gl.appSeenSinceLink = true; continue; }
          if (!p?.ok && p?.reason === 'locked') {
            if (await waitLockFree(lockDl) === 'timeout') return finalize('failed', 'Another pass held the accounts lock for too long. Run: accounts go-live (it resumes).');
            continue;
          }
          if (!p?.ok && p?.reason === 'rollback-active') return finalize('failed', 'A rollback is active or was interrupted. Quit Claude and run: accounts rollback');
          needPass = false;   // any other result: the check below judges the store itself
        }
        v = verifyLinked(ctx, gl.expected, gl.counts.folders);
        if (v.problems.length && !stopped()) { gl.appSeenSinceLink = true; needPass = true; continue; }   // the app started while we looked
        break;
      }
      if (v.problems.length) { for (const p of v.problems) log(`verify: ${p}`); return rollbackFlow(`the post-link check failed: ${v.problems.slice(0, 3).join('; ')}`); }
      gl.counts.ids = v.ids; gl.counts.split = v.health.split; gl.counts.missing = v.health.missing;
      note(`Verified: all ${gl.expected.length} expected conversations are in all ${v.folders} folders, 0 split, 0 missing.`);
      return 'relaunch';
    },

    async relaunch() {
      if (gl.opts.noRelaunch) { note('Not relaunching Claude (--no-relaunch). Start it yourself.'); return 'wait-start'; }
      const rl = await doRelaunch(ctx);
      gl.relaunch = rl;
      if (rl?.ok) log(`relaunch: ${rl.method}${rl.aumid ? ` ${rl.aumid}` : ''}`);
      else attention(`Could not start Claude (${rl?.error ?? 'unknown'}). Open it yourself.`);
      return 'wait-start';
    },

    async 'wait-start'() {
      const dl = deadline('wait-start', gl.opts.noRelaunch ? T.startNoRelaunchMs : T.startMs);
      for (;;) {
        beat();
        if (running()) { gl.appStarted = true; delete gl.deadlines['wait-start']; log('the app is running'); return 'wait-capability'; }
        if (clock() >= dl) { gl.appStarted = false; delete gl.deadlines['wait-start']; attention('Claude did not start in time. Open it, then run: accounts rectify'); return 'wait-capability'; }
        await sleep(pollMs);
      }
    },

    async 'wait-capability'() {
      const lacking = () => copies(ctx).filter((c) => !c.capable);
      // the app refreshes its own copies at start; a terminal copy changes only when someone updates it, so it is not waited for
      const lackingDesktop = () => lacking().filter((c) => c.kind !== 'cli');
      if (gl.appStarted !== false && lackingDesktop().length) {
        note(`Waiting for ${copyWords(lackingDesktop())} of session-sync to refresh (the app does this at start).`);
        const dl = deadline('wait-capability', T.capabilityMs);
        while (lackingDesktop().length && clock() < dl) { beat(); await sleep(pollMs); }
        delete gl.deadlines['wait-capability'];
      }
      const stillLacking = lacking();
      if (stillLacking.length) {
        if (gl.pausedPush) attention(`Push stays PAUSED: ${copyWords(stillLacking)} of session-sync still lack the account feature. ${copyHints(stillLacking)}, then run: config enabled true`);
        else attention(`${copyWords(stillLacking)} of session-sync still lack the account feature. ${copyHints(stillLacking)}.`);
      } else if (gl.pausedPush) {
        try { setPush(true); gl.pushReEnabled = true; note('Every copy of session-sync has the account feature. Push is switched back on.'); } catch (e) { attention(`Could not switch push back on: ${e?.message ?? e}. Run: config enabled true`); }
      } else if (getPush() === false) {
        note('Push was already paused before go-live, so it stays paused. Switch it on with: config enabled true');
      }
      return 'rectify';
    },

    async rectify() {
      try {
        beat();
        const r = await deps.rectify?.(ctx);
        beat();
        if (r && !r.ok && !r.skipped) attention(`The rectify pass did not finish (${r.reason ?? 'unknown'}). Run: accounts rectify`);
        else log(`rectify: ${r ? (r.skipped ? `skipped (${r.skipped})` : 'ok') : 'not wired'}`);
      } catch (e) { attention(`The rectify pass failed: ${e?.message ?? e}. Run: accounts rectify`); }
      return 'remote';
    },

    async remote() {
      let r = null;
      beat();
      try { r = await deps.remoteCheck?.(ctx); } catch (e) { r = { checked: false, reason: String(e?.message ?? e) }; }
      beat();
      if (!r) { note('The remote duplicate check is not wired.'); return 'finish'; }
      if (!r.checked) {
        if (r.notConfigured) note(`Remote duplicate check skipped: ${r.reason}.`);
        else attention(`The remote duplicate check did not run: ${r.reason}. Run: accounts status --remote`);
        return 'finish';
      }
      gl.counts.remoteIds = r.ids; gl.counts.remoteDuplicates = r.duplicates;
      if (Number(r.duplicates) !== 0) {
        try { setPush(false); } catch { /* reported below */ }
        if (gl.before?.pushEnabled !== false) { gl.pausedPush = true; gl.pushReEnabled = false; }   // the result must not say push is back on
        attention(`The remote holds ${r.duplicates} conversation(s) under more than one folder (expected 0). Push is PAUSED. Nothing was deleted. Look at it before running: config enabled true`);
      } else note(r.neverPushed ? 'Remote: nothing has been pushed yet, so 0 records and 0 duplicates.' : `Remote: ${r.ids} record(s), 0 duplicates.`);
      return 'finish';
    },

    async finish() { return finalize('ok', null); },
  };

  // a timer keeps the claim fresh while a long step awaits; it cannot fire during a synchronous step, hence the window above
  const hbTimer = setInterval(beat, deps.heartbeatMs ?? HEARTBEAT_MS);
  hbTimer.unref?.();
  try {
    if (prev?.id === gl.id && prev.status === 'failed') { gl.deadlines = {}; log('resuming after a stopped run'); }
    log(`runner started (pid ${process.pid}), phase ${gl.phase}`);
    writeResult(ctx, gl, 'waiting');
    for (;;) {
      if (gl.phase === 'done') break;
      const fn = steps[gl.phase];
      if (!fn) { finalize('failed', `Unknown phase "${gl.phase}" in the go-live state.`); break; }
      await deps.onPhase?.(gl.phase);
      log(`phase: ${gl.phase}`);
      const done = gl.phase;
      const next = await fn();
      if (next === END) break;
      gl.phase = next; save(); writeResult(ctx, gl, 'waiting');
      if (deps.haltAfter === done) return { exit: 'halted' };
    }
    return { exit: 'done', status: readGoLiveResult(ctx)?.status };
  } catch (e) {
    note(`The runner stopped on an error: ${e?.message ?? e}. Run: accounts go-live (it resumes).`);
    save(); writeResult(ctx, gl, 'failed');
    return { exit: 'failed', status: 'failed' };
  } finally {
    clearInterval(hbTimer);
    releaseClaim(ctx);
  }
}

/**
 * The real rollback: the standalone script of the pre-link backup, run with the app closed. It runs as an async child
 * (not spawnSync) so the runner's heartbeat keeps beating for up to 30 minutes. `--json` gives the files that did not
 * match the backup and the snapshot path. `o`: { exact, spawnFn, timeoutMs }.
 * @returns {Promise<{ok:boolean, code?:number|null, errors?:string[], snapshot?:string, error?:string}>}
 */
export function defaultRollback(ctx, o = {}) {
  const st = loadState(ctx);
  const script = st.backupId ? accPath(ctx, 'backup', st.backupId, 'rollback.mjs') : null;
  if (!script) return Promise.resolve({ ok: false, error: 'no backup' });
  return new Promise((resolve) => {
    let out = ''; let done = false; let timer = null; let child;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    try {
      child = (o.spawnFn ?? spawn)(process.execPath, [script, '--json', ...(o.exact ? ['--exact'] : [])], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { finish({ ok: false, error: String(e?.message ?? e) }); return; }
    timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish({ ok: false, code: null, error: 'the rollback timed out' }); }, o.timeoutMs ?? 30 * MIN);
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', () => {});
    child.on('error', (e) => finish({ ok: false, error: String(e?.message ?? e) }));
    child.on('close', (code) => {
      let parsed = null;
      try { parsed = JSON.parse(out.trim().split(/\r?\n/).pop()); } catch { /* no JSON: refused or failed part way */ }
      finish({ ok: code === 0, code, errors: parsed?.errors?.length ? parsed.errors : undefined, snapshot: parsed?.snapshot });
    });
  });
}
