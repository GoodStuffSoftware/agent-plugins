/**
 * rclinks.mjs - which Remote Control links were minted under another account (0.5.7).
 *
 * The `ownerAccountUuid` of a `bridge-session` entry says nothing about the account the app was signed in as: the CLI stamps it from its own
 * cached identity, so on a machine that switched accounts every link carries the old account's uuid. The decision "was this link minted
 * under another account" therefore never reads that field. It comes from two records the plugin keeps (and can rebuild):
 *
 *   switch-history.json   [{at (ISO), acct}]: the account that was signed in from `at` on. Appended by the account pass when it sees a
 *                         switch; seeded (and refreshed when it is stale) from the app's remote-control.log, whose `start identity=<org>:<acct>`
 *                         lines name the account of each start of the Remote Control service.
 *   rc-links.json         {v:1, links:{<bridgeSessionId>: {acct, firstSeen}}}: for each link, the account that was signed in when the
 *                         transcript first named it. A cache: it can be rebuilt from the transcript and the history.
 *
 * A transcript's `bridge-session` lines carry no timestamp, so the first sighting of a link is dated by the `timestamp` of the nearest
 * preceding line (only that one token is read from it; nothing else of that line is decoded or kept). Without a date the transcript's
 * modified time is used when it is older than the last switch. A link whose account cannot be told is never called foreign.
 *
 * 0.5.10: "foreign" is not the only way a link is dead. The app retires an account's Remote Control instance at every switch, so a link minted
 * under the account that is signed in NOW, but before this sign-in began (an A to B and back to A round trip), is gone as well, and the CLI's
 * owner check lets it through to a "gone" reattach that mints a link with a default name. `staleLink` answers that, whatever the owner.
 */

import { openSync, readSync, fstatSync, closeSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { accPath, readJson, writeJsonAtomic } from './state.mjs';

export const ledgerFile = (ctx) => accPath(ctx, 'rc-links.json');
export const switchHistoryFile = (ctx) => accPath(ctx, 'switch-history.json');

const lower = (s) => (typeof s === 'string' ? s.toLowerCase() : '');
const msOf = (v) => (typeof v === 'number' ? v : Date.parse(v));

/**
 * The app's Remote Control log. `SESSION_SYNC_RC_LOG` replaces the path (an empty value switches the seed off; the test preload sets it).
 */
export function defaultRcLog(platform = process.platform, env = process.env) {
  if (env.SESSION_SYNC_RC_LOG !== undefined) return env.SESSION_SYNC_RC_LOG || null;
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Claude', 'logs', 'remote-control.log');
  if (platform === 'darwin') return join(homedir(), 'Library', 'Logs', 'Claude', 'remote-control.log');
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Claude', 'logs', 'remote-control.log');
}

const START_LINE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)? \[\w+\] start identity=[0-9a-f-]{36}:([0-9a-f-]{36})\b/i;

/** The account changes in a remote-control.log text: [{at (ms, the log's local clock), acct}], oldest first, consecutive repeats dropped. */
export function parseIdentityLog(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = START_LINE.exec(line);
    if (!m) continue;
    const at = new Date(`${m[1]}T${m[2]}`).getTime();
    const acct = lower(m[3]);
    if (!Number.isFinite(at)) continue;
    if (out.length && out[out.length - 1].acct === acct) continue;
    out.push({ at, acct });
  }
  return out;
}

function readLogSeed(rcLog) {
  if (!rcLog) return [];
  let fd; try { fd = openSync(rcLog, 'r'); } catch { return []; }
  try {
    const size = fstatSync(fd).size; const len = Math.min(size, 16 * 1024 * 1024);
    const buf = Buffer.alloc(len); readSync(fd, buf, 0, len, size - len);
    return parseIdentityLog(buf.toString('utf8'));
  } catch { return []; } finally { try { closeSync(fd); } catch { /* ignore */ } }
}

/**
 * The switch history: [{at (ms), acct}] oldest first, and `dirty` when it differs from the saved file (a seed or a refresh from the log).
 * Read only. o: { acct (the signed-in account), rcLog (path; null: no seed; default defaultRcLog()) }
 */
export function switchHistory(ctx, o = {}) {
  const raw = readJson(switchHistoryFile(ctx), null);
  let list = Array.isArray(raw)
    ? raw.map((e) => ({ at: msOf(e?.at), acct: lower(e?.acct) })).filter((e) => Number.isFinite(e.at) && e.acct).sort((a, b) => a.at - b.at)
    : null;
  const exists = list !== null;
  list ??= [];
  const cur = lower(o.acct);
  let dirty = !exists;
  if (!exists || (cur && list.length && list[list.length - 1].acct !== cur)) {   // missing, or stale: the app was switched while nothing noted it
    // an explicit null means "no seed"; undefined (a caller that has none, even as a present key) means the app's own log
    const rcLog = o.rcLog !== undefined ? o.rcLog : (ctx.rcLog !== undefined ? ctx.rcLog : defaultRcLog(ctx.platform));
    for (const s of readLogSeed(rcLog)) {
      const last = list[list.length - 1];
      if (last && (s.at <= last.at || s.acct === last.acct)) continue;
      list.push(s); dirty = true;
    }
  }
  if (!list.length) dirty = false;
  return { list, dirty };
}

/**
 * When did the current sign-in begin, if that was within `withinMs` of `nowMs`? (ms), else null: no switch recorded (one history entry only),
 * the last entry names another account, or the switch is older. A watcher that starts just after a switch uses it to sweep at once.
 * Read only. o: { rcLog }
 */
export function recentSwitch(ctx, acct, nowMs, withinMs, o = {}) {
  const { list } = switchHistory(ctx, { ...o, acct });
  const last = list[list.length - 1];
  if (list.length < 2 || !last || last.acct !== lower(acct)) return null;
  const age = nowMs - last.at;
  return age >= 0 && age <= withinMs ? last.at : null;
}

/** The account that was signed in at `tMs`, or null when that cannot be told (before the history, or after a switch nothing recorded). */
export function acctAt(list, tMs, curAcct) {
  let hit = null;
  for (const e of list) { if (e.at <= tMs) hit = e; else break; }
  if (!hit) return null;
  if (hit === list[list.length - 1] && curAcct && hit.acct !== lower(curAcct)) return null;
  return hit.acct;
}

const writeHistory = (ctx, list) => writeJsonAtomic(switchHistoryFile(ctx), list.map((e) => ({ at: new Date(e.at).toISOString(), acct: e.acct })));

/** The account pass saw `acct` signed in at `atMs`: append it when it differs from the last entry. Never throws. */
export function recordSwitch(ctx, acct, atMs, o = {}) {
  try {
    const a = lower(acct);
    if (!a) return false;
    const { list, dirty } = switchHistory(ctx, { ...o, acct: a });
    if (!list.length && o.prev) list.push({ at: 0, acct: lower(o.prev) });   // nothing known before: the account just left was signed in until now
    const last = list[list.length - 1];
    if (last && last.acct === a) { if (dirty) writeHistory(ctx, list); return false; }
    list.push({ at: atMs, acct: a });
    writeHistory(ctx, list);
    return true;
  } catch { return false; }
}

export function readLedger(ctx) {
  const j = readJson(ledgerFile(ctx), null);
  return j && typeof j === 'object' && j.links && typeof j.links === 'object' ? j : { v: 1, links: {} };
}

/** Record links that are not in the ledger yet: found = {<bridgeSessionId>: {acct, firstSeen (ms)}}. Atomic (tmp + rename); adds only. */
export function observeLinks(ctx, found) {
  const ids = Object.keys(found ?? {});
  if (!ids.length) return 0;
  const led = readLedger(ctx);
  let n = 0;
  for (const id of ids) {
    if (led.links[id]) continue;
    led.links[id] = { acct: lower(found[id].acct), firstSeen: new Date(found[id].firstSeen).toISOString() };
    n++;
  }
  if (n) writeJsonAtomic(ledgerFile(ctx), led);
  return n;
}

/* ------------------------------------------------------------------ the first sighting of a link in a transcript */

const CHUNK = 512 * 1024;
const BLOCK = 256 * 1024;
const LINK_ID = /^[A-Za-z0-9_-]{4,100}$/;
const TS = /"timestamp":"(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)"/g;

/**
 * When did this transcript first name the link? The first `bridge-session` line that carries `"bridgeSessionId":"<id>"`, dated by the
 * nearest preceding line that has a `timestamp`. Only that token is taken from those lines (a regex over the raw bytes); nothing of
 * them is parsed or kept. Returns ms, or null when it cannot be told.
 */
export function firstSeenOfLink(file, bridgeId) { return firstSeenBounds(file, bridgeId).before; }

/**
 * The same search, with both neighbours: `before` is the nearest timestamp before the line, `after` the nearest after it (up to 3 lines
 * each way). A link minted while the session sat idle lies between the two, which may straddle an account switch.
 */
export function firstSeenBounds(file, bridgeId) {
  const none = { before: null, after: null };
  if (!LINK_ID.test(bridgeId ?? '')) return none;
  const needle = Buffer.from(`"bridgeSessionId":"${bridgeId}"`);
  let fd; try { fd = openSync(file, 'r'); } catch { return none; }
  try {
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(CHUNK + needle.length);
    for (let pos = 0; pos < size; pos += CHUNK) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
      let from = 0;
      for (;;) {
        const i = buf.subarray(0, n).indexOf(needle, from);
        if (i < 0 || i >= CHUNK) break;
        from = i + 1;
        const abs = pos + i;
        const line = bridgeLineStart(fd, abs, needle.length, size);
        if (line !== null) return { before: timestampBefore(fd, line.start), after: timestampAfter(fd, line.end, size) };
      }
    }
    return none;
  } catch { return none; } finally { try { closeSync(fd); } catch { /* ignore */ } }
}

/** The start and end offsets of the line that holds a match at `abs`, when that line is a short `bridge-session` line; else null. */
function bridgeLineStart(fd, abs, len, size) {
  const a = Math.max(0, abs - 2048);
  const b = Buffer.alloc(Math.min(size, abs + len + 2048) - a);
  readSync(fd, b, 0, b.length, a);
  const rel = abs - a;
  const ls = b.lastIndexOf(10, rel) + 1;
  if (ls === 0 && a > 0) return null;                       // the line is longer than the window: not a bridge-session line
  let le = b.indexOf(10, rel + len); if (le < 0) { if (a + b.length < size) return null; le = b.length; }
  return b.subarray(ls, le).includes('"type":"bridge-session"') ? { start: a + ls, end: a + le } : null;
}

/** The `timestamp` of the nearest of the (up to 20: metadata lines carry none) lines after offset `le` (the newline that ends the bridge line); null when none has one. */
function timestampAfter(fd, le, size) {
  const from = le + 1;
  if (from >= size) return null;
  const b = Buffer.alloc(Math.min(BLOCK, size - from));
  readSync(fd, b, 0, b.length, from);
  let pos = 0;
  for (let k = 0; k < 20 && pos < b.length; k++) {
    let nl = b.indexOf(10, pos); if (nl < 0) nl = b.length;
    const text = b.subarray(pos, nl).toString('latin1');
    TS.lastIndex = 0;
    const m = TS.exec(text);
    if (m) { const t = Date.parse(m[1]); if (Number.isFinite(t)) return t; }
    pos = nl + 1;
  }
  return null;
}

/** The `timestamp` of the nearest of the (up to 3) lines before offset `ls`; null when none has one. */
function timestampBefore(fd, ls) {
  if (ls === 0) return null;
  const start = Math.max(0, ls - BLOCK);
  const b = Buffer.alloc(ls - 1 - start);          // up to the newline that ends the previous line
  if (b.length <= 0) return null;
  readSync(fd, b, 0, b.length, start);
  let end = b.length;
  for (let k = 0; k < 3 && end > 0; k++) {
    const nl = b.lastIndexOf(10, end - 1);
    const text = b.subarray(nl + 1, end).toString('latin1');
    let last = null; TS.lastIndex = 0;
    for (let m = TS.exec(text); m; m = TS.exec(text)) last = m[1];
    if (last) { const t = Date.parse(last); if (Number.isFinite(t)) return t; }
    if (nl < 0) break;
    end = nl;
  }
  return null;
}

/* ------------------------------------------------------------------ the decision */

/**
 * `foreign(bridgeSessionId, transcript)`: was this link minted under an account other than `acct`? true | false. A link the ledger
 * does not know is dated from its transcript (and recorded by `flush()`); one that cannot be dated is not foreign.
 * Read only until `flush()` (the callers that write call it; a dry run never does).
 * o: { rcLog }
 */
export function makeForeign(ctx, acct, o = {}) {
  const cur = lower(acct);
  const { list, dirty } = switchHistory(ctx, { ...o, acct: cur });
  const links = readLedger(ctx).links;
  const cache = new Map();
  const fresh = {};
  let undated = 0;   // links this check could not date (kept: an undatable link is never called foreign)
  const lastSwitch = list.length && list[list.length - 1].acct === cur ? list[list.length - 1].at : null;
  // when the CURRENT sign-in began: the last history entry, but only when an earlier entry names another account (a history of one entry says
  // when the log began, not that a switch happened, so nothing is stale by it). o.signInStart (ms) replaces it (accounts rc-sweep --before).
  const signInStart = Number.isFinite(o.signInStart) ? o.signInStart : (list.length >= 2 && list[list.length - 1].acct === cur ? list[list.length - 1].at : null);
  const dates = new Map();
  let undatedStale = 0;   // links whose date could not be told and that were judged by the transcript's modified time instead
  /** 'foreign' | 'own' (minted under the signed-in account, or no link) | 'undated' (cannot be told; not foreign). */
  function classify(bridgeId, transcript) {
    if (!bridgeId) return 'own';
    if (cache.has(bridgeId)) return cache.get(bridgeId);
    let r = 'own';
    const led = links[bridgeId];
    if (led?.acct) r = lower(led.acct) !== cur ? 'foreign' : 'own';
    else if (list.length) {
      const { before: seen, after } = transcript ? firstSeenBounds(transcript, bridgeId) : { before: null, after: null };
      if (seen !== null) {
        const a = acctAt(list, seen, cur);
        // the link may have been minted after the last event before it: when the next event is under another account, it cannot be dated
        const straddles = after !== null && acctAt(list, after, cur) !== a;
        if (a && !straddles) { fresh[bridgeId] = { acct: a, firstSeen: seen }; r = a !== cur ? 'foreign' : 'own'; }
        else { undated++; r = 'undated'; }
      } else if (transcript && lastSwitch !== null) {
        let m = null; try { m = statSync(transcript).mtimeMs; } catch { /* gone */ }
        if (m !== null && m < lastSwitch) { const a = acctAt(list, m, cur); r = a && a !== cur ? 'foreign' : (a ? 'own' : 'undated'); }   // untouched since the switch: dated by its last write
        else { undated++; r = 'undated'; }
      } else { undated++; r = 'undated'; }
    } else r = 'undated';   // no history at all: nothing to date it by
    cache.set(bridgeId, r);
    return r;
  }
  const foreign = (bridgeId, transcript) => classify(bridgeId, transcript) === 'foreign';
  /**
   * The bounds of the mint time of a link: `lower` (the nearest timestamp before its first line, or the ledger's first sighting, whichever is
   * later: the link existed no earlier than that) and `upper` (the nearest timestamp after its first line; null when there is none).
   */
  function linkBounds(bridgeId, transcript) {
    if (dates.has(bridgeId)) return dates.get(bridgeId);
    const b = transcript ? firstSeenBounds(transcript, bridgeId) : { before: null, after: null };
    const led = Date.parse(links[bridgeId]?.firstSeen ?? '');
    const lows = [b.before, Number.isFinite(led) ? led : null].filter((x) => x !== null);
    const out = { lower: lows.length ? Math.max(...lows) : null, upper: b.after };
    dates.set(bridgeId, out);
    return out;
  }
  /**
   * Was this link certainly minted before `cutoff` (default: the start of the current sign-in), whatever account minted it? The nearest
   * timestamp BEFORE the link line is only a lower bound of the mint time (a resumed session writes its link before its next timestamped
   * line), so a link is stale only when its UPPER bound is below the cutoff: the nearest timestamp after it or, when none follows, the
   * transcript's modified time (nothing was written since). A link first seen at or after the cutoff, or whose bounds straddle it, is left
   * alone. No cutoff known: false.
   */
  function staleLink(bridgeId, transcript, cutoff = signInStart) {
    if (!bridgeId || !Number.isFinite(cutoff)) return false;
    const { lower, upper } = linkBounds(bridgeId, transcript);
    if (lower !== null && lower >= cutoff) return false;
    if (upper !== null) return upper < cutoff;
    let m = null; try { m = statSync(transcript).mtimeMs; } catch { /* gone */ }
    if (m !== null && m < cutoff) { undatedStale++; return true; }
    return false;
  }
  function flush() {
    try {
      if (dirty) writeHistory(ctx, list);
      observeLinks(ctx, fresh);
    } catch { /* a cache: the next pass rebuilds it */ }
  }
  return { foreign, classify, staleLink, signInStart, flush, history: list, get undated() { return undated; }, get undatedStale() { return undatedStale; } };
}
