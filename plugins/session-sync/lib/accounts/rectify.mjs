/**
 * rectify.mjs - the record engine (plan 5.4, 5.5).
 *
 * Every `local_*.json` of a linked group should be ONE inode (hard links) under
 * its name in every folder of the group. The app's atomic save (tmp + rename)
 * breaks a link on the first save from either side; rectify repairs that:
 *
 *   inventory(group)  -> what is on disk now
 *   classify(...)     -> a pure per-record decision (no mode, no writes)
 *   rectify(...)      -> applies the decision under the live/full rules
 *
 * Targeted pass (the app runs): the app holds the folders of the signed-in account
 * (loaded) and, for a few seconds after a switch, the previous one (cooling) in
 * memory, so those get ADD only. Every other folder of the group is free and is
 * kept fully current: re-links, deletes, tombstones. A name a parked session still
 * writes (held) is left alone. Live pass (older mode): only ADD new names, re-link
 * losers in non-live folders. Full pass (app stopped): everything, including
 * deletes. Nothing is ever erased: a displaced file is COPIED to a rectify backup
 * first, and a propagated delete writes tombstones as regular files, never links.
 *
 * rectify() mutates `state.records` but does not save it; the caller saves.
 */

import {
  readdirSync, lstatSync, statSync, readFileSync, writeFileSync, linkSync, renameSync, unlinkSync, existsSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { RECORD, TOMB, OURTMP, homeOf } from './folders.mjs';
import { backupCopy, resetBackupCache, sha256File, pruneBackups } from './backup.mjs';
import { accPath, readJson, tickMutation, sleepSync, LOCK_TTL_MS, loadOwnLinks, ownInos, saveOwnLinks, OWN_LINKS_CAP } from './state.mjs';
import { AppRunningError, nameIsHeld } from './appstate.mjs';
import { acquireLock, pidAlive } from '../lock.mjs';

const TEN_MIB = 10 * 1024 * 1024;
const TOMB_SKEW_MS = 2000;
const OUR_TMP_MAX_AGE_MS = 60 * 60 * 1000;
const PULL_ACTIVE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const BOUND_FIELDS = [
  'bridgeSessionId', 'bridgeSessionIds', 'scheduledTaskId', 'enabledMcpTools', 'remoteMcpServersConfig', 'servedConnectorCalls',
];

/** Thrown by the internal check for a mutation the live rules forbid. */
export class DeferredError extends Error {
  constructor(msg = 'deferred') { super(msg); this.name = 'DeferredError'; }
}

const lower = (s) => String(s).toLowerCase();

/* ------------------------------------------------------------------ inventory */

/**
 * @param {Array<{key:string, path:string}>} group
 * @returns {{folders:Map, byId:Map<string,Map<string,object>>}}
 */
export function inventory(group) {
  const folders = new Map();
  const byId = new Map();
  for (const F of group) {
    const f = { folder: F, tombs: new Map(), orphanTmp: [], ourTmp: [], recordCount: 0 };
    folders.set(F.key, f);
    let names;
    try { names = readdirSync(F.path); } catch { continue; }
    const set = new Set(names);
    for (const name of names) {
      const p = join(F.path, name);
      let m;
      if ((m = RECORD.exec(name))) {
        let st;
        try { st = lstatSync(p, { bigint: true }); } catch { continue; }
        if (!st.isFile()) continue;
        const id = `local_${m[1]}`;
        const e = {
          id, uuid: m[1], name, path: p, folder: F.key,
          dev: st.dev, ino: st.ino, inoKey: `${st.dev}:${st.ino}`, nlink: Number(st.nlink), size: Number(st.size),
          mtimeNs: st.mtimeNs, mtimeMs: Number(st.mtimeNs / 1000000n), hasTmp: set.has(`${name}.tmp`),
        };
        if (!byId.has(id)) byId.set(id, new Map());
        byId.get(id).set(F.key, e);
        f.recordCount++;
      } else if ((m = TOMB.exec(name))) {
        let ms = null;
        try {
          const st = statSync(p);
          if (st.isFile() && st.size <= 64) {
            const c = readFileSync(p, 'utf8').trim();
            ms = /^\d{13}$/.test(c) ? Number(c) : st.mtimeMs;
          } else if (st.isFile()) ms = st.mtimeMs;
        } catch { continue; }
        if (ms !== null) f.tombs.set(lower(m[1]), { key: lower(m[1]), name, path: p, folder: F.key, ms });
      } else if (name.startsWith('local_') && name.endsWith('.json.tmp')) {
        if (!set.has(name.slice(0, -4))) f.orphanTmp.push(name);
      } else if (OURTMP.test(name)) {
        f.ourTmp.push(name);
      }
    }
  }
  return { folders, byId };
}

/* ------------------------------------------------------------------ record summary */

function toMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? -Infinity : t; }
  return -Infinity;
}

/**
 * S2: a record's summary only changes when the file does, so it is cached across passes (the watcher process runs one every 30 s and
 * about 2 s after each save) under path, inode, mtime and size; only a file that changed is read and parsed again.
 */
const SUMMARIES = new Map();
const SUMMARY_CACHE_MAX = 20000;
export const summaryStats = { parsed: 0, hits: 0 };

function makeSummarizer() {
  return (e) => {
    const k = `${e.path}|${e.inoKey}|${e.mtimeNs}|${e.size}`;
    let r = SUMMARIES.get(k);
    if (r) { summaryStats.hits++; return r; }
    summaryStats.parsed++;
    try {
      const o = JSON.parse(readFileSync(e.path, 'utf8'));
      if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('not an object');
      r = {
        ok: true,
        la: toMs(o.lastActivityAt),
        turns: Number.isFinite(o.completedTurns) ? o.completedTurns : 0,
        cli: typeof o.cliSessionId === 'string' ? o.cliSessionId : null,
        bound: [...BOUND_FIELDS.filter((f) => o[f] !== undefined && o[f] !== null),
          ...Object.keys(o).some((x) => x.startsWith('remoteControl')) ? ['remoteControl*'] : []],
      };
    } catch { r = { ok: false, la: -Infinity, turns: 0, cli: null, bound: [] }; }
    if (SUMMARIES.size >= SUMMARY_CACHE_MAX) SUMMARIES.clear();
    SUMMARIES.set(k, r);
    return r;
  };
}

/* ------------------------------------------------------------------ classify */

/**
 * Pure decision per record id. Returns plan objects; nothing here writes.
 *
 * @param {object} inv       from inventory()
 * @param {object} state     state.json content (records[id].folders = where we saw it)
 * @param {object} o         {groupKeys, remoteList}
 */
export function classify(inv, state, o) {
  const { groupKeys, remoteList } = o;
  const summarize = o.summarize ?? makeSummarizer();
  const plans = [];
  for (const [id, P] of [...inv.byId.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const presentKeys = [...P.keys()].sort();
    const A = groupKeys.filter((k) => !P.has(k));
    const uuid = id.slice('local_'.length);
    const rec = state.records?.[id];
    const home = homeOf(id, presentKeys, state, remoteList, groupKeys);
    const plan = {
      id, uuid, home, P: presentKeys, A, entries: P, W: null, keys: [lower(uuid)],
      saving: false, unparseable: false, oversize: false, summary: null,
      del: new Map(), delete: false, resurrect: false, losers: [], add: [], tombstonedHere: [], extraLinks: [],
    };
    plans.push(plan);

    if ([...P.values()].some((e) => e.hasTmp)) { plan.saving = true; continue; }

    // winner among the distinct inodes
    const byIno = new Map();
    for (const e of P.values()) if (!byIno.has(e.inoKey)) byIno.set(e.inoKey, []);
    for (const e of P.values()) byIno.get(e.inoKey).push(e);
    const cands = [...byIno.values()].map((list) => list.find((e) => e.folder === home) ?? list.sort((a, b) => (a.folder < b.folder ? -1 : 1))[0]);
    cands.sort((a, b) => {
      if (a.mtimeNs !== b.mtimeNs) return a.mtimeNs > b.mtimeNs ? -1 : 1;
      if (cands.length > 1) {
        const la = summarize(a).la; const lb = summarize(b).la;
        if (la !== lb) return la > lb ? -1 : 1;
      }
      const ah = a.folder === home ? 0 : 1; const bh = b.folder === home ? 0 : 1;
      if (ah !== bh) return ah - bh;
      return a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0;
    });
    const W = cands[0];
    plan.W = W;
    plan.summary = summarize(W);
    if (!plan.summary.ok) plan.unparseable = true;
    else if (plan.summary.cli) plan.keys.push(lower(plan.summary.cli));
    plan.oversize = W.size > TEN_MIB;

    // tombstones
    const keys = new Set(plan.keys);
    const tombsOf = (F) => inv.folders.get(F)?.tombs ?? new Map();
    const matching = (F) => [...keys].map((k) => tombsOf(F).get(k)).filter(Boolean);
    for (const F of A) {
      const m = matching(F);
      if (!m.length) continue;
      if (rec?.folders?.includes(F)) plan.del.set(F, m);
      else plan.tombstonedHere.push(F);
    }
    for (const F of P.keys()) {
      // a stale copy next to its own tombstone (for example pulled back, or put back by a live ADD between the app's
      // "rm record" and "write tombstone"). The uuid key always counts; a cliSessionId key only in a folder where the
      // record was seen before (T9), as in the absent-folder rule above (N2).
      const seen = F === home || rec?.folders?.includes(F);
      const own = [...keys].filter((k) => k === lower(uuid) || seen).map((k) => tombsOf(F).get(k)).filter(Boolean);
      if (own.length) plan.del.set(F, own);
    }
    if (plan.del.size) {
      const tMax = Math.max(...[...plan.del.values()].flat().map((t) => t.ms));
      const mMax = Math.max(...[...P.values()].map((e) => e.mtimeMs));
      plan.tMax = tMax;
      if (mMax <= tMax + TOMB_SKEW_MS) plan.delete = true; else plan.resurrect = true;
    }

    plan.losers = [...P.values()].filter((e) => e.inoKey !== W.inoKey);
    let blocked = A.filter((F) => matching(F).length);
    if (plan.resurrect) blocked = blocked.filter((F) => !plan.del.has(F));
    plan.add = A.filter((F) => !blocked.includes(F));

    for (const [ino, list] of byIno) {
      if (list[0].nlink > list.length) plan.extraLinks.push({ ino, nlink: list[0].nlink, names: list.length });
    }
  }
  return plans;
}

/* ------------------------------------------------------------------ rectify */

function newReport(mode) {
  return {
    mode, aborted: false, skipped: null,
    counts: {
      ids: 0, ok: 0, add: 0, split: 0, delete: 0, resurrect: 0, saving: 0, tombstonedHere: 0,
      extraLinks: 0, unparseable: 0, oversize: 0, deferred: 0, orphanTmp: 0, cleanedTmp: 0,
    },
    owed: [], notes: [], accountBound: {},
  };
}

/**
 * Apply the engine to a group.
 *
 * @param {Array}  group     folder objects {acct, org, key, path}
 * @param {object} opts
 * @param {'live'|'targeted'|'full'} opts.mode
 * @param {Set|string[]}  [opts.live]   live folder keys (live pass)
 * @param {{loaded:Set, cooling:Set}} [opts.roles]  targeted pass: folders that get ADD only (every other folder is free)
 * @param {Function}      [opts.testHook]  (stage, entry) => void, called right before a re-link or delete acts (tests mutate the target here)
 * @param {Function}      [opts.guard]  (op, folderKey) => void; throws AppRunningError to abort
 * @param {object}        opts.ctx
 * @param {object}        opts.state    mutated, not saved
 * @param {object}        [opts.remoteList]
 * @param {boolean}       [opts.locked] caller already holds accounts.lock
 * @param {boolean}       [opts.accountFields] count account-bound fields (default: full pass)
 * @param {boolean}       [opts.dryRun] no lock, no writes anywhere (state is cloned); `rep.dry` lists what would change
 */
export function rectify(group, opts) {
  const { mode = 'full', ctx, guard, remoteList } = opts;
  const dryRun = !!opts.dryRun;
  const state = dryRun ? structuredClone(opts.state) : opts.state;
  const live = opts.live instanceof Set ? opts.live : new Set(opts.live ?? []);
  const rep = newReport(mode);
  if (dryRun) rep.dry = [];
  const pa = readJson(accPath(ctx, 'pull-active'), null);
  if (pa && pidAlive(pa.pid) && ctx.now() - (pa.at || 0) < PULL_ACTIVE_MAX_AGE_MS) { rep.skipped = 'pull-active'; return rep; }

  let lock = null;
  if (!opts.locked && !dryRun) {
    lock = acquireLock(accPath(ctx, 'accounts.lock'), { ttlMs: LOCK_TTL_MS });
    if (!lock.acquired) { rep.skipped = 'locked'; return rep; }
  }
  const roles = mode === 'targeted' ? { loaded: new Set(opts.roles?.loaded ?? []), cooling: new Set(opts.roles?.cooling ?? []) } : null;
  try { return run(group, { mode, ctx, state, guard, remoteList, live, roles, testHook: opts.testHook, dryRun, appStartedAtMs: opts.appStartedAtMs ?? 0, accountFields: opts.accountFields ?? mode === 'full' }, rep); }
  finally { lock?.release(); }
}

function run(group, o, rep) {
  const { mode, ctx, state, guard, remoteList, live, roles, dryRun } = o;
  resetBackupCache();
  if (!dryRun) { try { rep.pruned = pruneBackups(ctx, { days: 14 }).pruned; } catch { /* retention is best effort */ } }
  // 0.5.16: the inode each link of ours actually got (side file; see state.mjs). Kept apart from state.json.
  const own = loadOwnLinks(ctx);
  const ownOf = (id, folder = null) => ownInos(own, id, folder);
  const recordOwn = (id, ino, f) => {
    const list = (own.links[id] ||= []).filter((x) => !(x.ino === ino && x.f === f));
    list.push({ ino, f, at: ctx.now() });
    own.links[id] = list.slice(-OWN_LINKS_CAP);
  };
  // the one-time reset (case b): copies the old waiter linked have no inode record and read as a parked session's. The first pass of
  // this version drops every hold and holds nothing; from the next pass on, our links are recorded and a real parked session is held again.
  const resetHolds = !own.resetAt;
  const groupKeys = group.map((f) => f.key);
  const folderPath = Object.fromEntries(group.map((f) => [f.key, f.path]));
  const inv = inventory(group);
  const summarize = makeSummarizer();
  const plans = classify(inv, state, { groupKeys, remoteList, summarize });
  state.records ||= {};

  // targeted: why a mutation other than ADD may not touch this name now (null = it may)
  // A name that is not the inode a pass of ours left there, alone, and written since the folder stopped being loaded (an unload seen
  // in this app run) is a parked session's: its next save would replace whatever we put there. It is remembered in `state.held`
  // (folder + inode) so the hold survives another folder being linked to it (S3: nlink is no longer the test once it is recorded).
  // An unknown unload time holds nothing (B1: every earlier write of the run is drift and converges to the newest).
  const held = (state.held ||= {});
  if (mode === 'targeted') {
    if (state.heldRun !== (o.appStartedAtMs ?? 0)) { for (const k of Object.keys(held)) delete held[k]; state.heldRun = o.appStartedAtMs ?? 0; }   // a restart ends every parked session
    if (resetHolds) {
      const n = Object.values(held).reduce((a, h) => a + Object.keys(h).length, 0);
      for (const k of Object.keys(held)) delete held[k];
      rep.holdsReset = n;
      if (dryRun) rep.dry.push({ op: 'reset-holds', held: n });
    }
    for (const id of Object.keys(held)) {
      if (!inv.byId.has(id)) { delete held[id]; continue; }
      for (const F of Object.keys(held[id])) {
        const e = inv.byId.get(id).get(F);
        // loaded again, the name is gone, or the name is one of our links / a write no later than the start of held time (0.5.16)
        if (roles.loaded.has(F) || !e || (held[id][F] === e.inoKey && !nameIsHeld(state, e, o.appStartedAtMs ?? 0, ownOf(id, F)))) delete held[id][F];
      }
      if (!Object.keys(held[id]).length) delete held[id];
    }
    if (!resetHolds) {
      for (const P of inv.byId.values()) {
        for (const e of P.values()) {
          if (roles.loaded.has(e.folder) || roles.cooling.has(e.folder)) continue;
          if (nameIsHeld(state, e, o.appStartedAtMs ?? 0, ownOf(e.id, e.folder))) (held[e.id] ||= {})[e.folder] = e.inoKey;
        }
      }
    }
  }
  const isHeld = (e) => held[e.id]?.[e.folder] === e.inoKey;
  const blockedWhy = (e) => {
    if (mode !== 'targeted') return null;
    if (roles.loaded.has(e.folder)) return `${e.folder} is loaded by the app`;
    if (roles.cooling.has(e.folder)) return `${e.folder} was just switched away from`;
    if (isHeld(e)) return `${e.id} is held in ${e.folder}`;
    return null;
  };
  const check = (op, F, e) => {
    tickMutation();
    if (mode === 'live' && op !== 'add' && live.has(F)) throw new DeferredError(`${F} is live`);
    if (mode === 'targeted' && op !== 'add') {
      const why = e ? blockedWhy(e) : (roles.loaded.has(F) ? `${F} is loaded by the app` : roles.cooling.has(F) ? `${F} was just switched away from` : null);
      if (why) throw new DeferredError(why);
    }
    guard?.(op, F);
  };
  // S3: right before a re-link or a delete, look at the target again. A changed inode or mtime, or a `.tmp` sibling, means the app
  // (or a parked session) wrote it since the inventory: leave it, it is owed to the next pass.
  const restat = (e) => {
    try {
      const st = lstatSync(e.path, { bigint: true });
      if (`${st.dev}:${st.ino}` !== e.inoKey || st.mtimeNs !== e.mtimeNs) return 'changed since it was read';
      if (existsSync(`${e.path}.tmp`)) return 'being saved (a .tmp sibling exists)';
    } catch { return 'gone since it was read'; }
    return null;
  };
  const changedSince = (e) => { o.testHook?.('before-act', e); return restat(e); };
  const owe = (id, why, folder) => { rep.counts.deferred++; rep.owed.push({ id, why, ...(folder ? { folder } : {}) }); };
  const note = (id, msg) => rep.notes.push({ id, msg });

  for (const f of inv.folders.values()) {
    rep.counts.orphanTmp += f.orphanTmp.length;
    for (const n of f.orphanTmp) note(n, `orphan tmp in ${f.folder.key}; left for the app`);
    for (const n of f.ourTmp) {
      const p = join(f.folder.path, n);
      try {
        if (ctx.now() - statSync(p).mtimeMs > OUR_TMP_MAX_AGE_MS) { if (!dryRun) unlinkSync(p); rep.counts.cleanedTmp++; }
      } catch { /* gone */ }
    }
  }

  try {
    for (const plan of plans) {
      rep.counts.ids++;
      if (o.accountFields && plan.summary?.ok) for (const f of plan.summary.bound) rep.accountBound[f] = (rep.accountBound[f] || 0) + 1;
      try {
        applyPlan(plan);
      } catch (e) {
        if (e instanceof DeferredError) owe(plan.id, e.message);
        else throw e;
      }
    }
    if (mode === 'full' && !dryRun) sweepGone();
  } catch (e) {
    if (e instanceof AppRunningError) {
      rep.aborted = true;
      state.fullPassOwed = true;
      note('pass', e.message);
    } else throw e;
  }

  if (mode === 'full' && !rep.aborted) { state.held = {}; state.heldRun = 0; }   // the app is stopped: no parked session is left
  state.lastRectify = new Date(ctx.now()).toISOString();
  if (!dryRun) {
    if (!rep.aborted && mode !== 'live' && !own.resetAt) own.resetAt = new Date(ctx.now()).toISOString();
    try { saveOwnLinks(ctx, own); } catch { /* the record is advisory; the next pass writes it again */ }
  }
  return rep;

  /* ---------------- per record ---------------- */

  function applyPlan(plan) {
    if (plan.saving) { rep.counts.saving++; note(plan.id, 'saving (a .tmp sibling exists); skipped'); return; }
    if (plan.unparseable) { rep.counts.unparseable++; note(plan.id, 'unparseable record; linked by inode, tombstone key is the uuid only'); }
    if (plan.oversize) { rep.counts.oversize++; note(plan.id, 'record over 10 MiB; the app skips it'); }
    if (plan.extraLinks.length) { rep.counts.extraLinks++; note(plan.id, 'extra links outside the group (backups or conflicts)'); }
    for (const F of plan.tombstonedHere) { rep.counts.tombstonedHere++; note(plan.id, `tombstoned in ${F}; not added there`); }

    if (plan.delete) {
      if (mode === 'live') { owe(plan.id, 'delete'); return; }
      if (dryRun) { rep.dry.push({ op: 'delete', id: plan.id }); return; }
      const done = doDelete(plan);
      if (done) rep.counts.delete++;
      return;
    }
    if (plan.resurrect) {
      if (mode === 'live') { owe(plan.id, 'resurrect'); return; }
      if (mode === 'targeted') {
        const pinned = [...plan.del.keys()].find((F) => roles.loaded.has(F) || roles.cooling.has(F));
        if (pinned) { owe(plan.id, 'resurrect', pinned); return; }
      }
      if (dryRun) rep.dry.push({ op: 'resurrect', id: plan.id }); else doResurrect(plan);
      rep.counts.resurrect++;
    }

    if (mode === 'targeted') noteConflict(plan);

    const folders = new Set(plan.P);
    let acted = false;
    // S1: the version a pass of ours left in the other folders, replaced by the next save of the same folder's session (the loaded app,
    // or a parked session), is an ancestor of that save: it needs no backup. Only a copy from another history (a stale continuation,
    // a switch flush, field drift) is backed up.
    const prevWin = state.records?.[plan.id]?.win;
    // 0.5.16: the loser is an inode a link of ours produced (the recorded inode, not only the last winner's) in the winner's own folder's lineage
    const ownIds = (ino, F) => ownOf(plan.id, F).has(ino);
    const supersedes = (loser) => mode === 'targeted' && !!prevWin && (ownIds(loser.inoKey, loser.folder) || prevWin.ino === loser.inoKey) && prevWin.f === plan.W.folder
      && (roles.loaded.has(plan.W.folder) || isHeld(plan.W));
    for (const loser of plan.losers) {
      if (mode === 'live' && live.has(loser.folder)) { owe(plan.id, 'split-loser-live', loser.folder); continue; }
      const why = blockedWhy(loser);
      if (why) { owe(plan.id, roles.loaded.has(loser.folder) ? 'split-loser-loaded' : 'split-loser-pinned', loser.folder); continue; }
      const r = relink(plan.W, loser, supersedes(loser));
      if (r === true) { acted = true; rep.counts.split++; } else owe(plan.id, r === false ? 'relink-busy' : 'relink-changed', loser.folder);
    }
    for (const F of plan.add) {
      if (addLink(plan.W, F, plan.id)) { folders.add(F); acted = true; rep.counts.add++; }
    }
    if (!acted && !plan.losers.length && !plan.add.length) rep.counts.ok++;

    // the inode of "our" copy: a winner that is a parked session's file (held, in a free folder) is not ours to remember, or the next pass
    // would stop seeing it as held
    const heldWinner = mode === 'targeted' && !roles.loaded.has(plan.W.folder) && !roles.cooling.has(plan.W.folder) && !!blockedWhy(plan.W);
    state.records[plan.id] = {
      home: plan.home, folders: [...folders].sort(), ino: heldWinner ? (state.records[plan.id]?.ino ?? null) : plan.W.inoKey, mtimeMs: plan.W.mtimeMs, keys: plan.keys,
      win: { f: plan.W.folder, ino: plan.W.inoKey },   // the last winner, for the ancestor test above
    };
  }

  /**
   * The app continued a copy it loaded stale: the winner is in a loaded folder under an inode the app made after it loaded the folder,
   * and another folder holds a DIFFERENT newer version than the one the app loaded. Still the newest wins (the user's last action is
   * there and the shared transcript holds every turn); the loser is backed up when it is replaced, and the case is recorded for
   * `accounts status`. `cliChanged`: the loser points at another transcript (a /clear), the one case worth a toast.
   */
  function noteConflict(plan) {
    if (!plan.losers.length || !plan.W) return;
    for (const L of roles.loaded) {
      const snap = state.loadedSnapshot?.[L]?.[plan.id.toLowerCase()];
      const mine = plan.entries.get(L);
      if (!snap || !mine || mine.inoKey === snap || mine.inoKey !== plan.W.inoKey) continue;
      // 0.5.16: a conflict only when another copy is REALLY newer than the winner (a later record timestamp, or the same one and more
      // completed turns) and its content differs; a copy that is merely a different inode, or an older save, is not one.
      const ws = plan.summary;
      const reallyNewer = (l) => {
        const ls = summarize(l);
        if (!(ls.la > ws.la || (ls.la === ws.la && ls.turns > ws.turns))) return false;
        try { return sha256File(l.path) !== sha256File(plan.W.path); } catch { return false; }
      };
      const displaced = plan.losers.filter((loser) => loser.folder !== L && loser.inoKey !== snap && reallyNewer(loser));
      if (!displaced.length) continue;
      state.conflicts ||= {};
      const prev = state.conflicts[plan.id];
      // deduped on the set of other copies (the winner's inode changes with every save and is not part of the key)
      if (prev && displaced.every((l) => (prev.loserInos ?? [prev.loserIno]).includes(l.inoKey))) continue;
      // N1: one entry names every displaced copy (the first is `loser`, all are in `losers`), not only the last one met
      const c = {
        at: new Date(ctx.now()).toISOString(), winner: L, loser: displaced[0].folder, losers: displaced.map((l) => l.folder),
        winnerIno: plan.W.inoKey, loserIno: displaced[0].inoKey, loserInos: displaced.map((l) => l.inoKey),
        cliChanged: displaced.some((l) => summarize(l).cli !== (plan.summary?.cli ?? null)), notified: false,
      };
      state.conflicts[plan.id] = c;
      (rep.conflicts ||= []).push({ id: plan.id, ...c });
    }
  }

  /* ---------------- operations ---------------- */

  /** true: re-linked. false: busy (EPERM and the like). A string: the target changed since the inventory, left as it is. */
  function relink(W, loser, superseded = false) {
    check('relink', loser.folder, loser);
    if (dryRun) { rep.dry.push({ op: 'relink', id: loser.id, folder: loser.folder }); return true; }
    const dst = loser.path;
    const ch = changedSince(loser);
    if (ch) { note(loser.id, `${loser.folder}: ${ch}; next pass`); return ch; }
    const tmp = join(dirname(dst), `.session-sync-link-${randomBytes(6).toString('hex')}`);
    let err = null;
    let linked = null;
    for (let i = 0; i < 3; i++) {
      try {
        linkSync(W.path, tmp);
        // 0.5.16: the inode this link ACTUALLY got (the winner may have been replaced by a save since the inventory)
        const t = statSync(tmp, { bigint: true });
        linked = `${t.dev}:${t.ino}`;
        // the backup only when a copy that differs is really about to be replaced; N8: look at the target again right after it (it takes a while)
        if (!superseded && sha256File(dst) !== sha256File(tmp)) backupCopy(ctx, dst, { reason: 'split-loser', folder: loser.folder, name: loser.name });
        const late = restat(loser);
        if (late) { try { unlinkSync(tmp); } catch { /* gone */ } note(loser.id, `${loser.folder}: ${late}; next pass`); return late; }
        renameSync(tmp, dst); err = null; break;
      } catch (e) {
        err = e;
        try { unlinkSync(tmp); } catch { /* not created */ }
        // N9: the winner went away between the plan and the link: owed, not a failed pass
        if (e.code === 'ENOENT') { note(loser.id, `${loser.folder}: the winner is gone; next pass`); return 'the winner changed since it was read'; }
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
        sleepSync(200);
      }
    }
    if (err) return false;
    const a = statSync(dst, { bigint: true });
    if (`${a.dev}:${a.ino}` !== linked) throw new Error(`re-link of ${dst} did not share the inode`);
    recordOwn(loser.id, linked, loser.folder);
    return true;
  }

  function addLink(W, F, id) {
    check('add', F);
    if (dryRun) { rep.dry.push({ op: 'add', id, folder: F }); return true; }
    const dst = join(folderPath[F], W.name);
    try {
      linkSync(W.path, dst);
      try { const t = statSync(dst, { bigint: true }); recordOwn(id, `${t.dev}:${t.ino}`, F); } catch { /* recorded next time */ }
      return true;
    } catch (e) {
      if (e.code === 'EEXIST') { note(id, `${F}: name appeared meanwhile; next pass`); return false; }
      if (e.code === 'EXDEV') { note(id, `${F}: different volume; not linked`); return false; }
      throw e;
    }
  }

  function writeTombstone(F, name, content) {
    check('tombstone', F);
    try { writeFileSync(join(folderPath[F], name), content, { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }

  /** Every name that may go is removed (after one backup copy per inode); returns false when some name was left (targeted pass: owed). */
  function doDelete(plan) {
    const all = [...plan.del.values()].flat();
    const top = all.reduce((a, b) => (b.ms > a.ms ? b : a));
    const content = String(Math.round(top.ms));
    const names = new Set([top.name, `deleted_${plan.uuid}`]);
    const left = [];
    const goers = [];
    for (const e of plan.entries.values()) {
      const why = blockedWhy(e);
      if (why) { left.push(e); owe(plan.id, 'delete', e.folder); } else goers.push(e);
    }
    // every distinct inode that goes is COPIED once, then its names go
    const seen = new Set();
    for (const e of goers) {
      if (seen.has(e.inoKey)) continue;
      seen.add(e.inoKey);
      backupCopy(ctx, e.path, { reason: 'delete', folder: e.folder, name: e.name });
    }
    for (const e of goers) {
      check('delete', e.folder, e);
      const ch = changedSince(e);
      if (ch) { left.push(e); owe(plan.id, 'delete-changed', e.folder); note(plan.id, `${e.folder}: ${ch}; next pass`); continue; }
      unlinkSync(e.path);
    }
    const holders = new Set([...plan.P, ...(state.records[plan.id]?.folders ?? []).filter((k) => groupKeys.includes(k))]);
    let tombsLeft = false;
    for (const F of holders) {
      if (mode === 'targeted' && (roles.loaded.has(F) || roles.cooling.has(F))) {
        if (![...names].every((n) => existsSync(join(folderPath[F], n)))) tombsLeft = true;
        continue;
      }
      for (const n of names) writeTombstone(F, n, content);
    }
    if (left.length || tombsLeft) { if (tombsLeft && !left.length) owe(plan.id, 'delete-tombstone'); return false; }
    delete state.records[plan.id];
    return true;
  }

  function doResurrect(plan) {
    for (const ts of plan.del.values()) {
      for (const t of ts) {
        backupCopy(ctx, t.path, { reason: 'tombstone-resurrect', folder: t.folder, name: t.name });
        check('tombstone-move', t.folder);
        try { unlinkSync(t.path); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
    }
  }

  /** Records gone from every folder where a held tombstone says "deleted": spread the tombstone, drop the entry. */
  function sweepGone() {
    for (const [id, rec] of Object.entries(state.records)) {
      if (inv.byId.has(id)) continue;
      const keys = new Set([lower(id.slice('local_'.length)), ...(rec.keys ?? []).map(lower)]);
      const held = [];
      for (const F of rec.folders ?? []) {
        if (!groupKeys.includes(F)) continue;
        for (const k of keys) { const t = inv.folders.get(F)?.tombs.get(k); if (t) held.push(t); }
      }
      if (!held.length) continue;
      const top = held.reduce((a, b) => (b.ms > a.ms ? b : a));
      for (const F of rec.folders) {
        if (!groupKeys.includes(F) || inv.folders.get(F)?.tombs.has(top.key)) continue;
        writeTombstone(F, top.name, String(Math.round(top.ms)));
      }
      delete state.records[id];
    }
  }
}

