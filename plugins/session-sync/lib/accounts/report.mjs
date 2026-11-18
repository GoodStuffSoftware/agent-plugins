/**
 * report.mjs - the short human report and the `--json` facts for every
 * `accounts` command (plan 6). Pure formatting plus one read-only collector
 * (`collectStatus`); nothing here writes the store.
 *
 * Facts in every pass report (human and --json alike): what was linked, split
 * (re-linked), deleted, restored, skipped, owed, plus the tasks, backlog,
 * settings and memory outcome. Account ids are cut to 8 characters; no value of a
 * setting, no credential and no record content ever appears.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadState, accPath, readJson, rollbackActive } from './state.mjs';
import { listFolders, groupOf, accountsOf, pendingPairs, RECORD } from './folders.mjs';
import { appState, nameIsHeld } from './appstate.mjs';
import { owedWork } from './pass.mjs';
import { waiterStatus } from './waiter.mjs';
import { accountLists, tasksDueCatchUp } from './lists.mjs';
import { unknownAccountKeys, CFG as DESKTOP_CONFIG } from './settings.mjs';
import { spawnStatus } from './rcspawn.mjs';

const id8 = (s) => (s ? String(s).slice(0, 8) : null);

/** The one line that leads every message about the account link: what the user does, and what happens. (go-live starts Claude again by itself.) */
export const RESTART_LEAD = 'Restart Claude to sync your accounts: quit Claude from the tray icon or app menu, the sync starts right away and Claude reopens by itself when it is done.';
/** The same for a link that is not a go-live (a plain `answer yes` or `link` waiter): it does not start Claude again. */
export const RESTART_LEAD_WAITER = 'Restart Claude to sync your accounts: quit Claude from the tray icon or app menu and the sync starts right away; open Claude again when the notice says it is done.';
/** What the user is told while a go-live waits for the app to stop (the command, the runner's notes and `accounts status`). */
export const WAIT_NOTE = `${RESTART_LEAD} There is no time limit and nothing needs to be run again. Closing the window only hides it.`;

export const REASON_TEXT = {
  'app-running': 'the Claude desktop app is running; this runs by itself after your next normal quit',
  'app-started': 'the Claude desktop app started during the pass; it will finish when the app exits',
  'no-group': 'no pair of accounts is answered yes (run: accounts answer yes)',
  'not-linked': 'the accounts are not linked',
  locked: 'another account pass is running',
  'pull-active': 'a pull is running',
  'rollback-active': 'a rollback is running or was interrupted (run: accounts rollback again to finish it)',
};

/* ------------------------------------------------------------------ pass reports */

/** The facts of a pass result (fullPass, link, livePass, unlink, rectify) as one small object. */
export function summarizePass(rep, kind = rep?.kind ?? 'pass') {
  const r = rep ?? {};
  const c = r.rectify?.counts ?? {};
  const owedList = [
    ...(r.rectify?.owed ?? []), ...(r.tasks?.owed ?? []), ...(r.backlog?.owed ?? []),
  ];
  const owed = owedList.length + (r.settings?.pending ? 1 : 0) + (r.memory?.pending ? 1 : 0);
  return {
    kind,
    ok: !!r.ok,
    ...(r.skipped ? { skipped: r.skipped } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
    ...(r.aborted ? { aborted: true } : {}),
    ...(r.backupId ? { backupId: r.backupId, backupReused: !!r.backupReused } : {}),
    records: c.ids ?? null,
    linked: c.add ?? 0,
    relinked: c.split ?? 0,
    deleted: c.delete ?? 0,
    restored: c.resurrect ?? 0,
    skippedRecords: (c.saving ?? 0) + (c.tombstonedHere ?? 0) + (c.unparseable ?? 0) + (c.oversize ?? 0),
    owed,
    tasks: r.tasks ? { written: r.tasks.written?.length ?? 0, deleted: r.tasks.deleted?.length ?? 0, conflicts: r.tasks.conflicts?.length ?? 0 } : null,
    backlog: r.backlog ? { written: r.backlog.written?.length ?? 0, deleted: r.backlog.deleted?.length ?? 0 } : null,
    settings: r.settings ? {
      written: Object.values(r.settings.files ?? {}).filter((f) => f.status === 'written').length,
      refused: r.settings.refused?.length ?? 0, pending: !!r.settings.pending, unknownKeys: r.settings.unknown?.length ?? 0,
    } : null,
    memory: r.memory ? { copied: r.memory.copied?.length ?? 0, deleted: r.memory.deleted?.length ?? 0, pending: !!r.memory.pending } : null,
    ...(r.unlinked !== undefined ? { unlinked: r.unlinked } : {}),
    ...(r.rectify?.skipped ? { rectifySkipped: r.rectify.skipped } : {}),
    accountBound: r.rectify?.accountBound ?? {},
    notes: (r.rectify?.notes ?? []).slice(0, 5).map((n) => n.msg ?? String(n)),
  };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function formatPass(sum) {
  const out = [];
  const head = { link: 'Accounts linked.', full: 'Full pass done.', live: 'Live pass done (the app is running).', unlink: 'Accounts unlinked.', pass: 'Pass done.' }[sum.kind] ?? 'Pass done.';
  if (sum.skipped) { out.push(`Not run: ${REASON_TEXT[sum.skipped] ?? sum.skipped}.`); return out; }
  if (!sum.ok) {
    out.push(`Not finished: ${REASON_TEXT[sum.reason] ?? sum.reason ?? 'unknown reason'}.`);
    if (sum.owed || sum.aborted) out.push('A full pass is owed; it runs by itself after your next normal quit of Claude.');
    return out;
  }
  out.push(head);
  if (sum.backupId) out.push(`Backup: ${sum.backupId}${sum.backupReused ? ' (reused from an interrupted link)' : ''}.`);
  if (sum.kind === 'unlink') out.push(`Removed ${plural(sum.unlinked ?? 0, 'mirrored name')}; every conversation stays in its home folder.`);
  else {
    out.push(`Conversations: ${sum.records ?? 0} checked, ${sum.linked} linked, ${sum.relinked} split re-linked, ${sum.deleted} deleted, ${sum.restored} restored, ${sum.skippedRecords} skipped.`);
  }
  if (sum.tasks) out.push(`Tasks: ${sum.tasks.written} file(s) written, ${sum.tasks.deleted} removed. Backlog: ${sum.backlog?.written ?? 0} written.`);
  if (sum.settings) out.push(`Settings: ${sum.settings.written} file(s) updated${sum.settings.refused ? `, ${sum.settings.refused} refused` : ''}. Memory: ${sum.memory?.copied ?? 0} copied.`);
  if (sum.owed) out.push(`Owed: ${sum.owed} item(s) wait for a full pass (it runs by itself after your next normal quit).`);
  for (const n of sum.notes) out.push(`Note: ${n}`);
  return out.slice(0, 15);
}

/* ------------------------------------------------------------------ status */

function countFolder(path) {
  let n = 0;
  try { for (const name of readdirSync(path)) if (RECORD.test(name)) n++; } catch { /* unreadable */ }
  return n;
}

/** split = ids whose names in the group point at more than one inode; missing = absent names. */
export function groupHealth(group) {
  const byId = new Map();
  for (const f of group) {
    let names = [];
    try { names = readdirSync(f.path); } catch { continue; }
    for (const n of names) {
      const m = RECORD.exec(n);
      if (!m) continue;
      let ino;
      try { const s = statSync(join(f.path, n), { bigint: true }); ino = `${s.dev}:${s.ino}`; } catch { continue; }
      const id = m[1].toLowerCase();
      if (!byId.has(id)) byId.set(id, { inos: new Set(), names: 0 });
      const e = byId.get(id); e.inos.add(ino); e.names++;
    }
  }
  let split = 0; let missing = 0;
  for (const e of byId.values()) { if (e.inos.size > 1) split++; if (e.names < group.length) missing++; }
  return { ids: byId.size, split, missing };
}

/**
 * Conversations a PARKED session of an account that is no longer loaded still writes (a direct switch between two signed-in
 * accounts with a conversation running): the name in the other folder is not one a pass of ours made, and is newer than the
 * switch. When the loaded account holds an idle copy of the same id it is listed as such. Read-only.
 */
export function heldConversations(group, state, app) {
  if (!app.running || !app.signedIn) return [];
  const loaded = new Set(group.filter((f) => f.acct === app.signedIn).map((f) => f.key));
  const stat = (p) => { try { return statSync(p, { bigint: true }); } catch { return null; } };
  const inLoaded = new Set();
  for (const f of group) {
    if (!loaded.has(f.key)) continue;
    let names = []; try { names = readdirSync(f.path); } catch { /* unreadable */ }
    for (const n of names) { const m = RECORD.exec(n); if (m) inLoaded.add(`local_${m[1].toLowerCase()}`); }
  }
  const out = [];
  for (const f of group) {
    if (loaded.has(f.key)) continue;
    let names = []; try { names = readdirSync(f.path); } catch { /* unreadable */ }
    for (const n of names) {
      const m = RECORD.exec(n);
      if (!m) continue;
      const id = `local_${m[1].toLowerCase()}`;
      const st = stat(join(f.path, n));
      if (!st) continue;
      // the same rule the engine uses (appstate.nameIsHeld): recorded as held, or alone and written after an unload seen in this app run
      if (!nameIsHeld(state, { id, folder: f.key, inoKey: `${st.dev}:${st.ino}`, nlink: Number(st.nlink), mtimeMs: Number(st.mtimeNs / 1000000n) }, app.startedAtMs ?? 0)) continue;
      out.push({ id: id8(id.slice(6)), runningIn: id8(f.acct), idleCopyIn: inLoaded.has(id) ? id8(app.signedIn) : null });
    }
  }
  return out;
}

/**
 * Read-only facts for `accounts status`. `o.probe` (default true) allows the
 * PowerShell process probe; `o.lists` (default true) includes the claude.ai lists.
 */
export function collectStatus(ctx, o = {}) {
  const folders = listFolders(ctx.store);
  const state = loadState(ctx);
  const app = appState({ ctx, probeProcesses: o.probe ?? true });
  const accts = accountsOf(folders);
  const group = groupOf(state, folders);
  const remoteList = readJson(accPath(ctx, 'remote-list.json'), null);
  const owed = state.linked ? owedWork(ctx, { state, app }) : { owed: false, parts: { flag: !!state.fullPassOwed } };
  const health = group.length >= 2 ? groupHealth(group) : null;
  const lists = (o.lists ?? true) && accts.length >= 2 ? accountLists(ctx, folders, state, { signedIn: app.signedIn, remoteList }) : { current: id8(app.signedIn), views: [] };
  let unknown = [];
  if (group.length >= 2) {
    const cfg = readJson(join(ctx.userData, DESKTOP_CONFIG), null);
    if (cfg) { try { unknown = unknownAccountKeys(cfg, group); } catch { /* unreadable settings: none */ } }
  }
  // tasks due a catch-up: the linked group's files, or (before an answer) what a yes would combine
  const dueScope = group.length >= 2 ? group : pendingPairs(state, accts).length ? folders : [];
  const tasksDue = dueScope.length ? tasksDueCatchUp(dueScope, ctx.now()) : null;
  const dups = remoteList?.ids ? Object.entries(remoteList.ids).filter(([, k]) => k.length > 1).length : null;
  return {
    accounts: accts.map((a) => ({ id: id8(a), signedIn: a === app.signedIn, folders: folders.filter((f) => f.acct === a).length })),
    folders: folders.map((f) => ({ key: `${id8(f.acct)}/${id8(f.org)}`, records: countFolder(f.path), inGroup: group.some((g) => g.key === f.key) })),
    pairs: Object.entries(state.pairs ?? {}).map(([k, v]) => ({ pair: k.split('|').map(id8).join('|'), answer: v.answer ?? null, via: v.via ?? null, at: v.at ?? null, askCount: v.askCount ?? 0 })),
    pending: pendingPairs(state, accts).length,
    linked: !!state.linked,
    group: group.map((f) => `${id8(f.acct)}/${id8(f.org)}`),
    health,
    app: { running: app.running, stopped: app.fullAllowed, staleLock: !!app.stale, signedIn: id8(app.signedIn), s1: app.s1, s2: app.s2 },
    owed: owed.owed, owedParts: owed.parts, fullPassOwed: !!state.fullPassOwed,
    waiter: waiterStatus(ctx),
    lastFullPass: state.lastFullPass ?? null, lastRectify: state.lastRectify ?? null,
    lastPass: readJson(accPath(ctx, 'last-pass.json'), null),
    backupId: state.backupId ?? null,
    rollbackActive: rollbackActive(ctx),
    goLive: readJson(accPath(ctx, 'go-live-result.json'), null),
    remote: remoteList ? { checkedAt: remoteList.at ?? null, ids: Object.keys(remoteList.ids ?? {}).length, duplicates: dups } : null,
    lists,
    tasksDue,
    unknownKeys: unknown,
    // a restart of Claude is asked for only by an account that is not linked yet: not linked at all, or joined a linked group later
    gainedAccounts: state.linked ? [...new Set(group.filter((f) => !new Set((state.group ?? []).map((k) => String(k).split('/')[0])).has(f.acct)).map((f) => id8(f.acct)))] : [],
    switchState: state.signed?.acct ? {
      signedIn: id8(state.signed.acct), previous: id8(state.signed.prev),
      cooling: Object.entries(state.signed.cooling ?? {}).filter(([, t]) => t > ctx.now()).map(([a]) => id8(a)),
    } : null,
    conflicts: Object.entries(state.conflicts ?? {}).map(([id, c]) => ({ id: id8(id.slice(6)), at: c.at, winner: id8(String(c.winner).split('/')[0]), loser: id8(String(c.loser).split('/')[0]), cliChanged: !!c.cliChanged })),
    held: group.length >= 2 ? heldConversations(group, state, app) : [],
    rcSpawn: spawnStatus(ctx),   // sessions started from claude.ai under another account: flagged now (pending) and fixed earlier
  };
}

export function formatStatus(st, { all = false } = {}) {
  const out = [];
  // the one line the user needs when a link is waiting for them to quit Claude
  // only while an account is NOT linked yet (never linked, or a new account joined later): once linked nothing asks for a restart
  const unlinked = !st.linked || (st.gainedAccounts ?? []).length > 0;
  if (!st.linked && st.goLive?.status === 'waiting' && st.goLive.phase === 'wait-stop') out.push(WAIT_NOTE);
  else if (unlinked && st.app?.running && st.waiter?.alive && (st.waiter.reasons ?? []).includes('link')) out.push(RESTART_LEAD_WAITER);
  const signed = st.accounts.find((a) => a.signedIn);
  out.push(`Accounts: ${st.accounts.map((a) => `${a.id}${a.signedIn ? '*' : ''}`).join(', ') || 'none'}${signed ? ' (* signed in)' : ''}; ${plural(st.folders.length, 'folder')}.`);
  out.push(...formatSpawn(st.rcSpawn));
  if (st.accounts.length < 2) { out.push('Only one account on this machine: nothing to link.'); return out; }
  const answered = st.pairs.filter((p) => p.answer).map((p) => `${p.pair} ${p.answer}${p.via ? ` (${p.via})` : ''}`);
  out.push(`Pairs: ${answered.join('; ') || 'none answered'}${st.pending ? `; ${st.pending} pending (run: accounts answer yes|no)` : ''}.`);
  out.push(`Linked: ${st.linked ? `yes, ${plural(st.group.length, 'folder')}` : 'no'}${st.lastFullPass ? `; last full pass ${st.lastFullPass}` : ''}.`);
  if (st.health) out.push(`Conversations: ${st.health.ids}; ${st.health.split} split; ${st.health.missing} missing a name.`);
  out.push(`App: ${st.app.running ? 'running' : st.app.stopped ? 'stopped' : 'unknown'}${st.app.signedIn ? `, signed in ${st.app.signedIn}` : ''}. Owed: ${st.owed ? 'yes' : 'no'}.`);
  if (st.app.staleLock) out.push('A Claude lock marker is left behind with no Claude process running (a crash or power loss). Start Claude once and quit it from the tray icon; the marker is then removed and the link can run.');
  out.push(`Waiter: ${st.waiter.alive ? `armed (pid ${st.waiter.pid}; ${st.waiter.reasons.join(', ') || 'no reason'})` : 'none'}.`);
  if (st.linked && st.switchState) out.push(`Account switch: signed in ${st.switchState.signedIn}${st.switchState.previous ? `, previous ${st.switchState.previous}` : ''}${st.switchState.cooling.length ? `; just switched away from ${st.switchState.cooling.join(', ')} (kept as it is for a few seconds)` : ''}.`);
  for (const c of st.conflicts ?? []) out.push(`Conversation ${c.id} was continued from an older copy in ${c.winner}; the other version (from ${c.loser}) is kept in the session-sync backups${c.cliChanged ? ' (it pointed at a different transcript)' : ''}.`);
  for (const h of st.held ?? []) out.push(`Conversation ${h.id} is still running in ${h.runningIn}${h.idleCopyIn ? `; an idle copy shows in ${h.idleCopyIn}` : ''}. Finish or stop it before switching straight between two signed-in accounts.`);
  if (st.rollbackActive) out.push('A rollback is running or was interrupted: no pass runs until it finishes (run: accounts rollback again).');
  if (st.lastPass) out.push(`Last pass: ${st.lastPass.op} ${st.lastPass.ok ? 'ok' : `failed (${st.lastPass.reason ?? st.lastPass.error ?? 'unknown'})`} at ${st.lastPass.at}.`);
  if (st.goLive) out.push(formatGoLive(st.goLive));
  out.push(`Remote duplicates: ${st.remote ? `${st.remote.duplicates} (checked ${st.remote.checkedAt})` : 'not checked (run: accounts status --remote)'}.`);
  if (st.unknownKeys.length) out.push(`Unknown per-account settings keys (not synced): ${st.unknownKeys.length}.`);
  if (st.tasksDue) {
    const t = st.tasksDue;
    out.push(`Tasks due a catch-up run when the app next loads: ${t.count}${t.names.length ? ` - ${t.names.join('; ')}${t.count > t.names.length ? `; and ${t.count - t.names.length} more` : ''}` : ''}.`);
  }
  for (const v of st.lists.views) {
    const tag = st.lists.views.length > 1 ? ` for ${v.account}` : '';
    const cl = all ? v.connectorsMissing : v.connectorsMissing.slice(0, 10);
    out.push(`Connectors missing${tag}: ${v.connectorsMissing.length}${cl.length ? ` - ${cl.map((c) => (c.url ? `${c.name} (${c.url})` : c.name)).join('; ')}` : ''}${v.connectorsMissing.length > cl.length ? `; and ${v.connectorsMissing.length - cl.length} more` : ''}.`);
    if (v.connectorsMissing.length) out.push('Add each at claude.ai Settings, Connectors.');
    const al = all ? v.artifactsFromOthers : v.artifactsFromOthers.slice(0, 20);
    out.push(`Artifacts from other accounts${tag}: ${v.artifactsFromOthers.length}${al.length ? ` (${all ? 'all' : `newest ${al.length}`})` : ''}.`);
    for (const a of al) out.push(`  ${a.title ?? '(untitled)'} ${a.url}`);
    if (v.artifactsFromOthers.length) out.push('Share each one you need with this account on claude.ai, or republish it from this account.');
    if (v.pluginsMissing.length) out.push(`Plugins missing${tag}: ${v.pluginsMissing.join(', ')}.`);
  }
  return out;
}

/** The status lines for the Remote Control spawn records of sessions started from claude.ai under another account (rcspawn.mjs). Silent when there is nothing to say. */
export function formatSpawn(sp) {
  if (!sp) return [];
  const out = [];
  const list = (a) => a.map((x) => `"${x.title || x.id}"`).join(', ');
  if (sp.pending?.length) {
    const how = sp.mode === 'off'
      ? 'The automatic fix is off (rcRestore.spawnFix); run: accounts rc-spawn-fix with Claude quit.'
      : 'Fixed at the next quit of Claude or account switch, or run: accounts rc-spawn-fix with Claude quit.';
    out.push(`Remote Control: ${plural(sp.pending.length, 'session')} started from claude.ai under another account cannot be resumed (pending): ${list(sp.pending)}. ${how}`);
  }
  if (sp.fixed?.length) out.push(`Remote Control: fixed earlier: ${sp.fixed.map((x) => `"${x.title || x.id}" (${String(x.at ?? '').slice(0, 10)})`).join(', ')}.`);
  return out;
}

/** One status line for the go-live result file. */
export function formatGoLive(g) {
  const last = String((g.messages ?? []).slice(-1)[0] ?? '').replace(WAIT_NOTE, '').trim();   // the wait note leads `accounts status` on its own
  const phase = g.status === 'waiting' ? ` (phase ${g.phase})` : '';
  const done = g.finishedAt ? `, finished ${g.finishedAt}` : '';
  const paused = g.status !== 'ok' && g.push?.pausedByGoLive && !g.push?.reEnabled ? ' Push is paused by go-live and stays off until it finishes or you run: config enabled true.' : '';
  return `Go-live: ${g.status}${phase}, started ${g.startedAt}${done}.${last ? ` ${last}` : ''}${paused} Log: ${g.log}`;
}

/** The final text of a command result. */
export function formatReport(r, opts = {}) {
  if (r?.status) return formatStatus(r.status, opts).join('\n');
  if (r?.pass) return formatPass(r.pass).join('\n');
  if (Array.isArray(r?.lines)) return r.lines.join('\n');
  return JSON.stringify(r);
}
