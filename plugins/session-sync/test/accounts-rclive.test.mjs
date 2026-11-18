/**
 * The live relink (0.5.7): the needsRelink hazard fix (the owner stamp is no account signal), the foreign-link ledger and switch history,
 * and the per-session live gate. Synthetic stores and transcripts only, in temp folders; `liveCliIds` and `now` are injected, so nothing
 * here starts PowerShell and nothing touches the live store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRoot, addFolder, putRecord, uuid, setMtime } from './fixtures/store.mjs';
import {
  rcPlan, rcQuitStep, liveRelinkPass, liveRelinkCandidates, wakeWithRelink, lastBridgeEntry, rcSettings, RC_DEFAULTS, LIVE_QUIET_MS, wakeClaimFile,
} from '../lib/accounts/rcrestore.mjs';
import { switchHistory, readLedger, recordSwitch, parseIdentityLog, firstSeenOfLink, acctAt, ledgerFile, switchHistoryFile } from '../lib/accounts/rclinks.mjs';
import { parseCliIds, liveCliIds } from '../lib/accounts/proc.mjs';

// the shape of the machine this was found on: the app is signed in as ME, every link carries the OLD account's owner stamp
const ME = '00000000-0000-4000-8000-0000000000a1';
const OLD = '00000000-0000-4000-8000-0000000000a2';
const ORG = uuid('f', 1);
const SWITCH = Date.parse('2026-11-16T18:21:47Z');
const NOW = Date.parse('2026-11-18T15:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const CLEAR = (cli) => `{"type":"bridge-session","sessionId":"${cli}","bridgeSessionId":"","lastSequenceNum":0}`;

function world({ history = true } = {}) {
  const r = makeRoot('live');
  writeFileSync(join(r.userData, 'config.json'), JSON.stringify({ lastKnownAccountUuid: ME }));
  const projects = join(r.root, 'projects');
  mkdirSync(projects, { recursive: true });
  const folder = addFolder(r.store, ME, ORG);
  r.ctx.platform = 'win32';
  r.ctx.rcLog = null;                 // no seed from a real remote-control.log
  r.ctx.setNow(NOW);
  if (history) { mkdirSync(r.acc, { recursive: true }); writeFileSync(switchHistoryFile(r.ctx), JSON.stringify([{ at: iso(SWITCH - 30 * 86400_000), acct: OLD }, { at: iso(SWITCH), acct: ME }])); }
  return { ...r, projects, folder };
}

const keyOf = (n) => `C:\\synthetic\\project-${n}`.replace(/[^a-zA-Z0-9]/g, '-');
const cli = (n) => uuid('d', n);
const sid = (n) => `local_${uuid('c', n)}`;
const tpOf = (w, n) => join(w.projects, keyOf(n), `${cli(n)}.jsonl`);

/**
 * A session whose transcript was first linked at `at` (ISO) and ends with `link`: user and assistant lines carry a timestamp, the
 * bridge-session line (written once, then repeated before the tail) carries none, as in a real transcript.
 */
function session(w, n, { link = 'cse_a', nhb = false, at = '2026-11-17T06:10:00.000Z', rec = {}, ageMs = 3600_000, eol = '\n', trailing = true, laterMs = 60_000 } = {}) {
  putRecord(w.folder.path, n, { lastActivityAt: iso(NOW - ageMs), title: `Session ${n}`, remoteControlUserEnabled: true, bridgeSessionIds: [`session_${n}`], ...rec });
  mkdirSync(join(w.projects, keyOf(n)), { recursive: true });
  const bridge = JSON.stringify({ type: 'bridge-session', sessionId: cli(n), bridgeSessionId: link, lastSequenceNum: 7, ownerAccountUuid: OLD, ownerOrganizationUuid: ORG, ...(nhb ? { noHistoryBackfill: true } : {}) });
  const dated = Number.isFinite(Date.parse(at));     // an undated transcript has no timestamp tokens at all
  const lines = [
    JSON.stringify({ type: 'user', ...(dated ? { timestamp: at } : {}), message: 'hello' }),
    JSON.stringify({ type: 'assistant', ...(dated ? { timestamp: at } : {}), message: 'hi' }),
    bridge,
    JSON.stringify({ type: 'assistant', ...(dated ? { timestamp: iso(Date.parse(at) + laterMs) } : {}), message: 'later' }),
  ];
  const tp = tpOf(w, n);
  writeFileSync(tp, lines.join(eol) + (trailing ? eol : ''));
  setMtime(tp, NOW - ageMs);
  return tp;
}

const pass = (w, o = {}) => liveRelinkPass(w.ctx, { settings: RC_DEFAULTS, projects: w.projects, rcLog: null, liveCliIds: () => new Set(), ...o });

/* ------------------------------------------------------------------ section 0: needsRelink must not read the owner stamp */

test('L1 regression: a store shaped like today (29 candidates, every link stamped with the old owner, signed in as the new account) selects only the 3 noHistoryBackfill links', () => {
  const w = world();
  for (let n = 1; n <= 3; n++) session(w, n, { link: `cse_nhb${n}`, nhb: true, at: '2026-11-17T21:00:00.000Z' });          // the random-name links
  for (let n = 4; n <= 29; n++) session(w, n, { link: `cse_titled${n}`, at: '2026-11-17T06:10:00.000Z' });                  // healthy, minted after the switch
  const plan = rcPlan(w.ctx, { projects: w.projects, days: 3, rcLog: null });
  assert.equal(plan.acct, ME);
  assert.equal(plan.recent, 29);
  assert.equal(plan.relink.length, 3);
  assert.deepEqual(plan.relink.map((x) => x.why), ['noHistoryBackfill', 'noHistoryBackfill', 'noHistoryBackfill']);
  assert.equal(rcPlan(w.ctx, { projects: w.projects, days: 3, rcLog: null, acct: OLD }).relink.length, 0, 'no records for the other account');
});

test('L2 the quit step re-checks with the same rule: a titled link with the old owner stamp is never cleared', async () => {
  const w = world();
  const keep = session(w, 1, { link: 'cse_titled', at: '2026-11-17T06:10:00.000Z' });
  const bad = session(w, 2, { link: 'cse_nhb', nhb: true });
  const before = readFileSync(keep, 'utf8');
  const r = await rcQuitStep(w.ctx, { projects: w.projects, rcLog: null, stopped: () => true });
  assert.equal(r.res.relinked, 1);
  assert.equal(readFileSync(keep, 'utf8'), before);
  assert.equal(lastBridgeEntry(bad).bridgeSessionId, '');
});

/* ------------------------------------------------------------------ section 1: the ledger and the switch history */

test('L3 a link first seen before the last switch is foreign; one first seen after it is not; a link nothing can date is not', () => {
  const w = world();
  session(w, 1, { link: 'cse_old1', at: '2026-11-10T12:00:00.000Z' });     // minted under the old account
  session(w, 2, { link: 'cse_new2', at: '2026-11-17T06:10:00.000Z' });     // minted under the current one
  const noDate = session(w, 3, { link: 'cse_nodate3', at: 'not a timestamp' });
  setMtime(noDate, NOW - 3600_000);                                        // modified after the switch: cannot be called old
  const c = liveRelinkCandidates(w.ctx, { projects: w.projects, rcLog: null, now: NOW });
  assert.deepEqual(c.candidates.map((x) => [x.id, x.why]), [[sid(1), 'foreign']]);
});

test('L4 a transcript untouched since the switch is dated by its last write when its lines carry no timestamp', () => {
  const w = world();
  const tp = session(w, 1, { link: 'cse_old', at: 'none', ageMs: 5 * 86400_000 });
  setMtime(tp, SWITCH - 3 * 86400_000);   // last written 3 days before the switch
  const c = liveRelinkCandidates(w.ctx, { projects: w.projects, rcLog: null, now: NOW, all: true });
  assert.deepEqual(c.candidates.map((x) => x.why), ['foreign']);
});

test('L5 firstSeenOfLink: the first line that names the link, dated by the nearest preceding timestamp; a quoted id in another line is ignored', () => {
  const w = world();
  const tp = session(w, 1, { link: 'cse_x', at: '2026-11-12T01:02:03.000Z' });
  appendFileSync(tp, JSON.stringify({ type: 'user', timestamp: '2026-11-20T00:00:00.000Z', message: 'the link is "bridgeSessionId":"cse_y" in a message' }) + '\n');
  assert.equal(firstSeenOfLink(tp, 'cse_x'), Date.parse('2026-11-12T01:02:03.000Z'));
  assert.equal(firstSeenOfLink(tp, 'cse_y'), null, 'only a bridge-session line counts');
  assert.equal(firstSeenOfLink(tp, 'cse_missing'), null);
  assert.equal(firstSeenOfLink(join(w.root, 'missing.jsonl'), 'cse_x'), null);
  assert.equal(firstSeenOfLink(tp, '../bad id'), null);
});

test('L6 the history: seeded from the log (the account changes only), refreshed when stale, appended by recordSwitch; acctAt; a stale history dates nothing after it', () => {
  const w = world({ history: false });
  const local = (ms) => { const d = new Date(ms); const p = (x, n = 2) => String(x).padStart(n, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.123`; };
  const log = [
    `${local(SWITCH - 30 * 86400_000)} [info] start identity=${ORG}:${OLD} machine=X persistedFolders=0`,
    `${local(SWITCH - 20 * 86400_000)} [info] start identity=${ORG}:${OLD} machine=X persistedFolders=0`,
    `${local(SWITCH - 5000)} [info] dispose identity=${ORG}:${OLD}: 1 session(s) queued for unarchive`,
    `${local(SWITCH)} [info] start identity=${uuid('e', 1)}:${ME} machine=X persistedFolders=0`,
  ].join('\n');
  const logFile = join(w.root, 'remote-control.log');
  writeFileSync(logFile, log);
  assert.deepEqual(parseIdentityLog(log).map((e) => e.acct), [OLD, ME]);
  const h = switchHistory(w.ctx, { acct: ME, rcLog: logFile });
  assert.deepEqual(h.list.map((e) => e.acct), [OLD, ME]);
  assert.equal(h.list[1].at, SWITCH, 'the log second, read as local time');
  assert.equal(h.dirty, true);
  assert.equal(existsSync(switchHistoryFile(w.ctx)), false, 'reading the history writes nothing');
  assert.equal(acctAt(h.list, SWITCH + 1000, ME), ME);
  assert.equal(acctAt(h.list, SWITCH - 1000, ME), OLD);
  assert.equal(acctAt(h.list, SWITCH - 90 * 86400_000, ME), null, 'before the history');
  assert.equal(acctAt(h.list, SWITCH + 1000, uuid('9', 9)), null, 'the signed-in account is not the last one the history knows: nothing after it can be dated');
  // recordSwitch saves the seed and appends
  assert.equal(recordSwitch(w.ctx, uuid('9', 9), SWITCH + 86400_000, { rcLog: logFile }), true);
  assert.deepEqual(JSON.parse(readFileSync(switchHistoryFile(w.ctx), 'utf8')).map((e) => e.acct), [OLD, ME, uuid('9', 9)]);
  assert.equal(recordSwitch(w.ctx, uuid('9', 9), SWITCH + 2 * 86400_000, { rcLog: logFile }), false, 'the same account again is no switch');
});

test('L7 the ledger: kept by a pass that writes, never by a dry run; a link keeps the account it was first seen under', async () => {
  const w = world();
  session(w, 1, { link: 'cse_old', at: '2026-11-10T12:00:00.000Z' });
  session(w, 2, { link: 'cse_new', at: '2026-11-17T06:10:00.000Z' });
  await pass(w, { dryRun: true, all: true });
  assert.equal(existsSync(ledgerFile(w.ctx)), false, 'a dry run writes nothing');
  await pass(w, { all: true });
  const led = readLedger(w.ctx).links;
  assert.equal(led.cse_old.acct, OLD);
  assert.equal(led.cse_new.acct, ME);
  // the ledger, not the transcript, decides from now on: rewrite the transcript so its dates would say otherwise
  session(w, 3, { link: 'cse_old', at: '2026-11-17T06:10:00.000Z' });
  const c = liveRelinkCandidates(w.ctx, { projects: w.projects, rcLog: null, now: NOW, all: true });
  assert.ok(c.candidates.some((x) => x.id === sid(3)), 'cse_old is the old account\'s link in the ledger');
});

/* ------------------------------------------------------------------ section 2: the live gate */

test('L8 an idle session with a noHistoryBackfill link and no CLI: the clear line is appended byte for byte after a backup', async () => {
  const w = world();
  const tp = session(w, 1, { link: 'cse_nhb', nhb: true });
  const before = readFileSync(tp, 'utf8');
  const logs = [];
  const r = await pass(w, { log: (l) => logs.push(l) });
  assert.equal(r.cleared.length, 1);
  assert.equal(r.cleared[0].why, 'noHistoryBackfill');
  const after = readFileSync(tp, 'utf8');
  assert.ok(after.startsWith(before));
  assert.equal(after.slice(before.length), `${CLEAR(cli(1))}\n`);
  assert.equal(lastBridgeEntry(tp).bridgeSessionId, '');
  const dirs = readdirSync(join(w.acc, 'rc-restore', 'backup'));
  assert.equal(dirs.length, 1);
  assert.equal(readFileSync(join(w.acc, 'rc-restore', 'backup', dirs[0], `${cli(1)}.jsonl`), 'utf8'), before);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^rc-live: cleared 1 \(.{8}\), skipped live 0, quiet 0, raced 0$/);
  // idempotent: the link is cleared now
  assert.equal((await pass(w)).candidates, 0);
  assert.equal(readFileSync(tp, 'utf8'), after);
});

test('L9 a foreign link (first seen before the switch) is cleared as well, and says why', async () => {
  const w = world();
  const tp = session(w, 1, { link: 'cse_old', at: '2026-11-10T12:00:00.000Z' });
  const r = await pass(w);
  assert.deepEqual(r.cleared.map((c) => c.why), ['foreign']);
  assert.equal(lastBridgeEntry(tp).bridgeSessionId, '');
});

test('L10 a titled link minted under the current account, with the old owner stamp, is not cleared', async () => {
  const w = world();
  const tp = session(w, 1, { link: 'cse_titled', at: '2026-11-17T06:10:00.000Z' });
  const before = readFileSync(tp, 'utf8');
  const r = await pass(w, { all: true });
  assert.equal(r.candidates, 0);
  assert.equal(readFileSync(tp, 'utf8'), before);
});

test('L11 a live CLI for the conversation: not cleared, counted; another conversation\'s CLI does not protect it', async () => {
  const w = world();
  const a = session(w, 1, { link: 'cse_nhb1', nhb: true });
  const b = session(w, 2, { link: 'cse_nhb2', nhb: true });
  const beforeA = readFileSync(a, 'utf8');
  const r = await pass(w, { liveCliIds: () => new Set([cli(1).toUpperCase(), cli(9)]) });
  assert.equal(r.skippedLive, 1);
  assert.deepEqual(r.cleared.map((c) => c.id), [sid(2)]);
  assert.equal(readFileSync(a, 'utf8'), beforeA);
  assert.equal(lastBridgeEntry(b).bridgeSessionId, '');
});

test('L12 an unknown process list (null) clears nothing, and says unknown', async () => {
  const w = world();
  const tp = session(w, 1, { link: 'cse_nhb', nhb: true });
  const before = readFileSync(tp, 'utf8');
  const logs = [];
  for (const live of [() => null, null, async () => null]) {
    const r = await pass(w, { liveCliIds: live, log: (l) => logs.push(l) });
    assert.equal(r.cleared.length, 0);
    assert.equal(r.unknown, 1);
  }
  assert.match(logs[0], /unknown 1/);
  assert.equal(readFileSync(tp, 'utf8'), before);
});

test('L13 a transcript written to within 120 s, or a record that is mid-turn, is not cleared', async () => {
  const w = world();
  const recent = session(w, 1, { link: 'cse_nhb1', nhb: true });
  setMtime(recent, NOW - 30_000);
  session(w, 2, { link: 'cse_nhb2', nhb: true, rec: { isRunning: true } });
  const edge = session(w, 3, { link: 'cse_nhb3', nhb: true });
  setMtime(edge, NOW - LIVE_QUIET_MS - 1000);
  const r = await pass(w);
  assert.equal(r.quiet, 1);
  assert.equal(r.running, 1);
  assert.deepEqual(r.cleared.map((c) => c.id), [sid(3)]);
});

test('L14 the race: a CLI that appears between the checks is logged as raced; the file holds the original plus the clear line only', async () => {
  const w = world();
  const tp = session(w, 1, { link: 'cse_nhb', nhb: true });
  const before = readFileSync(tp, 'utf8');
  let calls = 0;
  const logs = [];
  const r = await pass(w, { liveCliIds: () => { calls++; return calls >= 3 ? new Set([cli(1)]) : new Set(); }, log: (l) => logs.push(l) });
  assert.equal(calls, 3, 'the list, the list again right before the write, the list once more after it');
  assert.equal(r.raced, 1);
  assert.equal(r.cleared.length, 1);
  assert.match(logs[0], /raced 1/);
  assert.equal(readFileSync(tp, 'utf8'), `${before}${CLEAR(cli(1))}\n`);
  // a CLI that shows up between the first list and the write is skipped, nothing is written
  const w2 = world();
  const tp2 = session(w2, 1, { link: 'cse_nhb', nhb: true });
  const before2 = readFileSync(tp2, 'utf8');
  let n2 = 0;
  const r2 = await pass(w2, { liveCliIds: () => (++n2 >= 2 ? new Set([cli(1)]) : new Set()) });
  assert.equal(r2.cleared.length, 0);
  assert.equal(r2.skippedLive, 1);
  assert.equal(readFileSync(tp2, 'utf8'), before2);
});

test('L15 a transcript with no final newline gets one first; CRLF files keep CRLF', async () => {
  const w = world();
  const a = session(w, 1, { link: 'cse_nhb1', nhb: true, trailing: false });
  const b = session(w, 2, { link: 'cse_nhb2', nhb: true, eol: '\r\n' });
  const beforeA = readFileSync(a, 'utf8'); const beforeB = readFileSync(b, 'utf8');
  await pass(w);
  assert.equal(readFileSync(a, 'utf8'), `${beforeA}\n${CLEAR(cli(1))}\n`);
  assert.equal(readFileSync(b, 'utf8'), `${beforeB}${CLEAR(cli(2))}\r\n`);
});

test('L16 off: liveRelink off or rcRestore off is a no-op (a dry run still runs); archived, cloud and scheduled-free records are left out', async () => {
  const w = world();
  const tp = session(w, 1, { link: 'cse_nhb1', nhb: true });
  session(w, 2, { link: 'cse_nhb2', nhb: true, rec: { isArchived: true } });
  session(w, 3, { link: 'cse_nhb3', nhb: true, rec: { movedToCloud: true } });
  const before = readFileSync(tp, 'utf8');
  for (const settings of [rcSettings({ rcRestore: { liveRelink: 'off' } }), rcSettings({ rcRestore: { enabled: false } })]) {
    const r = await pass(w, { settings });
    assert.deepEqual([r.ran, r.reason, r.cleared.length], [false, 'disabled', 0]);
    const d = await pass(w, { settings, dryRun: true });
    assert.equal(d.ran, true);
    assert.deepEqual(d.wouldClear.map((c) => c.id), [sid(1)]);
  }
  assert.equal(readFileSync(tp, 'utf8'), before);
  const r = await pass(w);
  assert.deepEqual(r.cleared.map((c) => c.id), [sid(1)], 'archived and cloud sessions were never candidates');
});

test('L17 the limit per pass: liveMax clears the most recent first, the rest are deferred to the next pass', async () => {
  const w = world();
  for (let n = 1; n <= 5; n++) session(w, n, { link: `cse_nhb${n}`, nhb: true, ageMs: n * 3600_000 });
  const r = await pass(w, { settings: rcSettings({ rcRestore: { liveMax: 2 } }) });
  assert.deepEqual(r.cleared.map((c) => c.id), [sid(1), sid(2)]);
  assert.equal(r.deferred, 3);
  assert.equal((await pass(w, { settings: rcSettings({ rcRestore: { liveMax: 2 } }) })).cleared.length, 2);
});

test('L18 the window: without all, only sessions active within rcRestore.days; with all, every non-archived record', async () => {
  const w = world();
  session(w, 1, { link: 'cse_nhb1', nhb: true });
  session(w, 2, { link: 'cse_nhb2', nhb: true, ageMs: 10 * 86400_000 });
  assert.deepEqual((await pass(w, { dryRun: true })).wouldClear.map((c) => c.id), [sid(1)]);
  assert.deepEqual((await pass(w, { dryRun: true, all: true })).wouldClear.map((c) => c.id), [sid(1), sid(2)]);
});

test('L19 the dry run reads only: the transcripts, the records and the state folder are unchanged, and the counts are reported', async () => {
  const w = world();
  const a = session(w, 1, { link: 'cse_nhb1', nhb: true });
  const b = session(w, 2, { link: 'cse_nhb2', nhb: true });
  const c = session(w, 3, { link: 'cse_old', at: '2026-11-10T12:00:00.000Z' });
  setMtime(c, NOW - 20_000);
  const files = [a, b, c].map((f) => readFileSync(f, 'utf8'));
  const accBefore = readdirSync(w.acc).sort();
  const r = await pass(w, { dryRun: true, liveCliIds: () => new Set([cli(2)]) });
  assert.equal(r.dryRun, true);
  assert.deepEqual(r.wouldClear.map((x) => [x.id, x.why]), [[sid(1), 'noHistoryBackfill']]);
  assert.deepEqual([r.skippedLive, r.quiet, r.unknown, r.candidates], [1, 1, 0, 3]);
  assert.deepEqual([a, b, c].map((f) => readFileSync(f, 'utf8')), files);
  assert.deepEqual(readdirSync(w.acc).sort(), accBefore);
});

test('L20 the session the hook runs in is never touched', async () => {
  const w = world();
  const mine = session(w, 1, { link: 'cse_nhb1', nhb: true });
  session(w, 2, { link: 'cse_nhb2', nhb: true });
  const before = readFileSync(mine, 'utf8');
  const r = await pass(w, { hookCliSessionId: cli(1) });
  assert.equal(r.self, 1);
  assert.deepEqual(r.cleared.map((c) => c.id), [sid(2)]);
  assert.equal(readFileSync(mine, 'utf8'), before);
});

test('L21 nothing to look at: the process list is not asked at all', async () => {
  const w = world();
  session(w, 1, { link: 'cse_titled', at: '2026-11-17T06:10:00.000Z' });
  let asked = 0;
  const r = await pass(w, { liveCliIds: () => { asked++; return new Set(); } });
  assert.equal(r.ran, true);
  assert.equal(asked, 0);
});

/* ------------------------------------------------------------------ section 3: the wake hook */

test('L22 rc-wake: the claiming prompt runs the relink once, before it returns the instruction, and never on the session it runs in', async () => {
  const w = world();
  writeFileSync(join(w.userData, 'lockfile'), '');
  const now = Date.now();
  w.ctx.setNow(now);
  const mk = (n, nhb) => {
    const tp = session(w, n, { link: `cse_${n}`, nhb, at: iso(now - 86400_000) });
    putRecord(w.folder.path, n, { lastActivityAt: iso(now - 60_000), title: `S${n}`, remoteControlUserEnabled: true, bridgeSessionIds: ['x'] });
    setMtime(tp, now - 3600_000);
    return tp;
  };
  const mine = mk(1, true); const other = mk(2, true);
  writeFileSync(switchHistoryFile(w.ctx), JSON.stringify([{ at: iso(now - 20 * 86400_000), acct: ME }]));
  let asked = 0;
  const opts = { settings: RC_DEFAULTS, sessionId: cli(1), now, projects: w.projects, rcLog: null, liveCliIds: () => { asked++; return new Set(); } };
  const d = await wakeWithRelink(w.ctx, opts);
  assert.equal(d.act, true);
  assert.match(d.text, /list_sessions/);
  assert.equal(lastBridgeEntry(other).bridgeSessionId, '', 'cleared before the instruction was returned');
  assert.equal(lastBridgeEntry(mine).bridgeSessionId, 'cse_1', 'the hook\'s own session is left alone');
  assert.deepEqual([d.live.cleared.length, d.live.self], [1, 1]);
  const askedOnce = asked;
  // the next prompt: the claim is taken, no relink pass
  const again = await wakeWithRelink(w.ctx, opts);
  assert.deepEqual([again.act, again.reason], [false, 'claimed']);
  assert.equal(again.live, undefined);
  assert.equal(asked, askedOnce);
});

test('L23 rc-wake: the baseline claim relinks too; liveRelink off, a closed app and a refusal do not', async () => {
  const w = world();
  writeFileSync(join(w.userData, 'lockfile'), '');
  const now = Date.now();
  w.ctx.setNow(now);
  const tp = session(w, 2, { link: 'cse_2', nhb: true, at: iso(now - 86400_000) });
  putRecord(w.folder.path, 2, { lastActivityAt: iso(now - 60_000), remoteControlUserEnabled: true, bridgeSessionIds: ['x'] });
  setMtime(tp, now - 3600_000);
  const o = { settings: RC_DEFAULTS, sessionId: cli(2), projects: w.projects, rcLog: null, liveCliIds: () => new Set() };
  const off = await wakeWithRelink(w.ctx, { ...o, now, settings: rcSettings({ rcRestore: { liveRelink: 'off' } }) });
  assert.equal(off.act, true);
  assert.equal(off.live, undefined);
  assert.equal(lastBridgeEntry(tp).bridgeSessionId, 'cse_2');
  const w2 = world();
  writeFileSync(join(w2.userData, 'lockfile'), '');
  w2.ctx.setNow(now);
  const tp2 = session(w2, 2, { link: 'cse_2', nhb: true, at: iso(now - 86400_000) });
  putRecord(w2.folder.path, 2, { lastActivityAt: iso(now - 60_000), remoteControlUserEnabled: true, bridgeSessionIds: ['x'] });
  setMtime(tp2, now - 3600_000);
  const base = await wakeWithRelink(w2.ctx, { ...o, sessionId: cli(2), now: now + 7 * 3600_000, liveCliIds: () => new Set() });
  assert.equal(base.reason, 'baseline');
  assert.equal(base.live.ran, true);
  assert.equal(existsSync(wakeClaimFile(w2.ctx, 1)), false);
});

/* ------------------------------------------------------------------ the process list and the settings */

test('L24 parseCliIds: --resume and --session-id, quoted or with =, lower-cased; an unreadable command line or a missing end marker is unknown', () => {
  const id1 = cli(1); const id2 = cli(2).toUpperCase();
  const out = (...l) => `${l.join('\r\n')}\r\n`;
  const ok = parseCliIds(out(`P\tC:\\x\\claude.exe --output-format stream-json --resume ${id1} --other`, `P\t"C:\\app\\Claude.exe" --type=renderer`, `P\tclaude.exe --session-id="${id2}"`, 'ok-end'));
  assert.deepEqual([...ok].sort(), [id1, id2.toLowerCase()].sort());
  assert.deepEqual([...parseCliIds(out('ok-end'))], []);
  assert.equal(parseCliIds(out(`P\tclaude.exe --resume ${id1}`)), null, 'no end marker: the listing may be cut off');
  assert.equal(parseCliIds(out('P\t', 'ok-end')), null, 'a claude.exe whose command line cannot be read');
  assert.equal(parseCliIds(''), null);
});

test('L25 liveCliIds: hidden window, a timeout, a failed run is unknown, other platforms are unknown', async () => {
  let seen;
  const fake = (code, stdout) => (file, args, opts, cb) => { seen = { file, args, opts }; cb(code ? new Error('x') : null, stdout); };
  const ids = await liveCliIds({ platform: 'win32', execFileFn: fake(0, `P\tclaude.exe --resume ${cli(1)}\nok-end\n`) });
  assert.deepEqual([...ids], [cli(1)]);
  assert.equal(seen.file, 'powershell.exe');
  assert.equal(seen.opts.windowsHide, true);
  assert.ok(seen.opts.timeout > 0);
  assert.equal(await liveCliIds({ platform: 'win32', execFileFn: fake(1, '') }), null);
  assert.equal(await liveCliIds({ platform: 'win32', execFileFn: () => { throw new Error('spawn'); } }), null);
  assert.equal(await liveCliIds({ platform: 'linux' }), null);
});

test('L26 rcSettings: liveRelink off or idle-only (anything else falls back), liveMax 1 to 100, liveEveryMs 1 minute to 1 day', () => {
  const s = (o) => rcSettings({ rcRestore: o });
  assert.deepEqual([s({}).liveRelink, s({}).liveMax, s({}).liveEveryMs], ['idle-only', 10, 600000]);
  assert.equal(s({ liveRelink: 'off' }).liveRelink, 'off');
  for (const bad of ['kill', true, 1, null, 'OFF']) assert.equal(s({ liveRelink: bad }).liveRelink, 'idle-only');
  assert.equal(s({ liveMax: 3 }).liveMax, 3);
  for (const bad of [0, 101, 2.5, 'many', -1]) assert.equal(s({ liveMax: bad }).liveMax, 10);
  assert.equal(s({ liveEveryMs: 60000 }).liveEveryMs, 60000);
  for (const bad of [59999, 86400001, 'soon', NaN]) assert.equal(s({ liveEveryMs: bad }).liveEveryMs, 600000);
});

/* ------------------------------------------------------------------ the waiter */

/** One watcher run, ~40 steps of an injected clock, the app running (or not), the live relink replaced by a recorder. */
async function watchRun({ app, rc, liveEveryMs, liveRelinkFn, steps = 40 }) {
  const { runWaiter } = await import('../lib/accounts/waiter.mjs');
  const { emptyState, saveState, resetMutations } = await import('../lib/accounts/state.mjs');
  const { unlinkSync } = await import('node:fs');
  const w = world();
  const appFile = join(w.root, 'app.json');
  writeFileSync(appFile, JSON.stringify(app ? { running: true, signedIn: ME, startedAtMs: 1 } : { running: false }));
  process.env.SESSION_SYNC_TEST_APP_STATE = appFile;
  saveState(w.ctx, emptyState(w.store));
  const logs = []; let t = 0; let sleeps = 0;
  try {
    await runWaiter(w.ctx, {
      watchLockfile: false, gapMs: 150, pollMs: 1, probeEveryMs: 1, watch: true, reason: 'watch', notify: () => {},
      clock: () => (t += 100), sleep: async () => { if (++sleeps >= steps) { try { unlinkSync(join(w.acc, 'waiter.claim')); } catch { /* gone */ } } },
      rcRestore: rc, rcOpts: { projects: w.projects }, liveEveryMs, log: (l) => logs.push(l), liveRelinkFn,
    });
  } finally { delete process.env.SESSION_SYNC_TEST_APP_STATE; resetMutations(); }
  return logs;
}

test('L27 the waiter runs the live relink every liveEveryMs while the app runs; not before the interval, not while the app is closed, not when off', async () => {
  const calls = [];
  const rec = async (ctx, o) => { calls.push({ all: o.all, days: o.days, mode: o.settings.liveRelink }); };
  const on = { enabled: true, days: 3, liveRelink: 'idle-only' };
  await watchRun({ app: true, rc: on, liveEveryMs: 1000, liveRelinkFn: rec });
  assert.ok(calls.length >= 2, `ran ${calls.length} times`);
  assert.deepEqual([...new Set(calls.map((c) => c.all))], [false]);
  assert.equal(calls[0].days, 3);
  assert.equal(calls[0].mode, 'idle-only');
  for (const [name, args] of [
    ['interval not reached', { app: true, rc: on, liveEveryMs: 86_400_000 }],
    ['app closed', { app: false, rc: on, liveEveryMs: 1000 }],
    ['liveRelink off', { app: true, rc: { ...on, liveRelink: 'off' }, liveEveryMs: 1000 }],
    ['rcRestore off', { app: true, rc: { ...on, enabled: false }, liveEveryMs: 1000 }],
  ]) {
    const before = calls.length;
    await watchRun({ ...args, liveRelinkFn: rec });
    assert.equal(calls.length, before, name);
  }
});

test('L28 a live relink that throws is logged and the watcher goes on', async () => {
  const logs = await watchRun({ app: true, rc: { enabled: true, days: 3, liveRelink: 'idle-only' }, liveEveryMs: 1000, steps: 12, liveRelinkFn: async () => { throw new Error('boom'); } });
  assert.ok(logs.some((l) => /live relink failed: boom/.test(l)));
});

/* ------------------------------------------------------------------ the command */

test('L29 accounts rc-restore --live --dry-run --json: valid JSON, nothing cleared, exit 0 (the sandbox has no store: it says so and writes nothing)', async () => {
  const { spawnSync } = await import('node:child_process');
  const { dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'cli.mjs');
  const r = spawnSync(process.execPath, [CLI, 'accounts', 'rc-restore', '--live', '--dry-run', '--json'], { encoding: 'utf8', windowsHide: true, timeout: 30_000, env: { ...process.env } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.command, 'rc-restore');
  assert.equal(out.mode, 'live');
  assert.equal(out.dryRun, true);
  assert.equal(out.cleared, 0);
  assert.ok(Array.isArray(out.sessions));
});

/* ------------------------------------------------------------------ review round: the default log, straddling links, the preview, the ledger */

const logLocal = (ms) => { const d = new Date(ms); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.123`; };

test('L30 no rcLog option and no ctx.rcLog (as the CLI, the waiter and the hook call it): the history is seeded from the app\'s own remote-control.log', async () => {
  const w = world({ history: false });
  delete w.ctx.rcLog;
  const logFile = join(w.root, 'remote-control.log');
  writeFileSync(logFile, [
    `${logLocal(SWITCH - 30 * 86400_000)} [info] start identity=${ORG}:${OLD} machine=X persistedFolders=0`,
    `${logLocal(SWITCH)} [info] start identity=${uuid('e', 1)}:${ME} machine=X persistedFolders=0`,
  ].join('\n'));
  const keep = process.env.SESSION_SYNC_RC_LOG;
  process.env.SESSION_SYNC_RC_LOG = logFile;
  try {
    const old = session(w, 1, { link: 'cse_old', at: '2026-11-10T12:00:00.000Z' });
    const nhb = session(w, 2, { link: 'cse_nhb', nhb: true });
    const titled = session(w, 3, { link: 'cse_titled', at: '2026-11-17T06:10:00.000Z' });
    const before = readFileSync(titled, 'utf8');
    const dry = await liveRelinkPass(w.ctx, { settings: RC_DEFAULTS, projects: w.projects, dryRun: true, liveCliIds: () => new Set() });
    assert.deepEqual(dry.wouldClear.map((c) => [c.id, c.why]), [[sid(1), 'foreign'], [sid(2), 'noHistoryBackfill']]);
    assert.equal(existsSync(switchHistoryFile(w.ctx)), false, 'a dry run keeps nothing');
    const r = await liveRelinkPass(w.ctx, { settings: RC_DEFAULTS, projects: w.projects, liveCliIds: () => new Set() });
    assert.deepEqual(r.cleared.map((c) => c.id).sort(), [sid(1), sid(2)].sort());
    assert.equal(lastBridgeEntry(old).bridgeSessionId, '');
    assert.equal(lastBridgeEntry(nhb).bridgeSessionId, '');
    assert.equal(readFileSync(titled, 'utf8'), before);
    assert.deepEqual(JSON.parse(readFileSync(switchHistoryFile(w.ctx), 'utf8')).map((e) => e.acct), [OLD, ME]);
  } finally { if (keep === undefined) delete process.env.SESSION_SYNC_RC_LOG; else process.env.SESSION_SYNC_RC_LOG = keep; }
});

test('L31 a link whose neighbours straddle the last switch cannot be dated: not foreign, counted as undated', async () => {
  const w = world();
  session(w, 1, { link: 'cse_between', at: '2026-11-16T18:21:00.000Z', laterMs: 120_000 });   // before the switch at 18:21:47Z, next event after it
  session(w, 2, { link: 'cse_old', at: '2026-11-16T10:00:00.000Z', laterMs: 60_000 });          // both neighbours before it: the old account's
  const d = await pass(w, { dryRun: true });
  assert.deepEqual(d.wouldClear.map((c) => [c.id, c.why]), [[sid(2), 'foreign']]);
  assert.equal(d.undated, 1);
});

test('L31b the straddle check looks past timestamp-less metadata lines after the link line', async () => {
  const w = world();
  const tp = session(w, 1, { link: 'cse_between', at: '2026-11-16T18:21:00.000Z', laterMs: 120_000 });
  const lines = readFileSync(tp, 'utf8').trimEnd().split('\n');   // user, assistant, bridge, later (dated after the switch)
  const meta = Array.from({ length: 6 }, (_, i) => JSON.stringify({ type: 'queue-operation', operation: `op${i}` }));
  writeFileSync(tp, [...lines.slice(0, 3), ...meta, lines[3]].join('\n') + '\n');
  setMtime(tp, NOW - 3600_000);
  const d = await pass(w, { dryRun: true });
  assert.deepEqual(d.wouldClear, []);
  assert.equal(d.undated, 1);
});

test('L32 the preview lists every session a pass would clear, however many; a real pass stops at liveMax', async () => {
  const w = world();
  for (let n = 1; n <= 5; n++) session(w, n, { link: `cse_nhb${n}`, nhb: true, ageMs: n * 3600_000 });
  const settings = rcSettings({ rcRestore: { liveMax: 2 } });
  const d = await pass(w, { settings, dryRun: true });
  assert.equal(d.wouldClear.length, 5);
  assert.equal(d.deferred, 3);
  assert.equal((await pass(w, { settings })).cleared.length, 2);
});

test('L33 the ledger learns the links a pass sees even when nothing is cleared (a live CLI, a busy session); a dry run learns nothing', async () => {
  const w = world();
  session(w, 1, { link: 'cse_busy', at: '2026-11-17T06:10:00.000Z', rec: { isRunning: true } });
  session(w, 2, { link: 'cse_live', at: '2026-11-17T07:10:00.000Z' });
  session(w, 3, { link: 'cse_nhb', nhb: true });
  await pass(w, { dryRun: true });
  assert.equal(existsSync(ledgerFile(w.ctx)), false);
  const r = await pass(w, { liveCliIds: () => new Set([cli(3)]) });
  assert.equal(r.cleared.length, 0);
  assert.deepEqual(Object.keys(readLedger(w.ctx).links).sort(), ['cse_busy', 'cse_live']);
  assert.equal(readLedger(w.ctx).links.cse_busy.acct, ME);
});
