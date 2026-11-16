/**
 * pass.mjs - the passes that tie the engine and the merges together (plan 5.13, 5.15).
 *
 *   livePass()   the app runs: only non-live writes, no deletes, no global settings.
 *                Anything deferred sets state.fullPassOwed (the caller arms the waiter).
 *   fullPass()   the app is stopped (S1 and S2 false), under accounts.lock. The first
 *                one for a group is the LINK: the one-time backup comes first and is
 *                verified; a failed verification aborts the link before any change.
 *   link()       fullPass with the link reason.
 *   unlink()     full rectify, then every record only in its home, tasks and backlog
 *                split back by origin, bases cleared, every pair set to "no".
 *   owedWork()   a cheap, write-free "is a full pass owed" check.
 *
 * Every function loads and saves state.json itself unless `o.state` is given. A
 * full-pass mutation re-checks the app's single-instance marker (S1) first
 * (`makeS1Guard`); an app that starts mid-pass aborts the pass and leaves
 * `fullPassOwed` set. Nothing here prints; callers format the returned report.
 */

import { existsSync, unlinkSync } from 'node:fs';
import {
  loadState, saveState, withAccountsLock, accPath, journalStart, journalRead, journalClear, tickMutation, rollbackActive,
} from './state.mjs';
import { listFolders, groupOf, answerPairs, homeOf } from './folders.mjs';
import { appState, liveFolders, makeS1Guard, noteSignedIn, AppRunningError } from './appstate.mjs';
import { rectify, inventory } from './rectify.mjs';
import { takeBackup, backupCopy } from './backup.mjs';
import { mergeTasks, mergeBacklog, splitByOrigin } from './tasks.mjs';
import { mergeSettings, computePathAreas } from './settings.mjs';
import { mergeCoworkMemory } from './cowork-memory.mjs';

const BASES = ['tasks-base.json', 'backlog-base.json', 'settings-base.json', 'memory-base.json'];

function setup(ctx, o) {
  const state = o.state ?? loadState(ctx);
  const app = o.app ?? appState({ ctx, probeProcesses: o.probeProcesses ?? true });
  const folders = o.folders ?? listFolders(ctx.store);
  const group = groupOf(state, folders);
  return { state, app, folders, group };
}

/**
 * Inside the lock: null while a rollback is active (it must be finished, never undone by a pass), else the
 * setup bundle re-read from disk unless the caller supplied its own state. A rollback or another pass may
 * have saved state.json since `setup`; saving a stale copy over it would undo that work.
 */
function underLock(ctx, o, cur) {
  if (rollbackActive(ctx)) return null;
  if (o.state) return cur;
  const state = loadState(ctx);
  const folders = o.folders ?? listFolders(ctx.store);
  return { ...cur, state, folders, group: groupOf(state, folders) };
}

const save = (ctx, state, o) => { if (o.save !== false) saveState(ctx, state); };
const iso = (ctx) => new Date(ctx.now()).toISOString();

/* ------------------------------------------------------------------ full pass and link */

export async function fullPass(ctx, o = {}) {
  const { state, app, group } = setup(ctx, o);
  const rep = { kind: 'full', ok: false, reasons: o.reasons ?? [] };
  if (!app.fullAllowed) return { ...rep, reason: 'app-running' };
  if (group.length < 2) return { ...rep, reason: 'no-group' };
  const res = await withAccountsLock(ctx, () => {
    const cur = underLock(ctx, o, { state, app, group });
    if (!cur) return { ...rep, reason: 'rollback-active' };
    if (cur.group.length < 2) return { ...rep, reason: 'no-group' };
    return runFull(ctx, o, cur, rep);
  });
  return res.ok ? res.value : { ...rep, reason: 'locked' };
}

export const link = (ctx, o = {}) => fullPass(ctx, { ...o, reasons: [...(o.reasons ?? []), 'link'] });

function runFull(ctx, o, { state, app, group }, rep) {
  const guard = o.guard ?? makeS1Guard(ctx);
  const keys = group.map((f) => f.key);
  noteSignedIn(state, app.signedIn, ctx.now());
  try {
    // A new link or a re-link after unlink or rollback gets a fresh 'pre-link' backup first: the rollback target
    // (state.backupId). A group that gained a folder gets a 'gained' backup: a safety copy of an already linked
    // store, listed in state.backups and NEVER the rollback target (restoring it would re-create every mirror).
    // A journal left by an interrupted link keeps its backup: a second one would capture a half-linked store.
    state.backups ||= [];
    const gained = state.linked && keys.some((k) => !(state.group ?? []).includes(k));
    if (!state.linked || gained) {
      const kind = gained ? 'gained' : 'pre-link';
      const j = journalRead(ctx);
      const jid = j?.op === 'link' && j.step === 'backup-done' && (j.kind ?? 'pre-link') === kind
        ? (j.backupId ?? (kind === 'pre-link' ? state.backupId : null)) : null;
      if (jid && existsSync(accPath(ctx, 'backup', jid, 'manifest.json'))) {
        rep.backupId = jid; rep.backupReused = true;
        if (kind === 'pre-link') state.backupId = jid;
        if (!state.backups.some((b) => b.id === jid)) state.backups.push({ id: jid, kind, at: iso(ctx) });
      } else {
        guard();
        tickMutation();
        const b = takeBackup(ctx, { group, pathAreas: computePathAreas(ctx, group) });
        state.backups.push({ id: b.id, kind, at: iso(ctx) });
        if (kind === 'pre-link') state.backupId = b.id;
        rep.backupId = b.id;
        journalStart(ctx, 'link', 'backup-done', { kind, backupId: b.id });
        saveState(ctx, state);
      }
    }

    const rec = rectify(group, { mode: 'full', ctx, state, guard, locked: true, remoteList: o.remoteList });
    rep.rectify = rec;
    if (rec.skipped) return { ...rep, reason: rec.skipped };
    if (rec.aborted) { state.fullPassOwed = true; return { ...rep, aborted: true, reason: 'app-started' }; }
    const common = { mode: 'full', ctx, state, guard };
    rep.tasks = mergeTasks(group, common);
    rep.backlog = mergeBacklog(group, common);
    rep.settings = mergeSettings(group, { ...common, signedIn: app.signedIn });
    rep.memory = mergeCoworkMemory(group, common);

    state.linked = true;
    state.group = keys;
    state.lastFullPass = iso(ctx);
    state.fullPassOwed = false;
    journalClear(ctx);
    return { ...rep, ok: true };
  } catch (e) {
    if (e instanceof AppRunningError) { state.fullPassOwed = true; return { ...rep, aborted: true, reason: 'app-started' }; }
    throw e;
  } finally {
    save(ctx, state, o);
  }
}

/* ------------------------------------------------------------------ live pass */

export async function livePass(ctx, o = {}) {
  const pre = setup(ctx, o);
  const { app } = pre;
  const rep = { kind: 'live', ok: false };
  if (!pre.state.linked) return { ...rep, skipped: 'not-linked' };
  if (!app.running) return { ...rep, skipped: 'app-not-running' };
  if (pre.group.length < 2) return { ...rep, skipped: 'no-group' };
  const res = await withAccountsLock(ctx, () => {
    const cur = underLock(ctx, o, pre);
    if (!cur) return { ...rep, skipped: 'rollback-active' };
    if (!cur.state.linked) return { ...rep, skipped: 'not-linked' };
    if (cur.group.length < 2) return { ...rep, skipped: 'no-group' };
    const { state, folders, group } = cur;
    try {
      noteSignedIn(state, app.signedIn, ctx.now());
      const live = liveFolders(app, folders, state);
      rep.live = [...live];
      const rec = rectify(group, { mode: 'live', live, ctx, state, locked: true, remoteList: o.remoteList });
      rep.rectify = rec;
      if (rec.skipped) return { ...rep, skipped: rec.skipped };
      // The scheduler holds ONE task file (the signed-in account's) and drops it on a switch, so for
      // scheduled-tasks.json only the signed-in account's folders are live. The sticky set (parked sessions that keep
      // writing records) must not keep a switched-away account's task file stale (S5: a catch-up would fire twice).
      const taskLive = app.signedIn ? new Set(group.filter((f) => f.acct === app.signedIn).map((f) => f.key)) : live;
      rep.tasks = mergeTasks(group, { mode: 'live', ctx, state, live: taskLive });
      rep.backlog = mergeBacklog(group, { mode: 'live', ctx, state, live });
      rep.settings = mergeSettings(group, { mode: 'live', ctx, state, signedIn: app.signedIn });
      rep.memory = mergeCoworkMemory(group, { mode: 'live', ctx, state });
      const owed = rec.owed.length > 0 || rep.tasks.owed.length > 0 || rep.backlog.owed.length > 0
        || rep.settings.pending || rep.memory.pending;
      if (owed) state.fullPassOwed = true;
      return { ...rep, ok: true, owed, armWaiter: owed };
    } finally {
      save(ctx, state, o);
    }
  });
  return res.ok ? res.value : { ...rep, skipped: 'locked' };
}

/* ------------------------------------------------------------------ owed */

/**
 * Is a full pass owed? Writes nothing (dry merges, no rectify). `state.fullPassOwed`
 * (set by an aborted or deferring pass) counts too.
 */
export function owedWork(ctx, o = {}) {
  const { state, app, group } = setup(ctx, o);
  const parts = { flag: !!state.fullPassOwed };
  if (state.linked && group.length >= 2) {
    const common = { mode: 'live', dry: true, ctx, state };
    parts.tasks = mergeTasks(group, { ...common, mode: 'full' }).pending;
    parts.backlog = mergeBacklog(group, { ...common, mode: 'full' }).pending;
    parts.settings = mergeSettings(group, { ...common, signedIn: app.signedIn }).pending;
    parts.memory = mergeCoworkMemory(group, common).pending;
  }
  return { owed: Object.values(parts).some(Boolean), parts };
}

/* ------------------------------------------------------------------ unlink */

export async function unlink(ctx, o = {}) {
  const pre = setup(ctx, o);
  const { app } = pre;
  const rep = { kind: 'unlink', ok: false };
  if (!app.fullAllowed) return { ...rep, reason: 'app-running' };
  if (!pre.state.linked) return { ...rep, reason: 'not-linked' };
  const res = await withAccountsLock(ctx, () => {
    const cur = underLock(ctx, o, pre);
    if (!cur) return { ...rep, reason: 'rollback-active' };
    if (!cur.state.linked) return { ...rep, reason: 'not-linked' };
    const { state, group } = cur;
    const guard = o.guard ?? makeS1Guard(ctx);
    try {
      journalStart(ctx, 'unlink', 'start');
      const rec = rectify(group, { mode: 'full', ctx, state, guard, locked: true, remoteList: o.remoteList });
      rep.rectify = rec;
      if (rec.skipped) return { ...rep, reason: rec.skipped };
      if (rec.aborted) return { ...rep, aborted: true, reason: 'app-started' };

      // each record stays only under its home name; a name whose bytes differ from home's is backed up first
      const groupKeys = group.map((f) => f.key);
      const inv = inventory(group);
      rep.unlinked = 0; rep.notes = [];
      for (const [id, byFolder] of inv.byId) {
        const home = homeOf(id, [...byFolder.keys()], state, null, groupKeys);
        const homeEntry = byFolder.get(home);
        if (!homeEntry) { if (byFolder.size > 1) rep.notes.push({ id, msg: 'no copy in its home folder; left as it is' }); continue; }
        for (const [k, e] of byFolder) {
          if (k === home) continue;
          tickMutation();
          guard(`unlink`, k);
          if (e.inoKey !== homeEntry.inoKey) backupCopy(ctx, e.path, { reason: 'unlink-nonhome', folder: k, name: e.name });
          unlinkSync(e.path);
          rep.unlinked++;
        }
      }
      rep.tasks = splitByOrigin(group, 'tasks', { ctx, state, guard });
      rep.backlog = splitByOrigin(group, 'backlog', { ctx, state, guard });

      // settings, memory and tombstones stay as they are; the link ends
      for (const b of BASES) for (const f of [accPath(ctx, b), `${accPath(ctx, b)}.bak`]) { try { unlinkSync(f); } catch { /* none */ } }
      const yes = Object.entries(state.pairs ?? {}).filter(([, v]) => v?.answer === 'yes').map(([k]) => k);
      answerPairs(state, yes, 'no', 'unlink', ctx.now());
      state.linked = false; state.group = []; state.records = {}; state.tasksWritten = {};
      state.live = { startedAtMs: 0, folders: [] };
      state.fullPassOwed = false; state.lastUnlink = iso(ctx);
      journalClear(ctx);
      return { ...rep, ok: true };
    } catch (e) {
      if (e instanceof AppRunningError) return { ...rep, aborted: true, reason: 'app-started' };
      throw e;
    } finally {
      save(ctx, state, o);
    }
  });
  return res.ok ? res.value : { ...rep, reason: 'locked' };
}
