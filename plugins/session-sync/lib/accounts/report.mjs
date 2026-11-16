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
import { loadState, accPath, readJson } from './state.mjs';
import { listFolders, groupOf, accountsOf, pendingPairs, RECORD } from './folders.mjs';
import { appState } from './appstate.mjs';
import { owedWork } from './pass.mjs';
import { waiterStatus } from './waiter.mjs';
import { accountLists } from './lists.mjs';
import { unknownAccountKeys, CFG as DESKTOP_CONFIG } from './settings.mjs';

const id8 = (s) => (s ? String(s).slice(0, 8) : null);

export const REASON_TEXT = {
  'app-running': 'the Claude desktop app is running (quit it from the tray icon first)',
  'app-started': 'the Claude desktop app started during the pass; it will finish when the app exits',
  'no-group': 'no pair of accounts is answered yes (run: accounts answer yes)',
  'not-linked': 'the accounts are not linked',
  locked: 'another account pass is running',
  'pull-active': 'a pull is running',
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
    if (sum.owed || sum.aborted) out.push('A full pass is owed; it runs when the app is stopped.');
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
  if (sum.owed) out.push(`Owed: ${sum.owed} item(s) wait for a full pass (app stopped).`);
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
function groupHealth(group) {
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
  const dups = remoteList?.ids ? Object.entries(remoteList.ids).filter(([, k]) => k.length > 1).length : null;
  return {
    accounts: accts.map((a) => ({ id: id8(a), signedIn: a === app.signedIn, folders: folders.filter((f) => f.acct === a).length })),
    folders: folders.map((f) => ({ key: `${id8(f.acct)}/${id8(f.org)}`, records: countFolder(f.path), inGroup: group.some((g) => g.key === f.key) })),
    pairs: Object.entries(state.pairs ?? {}).map(([k, v]) => ({ pair: k.split('|').map(id8).join('|'), answer: v.answer ?? null, via: v.via ?? null, at: v.at ?? null, askCount: v.askCount ?? 0 })),
    pending: pendingPairs(state, accts).length,
    linked: !!state.linked,
    group: group.map((f) => `${id8(f.acct)}/${id8(f.org)}`),
    health,
    app: { running: app.running, stopped: app.fullAllowed, signedIn: id8(app.signedIn), s1: app.s1, s2: app.s2 },
    owed: owed.owed, owedParts: owed.parts, fullPassOwed: !!state.fullPassOwed,
    waiter: waiterStatus(ctx),
    lastFullPass: state.lastFullPass ?? null, lastRectify: state.lastRectify ?? null,
    lastPass: readJson(accPath(ctx, 'last-pass.json'), null),
    backupId: state.backupId ?? null,
    remote: remoteList ? { checkedAt: remoteList.at ?? null, ids: Object.keys(remoteList.ids ?? {}).length, duplicates: dups } : null,
    lists,
    unknownKeys: unknown,
  };
}

export function formatStatus(st, { all = false } = {}) {
  const out = [];
  const signed = st.accounts.find((a) => a.signedIn);
  out.push(`Accounts: ${st.accounts.map((a) => `${a.id}${a.signedIn ? '*' : ''}`).join(', ') || 'none'}${signed ? ' (* signed in)' : ''}; ${plural(st.folders.length, 'folder')}.`);
  if (st.accounts.length < 2) { out.push('Only one account on this machine: nothing to link.'); return out; }
  const answered = st.pairs.filter((p) => p.answer).map((p) => `${p.pair} ${p.answer}${p.via ? ` (${p.via})` : ''}`);
  out.push(`Pairs: ${answered.join('; ') || 'none answered'}${st.pending ? `; ${st.pending} pending (run: accounts answer yes|no)` : ''}.`);
  out.push(`Linked: ${st.linked ? `yes, ${plural(st.group.length, 'folder')}` : 'no'}${st.lastFullPass ? `; last full pass ${st.lastFullPass}` : ''}.`);
  if (st.health) out.push(`Conversations: ${st.health.ids}; ${st.health.split} split; ${st.health.missing} missing a name.`);
  out.push(`App: ${st.app.running ? 'running' : st.app.stopped ? 'stopped' : 'unknown'}${st.app.signedIn ? `, signed in ${st.app.signedIn}` : ''}. Owed: ${st.owed ? 'yes' : 'no'}.`);
  out.push(`Waiter: ${st.waiter.alive ? `armed (pid ${st.waiter.pid}; ${st.waiter.reasons.join(', ') || 'no reason'})` : 'none'}.`);
  if (st.lastPass) out.push(`Last pass: ${st.lastPass.op} ${st.lastPass.ok ? 'ok' : `failed (${st.lastPass.reason ?? st.lastPass.error ?? 'unknown'})`} at ${st.lastPass.at}.`);
  out.push(`Remote duplicates: ${st.remote ? `${st.remote.duplicates} (checked ${st.remote.checkedAt})` : 'not checked (run: accounts status --remote)'}.`);
  if (st.unknownKeys.length) out.push(`Unknown per-account settings keys (not synced): ${st.unknownKeys.length}.`);
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

/** The final text of a command result. */
export function formatReport(r, opts = {}) {
  if (r?.status) return formatStatus(r.status, opts).join('\n');
  if (r?.pass) return formatPass(r.pass).join('\n');
  if (Array.isArray(r?.lines)) return r.lines.join('\n');
  return JSON.stringify(r);
}
