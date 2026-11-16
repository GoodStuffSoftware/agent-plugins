/**
 * folders.mjs - discovery of the desktop app's per-account folders, the link
 * group, and the "home" of a record (plan sections 5.1, 2).
 *
 * A folder is a REAL directory `<store>/<acct>/<org>`; both names are UUIDs.
 * A dirent that is not a directory (a junction or symlink included) is skipped:
 * the app's own scanners skip junctions, so we never treat one as a folder.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const RECORD = /^local_([0-9a-f-]{36})\.json$/i;
export const TOMB = /^deleted_([0-9a-f-]{36})$/i;
export const OURTMP = /^\.session-sync-link-[0-9a-f]{12}$/;

/** `<acct>/<org>` folders under the store, sorted by key. */
export function listFolders(store) {
  const out = [];
  let accts;
  try { accts = readdirSync(store, { withFileTypes: true }); } catch { return out; }
  for (const a of accts) {
    if (!a.isDirectory() || !UUID.test(a.name)) continue;
    let orgs;
    try { orgs = readdirSync(join(store, a.name), { withFileTypes: true }); } catch { continue; }
    for (const o of orgs) {
      if (!o.isDirectory() || !UUID.test(o.name)) continue;
      out.push({ acct: a.name, org: o.name, key: `${a.name}/${o.name}`, path: join(store, a.name, o.name) });
    }
  }
  return out.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
}

/** Distinct account ids, sorted. */
export function accountsOf(folders) {
  return [...new Set(folders.map((f) => f.acct))].sort();
}

/** Unordered pair key. */
export function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Accounts in a connected component (>= 2 accounts) of the graph of "yes" pair answers. */
export function groupAccounts(state, folders) {
  const accts = accountsOf(folders);
  const parent = new Map(accts.map((a) => [a, a]));
  const find = (x) => {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  for (const [k, v] of Object.entries(state?.pairs || {})) {
    if (v?.answer !== 'yes') continue;
    const [a, b] = k.split('|');
    if (!parent.has(a) || !parent.has(b)) continue;
    parent.set(find(a), find(b));
  }
  const comps = new Map();
  for (const a of accts) {
    const r = find(a);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r).push(a);
  }
  return [...comps.values()].filter((c) => c.length >= 2).flat().sort();
}

/**
 * The folders of every account that is joined to another by "yes" answers.
 * All orgs of a linked account join the group.
 */
export function groupOf(state, folders) {
  const accts = new Set(groupAccounts(state, folders));
  return folders.filter((f) => accts.has(f.acct));
}

/** Every unordered account pair with no recorded answer. */
export function pendingPairs(state, accts) {
  const list = [...accts].sort();
  const out = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const k = pairKey(list[i], list[j]);
      if (!state?.pairs?.[k]) out.push(k);
    }
  }
  return out;
}

/** Record one answer for the given pair keys (all pending pairs at once keeps the group transitive). */
export function answerPairs(state, pairKeys, answer, via, now = Date.now()) {
  state.pairs ||= {};
  const at = new Date(now).toISOString();
  for (const k of pairKeys) {
    const prev = state.pairs[k] || {};
    state.pairs[k] = { askedAt: prev.askedAt ?? null, askCount: prev.askCount ?? 0, ...prev, answer, at, via };
  }
  return state;
}

/**
 * The folder where a record was first seen. Stable once chosen (callers
 * persist it in state.records[id].home), so homes agree across machines.
 *
 * @param {string}   id           `local_<uuid>`
 * @param {string[]} present      folder keys that hold the record now
 * @param {object}   state
 * @param {object}   [remoteList] `{ids:{<id>:[folderKey]}}`
 * @param {string[]} [groupKeys]  keys of the group's folders
 */
export function homeOf(id, present, state, remoteList, groupKeys) {
  const stored = state?.records?.[id]?.home;
  if (stored && (!groupKeys || groupKeys.includes(stored))) return stored;
  if (present.length === 1) return present[0];
  const remote = remoteList?.ids?.[id];
  if (Array.isArray(remote) && remote.length === 1 && (!groupKeys || groupKeys.includes(remote[0]))) return remote[0];
  return present.length ? [...present].sort()[0] : null;
}
