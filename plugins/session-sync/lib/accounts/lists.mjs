/**
 * lists.mjs - what the claude.ai side keeps per account and a link cannot move
 * (plan 5.17): connectors, published artifacts and plugins that the CURRENT
 * account lacks but another account on this machine has. Local records only,
 * no network.
 *
 * Output is deliberately narrow: connectors print a name and a redacted URL,
 * artifacts a claude.ai URL and a title, plugins a name. Never a uuid, tool list,
 * instructions, header, credential or `sourcePath`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RECORD, homeOf } from './folders.mjs';
import { toMs } from './merge3.mjs';
import { RUNTIME } from './tasks.mjs';

const CTRL = /[\u0000-\u001f\u007f-\u009f]/g;
const clean = (s, max) => String(s ?? '').replace(CTRL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** Normalized form of a connector URL for comparing: lowercased host, origin + path, no trailing slash. */
function normUrl(raw) {
  try {
    const u = new URL(String(raw));
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host.toLowerCase()}${path}`;
  } catch { return null; }
}

/** Display form: origin + path, no query, fragment or userinfo; long token-like path segments redacted. */
export function displayUrl(raw) {
  try {
    const u = new URL(String(raw));
    const path = u.pathname.split('/').map((seg) => (/[A-Za-z0-9_-]{24,}/.test(seg) ? '<redacted>' : seg)).join('/').replace(/\/+$/, '');
    return clean(`${u.protocol}//${u.host.toLowerCase()}${path}`, 200);
  } catch { return null; }
}

/** claude.ai artifact URL without query or fragment, or null for anything else. */
function artifactUrl(raw) {
  try {
    const u = new URL(String(raw));
    if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'claude.ai') return null;
    return `https://claude.ai${u.pathname}`;
  } catch { return null; }
}

const ms = (v) => (typeof v === 'number' ? v : Date.parse(v ?? '') || 0);

/**
 * One parsed record per id, tagged with the account that holds its HOME folder.
 * Mirrors (hard links to the same inode) are never parsed twice.
 */
function homedRecords(ctx, folders, state, remoteList) {
  const present = new Map();
  for (const f of folders) {
    let names = [];
    try { names = readdirSync(f.path); } catch { continue; }
    for (const n of names) {
      const m = RECORD.exec(n);
      if (!m) continue;
      const id = `local_${m[1].toLowerCase()}`;
      if (!present.has(id)) present.set(id, new Map());
      present.get(id).set(f.key, join(f.path, n));
    }
  }
  const groupKeys = folders.map((f) => f.key);
  const out = [];
  for (const [id, byKey] of present) {
    const keys = [...byKey.keys()].sort();
    let home = homeOf(id, keys, state, remoteList, groupKeys);
    if (!byKey.has(home)) home = keys[0];
    let rec = null;
    try { rec = JSON.parse(readFileSync(byKey.get(home), 'utf8')); } catch { continue; }
    if (!rec || typeof rec !== 'object') continue;
    out.push({ id, home, acct: home.split('/')[0], rec });
  }
  return out;
}

function pluginNames(ctx, acct, folders) {
  const names = new Set();
  for (const f of folders.filter((x) => x.acct === acct)) {
    let doc = null;
    try { doc = JSON.parse(readFileSync(join(ctx.userData, 'plugin-list', f.acct, f.org, 'plugins.json'), 'utf8')); } catch { continue; }
    const list = Array.isArray(doc) ? doc : Array.isArray(doc?.plugins) ? doc.plugins : [];
    for (const p of list) if (p && typeof p.name === 'string') names.add(clean(p.name, 80));
  }
  return names;
}

/** What `current` lacks, from the records homed in every other account. */
function viewFor(current, items, ctx, folders) {
  const mine = items.filter((x) => x.acct === current);
  const others = items.filter((x) => x.acct !== current);

  const have = { urls: new Set(), names: new Set(), artifacts: new Set() };
  for (const { rec } of mine) {
    for (const c of Array.isArray(rec.remoteMcpServersConfig) ? rec.remoteMcpServersConfig : []) {
      if (!c || typeof c !== 'object') continue;
      const nu = c.url ? normUrl(c.url) : null;
      if (nu) have.urls.add(nu); else if (c.name) have.names.add(clean(c.name, 60).toLowerCase());
    }
    for (const a of Array.isArray(rec.publishedArtifacts) ? rec.publishedArtifacts : []) {
      const u = a && artifactUrl(a.url);
      if (u) have.artifacts.add(u);
    }
  }

  const conn = new Map();
  const arts = new Map();
  for (const { rec } of others) {
    const seen = ms(rec.lastActivityAt);
    for (const c of Array.isArray(rec.remoteMcpServersConfig) ? rec.remoteMcpServersConfig : []) {
      if (!c || typeof c !== 'object' || !c.name) continue;
      const nu = c.url ? normUrl(c.url) : null;
      const name = clean(c.name, 60);
      const key = nu ?? `name:${name.toLowerCase()}`;
      if (nu ? have.urls.has(nu) : have.names.has(name.toLowerCase())) continue;
      const prev = conn.get(key);
      if (!prev || seen > prev.seen) conn.set(key, { name, url: nu ? displayUrl(c.url) : null, seen });
    }
    for (const a of Array.isArray(rec.publishedArtifacts) ? rec.publishedArtifacts : []) {
      const url = a && artifactUrl(a.url);
      if (!url || have.artifacts.has(url)) continue;
      const at = ms(a.updatedAt);
      const prev = arts.get(url);
      if (!prev || at > prev.at) arts.set(url, { url, title: clean(a.title, 120) || null, updatedAt: at ? new Date(at).toISOString() : null, at });
    }
  }

  const mineP = pluginNames(ctx, current, folders);
  const otherP = new Set();
  for (const a of new Set(others.map((x) => x.acct))) for (const n of pluginNames(ctx, a, folders)) otherP.add(n);

  return {
    account: current.slice(0, 8),
    connectorsMissing: [...conn.values()].sort((a, b) => b.seen - a.seen).map(({ name, url }) => ({ name, ...(url ? { url } : {}) })),
    artifactsFromOthers: [...arts.values()].sort((a, b) => (b.at || -1) - (a.at || -1)).map(({ url, title, updatedAt }) => ({ url, title, updatedAt })),
    pluginsMissing: [...otherP].filter((n) => !mineP.has(n)).sort(),
  };
}

/**
 * @param {object} ctx
 * @param {Array}  folders   every `<acct>/<org>` folder (listFolders)
 * @param {object} state
 * @param {string|null} signedIn  the signed-in account, or null when unknown (every account gets its own view)
 * @returns {{current:string|null, views:Array}}
 */
export function accountLists(ctx, folders, state, { signedIn = null, remoteList = null } = {}) {
  const accts = [...new Set(folders.map((f) => f.acct))].sort();
  if (accts.length < 2) return { current: signedIn ? signedIn.slice(0, 8) : null, views: [] };
  const items = homedRecords(ctx, folders, state, remoteList);
  const targets = signedIn && accts.includes(signedIn) ? [signedIn] : accts;
  return { current: signedIn ? signedIn.slice(0, 8) : null, views: targets.map((a) => viewFor(a, items, ctx, folders)) };
}

export const connectorsMissing = (ctx, folders, state, o) => accountLists(ctx, folders, state, o).views.map((v) => ({ account: v.account, items: v.connectorsMissing }));
export const artifactsFromOthers = (ctx, folders, state, o) => accountLists(ctx, folders, state, o).views.map((v) => ({ account: v.account, items: v.artifactsFromOthers }));
export const pluginsMissing = (ctx, folders, state, o) => accountLists(ctx, folders, state, o).views.map((v) => ({ account: v.account, items: v.pluginsMissing }));

/* ------------------------------------------------------------------ tasks due a catch-up */

/** One cron field ("*", "n", "a-b", step forms, comma lists) as a predicate, or null when unparseable. */
function cronField(text, lo, hi) {
  const tests = [];
  for (const part of String(text).split(',')) {
    const m = /^(?:\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const step = m[3] ? Number(m[3]) : 1;
    if (!step) return null;
    const from = m[1] === undefined ? lo : Number(m[1]);
    const to = m[1] === undefined ? hi : m[2] !== undefined ? Number(m[2]) : m[3] ? hi : from;
    tests.push((v) => v >= from && v <= to && (v - from) % step === 0);
  }
  return (v) => tests.some((t) => t(v));
}

/** A matcher for a 5-field cron expression in LOCAL time (the app fires in local time), or null. */
function cronMatcher(expr) {
  const f = String(expr ?? '').trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [mi, h, dom, mo, dow] = [cronField(f[0], 0, 59), cronField(f[1], 0, 23), cronField(f[2], 1, 31), cronField(f[3], 1, 12), cronField(f[4], 0, 7)];
  if (![mi, h, dom, mo, dow].every(Boolean)) return null;
  const anyStar = f[2] === '*' || f[4] === '*';
  return (d) => {
    if (!mi(d.getMinutes()) || !h(d.getHours()) || !mo(d.getMonth() + 1)) return false;
    const dm = dom(d.getDate());
    const dw = dow(d.getDay()) || (d.getDay() === 0 && dow(7));
    return anyStar ? dm && dw : dm || dw;
  };
}

/**
 * The app's missed-run rule: a cron task fires once for the latest slot after
 * max(lastScheduledFor ?? lastRunAt ?? createdAt, missedRunScanFloor, now - 7 days); a one-shot
 * fires when `enabled && !lastRunAt && fireAt <= now`.
 */
export function taskIsDue(t, now) {
  if (!t || t.enabled !== true) return false;
  if (t.fireAt !== undefined && t.fireAt !== null) return !t.lastRunAt && toMs(t.fireAt) <= now;
  const match = cronMatcher(t.cronExpression);
  if (!match) return false;
  const after = Math.max(toMs(t.lastScheduledFor ?? t.lastRunAt ?? t.createdAt), toMs(t.missedRunScanFloor), now - 7 * 86400000);
  const floor = Number.isFinite(after) ? after : now - 7 * 86400000;
  for (let at = Math.floor(now / 60000) * 60000; at > floor; at -= 60000) if (match(new Date(at))) return true;
  return false;
}

/**
 * Tasks that will catch up once when the signed-in account next loads its task file. The files
 * of `folders` are combined by id with each run-time at its newest (what a full pass writes), so
 * this also answers "what would the first link make the app run". Names only, control characters
 * stripped. Unreadable files are skipped.
 */
export function tasksDueCatchUp(folders, now) {
  const merged = new Map();
  for (const f of folders) {
    let doc = null;
    try { doc = JSON.parse(readFileSync(join(f.path, 'scheduled-tasks.json'), 'utf8')); } catch { continue; }
    for (const t of Array.isArray(doc?.scheduledTasks) ? doc.scheduledTasks : []) {
      if (!t || typeof t !== 'object' || typeof t.id !== 'string') continue;
      const prev = merged.get(t.id);
      if (!prev) { merged.set(t.id, { ...t }); continue; }
      for (const k of RUNTIME) if (toMs(t[k]) > toMs(prev[k])) prev[k] = t[k];
    }
  }
  const due = [...merged.values()].filter((t) => taskIsDue(t, now)).map((t) => clean(t.displayName ?? t.id, 60)).sort();
  return { count: due.length, names: due.slice(0, 10) };
}
