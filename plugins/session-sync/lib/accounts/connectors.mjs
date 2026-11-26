/**
 * connectors.mjs - the connector check after an account switch (0.5.14; background run 0.5.15).
 *
 * The app keeps no local list of the connectors an account has connected, and a connector that is missing on the new account is not reported
 * as failed anywhere: a scheduled task that needs it just runs without it. What a run does record is its tool surface: the transcript of each
 * run (~/.claude/projects/<cwd key>/<cliSessionId>.jsonl) carries one `deferred_tools_delta` attachment whose `addedNames` lists every tool
 * available in that run, claude.ai connectors as `mcp__<connectorUuid>__<tool>`. So the check is reactive: for each enabled scheduled task it
 * compares the last run before the switch with the first run after it.
 *
 *   marker  connector-check.json (beside switch-history.json): {v:1, switchAt, from, to, createdAt, checked:{<taskId>:{at,status}}, lastCheckAt (hook throttle)}.
 *           Written by the live pass right after recordSwitch (a small file; the pass holds the accounts lock). It retires when every enabled task is
 *           checked, or 8 days after it was written.
 *   run     The SessionStart hook never scans (0.5.15): it reads the marker, applies the 15 minute throttle and, when due, starts
 *           `cli.mjs accounts connector-check --background` as a hidden detached process (connectorHookStep) and returns at once. A claim file
 *           (connector-check.claim, stale after CLAIM_STALE_MS) lets only one background check run at a time. The background run does the full,
 *           unbudgeted check. Before it writes flags, the notice or a toast, and again before it rewrites the marker, it re-reads the marker and
 *           drops its result when switchAt changed (the live pass wrote a newer switch meanwhile).
 *   flags   connector-flags.json: what the check found, kept after the marker retires; feeds the notice file and the once-only context line.
 *   notice  CONNECTORS-MISSING.md in the session-sync state directory (the parent of the accounts folder).
 *
 * Connectors that matter for a task: the ones its pre-switch run called (tool_use names mcp__<uuid>__<tool>) plus every connector uuid
 * written in its prompt file. A connector is missing when none of its tools is available in the post-switch run. When its tool names are
 * available under another uuid (connector uuids differ between accounts), that is only reported when the prompt hardcodes the old uuid.
 *
 * Privacy: a transcript is streamed and only tool names and the attachment's name list are read; no line is kept, printed or logged.
 */

import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync, existsSync, unlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as nodeSpawn } from 'node:child_process';
import { accPath, readJson, writeJsonAtomic } from './state.mjs';
import { listFolders } from './folders.mjs';
import { claudeHome } from '../paths.mjs';

const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');
export const EXPIRE_MS = 8 * 24 * 60 * 60 * 1000;
const LOOKBACK_MS = 21 * 24 * 60 * 60 * 1000;   // how far before the switch a task's last run is searched for
const PRE_SCAN_CAP = 256 * 1024 * 1024;         // bytes of one pre-switch transcript read for tool_use names
const PRE_RUNS = 3;                             // pre-switch runs whose called connectors make up the baseline
export const HOOK_THROTTLE_MS = 15 * 60 * 1000;  // the SessionStart hook checks at most this often
export const CLAIM_STALE_MS = 30 * 60 * 1000;   // a background check that holds the claim longer than this is taken to be dead
const POST_SCAN_LINES = 400;                    // the tool list sits in the first lines of a run

export const markerFile = (ctx) => accPath(ctx, 'connector-check.json');
const claimFilePath = (ctx) => accPath(ctx, 'connector-check.claim');
export const flagsFile = (ctx) => accPath(ctx, 'connector-flags.json');
export const noticeFile = (ctx) => join(dirname(ctx.acc), 'CONNECTORS-MISSING.md');

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TOOL_NAME = new RegExp(`^mcp__(${UUID})__(.+)$`, 'i');
const PROMPT_TOOL = new RegExp(`mcp__(${UUID})__([A-Za-z0-9_.-]+)`, 'gi');
const PROMPT_UUID = new RegExp(UUID, 'gi');
const msOf = (v) => (typeof v === 'number' ? v : Date.parse(v));
const iso = (ms) => new Date(ms).toISOString();
const short = (u) => String(u ?? '').slice(0, 8);
const safeKey = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');

/* ------------------------------------------------------------------ marker */

/** The live pass noted a switch at `at` (ms): leave a "check pending" marker. Never throws. */
export function writeConnectorMarker(ctx, { at, from, to }) {
  try {
    writeJsonAtomic(markerFile(ctx), { v: 1, switchAt: iso(at), from: from ?? null, to: to ?? null, createdAt: iso(ctx.now()), checked: {} });
    // a notice and flags from an older switch must not outlive it: the next check rewrites them for this one
    for (const f of [noticeFile(ctx), flagsFile(ctx)]) { try { unlinkSync(f); } catch { /* none */ } }
    return true;
  } catch { return false; }
}

export function readConnectorMarker(ctx) {
  const m = readJson(markerFile(ctx), null);
  return m && typeof m === 'object' && Number.isFinite(Date.parse(m.switchAt)) ? m : null;
}

/* ------------------------------------------------------------------ pure comparison */

const splitName = (n) => { const m = TOOL_NAME.exec(String(n)); return m ? { uuid: m[1].toLowerCase(), tool: m[2] } : null; };

/** { uuid -> Set(tool) } of the connector tools in a name list. */
function byConnector(names) {
  const out = new Map();
  for (const n of names ?? []) {
    const p = splitName(n);
    if (!p) continue;
    if (!out.has(p.uuid)) out.set(p.uuid, new Set());
    out.get(p.uuid).add(p.tool);
  }
  return out;
}

const NAME_HINTS = [
  [/grocery|price_check/i, 'Grocery Run'],
  [/search_threads|get_thread|get_message|create_draft|search_contacts/i, 'Gmail and Contacts (workspace-bridge)'],
  [/read_file_content|search_files|list_recent_files|download_file/i, 'Google Drive'],
  [/agent_register|bus/i, 'deckhand bus'],
  [/calendar|event/i, 'Calendar'],
];

/** A readable connector name: from the run record's own connector list when it has one, else a guess from the tool names. */
export function connectorName(uuid, tools, names = {}) {
  if (names[uuid]) return names[uuid];
  const t = [...(tools ?? [])].join(' ');
  for (const [re, name] of NAME_HINTS) if (re.test(t)) return name;
  return `connector ${short(uuid)}`;
}

/**
 * Compare one task. in: { called: [full tool names the pre run called], preAvail: [names available pre], postAvail: [names available post],
 * prompt: text of the prompt file, names: {uuid: display name} }. Returns the findings: [{uuid, name, kind: 'missing'|'different-id'|'moved',
 * alt?, hardcoded}]; 'moved' (same tools under another uuid, prompt does not hardcode the old one) is not an alert.
 */
export function compareTask({ called = [], preAvail = [], postAvail = [], prompt = '', names = {} }) {
  const calledBy = byConnector(called);
  const preBy = byConnector(preAvail);
  const postBy = byConnector(postAvail);
  const need = new Map();   // uuid -> Set(tool names known for it)
  const add = (u, tools) => { if (!need.has(u)) need.set(u, new Set()); for (const t of tools) need.get(u).add(t); };
  for (const [u, tools] of calledBy) add(u, tools);
  const text = String(prompt ?? '');
  for (const m of text.matchAll(PROMPT_TOOL)) add(m[1].toLowerCase(), [m[2]]);
  for (const m of text.matchAll(PROMPT_UUID)) {   // a bare uuid counts only when it is a connector the pre run had
    const u = m[0].toLowerCase();
    if (preBy.has(u) || postBy.has(u)) add(u, []);
  }
  const lowerText = text.toLowerCase();
  const out = [];
  for (const [u, known] of need) {
    if (postBy.has(u)) continue;
    const tools = known.size ? known : (preBy.get(u) ?? new Set());
    const hardcoded = lowerText.includes(u);
    const name = connectorName(u, tools, names);
    let alt = null;
    for (const [v, vt] of postBy) { if (preBy.has(v)) continue; if (tools.size && [...tools].every((t) => vt.has(t))) { alt = v; break; } }   // all of its known tools under one other uuid
    if (alt) out.push({ uuid: u, name, kind: hardcoded ? 'different-id' : 'moved', alt, hardcoded });
    else out.push({ uuid: u, name, kind: 'missing', hardcoded });
  }
  return out;
}

/* ------------------------------------------------------------------ transcripts (streamed; only names are read) */

/** Stream a file's lines to fn(line, n); fn returning true stops. Reads in 64 KB chunks, never loads the file. */
function streamLines(file, fn, capBytes = Infinity) {
  let fd;
  try { fd = openSync(file, 'r'); } catch { return null; }
  try {
    const buf = Buffer.alloc(64 * 1024);
    let rest = ''; let n = 0; let total = 0;
    for (;;) {
      const got = readSync(fd, buf, 0, buf.length, null);
      if (!got) break;
      total += got;
      rest += buf.toString('utf8', 0, got);
      let i;
      while ((i = rest.indexOf('\n')) >= 0) {
        const line = rest.slice(0, i); rest = rest.slice(i + 1); n += 1;
        if (line && fn(line, n) === true) return null;
      }
      if (total > capBytes) return null;
    }
    if (rest) fn(rest, n + 1);
    return null;
  } finally { closeSync(fd); }
}

/**
 * Read a run's transcript. wantCalls: also collect the connector tools the run called (reads the whole file up to capBytes); otherwise it stops at the
 * tool list. Returns { avail: [names] | null (no tool list yet), called: [names] }.
 */
export function scanTranscript(file, { wantCalls = false, capBytes = wantCalls ? PRE_SCAN_CAP : Infinity } = {}) {
  let avail = null;
  const called = new Set();
  streamLines(file, (line, n) => {
    if (avail === null && line.includes('"deferred_tools_delta"')) {
      try {
        const a = JSON.parse(line)?.attachment;
        if (a?.type === 'deferred_tools_delta' && Array.isArray(a.addedNames)) avail = a.addedNames.filter((x) => typeof x === 'string');
      } catch { /* a torn line */ }
    }
    if (wantCalls && line.includes('"tool_use"') && line.includes('mcp__')) {
      try {
        const c = JSON.parse(line)?.message?.content;
        if (Array.isArray(c)) for (const b of c) if (b?.type === 'tool_use' && typeof b.name === 'string' && TOOL_NAME.test(b.name)) called.add(b.name);
      } catch { /* a torn line */ }
    }
    if (!wantCalls && (avail !== null || n >= POST_SCAN_LINES)) return true;
    return false;
  }, capBytes);
  return { avail, called: [...called] };
}

/** `<projects>/<project key>/<cliSessionId>.jsonl`: the key derived from the cwd first, then every project folder. */
function findTranscript(projects, rec) {
  const id = rec?.cliSessionId;
  if (!/^[0-9a-f-]{36}$/i.test(id ?? '')) return null;
  if (typeof rec.cwd === 'string') {
    const p = join(projects, rec.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
    if (existsSync(p)) return p;
  }
  let dirs; try { dirs = readdirSync(projects); } catch { return null; }
  for (const d of dirs) { const p = join(projects, d, `${id}.jsonl`); if (existsSync(p)) return p; }
  return null;
}

/* ------------------------------------------------------------------ tasks and runs */

/** Enabled scheduled tasks, one per id, from every account folder's scheduled-tasks.json. */
function enabledTasks(folders) {
  const out = new Map();
  for (const f of folders) {
    const list = readJson(join(f.path, 'scheduled-tasks.json'), null)?.scheduledTasks;
    if (!Array.isArray(list)) continue;
    for (const t of list) {
      if (!t || typeof t.id !== 'string' || t.enabled === false) continue;
      if (!out.has(t.id)) out.set(t.id, t);
    }
  }
  return out;
}

/** Runs of the wanted tasks from the session records of every folder whose mtime is in [loMs, hiMs): Map(taskId -> run[]). */
function collectRuns(folders, wanted, loMs, hiMs, into, seen) {
  for (const f of folders) {
    let names; try { names = readdirSync(f.path); } catch { continue; }
    for (const n of names) {
      if (!/^local_[0-9a-f-]{36}\.json$/i.test(n)) continue;
      const p = join(f.path, n);
      if (seen.has(p)) continue;   // by path: a stub copy of a run in another folder has no cliSessionId, the full copy does
      let m; try { m = statSync(p).mtimeMs; } catch { continue; }
      if (m < loMs || m >= hiMs) continue;
      let text; try { text = readFileSync(p, 'utf8'); } catch { continue; }
      if (!text.includes('"scheduledTaskId"')) continue;
      let r; try { r = JSON.parse(text); } catch { continue; }
      if (!wanted.has(r?.scheduledTaskId)) continue;
      seen.add(p);
      if (!/^[0-9a-f-]{36}$/i.test(r.cliSessionId ?? '')) continue;
      const created = msOf(r.createdAt);
      if (!Number.isFinite(created)) continue;
      const names2 = {};
      for (const s of Array.isArray(r.remoteMcpServersConfig) ? r.remoteMcpServersConfig : []) if (s?.uuid && s?.name) names2[String(s.uuid).toLowerCase()] = String(s.name);
      if (!into.has(r.scheduledTaskId)) into.set(r.scheduledTaskId, []);
      into.get(r.scheduledTaskId).push({ created, cliSessionId: r.cliSessionId, cwd: r.cwd, names: names2 });
    }
  }
}

/* ------------------------------------------------------------------ the check */

/**
 * Check the tasks of a marker that are not yet checked. Read only, no time budget (it runs in the background process, never in the hook).
 * Returns { results: [{taskId, status: 'pending'|'ok'|'flagged', findings}], enabled }. Only a task with a decided result (ok or flagged) counts as
 * checked; a task with no run since the switch, or a run whose tool list is not written yet, stays pending.
 * o: { projects }
 */
export function checkTasks(ctx, marker, o = {}) {
  const projects = o.projects ?? join(claudeHome(), 'projects');
  const sinceMs = Date.parse(marker.switchAt);
  const folders = ctx.store ? listFolders(ctx.store) : [];
  const tasks = enabledTasks(folders);
  const wanted = new Set([...tasks.keys()].filter((id) => !marker.checked?.[id]));
  const runs = new Map(); const seen = new Set();
  collectRuns(folders, wanted, sinceMs, Infinity, runs, seen);   // records touched since the switch: every post run, and a pre run still being written
  const results = [];
  const needPre = [];
  const post = new Map();
  for (const id of wanted) {
    const first = (runs.get(id) ?? []).filter((r) => r.created >= sinceMs).sort((a, b) => a.created - b.created)[0];
    const file = first ? findTranscript(projects, first) : null;
    const scan = file ? scanTranscript(file) : null;
    if (!scan || scan.avail === null) { results.push({ taskId: id, status: 'pending', findings: [] }); continue; }
    post.set(id, { run: first, avail: scan.avail });
    needPre.push(id);
  }
  if (needPre.length) collectRuns(folders, new Set(needPre), sinceMs - LOOKBACK_MS, sinceMs, runs, seen);
  for (const id of needPre) {
    // the last PRE_RUNS runs before the switch: one run can itself have been made on the other account (a brief flip), with nothing called
    const pres = (runs.get(id) ?? []).filter((r) => r.created < sinceMs).sort((a, b) => b.created - a.created)
      .filter((r, i, all) => all.findIndex((x) => x.cliSessionId === r.cliSessionId) === i)   // the same run sits in every linked folder
      .map((r) => ({ r, file: findTranscript(projects, r) })).filter((x) => x.file).slice(0, PRE_RUNS);
    const scan = { avail: [], called: [] }; let preNames = {};
    for (const pre of pres) { const sc = scanTranscript(pre.file, { wantCalls: true }); scan.called.push(...sc.called); scan.avail.push(...(sc.avail ?? [])); preNames = { ...pre.r.names, ...preNames }; }
    let prompt = '';
    try { const fp = tasks.get(id)?.filePath; if (typeof fp === 'string') prompt = readFileSync(fp, 'utf8'); } catch { /* no prompt file */ }
    const findings = compareTask({ called: scan.called, preAvail: scan.avail ?? [], postAvail: post.get(id).avail, prompt, names: { ...preNames, ...post.get(id).run.names } });
    const alerts = findings.filter((f) => f.kind !== 'moved');
    results.push({ taskId: id, status: alerts.length ? 'flagged' : 'ok', findings, displayName: tasks.get(id)?.displayName ?? null });
  }
  return { results, enabled: [...tasks.keys()] };
}

/* ------------------------------------------------------------------ the alert */

const acctLabel = (a) => (a ? `account ${short(a)}` : 'this account');

function findingText(f, acct) {
  if (f.kind === 'different-id') return `${f.name}: available under a different id (${f.alt}); the prompt hardcodes ${f.uuid}. Fix: edit the prompt to use the new id, or switch back.`;
  return `${f.name} (${f.uuid}): not connected on ${acct}. Fix: connect ${f.name} on ${acct}, or switch back.`;
}

/** The notice file text. Pure. */
export function noticeText(flags) {
  const acct = acctLabel(flags.to);
  const lines = [
    '# Connectors missing after the account switch', '',
    `The app switched${flags.from ? ` from account ${short(flags.from)}` : ''} to ${acct} at ${flags.switchAt}. These scheduled tasks use a connector that run no longer has, so they fail silently.`,
    'session-sync rewrites this file when a check finds something new. Delete it once everything is fixed.', '',
  ];
  for (const [id, t] of Object.entries(flags.tasks ?? {})) {
    lines.push(`## ${id}${t.displayName ? ` (${t.displayName})` : ''}`, '');
    for (const f of t.findings.filter((x) => x.kind !== 'moved')) lines.push(`- ${findingText(f, acct)}`);
    lines.push('');
  }
  return lines.join('\n');
}

function claim(ctx, key) {
  const file = accPath(ctx, `connectors-told-${key}`);
  try { mkdirSync(dirname(file), { recursive: true }); closeSync(openSync(file, 'wx')); return true; } catch { return false; }
}

/**
 * Run the check for the pending marker (or an in-memory one for `since`). Returns a report; never throws. No time budget: the SessionStart hook
 * never calls this, it starts it in a background process (connectorHookStep).
 * o: { since (ISO or ms: ignore the marker, use this switch time), dryRun (write nothing, no toast), stamp (record lastCheckAt: the background
 *      run), toast(title, body), projects, log, afterScan (test seam, called once the tasks are checked) }
 */
export function connectorCheck(ctx, o = {}) {
  const log = o.log ?? (() => {});
  try {
    const nowMs = ctx.now();
    let marker; let ephemeral = false;
    if (o.since !== undefined) {
      const ms = msOf(o.since);
      if (!Number.isFinite(ms)) return { ran: false, reason: 'bad-since' };
      const saved = readConnectorMarker(ctx);
      marker = { v: 1, switchAt: iso(ms), from: saved?.from ?? null, to: saved?.to ?? null, createdAt: iso(nowMs), checked: {} };
      ephemeral = true;
    } else {
      marker = readConnectorMarker(ctx);
      if (!marker) return { ran: false, reason: 'no-marker' };
    }
    const { results, enabled } = checkTasks(ctx, marker, { projects: o.projects });
    if (typeof o.afterScan === 'function') o.afterScan();
    const rep = { ran: true, dryRun: !!o.dryRun, switchAt: marker.switchAt, from: marker.from, to: marker.to, tasks: results, flagged: results.filter((r) => r.status === 'flagged').map((r) => r.taskId), pending: results.filter((r) => r.status === 'pending').map((r) => r.taskId), retired: null };
    const checkedNow = results.filter((r) => r.status !== 'pending');   // only a decided result (flagged or ok) counts as checked
    const allDone = enabled.length > 0 && enabled.every((id) => marker.checked?.[id] || checkedNow.some((r) => r.taskId === id));
    const expired = nowMs - Date.parse(marker.createdAt) >= EXPIRE_MS;
    if (!ephemeral && (allDone || expired)) rep.retired = allDone ? 'complete' : 'expired';
    if (o.dryRun) return rep;
    // no accounts lock is held here: the live pass may have written a marker for a newer switch (and cleared its notice and flags) while the tasks
    // were checked. Then nothing of this result is written: no flags, notice, toast or marker change
    const newer = () => { if (ephemeral) return false; const c = readConnectorMarker(ctx); return !c || c.switchAt !== marker.switchAt; };
    if (newer()) { rep.retired = null; rep.dropped = 'newer-switch'; log('connector check: a newer switch was recorded meanwhile; this result is dropped'); return rep; }
    // alerts: the flags file keeps the findings (it outlives the marker), the notice file is written from it
    const flagged = results.filter((r) => r.status === 'flagged');
    if (flagged.length) {
      const old = readJson(flagsFile(ctx), null);
      const flags = old && old.switchAt === marker.switchAt ? old : { v: 1, switchAt: marker.switchAt, from: marker.from, to: marker.to, tasks: {} };
      for (const r of flagged) flags.tasks[r.taskId] = { displayName: r.displayName, findings: r.findings, at: iso(nowMs) };
      writeJsonAtomic(flagsFile(ctx), flags);
      try { mkdirSync(dirname(noticeFile(ctx)), { recursive: true }); writeFileSync(noticeFile(ctx), noticeText(flags)); } catch (e) { log(`connector check: the notice file was not written: ${e?.message ?? e}`); }
      if (typeof o.toast === 'function' && !newer()) {
        const told = flagged.filter((r) => claim(ctx, `toast-${Date.parse(marker.switchAt)}-${safeKey(r.taskId)}`));
        if (told.length) {
          const body = told.slice(0, 3).map((r) => `${r.taskId}: ${r.findings.filter((f) => f.kind !== 'moved').map((f) => f.name).join(', ')}`).join('; ') + (told.length > 3 ? `; and ${told.length - 3} more` : '');
          try { o.toast('Scheduled tasks need a connector', `${body}. Details: CONNECTORS-MISSING.md in the session-sync folder.`); } catch { /* a toast is never worth failing for */ }
        }
      }
      log(`connector check: ${flagged.length} task(s) flagged (${flagged.map((r) => r.taskId).join(', ')})`);
    }
    if (!ephemeral) {
      // re-read right before the write: a marker for a newer switch is not ours to retire or update
      const cur = readConnectorMarker(ctx);
      const ours = !!cur && cur.switchAt === marker.switchAt;
      if (rep.retired) { if (ours) { try { unlinkSync(markerFile(ctx)); } catch { /* already gone */ } log(`connector check: marker retired (${rep.retired})`); } }
      else if ((checkedNow.length || o.stamp) && ours) {
        cur.checked = cur.checked ?? {};
        for (const r of checkedNow) cur.checked[r.taskId] = { at: iso(nowMs), status: r.status };
        if (o.stamp) cur.lastCheckAt = iso(nowMs);
        writeJsonAtomic(markerFile(ctx), cur);
      }
    } else if (flagged.length || checkedNow.length) {
      // an explicit --since run adopts that switch time as the pending marker with what it found, so the rest is rechecked later
      if (!allDone) { for (const r of checkedNow) marker.checked[r.taskId] = { at: iso(nowMs), status: r.status }; writeJsonAtomic(markerFile(ctx), marker); }
    }
    return rep;
  } catch (e) {
    log(`connector check failed: ${e?.message ?? e}`);
    return { ran: false, reason: 'error' };
  }
}

/* ------------------------------------------------------------------ the background run */

/** Is a background check running? The claim file holds {pid, at}; one older than CLAIM_STALE_MS is a dead run's. */
function claimHeld(ctx) {
  if (!existsSync(claimFilePath(ctx))) return false;
  const at = Number(readJson(claimFilePath(ctx), null)?.at);
  return Number.isFinite(at) && ctx.now() - at < CLAIM_STALE_MS && at <= ctx.now() + CLAIM_STALE_MS;
}

/** Take the claim (the background process does this, so two that raced start only one check). Returns true when it is ours. */
function takeClaim(ctx) {
  const file = claimFilePath(ctx);
  for (let i = 0; i < 2; i += 1) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      const fd = openSync(file, 'wx');
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, at: ctx.now() })); } finally { closeSync(fd); }
      return true;
    } catch { /* held, or not writable */ }
    if (claimHeld(ctx)) return false;
    try { unlinkSync(file); } catch { return false; }   // stale: take it over on the second pass
  }
  return false;
}

function releaseClaim(ctx) {
  try { if (readJson(claimFilePath(ctx), null)?.pid === process.pid) unlinkSync(claimFilePath(ctx)); } catch { /* gone already */ }
}

/**
 * `accounts connector-check --background`: the full check, one at a time (claim file), recording lastCheckAt. Never throws.
 * o: { toast, log, projects, afterScan }. Returns the check report, or { ran: false, reason: 'claimed' } when another background check runs.
 */
export function backgroundConnectorCheck(ctx, o = {}) {
  try {
    if (!takeClaim(ctx)) return { ran: false, reason: 'claimed' };
    try { return connectorCheck(ctx, { ...o, stamp: true }); } finally { releaseClaim(ctx); }
  } catch { return { ran: false, reason: 'error' }; }
}

/**
 * The SessionStart step. It only reads the marker, applies the throttle and, when due, starts `cli.mjs accounts connector-check --background` hidden
 * and detached (the way the go-live waiter and the launch helper start), then returns at once: it never scans. A last check inside the window, made
 * for this same switch, is throttled; a lastCheckAt in the future (clock set back) is due. A fresh claim file means one is already running.
 * o: { throttleMs, spawnFn (injected in tests), execPath, cli, env, log }. Returns { started, reason, pid? }; never throws.
 */
export function connectorHookStep(ctx, o = {}) {
  try {
    const marker = readConnectorMarker(ctx);
    if (!marker) return { started: false, reason: 'no-marker' };
    const nowMs = ctx.now();
    const last = Date.parse(marker.lastCheckAt);
    if (o.throttleMs > 0 && Number.isFinite(last) && last >= Date.parse(marker.switchAt) && last <= nowMs && nowMs - last < o.throttleMs) return { started: false, reason: 'throttled' };
    if (claimHeld(ctx)) return { started: false, reason: 'claimed' };
    const spawnFn = o.spawnFn ?? nodeSpawn;
    const child = spawnFn(o.execPath ?? process.execPath, [o.cli ?? CLI_PATH, 'accounts', 'connector-check', '--background'], { detached: true, stdio: 'ignore', windowsHide: true, env: o.env ?? process.env });
    child?.on?.('error', () => {});
    child?.unref?.();
    return { started: !!child?.pid, reason: child?.pid ? 'started' : 'spawn-failed', pid: child?.pid ?? null };
  } catch (e) {
    (o.log ?? (() => {}))(`connector check: the background run was not started: ${e?.message ?? e}`);
    return { started: false, reason: 'error' };
  }
}

/** One context line for flagged tasks no session has been told about yet (claimed once per switch and task), else null. Never throws. */
export function takeConnectorReport(ctx) {
  try {
    const flags = readJson(flagsFile(ctx), null);
    if (!flags?.tasks) return null;
    const sw = Date.parse(flags.switchAt);
    const told = Object.entries(flags.tasks).filter(([id]) => claim(ctx, `ctx-${sw}-${safeKey(id)}`));
    if (!told.length) return null;
    const acct = acctLabel(flags.to);
    const parts = told.map(([id, t]) => `${id} (${t.findings.filter((f) => f.kind !== 'moved').map((f) => (f.kind === 'different-id' ? `${f.name}, id differs` : f.name)).join(', ')})`);
    return `session-sync: after the account switch at ${flags.switchAt}, ${told.length} scheduled task(s) use a connector missing on ${acct} and will fail silently: ${parts.join('; ')}. Fix: connect each on that account at claude.ai (Settings, Connectors), or switch back. Details: ${noticeFile(ctx)}`;
  } catch { return null; }
}
