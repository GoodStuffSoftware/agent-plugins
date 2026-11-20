/**
 * 0.5.10: the widened switch criterion (a link minted before the current sign-in is stale whatever its owner), `accounts rc-sweep`, the
 * noHistoryBackfill loop guard, the liveness back-off, and `accounts rc-repair --at-turn-end` with its Stop hook and helper.
 * Synthetic stores, transcripts and process lists in temp folders only: `liveCliIds`, `listProcs`, `stopPids`, `launch` and `sleep` are
 * injected, so nothing here starts PowerShell, launches a helper or stops a process, and nothing touches the live store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeRoot, addFolder, putRecord, uuid, setMtime } from './fixtures/store.mjs';
import { cworld, cleanupWorlds, CLI } from './fixtures/cliworld.mjs';
import {
  rcSweep, liveRelinkPass, liveRelinkCandidates, lastBridgeEntry, scanBridgeEntries, hasHistorySuppression, isGoneBounce, RC_DEFAULTS,
} from '../lib/accounts/rcrestore.mjs';
import { rcRepair, turnEndHook, runTurnEnd, turnEndFile, writeTurnEndRequest, TURN_END_MAX_LAUNCHES, TURN_END_GAP_MS } from '../lib/accounts/rcrepair.mjs';
import { recentSwitch, switchHistoryFile } from '../lib/accounts/rclinks.mjs';

test.after(() => cleanupWorlds());

// a round trip A -> B -> A: the app is signed in as ME again, since T2; links minted in the first stint under ME are dead
const ME = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000a2';
const ORG = uuid('f', 1);
const T0 = Date.parse('2026-11-01T00:00:00Z');
const T1 = Date.parse('2026-11-19T10:00:00Z');
const T2 = Date.parse('2026-11-20T18:09:00Z');      // the current sign-in began
const NOW = Date.parse('2026-11-20T20:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const CLEAR = (cli) => `{"type":"bridge-session","sessionId":"${cli}","bridgeSessionId":"","lastSequenceNum":0}`;
const cli = (n) => uuid('d', n);
const sid = (n) => `local_${uuid('c', n)}`;
const keyOf = (n) => `C:\\synthetic\\project-${n}`.replace(/[^a-zA-Z0-9]/g, '-');

function world({ history = [{ at: iso(T0), acct: ME }, { at: iso(T1), acct: OTHER }, { at: iso(T2), acct: ME }] } = {}) {
  const r = makeRoot('sweep');
  writeFileSync(join(r.userData, 'config.json'), JSON.stringify({ lastKnownAccountUuid: ME }));
  const projects = join(r.root, 'projects');
  mkdirSync(projects, { recursive: true });
  const folder = addFolder(r.store, ME, ORG);
  r.ctx.platform = 'win32';
  r.ctx.rcLog = null;
  r.ctx.setNow(NOW);
  if (history) { mkdirSync(r.acc, { recursive: true }); writeFileSync(switchHistoryFile(r.ctx), JSON.stringify(history)); }
  return { ...r, projects, folder };
}
const tpOf = (w, n) => join(w.projects, keyOf(n), `${cli(n)}.jsonl`);

/**
 * A session whose transcript was first linked at `at` (ISO; 'none' = a transcript with no timestamp tokens) and whose last link is `link`.
 * `before`: bridge lines written earlier (a different link, a clear line). `suppress`: a history-suppression line.
 */
function session(w, n, { link = 'cse_a', nhb = false, at = '2026-11-15T10:00:00.000Z', before = [], suppress = false, ageMs = 3600_000, rec = {}, laterMs = 60_000, later = true } = {}) {
  putRecord(w.folder.path, n, { lastActivityAt: iso(NOW - ageMs), title: `Session ${n}`, remoteControlUserEnabled: true, bridgeSessionIds: [`session_${n}`], ...rec });
  mkdirSync(join(w.projects, keyOf(n)), { recursive: true });
  const dated = Number.isFinite(Date.parse(at));
  const bl = (id, extra = {}) => JSON.stringify({ type: 'bridge-session', sessionId: cli(n), bridgeSessionId: id, lastSequenceNum: 7, ownerAccountUuid: ME, ...extra });
  const lines = [
    JSON.stringify({ type: 'user', ...(dated ? { timestamp: at } : {}), message: 'hello' }),
    JSON.stringify({ type: 'assistant', ...(dated ? { timestamp: at } : {}), message: 'hi' }),
    ...(suppress ? [JSON.stringify({ type: 'history-suppression', cause: 'restored_owner_mismatch' })] : []),
    ...before.map((b) => (b === '' ? CLEAR(cli(n)) : bl(b))),
    bl(link, nhb ? { noHistoryBackfill: true } : {}),
    ...(later ? [JSON.stringify({ type: 'assistant', ...(dated ? { timestamp: iso(Date.parse(at) + laterMs) } : {}), message: 'later' })] : []),
  ];
  const tp = tpOf(w, n);
  mkdirSync(join(w.projects, keyOf(n)), { recursive: true });
  writeFileSync(tp, lines.join('\n') + '\n');
  setMtime(tp, NOW - ageMs);
  return tp;
}

const sweep = (w, o = {}) => rcSweep(w.ctx, { projects: w.projects, rcLog: null, now: NOW, liveCliIds: () => new Set(), sleep: async () => {}, ...o });
const backups = (w) => { const root = join(w.acc, 'rc-restore', 'backup'); return existsSync(root) ? readdirSync(root) : []; };

/* ------------------------------------------------------------------ the widened criterion */

test('S1 after an A to B to A round trip a link minted under A BEFORE the round trip is cleared (a titled link, the owner stamp is ME); one minted after is left', async () => {
  const w = world();
  const dead = session(w, 1, { link: 'cse_dead', at: '2026-11-15T10:00:00.000Z' });      // minted in the first stint, before T1
  const mid = session(w, 2, { link: 'cse_mid', at: '2026-11-19T22:00:00.000Z' });        // minted while B was signed in
  const fresh = session(w, 3, { link: 'cse_fresh', at: '2026-11-20T18:30:00.000Z' });    // minted after T2
  const r = await sweep(w);
  assert.equal(r.ran, true);
  assert.equal(r.cutoff, T2, 'the default cutoff is the start of the current sign-in');
  assert.deepEqual(r.cleared.map((c) => c.id).sort(), [sid(1), sid(2)].sort());
  assert.equal(lastBridgeEntry(dead).bridgeSessionId, '');
  assert.equal(lastBridgeEntry(mid).bridgeSessionId, '');
  assert.equal(lastBridgeEntry(fresh).bridgeSessionId, 'cse_fresh');
  assert.ok(readFileSync(dead, 'utf8').endsWith(`${CLEAR(cli(1))}\n`));
});

test('S2 an undatable link (no timestamp near it) is stale only when the transcript mtime predates the sign-in', async () => {
  const w = world();
  const old = session(w, 1, { link: 'cse_old', at: 'none', ageMs: NOW - (T2 - 3600_000) });   // untouched since an hour before the sign-in
  const newer = session(w, 2, { link: 'cse_new', at: 'none', ageMs: 3600_000 });              // touched since
  const r = await sweep(w);
  assert.deepEqual(r.cleared.map((c) => c.id), [sid(1)]);
  assert.equal(lastBridgeEntry(old).bridgeSessionId, '');
  assert.equal(lastBridgeEntry(newer).bridgeSessionId, 'cse_new');
});

test('S3 a link whose only evidence straddles the sign-in start counts as undated: the mtime rule decides', async () => {
  const w = world();
  session(w, 1, { link: 'cse_x', at: iso(T2 - 600_000), laterMs: 1200_000 });               // the line before it is dated before T2, the line after it after T2
  const r = await sweep(w);
  assert.equal(r.cleared.length, 0, 'it may have been minted after the sign-in: not cleared');
  assert.equal(r.candidates, 0);
});

test('S4 no sign-in start known (no round trip recorded): only noHistoryBackfill and foreign links are stale', async () => {
  const w = world({ history: [{ at: iso(T0), acct: ME }] });
  const a = session(w, 1, { link: 'cse_a', at: '2026-11-15T10:00:00.000Z' });
  const r = await sweep(w);
  assert.equal(r.cutoff == null || Number.isNaN(r.cutoff), true);
  assert.equal(r.cleared.length, 0);
  assert.equal(lastBridgeEntry(a).bridgeSessionId, 'cse_a');
});

test('S5 --before moves the cutoff: a link minted before it is cleared, one after it is left', async () => {
  const w = world();
  session(w, 1, { link: 'cse_a', at: '2026-11-19T12:00:00.000Z' });
  session(w, 2, { link: 'cse_b', at: '2026-11-20T19:00:00.000Z' });                          // after T2
  const r = await sweep(w, { before: Date.parse('2026-11-20T19:30:00Z') });
  assert.equal(r.cutoff, Date.parse('2026-11-20T19:30:00Z'));
  assert.deepEqual(r.cleared.map((c) => c.id).sort(), [sid(1), sid(2)].sort());
  const w2 = world();
  session(w2, 1, { link: 'cse_a', at: '2026-11-15T12:00:00.000Z' });                        // minted in the first stint, under ME
  const earlier = await sweep(w2, { before: Date.parse('2026-11-10T00:00:00Z') });
  assert.equal(earlier.cleared.length, 0, 'minted after that cutoff');
});

test('S3b the lower bound alone never makes a link stale: a link that is the last thing in the transcript is stale only by the modified time', async () => {
  const w = world();
  // minted after the sign-in by a resumed session that then went quiet: the nearest timestamp before the line is old, nothing follows it
  const fresh = session(w, 1, { link: 'cse_fresh', at: '2026-11-15T12:00:00.000Z', later: false, ageMs: 3600_000 });         // modified after T2
  const old = session(w, 2, { link: 'cse_old', at: '2026-11-15T12:00:00.000Z', later: false, ageMs: NOW - (T2 - 3600_000) });  // modified before T2
  const r = await sweep(w);
  assert.deepEqual(r.cleared.map((c) => c.id), [sid(2)]);
  assert.equal(lastBridgeEntry(fresh).bridgeSessionId, 'cse_fresh');
  assert.equal(lastBridgeEntry(old).bridgeSessionId, '');
});

test('S3c a link spared on the first pass is spared on the second (the ledger keeps a lower bound only)', async () => {
  const w = world();
  const tp = session(w, 1, { link: 'cse_x', at: iso(T2 - 600_000), laterMs: 1200_000 });
  for (let i = 0; i < 3; i++) {
    const r = await sweep(w);
    assert.equal(r.cleared.length, 0, `pass ${i + 1}`);
    assert.equal(r.candidates, 0, `pass ${i + 1}`);
  }
  assert.equal(lastBridgeEntry(tp).bridgeSessionId, 'cse_x');
});

test('S3d a link written after our own clear line is not judged stale again by the old lines before the clear line', async () => {
  const w = world();
  const tp = session(w, 1, { link: 'cse_new', at: '2026-11-15T12:00:00.000Z', before: ['cse_old', ''], laterMs: 5.5 * 86400_000 });   // the line after it is dated after T2
  const r = await sweep(w);
  assert.equal(r.candidates, 0);
  assert.equal(lastBridgeEntry(tp).bridgeSessionId, 'cse_new');
  const tail = session(w, 2, { link: 'cse_new2', at: '2026-11-15T12:00:00.000Z', before: ['cse_old', ''], later: false, ageMs: 3600_000 });   // nothing follows; modified after T2
  assert.equal((await sweep(w)).candidates, 0);
  assert.equal(lastBridgeEntry(tail).bridgeSessionId, 'cse_new2');
});

/* ------------------------------------------------------------------ the gates */

test('S6 a live CLI is never written to; the others are', async () => {
  const w = world();
  const live = session(w, 1, { link: 'cse_a' });
  const idle = session(w, 2, { link: 'cse_b' });
  const before = readFileSync(live, 'utf8');
  const r = await sweep(w, { liveCliIds: () => new Set([cli(1)]) });
  assert.equal(r.skippedLive, 1);
  assert.deepEqual(r.cleared.map((c) => c.id), [sid(2)]);
  assert.equal(readFileSync(live, 'utf8'), before);
  assert.equal(lastBridgeEntry(idle).bridgeSessionId, '');
  assert.equal(r.sessions.find((s) => s.id === sid(1)).outcome, 'live');
});

test('S7 liveness unknown (the process list reads null on every try): nothing is written, nothing is treated as stale-and-free', async () => {
  const w = world();
  const tp = session(w, 1, { link: 'cse_a' });
  const before = readFileSync(tp, 'utf8');
  let reads = 0; const waits = [];
  const r = await sweep(w, { liveCliIds: () => { reads++; return null; }, sleep: async (ms) => { waits.push(ms); } });
  assert.equal(r.cleared.length, 0);
  assert.equal(r.unknown, 1);
  assert.equal(reads, 3, 'rc-sweep reads the list three times');
  assert.equal(waits.length, 2);
  assert.equal(readFileSync(tp, 'utf8'), before);
  assert.equal(backups(w).length, 0);
});

test('S8 the switch sweep retries the process list with back-off until it reads, then clears', async () => {
  const w = world();
  const tp = session(w, 1, { link: 'cse_a' });
  let reads = 0; const waits = []; const logs = [];
  const r = await liveRelinkPass(w.ctx, {
    settings: RC_DEFAULTS, projects: w.projects, rcLog: null, all: true, signInStart: T2,
    liveBackoffMs: [3000, 10_000, 30_000, 60_000], sleep: async (ms) => { waits.push(ms); }, log: (l) => logs.push(l),
    liveCliIds: () => (++reads < 4 ? null : new Set()),
  });
  assert.ok(reads >= 4, 'three failed reads, then the one that works (and the re-reads around the write)');
  assert.deepEqual(waits, [3000, 10_000, 30_000]);
  assert.deepEqual(r.cleared.map((c) => c.id), [sid(1)]);
  assert.equal(lastBridgeEntry(tp).bridgeSessionId, '');
  assert.ok(logs.some((l) => /could not be read, trying again in 3 s/.test(l)), logs.join('\n'));
});

test('S9 the back-off runs out: unknown, nothing written, and the log says so', async () => {
  const w = world();
  const tp = session(w, 1, { link: 'cse_a' });
  const before = readFileSync(tp, 'utf8'); const logs = [];
  const r = await liveRelinkPass(w.ctx, { settings: RC_DEFAULTS, projects: w.projects, rcLog: null, all: true, signInStart: T2, liveBackoffMs: [1, 2], sleep: async () => {}, log: (l) => logs.push(l), liveCliIds: () => null });
  assert.equal(r.unknown, 1);
  assert.equal(r.cleared.length, 0);
  assert.equal(readFileSync(tp, 'utf8'), before);
  assert.ok(logs.some((l) => /could not be read after 3 tries; nothing was written/.test(l)), logs.join('\n'));
});

test('S10 the switch sweep lifts the 10-link cap; the periodic pass keeps it', async () => {
  const w = world();
  for (let n = 1; n <= 15; n++) session(w, n, { link: `cse_${n}`, at: '2026-11-15T10:00:00.000Z' });
  const capped = await liveRelinkPass(w.ctx, { settings: RC_DEFAULTS, projects: w.projects, rcLog: null, all: true, signInStart: T2, liveCliIds: () => new Set() });
  assert.equal(capped.cleared.length, RC_DEFAULTS.liveMax, 'the default cap');
  assert.equal(capped.deferred, 5);
  const w2 = world();
  for (let n = 1; n <= 15; n++) session(w2, n, { link: `cse_${n}`, at: '2026-11-15T10:00:00.000Z' });
  const r = await sweep(w2);
  assert.equal(r.cleared.length, 15, 'rc-sweep has no cap');
  assert.equal(r.deferred, 0);
});

test('S11 a mid-turn record and a recently written transcript are skipped (the live gate is the same as the periodic pass)', async () => {
  const w = world();
  session(w, 1, { link: 'cse_a', rec: { isRunning: true } });
  session(w, 2, { link: 'cse_b', ageMs: 30_000 });
  const r = await sweep(w);
  assert.equal(r.cleared.length, 0);
  assert.equal(r.running, 1);
  assert.equal(r.quiet, 1);
});

/* ------------------------------------------------------------------ the gone-bounce loop guard */

test('S12 a noHistoryBackfill link after a different link is cleared; after a clear line, or in a history-suppression transcript, it is left', async () => {
  const w = world();
  const bounce = session(w, 1, { link: 'cse_nhb', nhb: true, at: '2026-11-20T19:00:00.000Z', before: ['cse_prev'] });
  const afterClear = session(w, 2, { link: 'cse_nhb', nhb: true, at: '2026-11-20T19:00:00.000Z', before: ['cse_prev', ''] });
  const first = session(w, 3, { link: 'cse_nhb', nhb: true, at: '2026-11-20T19:00:00.000Z' });
  const tainted = session(w, 4, { link: 'cse_nhb', nhb: true, at: '2026-11-20T19:00:00.000Z', before: ['cse_prev'], suppress: true });
  const r = await sweep(w);
  assert.deepEqual(r.cleared.map((c) => [c.id, c.why]), [[sid(1), 'noHistoryBackfill']]);
  assert.equal(r.guarded, 3);
  assert.equal(lastBridgeEntry(bounce).bridgeSessionId, '');
  assert.equal(lastBridgeEntry(afterClear).bridgeSessionId, 'cse_nhb');
  assert.equal(lastBridgeEntry(tainted).bridgeSessionId, 'cse_nhb');
  assert.equal(lastBridgeEntry(first).bridgeSessionId, 'cse_nhb');
});

test('S13 isGoneBounce ignores repeats of the link itself (the CLI re-appends the pointer every turn)', () => {
  const w = world();
  const tp = session(w, 1, { link: 'cse_nhb', nhb: true, before: ['cse_prev', 'cse_nhb', 'cse_nhb'] });
  assert.equal(isGoneBounce(tp, lastBridgeEntry(tp)), true);
  const only = session(w, 2, { link: 'cse_nhb', nhb: true, before: ['cse_nhb', 'cse_nhb'] });
  assert.equal(isGoneBounce(only, lastBridgeEntry(only)), false, 'no earlier link at all');
  assert.equal(hasHistorySuppression(session(w, 3, { suppress: true })), true);
  assert.equal(hasHistorySuppression(session(w, 4)), false);
  const seen = []; scanBridgeEntries(tp, (o) => { seen.push(o.bridgeSessionId); return false; });
  assert.deepEqual(seen, ['cse_nhb', 'cse_nhb', 'cse_nhb', 'cse_prev']);
});

/* ------------------------------------------------------------------ the one-shot command */

test('S14 rc-sweep --dry-run writes nothing, makes no backup, and lists every candidate with its outcome', async () => {
  const w = world();
  const a = session(w, 1, { link: 'cse_a' });
  const b = session(w, 2, { link: 'cse_b' });
  session(w, 3, { link: 'cse_fresh', at: '2026-11-20T19:00:00.000Z' });
  const pre = [readFileSync(a), readFileSync(b)];
  const r = await sweep(w, { dryRun: true, liveCliIds: () => new Set([cli(2)]) });
  assert.equal(r.dryRun, true);
  assert.equal(r.candidates, 2);
  assert.deepEqual(r.wouldClear.map((c) => c.id), [sid(1)]);
  assert.equal(r.cleared.length, 0);
  assert.equal(r.skippedLive, 1);
  assert.ok(readFileSync(a).equals(pre[0]) && readFileSync(b).equals(pre[1]));
  assert.equal(backups(w).length, 0);
  assert.deepEqual(r.sessions.map((s) => [s.id, s.why, s.outcome]).sort(), [[sid(1), 'stale', 'would-clear'], [sid(2), 'stale', 'live']]);
});

test('S15 the real run backs each transcript up byte for byte, appends exactly the CLI clear line, and is idempotent', async () => {
  const w = world();
  const tp = session(w, 1, { link: 'cse_a' });
  const before = readFileSync(tp, 'utf8');
  const r = await sweep(w);
  assert.equal(r.cleared.length, 1);
  const after = readFileSync(tp, 'utf8');
  assert.equal(after.slice(before.length), `${CLEAR(cli(1))}\n`);
  const dirs = backups(w);
  assert.equal(dirs.length, 1);
  assert.equal(readFileSync(join(w.acc, 'rc-restore', 'backup', dirs[0], `${cli(1)}.jsonl`), 'utf8'), before);
  const again = await sweep(w);
  assert.equal(again.candidates, 0);
  assert.equal(readFileSync(tp, 'utf8'), after);
});

test('S16 rc-sweep works with rcRestore.enabled off and liveRelink off (an explicit command)', async () => {
  const w = world();
  session(w, 1, { link: 'cse_a' });
  const r = await rcSweep(w.ctx, { projects: w.projects, rcLog: null, now: NOW, liveCliIds: () => new Set(), settings: { ...RC_DEFAULTS, enabled: false, liveRelink: 'off' } });
  assert.equal(r.ran, true);
  assert.equal(r.cleared.length, 1);
});

test('S17 liveRelinkCandidates dates links by mint time, never by ownerAccountUuid', () => {
  const w = world();
  session(w, 1, { link: 'cse_dead', at: '2026-11-15T10:00:00.000Z' });            // stamped ME, minted before the round trip
  const c = liveRelinkCandidates(w.ctx, { projects: w.projects, rcLog: null, now: NOW, all: true, signInStart: T2 });
  assert.deepEqual(c.candidates.map((x) => [x.id, x.why]), [[sid(1), 'stale']]);
  const none = liveRelinkCandidates(w.ctx, { projects: w.projects, rcLog: null, now: NOW, all: true });
  assert.deepEqual(none.candidates.map((x) => x.id), [sid(1)], 'the default cutoff is the last switch-history entry');
});

test('S18 recentSwitch: a switch within the window is reported, an older one and a first-ever entry are not', () => {
  const w = world();
  assert.equal(recentSwitch(w.ctx, ME, NOW, 15 * 60_000), null, 'T2 is 1 h 51 min old');
  assert.equal(recentSwitch(w.ctx, ME, NOW, 3 * 3600_000), T2);
  assert.equal(recentSwitch(w.ctx, OTHER, NOW, 3 * 3600_000), null, 'the last entry names another account');
  const first = world({ history: [{ at: iso(T2), acct: ME }] });
  assert.equal(recentSwitch(first.ctx, ME, NOW, 3 * 3600_000), null, 'a single entry is a first sign-in, not a switch');
});

/* ------------------------------------------------------------------ rc-repair --at-turn-end, the Stop hook, the helper */

function repairWorld() {
  const w = world();
  putRecord(w.folder.path, 1, { title: 'Session 1', cliSessionId: cli(1), cwd: 'C:\\synthetic\\project-1', isRunning: true });
  session(w, 1, { link: 'cse_dead', at: '2026-11-15T10:00:00.000Z', rec: { cliSessionId: cli(1), cwd: 'C:\\synthetic\\project-1', isRunning: true } });
  return w;
}
const procs = (initial) => {
  const st = { list: initial, stopped: [] };
  return { st, listProcs: async () => st.list.map((p) => ({ ...p })), stopPids: (pids) => { st.stopped.push(...pids); st.list = st.list.filter((p) => !pids.includes(p.pid)); return pids; } };
};
const proc = (pid, n) => ({ pid, ids: [cli(n)], resume: [cli(n)] });

test('T1 --at-turn-end on a mid-turn session only records a request: no stop, no write, no process list read', async () => {
  const w = repairWorld();
  const tp = tpOf(w, 1); const before = readFileSync(tp, 'utf8');
  let listed = 0;
  const r = await rcRepair(w.ctx, { id: sid(1), projects: w.projects, rcLog: null, atTurnEnd: true, listProcs: async () => { listed++; return []; }, stopPids: () => { throw new Error('must not stop'); } });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'queued');
  assert.equal(listed, 0);
  assert.equal(readFileSync(tp, 'utf8'), before);
  const req = JSON.parse(readFileSync(turnEndFile(w.ctx, cli(1)), 'utf8'));
  assert.equal(req.cliSessionId, cli(1));
  assert.equal(req.launches, 0);
  assert.match(r.text, /comes back on your next message/);
});

test('T2 without --at-turn-end a mid-turn session is still refused; a healthy link is not queued', async () => {
  const w = repairWorld();
  const r = await rcRepair(w.ctx, { id: sid(1), projects: w.projects, rcLog: null, stopCli: true, listProcs: async () => [], stopPids: () => [] });
  assert.equal(r.reason, 'mid-turn');
  const h = world();
  putRecord(h.folder.path, 1, { title: 'S', cliSessionId: cli(1), cwd: 'x', isRunning: true });
  session(h, 1, { link: 'cse_fresh', at: '2026-11-20T19:00:00.000Z', rec: { cliSessionId: cli(1), isRunning: true } });
  const q = await rcRepair(h.ctx, { id: sid(1), projects: h.projects, rcLog: null, atTurnEnd: true });
  assert.equal(q.reason, 'not-stale');
  assert.equal(existsSync(turnEndFile(h.ctx, cli(1))), false);
});

test('T3 the Stop hook launches the helper only for a request of its own session, once, and returns at once', () => {
  const w = repairWorld();
  writeTurnEndRequest(w.ctx, { cliSessionId: cli(1), session: sid(1), now: NOW });
  const launches = [];
  const launch = (args) => { launches.push(args); return { ok: true }; };
  assert.deepEqual(turnEndHook(w.ctx, { session_id: cli(2) }, { now: NOW, launch }), { launched: false, reason: 'none' });
  assert.deepEqual(turnEndHook(w.ctx, { session_id: 'not a uuid; rm -rf' }, { now: NOW, launch }), { launched: false, reason: 'bad-session' });
  assert.deepEqual(turnEndHook(w.ctx, {}, { now: NOW, launch }), { launched: false, reason: 'bad-session' });
  assert.equal(launches.length, 0);
  assert.deepEqual(turnEndHook(w.ctx, { session_id: cli(1) }, { now: NOW, launch }), { launched: true, reason: 'launched' });
  assert.deepEqual(launches, [['accounts', 'rc-turn-end-run', cli(1)]]);
  // a second Stop while the helper works does not start another
  assert.equal(turnEndHook(w.ctx, { session_id: cli(1) }, { now: NOW + 5000, launch }).reason, 'in-flight');
  assert.equal(launches.length, 1);
});

test('T4 the hook retries after the gap, but only TURN_END_MAX_LAUNCHES times, and drops an expired request', () => {
  const w = repairWorld();
  writeTurnEndRequest(w.ctx, { cliSessionId: cli(1), session: sid(1), now: NOW });
  let n = 0; const launch = () => { n++; return { ok: true }; };
  for (let i = 0; i < TURN_END_MAX_LAUNCHES; i++) assert.equal(turnEndHook(w.ctx, { session_id: cli(1) }, { now: NOW + i * (TURN_END_GAP_MS + 1), launch }).launched, true);
  assert.equal(turnEndHook(w.ctx, { session_id: cli(1) }, { now: NOW + 10 * TURN_END_GAP_MS, launch }).reason, 'expired');
  assert.equal(n, TURN_END_MAX_LAUNCHES);
  assert.equal(existsSync(turnEndFile(w.ctx, cli(1))), false);
  writeTurnEndRequest(w.ctx, { cliSessionId: cli(1), session: sid(1), now: NOW });
  assert.equal(turnEndHook(w.ctx, { session_id: cli(1) }, { now: NOW + 7 * 3600_000, launch }).reason, 'expired');
});

test('T5 a failing launch never throws and never fails the turn', () => {
  const w = repairWorld();
  writeTurnEndRequest(w.ctx, { cliSessionId: cli(1), session: sid(1), now: NOW });
  assert.equal(turnEndHook(w.ctx, { session_id: cli(1) }, { now: NOW, launch: () => ({ ok: false, error: 'no spawn' }) }).reason, 'launch-failed');
  assert.equal(turnEndHook(w.ctx, { session_id: cli(1) }, { now: NOW + 99_999, launch: () => { throw new Error('boom'); } }).reason, 'error');
  assert.equal(turnEndHook(null, { session_id: cli(1) }, {}).launched, false);
});

test('T6 the helper waits, stops that session\'s CLI, clears the link after a backup, and deletes the request', async () => {
  const w = repairWorld();
  const tp = tpOf(w, 1); const before = readFileSync(tp, 'utf8');
  writeTurnEndRequest(w.ctx, { cliSessionId: cli(1), session: sid(1), now: NOW });
  // the turn has ended by the time the helper looks: the record is idle
  putRecord(w.folder.path, 1, { title: 'Session 1', cliSessionId: cli(1), cwd: 'C:\\synthetic\\project-1', isRunning: false });
  const p = procs([proc(111, 1), proc(222, 2)]);
  const waits = []; const logs = [];
  const r = await runTurnEnd(w.ctx, { cliSessionId: cli(1), projects: w.projects, rcLog: null, listProcs: p.listProcs, stopPids: p.stopPids, sleep: async (ms) => { waits.push(ms); }, log: (l) => logs.push(l) });
  assert.equal(r.ran, true);
  assert.equal(r.result.status, 'cleared');
  assert.deepEqual(waits[0], 2000, 'it waits about 2 s first');
  assert.deepEqual(p.st.stopped, [111], 'only that session\'s CLI');
  assert.equal(readFileSync(tp, 'utf8').slice(before.length), `${CLEAR(cli(1))}\n`);
  assert.equal(backups(w).length, 1);
  assert.equal(existsSync(turnEndFile(w.ctx, cli(1))), false);
  assert.ok(logs.some((l) => /cleared/.test(l)), logs.join('\n'));
});

test('T7 the helper keeps a mid-turn record waiting a few tries; a refusal it can retry keeps the request, a final one drops it', async () => {
  const w = repairWorld();                          // the record stays isRunning: true
  writeTurnEndRequest(w.ctx, { cliSessionId: cli(1), session: sid(1), now: NOW });
  const p = procs([proc(111, 1)]);
  let sleeps = 0;
  const r = await runTurnEnd(w.ctx, { cliSessionId: cli(1), projects: w.projects, rcLog: null, listProcs: p.listProcs, stopPids: p.stopPids, sleep: async () => { sleeps++; }, midTurnTries: 3 });
  assert.equal(r.result.reason, 'mid-turn');
  assert.equal(sleeps, 1 + 3, 'the first wait and one between tries');
  assert.deepEqual(p.st.stopped, [], 'a mid-turn session\'s CLI is never stopped');
  assert.equal(r.kept, true);
  assert.equal(existsSync(turnEndFile(w.ctx, cli(1))), true, 'kept for the next turn');
  // the link was cleared meanwhile (by a sweep): not-stale is final, the request goes
  appendFileSync(tpOf(w, 1), `${CLEAR(cli(1))}\n`);
  putRecord(w.folder.path, 1, { title: 'Session 1', cliSessionId: cli(1), cwd: 'C:\\synthetic\\project-1', isRunning: false });
  const done = await runTurnEnd(w.ctx, { cliSessionId: cli(1), projects: w.projects, rcLog: null, listProcs: p.listProcs, stopPids: p.stopPids, sleep: async () => {} });
  assert.equal(done.result.reason, 'not-stale');
  assert.equal(existsSync(turnEndFile(w.ctx, cli(1))), false);
});

test('T8 the helper with no request, or a bad id, does nothing', async () => {
  const w = repairWorld();
  assert.deepEqual(await runTurnEnd(w.ctx, { cliSessionId: cli(1), sleep: async () => {} }), { ran: false, reason: 'no-request' });
  assert.deepEqual(await runTurnEnd(w.ctx, { cliSessionId: '../../etc', sleep: async () => {} }), { ran: false, reason: 'bad-session' });
});

/* ------------------------------------------------------------------ the CLI entry points */

test('T9 the rc-turn-end hook command exits 0 and prints nothing: no request, another session\'s request, garbage on stdin; it launches (logged, not started) for its own', () => {
  const w = cworld({ accounts: 1, records: 1 });
  mkdirSync(w.acc, { recursive: true });
  const dir = join(w.acc, 'rc-turn-end');
  const mine = uuid('d', 1);
  const run = (stdin, env = {}) => spawnSync(process.execPath, [CLI, 'rc-turn-end', '--from-hook'], {
    input: stdin, encoding: 'utf8', windowsHide: true, timeout: 30000,
    env: { ...process.env, USERPROFILE: w.home, HOME: w.home, APPDATA: join(w.home, 'AppData', 'Roaming'), XDG_CONFIG_HOME: join(w.home, '.config'), SESSION_SYNC_TEST_APP_STATE: w.appFile, ...env },
  });
  for (const stdin of ['', 'not json', '{}', JSON.stringify({ session_id: mine })]) { const r = run(stdin); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, ''); }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mine}.json`), JSON.stringify({ v: 1, cliSessionId: mine, session: null, force: false, at: Date.now(), launches: 0, launchedAt: 0 }));
  const log = join(w.home, 'launch.log');
  const other = run(JSON.stringify({ session_id: uuid('d', 2) }), { SESSION_SYNC_TEST_LAUNCH_LOG: log });
  assert.equal(other.status, 0); assert.equal(other.stdout, ''); assert.equal(existsSync(log), false);
  const own = run(JSON.stringify({ session_id: mine }), { SESSION_SYNC_TEST_LAUNCH_LOG: log });
  assert.equal(own.status, 0, own.stderr); assert.equal(own.stdout, '');
  assert.ok(existsSync(log), 'the helper was requested (the test seam logs it and starts nothing)');
  assert.match(readFileSync(log, 'utf8'), new RegExp(`rc-turn-end-run.*${mine}`));
});

test('T10 accounts rc-sweep rejects an unreadable --before with exit 2 and writes nothing; the Stop hook is registered with a short timeout', () => {
  const w = cworld({ accounts: 1, records: 1 });
  const r = spawnSync(process.execPath, [CLI, 'accounts', 'rc-sweep', '--before', 'yesterday-ish'], {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
    env: { ...process.env, USERPROFILE: w.home, HOME: w.home, APPDATA: join(w.home, 'AppData', 'Roaming'), XDG_CONFIG_HOME: join(w.home, '.config'), SESSION_SYNC_TEST_APP_STATE: w.appFile },
  });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /--before needs a date-time/);
  assert.equal(existsSync(join(w.acc, 'rc-restore', 'backup')), false);
  const hooks = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8')).hooks;
  const stop = hooks.Stop.flatMap((g) => g.hooks);
  assert.ok(stop.some((h) => h.args?.includes('rc-turn-end') && h.timeout <= 10));
});
