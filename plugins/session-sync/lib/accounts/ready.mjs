/**
 * ready.mjs - `accounts ready [--to <acct>] [--json]`: one command that says whether the machine is ready for a claude.ai account switch.
 *
 * 1. lists every installed copy of session-sync (the CLI cache, and each desktop-app rpm copy) with its version;
 * 2. an rpm copy older than the newest cache version is backed up (`~/.claude/backups/rpm-session-sync-<ver>-<date>[-n]`) and mirrored from the
 *    cache with Node fs. `.in_use` (an empty directory the app keeps in its copy) is never copied over and never deleted;
 * 3. a waiter older than the newest copy is replaced through the existing path (replaceOldWaiter, then ensureWaiter with the newest copy's cli;
 *    or, when this process is not the newest copy, a hidden child `node <newest>/lib/cli.mjs accounts rectify --json`);
 * 4. GO or NO-GO: behind session-record copies in the TARGET account (the source account's are repaired by its next quit: info only),
 *    sessions mid-turn (report.heldConversations, the "still running in" lines), the waiter running at the newest version, and no rpm copy
 *    of the target account older than the cache.
 *
 * Everything outside the pure decisions is passed in (`deps`), so the tests run it against a fixture home with no process started.
 */

import { existsSync, readdirSync, readFileSync, mkdirSync, cpSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pidAlive } from '../lock.mjs';
import { accPath, readJson, loadState, loadOwnLinks } from './state.mjs';
import { listFolders, groupOf, accountsOf } from './folders.mjs';
import { appState } from './appstate.mjs';
import { desktopCopies } from './desktop.mjs';
import { compareVersions, PLUGIN_VERSION } from './version.mjs';
import { inventory, classify, makeSummarizer } from './rectify.mjs';
import { heldConversations } from './report.mjs';
import { waiterStatus, replaceOldWaiter, ensureWaiter } from './waiter.mjs';
import { launchViaHelper } from './launcher.mjs';

const id8 = (s) => (s ? String(s).slice(0, 8) : null);
const IN_USE = '.in_use';
const SELF_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

export class ReadyError extends Error {}

const subdirs = (d) => { try { return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } };
const readPlugin = (root) => readJson(join(root, '.claude-plugin', 'plugin.json'), null);
const newer = (a, b) => (compareVersions(a, b) ?? -1) > 0;   // an unreadable version never wins

/* ------------------------------------------------------------------ copies */

/** The CLI cache's copies of session-sync: [{kind:'cache', path, version}], newest first. */
export function cacheCopies(home) {
  const cache = join(home, '.claude', 'plugins', 'cache');
  const out = [];
  for (const mp of subdirs(cache)) {
    for (const ver of subdirs(join(cache, mp, 'session-sync'))) {
      const root = join(cache, mp, 'session-sync', ver);
      const meta = readPlugin(root);
      if (meta?.name !== 'session-sync') continue;
      out.push({ kind: 'cache', path: root, version: String(meta.version ?? '') });
    }
  }
  return out.sort((a, b) => (newer(a.version, b.version) ? -1 : newer(b.version, a.version) ? 1 : 0));
}

/** The desktop-app copies, each with the account and org folder names it sits under: [{kind:'desktop', path, version, acct, org}]. */
export function rpmCopies(ctx) {
  const rpm = join(ctx.userData ?? '', 'rpm');
  return desktopCopies(ctx).map((c) => {
    const [acct, org] = relative(rpm, c.path).split(sep);
    return { kind: 'desktop', path: c.path, version: c.version, acct: acct ?? null, org: org ?? null };
  });
}

/** The newest copy this run can start code from: the cache's newest or this running copy, whichever has the higher version (a tie is this copy). */
export function newestCopy(cache, self) {
  let best = self;
  for (const c of cache) if (newer(c.version, best.version)) best = c;
  return best;
}

/* ------------------------------------------------------------------ mirror */

const inside = (parent, child) => { const r = relative(resolve(parent), resolve(child)); return r !== '' && !r.startsWith('..') && !r.includes(':') && !r.startsWith(sep); };
const kept = (rel) => rel === IN_USE || rel.startsWith(`${IN_USE}/`);

/** All files and folders under `root` (`.in_use` left out). `strict`: a folder that cannot be listed throws (the source side: a short listing would delete good files). */
function listTree(root, strict = false) {
  const files = new Map();
  const dirs = [];
  const walk = (abs, rel) => {
    let ents = [];
    try { ents = readdirSync(abs, { withFileTypes: true }); } catch (e) { if (strict) throw new ReadyError(`cannot list ${abs}: ${e?.code ?? e?.message ?? e}`); return; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (kept(r)) continue;
      if (e.isDirectory()) { dirs.push(r); walk(join(abs, e.name), r); } else if (e.isFile()) files.set(r, join(abs, e.name));
    }
  };
  walk(root, '');
  return { files, dirs };
}

const sameFile = (a, b) => { try { return readFileSync(a).equals(readFileSync(b)); } catch { return false; } };

const sizeOf = (p) => { try { return statSync(p).size; } catch { return -1; } };
const LABEL = '.claude-plugin/plugin.json';

/**
 * Make `dest` end with `src`'s file set: copy the files that differ, remove the files and folders `src` does not have, `.in_use` untouched.
 * Order: every other file is copied, the extras are deleted, the result is listed again and must hold exactly the source's files (sizes equal),
 * and only then `.claude-plugin/plugin.json` (the version label) is written. Any failure throws and the label keeps the old version, so a
 * mixed copy is never labelled as the new version. A source folder that cannot be listed aborts before anything is deleted.
 * Refuses a `dest` outside `allowedRoot`.
 * @returns {{copied:number, removed:number}}
 */
export function mirrorTree(src, dest, allowedRoot) {
  if (!inside(allowedRoot, dest)) throw new ReadyError(`refusing to write outside ${allowedRoot}`);
  const s = listTree(src, true);
  const d = listTree(dest);
  let copied = 0; let removed = 0;
  const put = (rel) => {
    const to = join(dest, ...rel.split('/'));
    if (d.files.has(rel) && sameFile(s.files.get(rel), to)) return;
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(s.files.get(rel), to);
    copied++;
  };
  for (const rel of s.files.keys()) if (rel !== LABEL) put(rel);
  for (const [rel, p] of d.files) if (!s.files.has(rel)) { rmSync(p, { force: true }); removed++; }
  const srcDirs = new Set(s.dirs);
  for (const rel of d.dirs.filter((r) => !srcDirs.has(r)).sort((a, b) => b.length - a.length)) rmSync(join(dest, ...rel.split('/')), { recursive: true, force: true });
  const after = listTree(dest, true);
  for (const [rel, p] of s.files) {
    if (rel === LABEL) continue;
    if (!after.files.has(rel) || sizeOf(after.files.get(rel)) !== sizeOf(p)) throw new ReadyError(`the copy is incomplete: ${rel}`);
  }
  for (const rel of after.files.keys()) if (rel !== LABEL && !s.files.has(rel)) throw new ReadyError(`the copy still holds a file the cache lacks: ${rel}`);
  if (s.files.has(LABEL)) put(LABEL);
  return { copied, removed };
}

/** Copy an rpm copy aside before it is overwritten: `<home>/.claude/backups/rpm-session-sync-<ver>-<YYYY-MM-DD>[-n]`. `.in_use` is left out. */
export function backupCopy(path, version, home, now) {
  const base = join(home, '.claude', 'backups', `rpm-session-sync-${String(version || 'unknown').replace(/[^0-9A-Za-z.+-]/g, '_')}-${new Date(now).toISOString().slice(0, 10)}`);
  let dir = base;
  for (let n = 2; existsSync(dir); n++) dir = `${base}-${n}`;
  mkdirSync(dirname(dir), { recursive: true });
  cpSync(path, dir, { recursive: true, filter: (p) => !kept(relative(path, p).split(sep).join('/')) });
  return dir;
}

/* ------------------------------------------------------------------ the checks */

/** `--to`: a full account uuid or a unique prefix of one (case does not matter) among the accounts that have a folder; else the one account that is not loaded. */
export function resolveTarget(accts, to, loaded, groupAccts = accts) {
  if (to) {
    const q = String(to).toLowerCase();
    const hit = accts.filter((a) => a.toLowerCase() === q);
    const m = hit.length ? hit : accts.filter((a) => a.toLowerCase().startsWith(q));
    if (m.length === 1) return m[0];
    throw new ReadyError(m.length ? `--to ${to} matches ${m.length} accounts: ${m.map(id8).join(', ')}` : `--to ${to}: no such account (known: ${accts.map(id8).join(', ') || 'none'})`);
  }
  if (!loaded) throw new ReadyError('the loaded account is not known (Claude is not signed in or not running): pass --to <account>');
  const others = groupAccts.filter((a) => a !== loaded);
  if (others.length === 1) return others[0];
  throw new ReadyError(others.length ? `several accounts are not loaded (${others.map(id8).join(', ')}): pass --to <account>` : 'there is no second account to switch to');
}

const SAMPLE_CAP = 50;

/**
 * Session-record copies that are behind, per side (a record's copies differ by inode: the winner and its losers, as rectify judges them).
 * A loser is behind when its lastActivityAt is older than the winner's, or equal and it has fewer completedTurns, or equal and another cliSessionId.
 * A copy that cannot be parsed also counts. `missing`: a record that has no copy yet in a folder of that side (info).
 */
export function behindCounts(ctx, group, state, targetAcct) {
  const summarize = makeSummarizer();
  const inv = inventory(group);
  const plans = classify(inv, state, { groupKeys: group.map((f) => f.key), remoteList: readJson(accPath(ctx, 'remote-list.json'), null), summarize });
  const out = { target: 0, source: 0, targetIds: [], sourceIds: [], missing: { target: 0, source: 0 } };
  const side = (folderKey) => (String(folderKey).split('/')[0] === targetAcct ? 'target' : 'source');
  for (const p of plans) {
    if (!p.W || p.saving || p.unparseable) continue;
    const w = p.summary;
    for (const e of p.losers) {
      const s = summarize(e);
      const behind = !s.ok || s.la < w.la || (s.la === w.la && (s.turns < w.turns || (s.turns === w.turns && s.cli !== w.cli)));
      if (!behind) continue;
      const k = side(e.folder);
      out[k]++;
      if (out[`${k}Ids`].length < SAMPLE_CAP) out[`${k}Ids`].push(id8(p.uuid));
    }
    if (!p.delete) for (const f of p.add) out.missing[side(f)]++;
  }
  return out;
}

const claimOf = (ctx) => readJson(accPath(ctx, 'waiter.claim'), null);

/** The waiter now: {alive, pid, version} (version from the claim of that same pid, else null). */
export function waiterInfo(ctx) {
  const st = waiterStatus(ctx);
  const claim = claimOf(ctx);
  return { alive: !!st.alive, pid: st.pid ?? null, version: st.alive && claim && claim.pid === st.pid ? (claim.version ?? null) : null };
}

/** Cheap check for the SessionStart hook: one small file read (plus a pid check), no process probe. True when a live waiter is older than `selfVersion`. */
export function waiterOlderThanSelf(ctx, selfVersion = PLUGIN_VERSION, alive = pidAlive) {
  if (!selfVersion) return false;
  const claim = claimOf(ctx);
  if (!claim || !claim.pid || !alive(claim.pid)) return false;
  if (!claim.version) return true;
  return compareVersions(claim.version, selfVersion) === -1;
}

const waiterCurrent = (w, newestVersion) => w.alive && !!w.version && (compareVersions(w.version, newestVersion) ?? -1) >= 0;

/* Time budget: the whole command stays under 2 minutes. The child is capped at 60 s and runs without the remote check; the wait for the waiter
 * stops by 100 s after the start; what follows (reading the records) is local. */
const CHILD_CAP_MS = 60 * 1000;
const BUDGET_MS = 100 * 1000;

const defaultSleep =(ms) => new Promise((r) => setTimeout(r, ms));

/** The rectify takeover as a hidden child. `--no-remote` skips the remote listing (the slow part, and not needed for the waiter); the cap is `timeoutMs`. */
function defaultChild(cli, timeoutMs = CHILD_CAP_MS) {
  const r = spawnSync(process.execPath, [cli, 'accounts', 'rectify', '--json', '--no-remote'], { windowsHide: true, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  return { ok: !r.error, status: r.status ?? null, error: r.error ? String(r.error.message ?? r.error) : null };
}

/** Replace a waiter older than the newest copy. Returns {mode, ok, ...}; never throws. */
async function takeover(ctx, newest, self, state, deps, deadline) {
  const cli = join(newest.path, 'lib', 'cli.mjs');
  try {
    if ((compareVersions(self.version, newest.version) ?? -1) >= 0) {
      const r = deps.replaceOld(ctx);
      if (!r.replaced && r.reason !== 'no-waiter') return { mode: 'in-process', ok: false, reason: r.reason };
      const reason = state.fullPassOwed ? 'owed' : 'watch';
      const e = deps.ensure(ctx, reason, (rsn) => {
        const l = deps.launch(['accounts', 'wait', '--reason', rsn], { ctx, cli });
        if (!l.ok) throw new Error(l.error ?? 'could not start the waiter');
        return l.pid;
      });
      return { mode: 'in-process', ok: e.action !== 'failed', replaced: !!r.replaced, ensure: e.action, ...(e.error ? { reason: e.error } : {}) };
    }
    const c = deps.child(cli, Math.max(5000, Math.min(CHILD_CAP_MS, deadline - Date.now() - 10000)));
    return { mode: 'child', ok: c.ok, ...(c.error ? { reason: c.error } : {}) };
  } catch (e) {
    return { mode: 'error', ok: false, reason: String(e?.message ?? e) };
  }
}

/* ------------------------------------------------------------------ the run */

/**
 * @param {object} ctx
 * @param {object} o  { to, home, now, self:{path,version}, deps:{ app(ctx), replaceOld, ensure, launch, child, sleep, waitMs } }
 * @returns {Promise<object>} the facts; verdict 'GO' or 'NO-GO'. Throws ReadyError for an unusable `--to` or an unknown loaded account.
 */
export async function runReady(ctx, o = {}) {
  const t0 = Date.now();
  const home = o.home ?? homedir();
  const now = o.now ?? ctx.now();
  const self = o.self ?? { kind: 'self', path: SELF_ROOT, version: PLUGIN_VERSION ?? '' };
  const deps = {
    app: (c) => appState({ ctx: c, readOnly: true }), replaceOld: (c) => replaceOldWaiter(c), ensure: ensureWaiter, launch: launchViaHelper,
    child: defaultChild, sleep: defaultSleep, waitMs: 20 * 1000, ...(o.deps ?? {}),
  };
  const reasons = [];
  const why = (code, text) => reasons.push({ code, text });

  const folders = listFolders(ctx.store);
  const state = loadState(ctx);
  const group = groupOf(state, folders);
  const app = deps.app(ctx);
  const loaded = app.signedIn ?? state.signed?.acct ?? null;
  const target = resolveTarget(accountsOf(folders), o.to ?? null, loaded, accountsOf(group));

  // 1 + 2: the copies, and the rpm copies brought up to the cache
  const cache = cacheCopies(home);
  const newest = newestCopy(cache, self);
  const cacheNewest = cache[0] ?? null;
  const copies = cache.map((c) => ({ kind: 'cache', path: c.path, version: c.version, action: c === cacheNewest ? 'source' : 'old' }));
  const known = accountsOf(folders);
  const rpmRoot = join(ctx.userData ?? '', 'rpm');
  for (const r of rpmCopies(ctx)) {
    const row = { kind: 'desktop', path: r.path, acct: r.acct, org: r.org, version: r.version, action: 'current' };
    copies.push(row);
    if (!cacheNewest) { row.action = 'no-cache'; continue; }
    const order = compareVersions(r.version, cacheNewest.version);
    if (order !== null && order >= 0) { row.action = order > 0 ? 'newer' : 'current'; continue; }
    try {
      row.backup = backupCopy(r.path, r.version, home, now);
      Object.assign(row, mirrorTree(cacheNewest.path, r.path, rpmRoot));
      row.action = 'mirrored';
      row.from = r.version;
      row.version = cacheNewest.version;
    } catch (e) {
      row.action = 'failed';
      row.error = String(e?.message ?? e);
    }
  }
  const ofTarget = (c) => !c.acct || !known.some((a) => a.toLowerCase().startsWith(String(c.acct).toLowerCase())) || String(target).toLowerCase().startsWith(String(c.acct).toLowerCase());
  for (const c of copies) {
    if (c.kind !== 'desktop' || !cacheNewest) continue;
    if (c.action === 'failed') why('rpm-copy-failed', `the app's copy under ${c.acct}/${c.org} could not be updated`);
    else if (ofTarget(c) && (compareVersions(c.version, cacheNewest.version) ?? -1) < 0) why('rpm-copy-older', `the app's copy under ${c.acct}/${c.org} is ${c.version || 'unknown'}, the cache has ${cacheNewest.version}`);
  }

  // 3: the waiter
  const before = waiterInfo(ctx);
  let after = before;
  let take = null;
  const needs = before.alive ? !waiterCurrent(before, newest.version) : (app.running || !!state.fullPassOwed);
  if (needs && state.linked && group.length >= 2) {
    take = await takeover(ctx, newest, self, state, deps, t0 + BUDGET_MS);
    const end = Math.min(Date.now() + deps.waitMs, t0 + BUDGET_MS);
    for (;;) {
      after = waiterInfo(ctx);
      if (waiterCurrent(after, newest.version) || Date.now() >= end) break;
      await deps.sleep(250);
    }
  }
  if (!after.alive) why('waiter-not-running', `the background waiter is not running${app.running ? '' : ' and Claude is stopped; start Claude, then run accounts ready again'}`);
  else if (!waiterCurrent(after, newest.version)) why('waiter-old', `the waiter runs ${after.version ?? 'an unknown version'}, the newest copy is ${newest.version}${take && !take.ok ? ` (takeover: ${take.reason ?? take.mode} failed)` : ''}`);

  // 4: the session records (after the takeover: a pass it ran may have repaired some)
  let behind = { target: 0, source: 0, targetIds: [], sourceIds: [], missing: { target: 0, source: 0 } };
  let midTurn = [];
  if (!state.linked || group.length < 2) why('not-linked', 'the accounts are not linked (accounts status)');
  else {
    if (!group.some((f) => f.acct === target)) why('target-not-linked', `account ${id8(target)} is not part of the linked group`);
    behind = behindCounts(ctx, group, state, target);
    if (behind.target) why('behind-target', `${behind.target} session copy(ies) in the target account are behind`);
    midTurn = heldConversations(group, state, deps.app(ctx), loadOwnLinks(ctx)).map((h) => ({ id: h.id, runningIn: h.runningIn }));
    if (midTurn.length) why('mid-turn', `${midTurn.length} session(s) still running: ${midTurn.map((m) => m.id).join(', ')}`);
  }

  return {
    ok: true, command: 'ready', verdict: reasons.length ? 'NO-GO' : 'GO', reasons,
    target: id8(target), loaded: id8(loaded), newest: { version: newest.version, path: newest.path },
    copies, waiter: { before, after, takeover: take }, behind, midTurn, elapsedMs: Date.now() - t0,
  };
}

/** Short plain lines: ids and counts only. */
export function formatReady(r) {
  const out = [r.verdict];
  for (const x of r.reasons) out.push(`  ${x.text}`);
  out.push(`target ${r.target} (loaded ${r.loaded ?? 'unknown'}); newest copy ${r.newest.version}`);
  for (const c of r.copies) {
    const where = c.kind === 'desktop' ? `app ${c.acct}/${c.org}` : 'cache';
    out.push(`${where} ${c.from ? `${c.from} -> ` : ''}${c.version || 'unknown'}: ${c.action}${c.backup ? `, backup ${c.backup}` : ''}${c.error ? ` (${c.error})` : ''}`);
  }
  const w = r.waiter;
  out.push(`waiter ${w.before.alive ? (w.before.version ?? '?') : 'none'} -> ${w.after.alive ? (w.after.version ?? '?') : 'none'}`);
  out.push(`behind copies: target ${r.behind.target}, source ${r.behind.source}${r.behind.target ? ` (${r.behind.targetIds.slice(0, 10).join(', ')})` : ''}`);
  out.push(`mid-turn: ${r.midTurn.length ? r.midTurn.map((m) => m.id).join(', ') : 'none'}`);
  out.push(`${r.elapsedMs} ms`);
  return out;
}
