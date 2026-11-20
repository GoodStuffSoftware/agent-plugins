/**
 * Remote Control restore (0.5.4): relink, the free-restore marker, eligibility, backups, idempotence, the in-place write, the app-log reader,
 * the settings. Synthetic stores and transcripts only; nothing here touches the live store or a live transcript.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, linkSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeRoot, addFolder, putRecord, uuid, readRecord, inoOf, nlinkOf, recordName,
} from './fixtures/store.mjs';
import {
  rcPlan, applyPlan, rcQuitStep, eligible, needsRelink, lastBridgeEntry, appendClearLine, writeRecordInPlace, markerAge,
  findTranscript, readLaunchOutcome, rcSettings, rcDoneText, RC_DEFAULTS, MARKER_REFRESH_MS, MARKER_FRESH_MS, MAX_RESTORE, DAY_MS,
  pruneBackups, BACKUP_KEEP_MS,
} from '../lib/accounts/rcrestore.mjs';

const ME = uuid('a', 1);
const OTHER = uuid('b', 2);
const ORG = uuid('f', 1);
const NOW = 1_800_000_500_000;
const iso = (ms) => new Date(ms).toISOString();

/** A store with the current account signed in (config.json carries only the uuid), a projects folder, and a records folder. */
function world() {
  const r = makeRoot('rc');
  writeFileSync(join(r.userData, 'config.json'), JSON.stringify({ lastKnownAccountUuid: ME }));
  const projects = join(r.root, 'projects');
  mkdirSync(projects, { recursive: true });
  const folder = addFolder(r.store, ME, ORG);
  r.ctx.platform = 'win32';
  r.ctx.setNow(NOW);
  return { ...r, projects, folder };
}

const keyOf = (n) => `C:\\synthetic\\project-${n}`.replace(/[^a-zA-Z0-9]/g, '-');
const transcriptPath = (w, n) => join(w.projects, keyOf(n), `${uuid('d', n)}.jsonl`);

/** A record that was on RC and was active `agoMs` ago; its transcript ends with the given bridge-session entry (or none). */
function session(w, n, { agoMs = 3600_000, rec = {}, bridge, lines = 5, prev } = {}) {
  const file = putRecord(w.folder.path, n, {
    lastActivityAt: iso(NOW - agoMs), remoteControlUserEnabled: true, bridgeSessionIds: [`session_${n}`], remoteControlAutoEligible: false, ...rec,
  });
  const tp = transcriptPath(w, n);
  mkdirSync(join(w.projects, keyOf(n)), { recursive: true });
  const body = [];
  for (let i = 0; i < lines; i++) body.push(JSON.stringify({ type: i % 2 ? 'assistant' : 'user', message: `line ${i} of ${n}` }));
  // a noHistoryBackfill link is a gone-bounce only when a different non-empty link came before it (0.5.10, isGoneBounce): give it one
  if (bridge?.noHistoryBackfill && prev !== false) body.push(JSON.stringify({ type: 'bridge-session', sessionId: uuid('d', n), bridgeSessionId: 'cse_prev', lastSequenceNum: 3 }));
  if (bridge) body.push(JSON.stringify({ type: 'bridge-session', sessionId: uuid('d', n), lastSequenceNum: 7, ...bridge }));
  body.push(JSON.stringify({ type: 'assistant', message: 'tail' }));
  writeFileSync(tp, body.join('\n') + '\n');
  return { file, tp };
}

const STALE = { bridgeSessionId: 'cse_stale', noHistoryBackfill: true, ownerAccountUuid: ME };
const FOREIGN = { bridgeSessionId: 'cse_foreign', ownerAccountUuid: OTHER };
const GOOD = { bridgeSessionId: 'cse_good', ownerAccountUuid: ME };

/* ------------------------------------------------------------------ relink */

test('R1 relink: noHistoryBackfill, or a link the ledger calls foreign; the owner stamp, a clean link and no link are not', () => {
  const yes = () => true;
  assert.equal(needsRelink(STALE), true);
  assert.equal(needsRelink(FOREIGN), false, 'the owner field is no account signal: only the ledger and the switch history can call a link foreign');
  assert.equal(needsRelink(FOREIGN, yes), true);
  assert.equal(needsRelink(GOOD), false);
  assert.equal(needsRelink({ ...GOOD, noHistoryBackfill: false }), false);
  assert.equal(needsRelink(null), false);
  assert.equal(needsRelink({ bridgeSessionId: '', noHistoryBackfill: true }, yes), false, 'an already cleared link is left alone');
});

test('R2 lastBridgeEntry: the last entry wins, wherever it is, and nothing else in the file is parsed', () => {
  const w = world();
  const a = session(w, 1, { bridge: GOOD });
  appendFileSync(a.tp, JSON.stringify({ type: 'bridge-session', sessionId: uuid('d', 1), bridgeSessionId: 'cse_later', lastSequenceNum: 9, ownerAccountUuid: OTHER }) + '\nplain text that is not json {{{\n');
  assert.equal(lastBridgeEntry(a.tp).bridgeSessionId, 'cse_later');
  const b = session(w, 2, {});
  assert.equal(lastBridgeEntry(b.tp), null);
  assert.equal(lastBridgeEntry(join(w.root, 'missing.jsonl')), null);
  // an entry that sits before a very long tail (several read blocks back)
  const c = session(w, 3, { bridge: STALE });
  appendFileSync(c.tp, (JSON.stringify({ type: 'user', message: 'x'.repeat(2000) }) + '\n').repeat(400));
  assert.equal(lastBridgeEntry(c.tp).bridgeSessionId, 'cse_stale');
});

test('R3 plan: only records active within the window, of the current account, with an affected last entry', () => {
  const w = world();
  session(w, 1, { bridge: STALE });                              // affected
  session(w, 2, { bridge: FOREIGN });                            // another owner stamp: not an account signal, not affected
  session(w, 3, { bridge: GOOD });                               // clean
  session(w, 4, { bridge: STALE, agoMs: 4 * DAY_MS });           // too old for 3 days
  session(w, 5, {});                                             // no link at all
  const other = addFolder(w.store, OTHER, ORG);
  putRecord(other.path, 6, { lastActivityAt: iso(NOW - 1000), remoteControlUserEnabled: true });   // another account's folder
  const plan = rcPlan(w.ctx, { projects: w.projects, days: 3 });
  assert.equal(plan.acct, ME);
  assert.deepEqual(plan.relink.map((x) => x.id), [`local_${uuid('c', 1)}`]);
  assert.equal(rcPlan(w.ctx, { projects: w.projects, days: 7 }).relink.length, 2, 'a wider window takes the older one too');
});

test('R4 apply: the clearing line is the CLI\'s own, appended once, after a backup; the second run changes nothing', () => {
  const w = world();
  const s = session(w, 1, { bridge: STALE });
  const before = readFileSync(s.tp, 'utf8');
  const plan = rcPlan(w.ctx, { projects: w.projects });
  const res = applyPlan(w.ctx, plan, { stopped: () => true });
  assert.equal(res.status, 'ok');
  assert.equal(res.relinked, 1);
  const after = readFileSync(s.tp, 'utf8');
  assert.ok(after.startsWith(before), 'only an append');
  const added = after.slice(before.length);
  assert.equal(added, `{"type":"bridge-session","sessionId":"${uuid('d', 1)}","bridgeSessionId":"","lastSequenceNum":0}\n`);
  assert.equal(lastBridgeEntry(s.tp).bridgeSessionId, '');
  // the backup is the file as it was
  const backups = readdirSync(join(w.acc, 'rc-restore', 'backup')).map((d) => join(w.acc, 'rc-restore', 'backup', d, `${uuid('d', 1)}.jsonl`));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(backups[0], 'utf8'), before);
  // idempotent
  const again = applyPlan(w.ctx, rcPlan(w.ctx, { projects: w.projects }), { stopped: () => true });
  assert.equal(again.relinked, 0);
  assert.equal(readFileSync(s.tp, 'utf8'), after);
});

test('R5 apply: a transcript is re-checked right before the write; one that stopped needing it is skipped', () => {
  const w = world();
  const s = session(w, 1, { bridge: STALE });
  const plan = rcPlan(w.ctx, { projects: w.projects });
  appendFileSync(s.tp, JSON.stringify({ type: 'bridge-session', sessionId: uuid('d', 1), bridgeSessionId: 'cse_new', ownerAccountUuid: ME, lastSequenceNum: 1 }) + '\n');
  const sizeBefore = readFileSync(s.tp).length;
  const res = applyPlan(w.ctx, plan, { stopped: () => true });
  assert.equal(res.relinked, 0);
  assert.equal(res.skipped, 1);
  assert.equal(readFileSync(s.tp).length, sizeBefore);
});

test('R6 clearing line keeps CRLF and adds the missing final newline', () => {
  const w = world();
  const f = join(w.root, 'crlf.jsonl');
  writeFileSync(f, '{"type":"user"}\r\n{"type":"assistant"}');
  appendClearLine(f, uuid('d', 1));
  assert.equal(readFileSync(f, 'utf8'), `{"type":"user"}\r\n{"type":"assistant"}\r\n{"type":"bridge-session","sessionId":"${uuid('d', 1)}","bridgeSessionId":"","lastSequenceNum":0}\r\n`);
});

test('R7 findTranscript: the derived project folder first, then a search of the others; unsafe ids are refused', () => {
  const w = world();
  const s = session(w, 1, { bridge: GOOD });
  assert.equal(findTranscript(w.projects, { cliSessionId: uuid('d', 1), cwd: 'C:\\synthetic\\project-1' }), s.tp);
  assert.equal(findTranscript(w.projects, { cliSessionId: uuid('d', 1), cwd: 'D:\\elsewhere' }), s.tp, 'found by the scan when the key differs');
  assert.equal(findTranscript(w.projects, { cliSessionId: '../../etc/passwd' }), null);
  assert.equal(findTranscript(w.projects, { cliSessionId: uuid('d', 9), cwd: 'x' }), null);
});

/* ------------------------------------------------------------------ eligibility and the marker */

test('E1 eligible: local, active, resumable, not scheduled, RC was on', () => {
  const base = { cliSessionId: uuid('d', 1), remoteControlUserEnabled: true };
  assert.equal(eligible(base), true);
  assert.equal(eligible({ cliSessionId: uuid('d', 1), bridgeSessionIds: ['s'] }), true, 'a bridge id alone shows RC was on');
  assert.equal(eligible({ cliSessionId: uuid('d', 1), bridgeSessionIds: [] }), false, 'RC never on');
  assert.equal(eligible({ ...base, isArchived: true }), false);
  assert.equal(eligible({ ...base, scheduledTaskId: 'daily' }), false);
  assert.equal(eligible({ ...base, cliSessionId: undefined }), false);
  assert.equal(eligible({ ...base, movedToCloud: true }), false);
  assert.equal(eligible({ ...base, backend: { kind: 'remote' } }), false);
  assert.equal(eligible({ ...base, backend: { kind: 'local' } }), true);
  assert.equal(eligible(null), false);
});

test('E2 marker: written for the 4 most recent eligible records only, in the app\'s shape, never interruptedByQuitAt', () => {
  const w = world();
  const files = [];
  for (let n = 1; n <= 6; n++) files.push(session(w, n, { agoMs: n * 600_000 }).file);   // 1 is the newest
  session(w, 7, { agoMs: 1000, rec: { isArchived: true } });
  session(w, 8, { agoMs: 2000, rec: { scheduledTaskId: 'nightly' } });
  session(w, 9, { agoMs: 3000, rec: { remoteControlUserEnabled: false, bridgeSessionIds: [] } });
  const plan = rcPlan(w.ctx, { projects: w.projects });
  assert.equal(plan.targets.length, MAX_RESTORE);
  assert.deepEqual(plan.targets.map((t) => t.id), [1, 2, 3, 4].map((n) => `local_${uuid('c', n)}`));
  const res = applyPlan(w.ctx, plan, { stopped: () => true });
  assert.equal(res.marked, 4);
  for (let n = 1; n <= 6; n++) {
    const rec = readRecord(files[n - 1]);
    if (n <= 4) {
      assert.deepEqual(rec.remoteControlLiveAtUpdateQuit, { at: NOW, accountId: ME });
      assert.equal(rec.remoteControlAutoEligible, true);
    } else {
      assert.equal(rec.remoteControlLiveAtUpdateQuit, undefined);
    }
    assert.equal('interruptedByQuitAt' in rec, false);
    assert.equal(rec.title, `Synthetic conversation ${n}`, 'the rest of the record is untouched');
    assert.deepEqual(rec.messages[0], { role: 'user', text: `hello ${n}` });
  }
});

test('E3 marker freshness: a young marker is left alone, refreshed once it is 20 minutes old, rewritten as a new restore past 55 minutes', () => {
  const w = world();
  const s = session(w, 1, {});
  applyPlan(w.ctx, rcPlan(w.ctx, { projects: w.projects }), { stopped: () => true });
  assert.equal(readRecord(s.file).remoteControlLiveAtUpdateQuit.at, NOW);
  const run = (dt) => {
    w.ctx.setNow(NOW + dt);
    return applyPlan(w.ctx, rcPlan(w.ctx, { projects: w.projects }), { stopped: () => true });
  };
  let r = run(5 * 60_000);
  assert.deepEqual([r.marked, r.refreshed], [0, 0], 'young: nothing is written');
  assert.equal(readRecord(s.file).remoteControlLiveAtUpdateQuit.at, NOW);
  r = run(MARKER_REFRESH_MS + 1000);
  assert.deepEqual([r.marked, r.refreshed], [0, 1], 'old enough to be refreshed');
  assert.equal(readRecord(s.file).remoteControlLiveAtUpdateQuit.at, NOW + MARKER_REFRESH_MS + 1000);
  r = run(MARKER_REFRESH_MS + 1000 + MARKER_FRESH_MS + 5000);
  assert.deepEqual([r.marked, r.refreshed], [1, 0], 'past the hour the app accepts: a new restore');
  // a marker of another account is not a marker for this one
  assert.equal(markerAge({ remoteControlLiveAtUpdateQuit: { at: NOW - 1000, accountId: OTHER } }, ME, NOW), null);
  assert.equal(markerAge({ remoteControlLiveAtUpdateQuit: { at: NOW + 5000, accountId: ME } }, ME, NOW), null, 'a marker from the future is not accepted by the app');
  assert.equal(markerAge({ remoteControlLiveAtUpdateQuit: { at: NOW - 1000, accountId: ME } }, ME, NOW), 1000);
});

test('E4 the marker is written in place: the inode and the hard links of a linked record survive', () => {
  const w = world();
  const s = session(w, 1, {});
  const org2 = addFolder(w.store, ME, uuid('f', 2));
  const twin = join(org2.path, recordName(1));
  linkSync(s.file, twin);
  const ino = inoOf(s.file);
  assert.equal(nlinkOf(s.file), 2);
  applyPlan(w.ctx, rcPlan(w.ctx, { projects: w.projects }), { stopped: () => true });
  assert.equal(inoOf(s.file), ino);
  assert.equal(nlinkOf(s.file), 2);
  assert.deepEqual(readRecord(twin).remoteControlLiveAtUpdateQuit, { at: NOW, accountId: ME }, 'the twin shows the same marker');
});

test('E5 writeRecordInPlace keeps the format (indent, newline, BOM) and shrinks cleanly', () => {
  const w = world();
  const f = join(w.root, 'rec.json');
  writeFileSync(f, '\ufeff{\r\n  "a": 1,\r\n  "padding": "' + 'x'.repeat(200) + '"\r\n}\r\n');
  writeRecordInPlace(f, (o) => { delete o.padding; o.b = 2; });
  assert.equal(readFileSync(f, 'utf8'), '\ufeff{\r\n  "a": 1,\r\n  "b": 2\r\n}\r\n');
});

test('E6 the record is backed up before its first marker, and not again for a refresh', () => {
  const w = world();
  const s = session(w, 1, {});
  const original = readFileSync(s.file, 'utf8');
  applyPlan(w.ctx, rcPlan(w.ctx, { projects: w.projects }), { stopped: () => true });
  const root = join(w.acc, 'rc-restore', 'backup');
  const dirs = readdirSync(root);
  assert.equal(dirs.length, 1);
  const saved = readdirSync(join(root, dirs[0]));
  assert.equal(saved.length, 1);
  assert.equal(readFileSync(join(root, dirs[0], saved[0]), 'utf8'), original);
  w.ctx.setNow(NOW + MARKER_REFRESH_MS + 1000);
  applyPlan(w.ctx, rcPlan(w.ctx, { projects: w.projects }), { stopped: () => true });
  assert.equal(readdirSync(root).length, 1, 'a refresh makes no new backup');
});

test('E7 never writes while the app runs: a refusal before the first write, and a stop in the middle leaves the rest alone', () => {
  const w = world();
  const a = session(w, 1, { bridge: STALE });
  const b = session(w, 2, {});
  const refused = applyPlan(w.ctx, rcPlan(w.ctx, { projects: w.projects }), { stopped: () => false });
  assert.equal(refused.status, 'refused_app_running');
  assert.equal(readRecord(b.file).remoteControlLiveAtUpdateQuit, undefined);
  assert.equal(lastBridgeEntry(a.tp).bridgeSessionId, 'cse_stale');
  let calls = 0;
  const partial = applyPlan(w.ctx, rcPlan(w.ctx, { projects: w.projects }), { stopped: () => ++calls <= 3 });   // the guard, the relink, the first marker
  assert.equal(partial.status, 'partial');
  assert.ok(partial.relinked + partial.marked >= 1 && partial.skipped >= 1);
});

test('E8 the scheduled-task and archived records are never touched, even when RC was on', () => {
  const w = world();
  const sched = session(w, 1, { rec: { scheduledTaskId: 'nightly' } });
  const arch = session(w, 2, { rec: { isArchived: true } });
  const before = [readFileSync(sched.file, 'utf8'), readFileSync(arch.file, 'utf8')];
  applyPlan(w.ctx, rcPlan(w.ctx, { projects: w.projects }), { stopped: () => true });
  assert.deepEqual([readFileSync(sched.file, 'utf8'), readFileSync(arch.file, 'utf8')], before);
});

test('E9 rcQuitStep: runs under the lock, writes its result file, reports nothing-to-do and no-account', async () => {
  const w = world();
  const empty = await rcQuitStep(w.ctx, { projects: w.projects });
  assert.deepEqual([empty.ran, empty.reason], [false, 'nothing-to-do']);
  session(w, 1, { bridge: STALE });
  const started = [];
  const r = await rcQuitStep(w.ctx, { projects: w.projects, stopped: () => true, onStart: (i) => started.push(i) });
  assert.equal(r.ran, true);
  assert.deepEqual(started, [{ relink: 1, marks: 1 }]);
  const out = JSON.parse(readFileSync(join(w.acc, 'rc-restore.json'), 'utf8'));
  assert.deepEqual([out.relinked, out.marked, out.status, out.acct], [1, 1, 'ok', ME]);
  assert.equal(rcDoneText(r.res), 'Remote Control: 1 stale link reset, 1 session will reconnect when Claude opens.');
  // no signed-in account: nothing is done
  writeFileSync(join(w.userData, 'config.json'), '{}');
  const none = await rcQuitStep(w.ctx, { projects: w.projects });
  assert.deepEqual([none.ran, none.reason], [false, 'no-account']);
});

test('E10 a refresh (marker only) shows no start notice', async () => {
  const w = world();
  session(w, 1, {});
  const started = [];
  await rcQuitStep(w.ctx, { projects: w.projects, stopped: () => true, onStart: () => started.push(1) });
  assert.equal(started.length, 1);
  w.ctx.setNow(NOW + MARKER_REFRESH_MS + 1000);
  const r = await rcQuitStep(w.ctx, { projects: w.projects, stopped: () => true, onStart: () => started.push(2) });
  assert.equal(r.res.refreshed, 1);
  assert.equal(started.length, 1, 'only a relink or a first marker is announced');
});

test('E11 backups older than 14 days are pruned', () => {
  const w = world();
  const old = join(w.acc, 'rc-restore', 'backup', '20200101T000000Z');
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, 'x.json'), '{}');
  assert.equal(pruneBackups(w.ctx, Date.now() + BACKUP_KEEP_MS + 1000), 1);
  assert.equal(existsSync(old), false);
});

/* ------------------------------------------------------------------ the app's own log */

test('L1 readLaunchOutcome: the pass summary and verdict lines after the start, with the outcome; older lines and other lines ignored', () => {
  const w = world();
  const log = join(w.root, 'main.log');
  const t0 = Date.parse('2026-11-17T09:00:00');
  writeFileSync(log, [
    '2026-11-17 08:00:00 [info] [CCD] Remote Control restore after update: {"outcome":"gate_off"}',
    '2026-11-17 09:00:05 [info] something else entirely',
    '2026-11-17 09:00:07 [info] [CCD] Remote Control restore after update: {"restored":3,"outcome":"ran"}',
    '2026-11-17 09:00:08 [info] [rcAutoEnable] verdict=enable trigger=launch_remote_control_restore',
  ].join('\n') + '\n');
  const r = readLaunchOutcome(log, t0);
  assert.equal(r.found, true);
  assert.equal(r.outcome, 'ran');
  assert.equal(r.lines.length, 2);
  assert.deepEqual(readLaunchOutcome(join(w.root, 'nope.log'), t0), { found: false, outcome: null, lines: [] });
  assert.equal(readLaunchOutcome(log, Date.parse('2026-11-17T10:00:00')).found, false);
});

/* ------------------------------------------------------------------ settings */

test('S1 rcSettings: defaults on, 3 days, wake on; partial blocks keep the other defaults; bad values fall back', () => {
  assert.deepEqual(rcSettings({}), { enabled: true, days: 3, wake: true, wakeMax: 4, logonTask: true, liveRelink: 'idle-only', liveMax: 10, liveEveryMs: 600000, spawnFix: 'auto' });
  assert.deepEqual(RC_DEFAULTS, { enabled: true, days: 3, wake: true, wakeMax: 4, logonTask: true, liveRelink: 'idle-only', liveMax: 10, liveEveryMs: 600000, spawnFix: 'auto' });
  assert.deepEqual(rcSettings({ rcRestore: { wake: false } }), { enabled: true, days: 3, wake: false, wakeMax: 4, logonTask: true, liveRelink: 'idle-only', liveMax: 10, liveEveryMs: 600000, spawnFix: 'auto' });
  assert.deepEqual(rcSettings({ rcRestore: { enabled: false, days: 7 } }), { enabled: false, days: 7, wake: true, wakeMax: 4, logonTask: true, liveRelink: 'idle-only', liveMax: 10, liveEveryMs: 600000, spawnFix: 'auto' });
  assert.equal(rcSettings({ rcRestore: { days: 0 } }).days, 3);
  assert.equal(rcSettings({ rcRestore: { days: 'many' } }).days, 3);
  assert.equal(rcSettings({ rcRestore: { days: 400 } }).days, 3);
  assert.deepEqual(rcSettings({ rcRestore: 'yes' }), { enabled: true, days: 3, wake: true, wakeMax: 4, logonTask: true, liveRelink: 'idle-only', liveMax: 10, liveEveryMs: 600000, spawnFix: 'auto' });
  assert.deepEqual(rcSettings(undefined), { enabled: true, days: 3, wake: true, wakeMax: 4, logonTask: true, liveRelink: 'idle-only', liveMax: 10, liveEveryMs: 600000, spawnFix: 'auto' });
});

test('E12 a linked account: one conversation per org folder counts once; 4 distinct sessions get the marker, once each, hard links kept', () => {
  const w = world();
  const org2 = addFolder(w.store, ME, uuid('f', 2));
  const sessions = [];
  for (let n = 1; n <= 6; n++) {
    const s = session(w, n, { agoMs: n * 600_000, bridge: n <= 2 ? STALE : undefined });   // 1 and 2 also need a relink
    const twin = join(org2.path, recordName(n));
    linkSync(s.file, twin);
    sessions.push({ ...s, twin });
  }
  const plan = rcPlan(w.ctx, { projects: w.projects });
  assert.equal(plan.recent, 6, 'twelve record files, six conversations');
  assert.deepEqual(plan.targets.map((t) => t.id), [1, 2, 3, 4].map((n) => `local_${uuid('c', n)}`), '4 distinct sessions, not 2 sessions twice');
  assert.equal(new Set(plan.targets.map((t) => t.id)).size, MAX_RESTORE);
  assert.equal(plan.relink.length, 2, 'one relink per transcript');
  const res = applyPlan(w.ctx, plan, { stopped: () => true });
  assert.equal(res.marked, 4);
  assert.equal(res.relinked, 2);
  assert.equal(res.skipped, 0);
  for (let n = 1; n <= 6; n++) {
    const { file, twin } = sessions[n - 1];
    assert.equal(inoOf(file), inoOf(twin), 'still one inode');
    assert.equal(nlinkOf(file), 2);
    const marked = n <= 4;
    assert.equal(readRecord(file).remoteControlLiveAtUpdateQuit !== undefined, marked, `session ${n}`);
    assert.equal(readRecord(twin).remoteControlLiveAtUpdateQuit !== undefined, marked, `twin of ${n}`);
  }
  const root = join(w.acc, 'rc-restore', 'backup');
  const saved = readdirSync(join(root, readdirSync(root)[0]));
  assert.equal(saved.filter((x) => x.endsWith('.jsonl')).length, 2, 'one transcript backup each');
  assert.equal(saved.filter((x) => x.endsWith('.json')).length, 4, 'one record backup each');
  assert.equal(rcDoneText(res), 'Remote Control: 2 stale links reset, 4 sessions will reconnect when Claude opens.');
});

test('E12b copies that are separate files (not hard-linked) are all marked', () => {
  const w = world();
  const s = session(w, 1, {});
  const org2 = addFolder(w.store, ME, uuid('f', 2));
  const twin = join(org2.path, recordName(1));
  writeFileSync(twin, readFileSync(s.file));
  const plan = rcPlan(w.ctx, { projects: w.projects });
  assert.equal(plan.targets.length, 1);
  assert.equal(applyPlan(w.ctx, plan, { stopped: () => true }).marked, 1);
  assert.deepEqual(readRecord(s.file).remoteControlLiveAtUpdateQuit, { at: NOW, accountId: ME });
  assert.deepEqual(readRecord(twin).remoteControlLiveAtUpdateQuit, { at: NOW, accountId: ME });
});

test('E13 an explicit "RC off" is never switched back on; sessions with the flag on come before link history only', () => {
  assert.equal(eligible({ cliSessionId: uuid('d', 1), remoteControlUserEnabled: false, bridgeSessionIds: ['s'] }), false, 'off wins over old link ids');
  const w = world();
  session(w, 1, { agoMs: 1000, rec: { remoteControlUserEnabled: undefined } });             // history only, newest
  session(w, 2, { agoMs: 2000, rec: { remoteControlUserEnabled: undefined } });             // history only
  session(w, 3, { agoMs: 3000, rec: { remoteControlUserEnabled: false } });                 // turned off: vetoed
  for (let n = 4; n <= 7; n++) session(w, n, { agoMs: n * 10_000 });                        // flag on, older
  const ids = rcPlan(w.ctx, { projects: w.projects }).targets.map((t) => t.id);
  assert.deepEqual(ids, [4, 5, 6, 7].map((n) => `local_${uuid('c', n)}`), 'the four flagged ones, not the newer history-only ones');
  assert.equal(ids.includes(`local_${uuid('c', 3)}`), false);
  // fewer flagged than slots: history-only fill the rest, newest first
  const w2 = world();
  session(w2, 1, { agoMs: 1000, rec: { remoteControlUserEnabled: undefined } });
  session(w2, 2, { agoMs: 2000, rec: { remoteControlUserEnabled: undefined } });
  session(w2, 3, { agoMs: 3000 });
  assert.deepEqual(rcPlan(w2.ctx, { projects: w2.projects }).targets.map((t) => t.id), [3, 1, 2].map((n) => `local_${uuid('c', n)}`));
});

test('S2 rcSettings wakeMax: default 4, 1 to 50, a bad value falls back', () => {
  assert.equal(rcSettings({}).wakeMax, 4);
  assert.equal(rcSettings({ rcRestore: { wakeMax: 10 } }).wakeMax, 10);
  assert.equal(rcSettings({ rcRestore: { wakeMax: 0 } }).wakeMax, 4);
  assert.equal(rcSettings({ rcRestore: { wakeMax: 51 } }).wakeMax, 4);
  assert.equal(rcSettings({ rcRestore: { wakeMax: 2.5 } }).wakeMax, 4);
  assert.equal(rcSettings({ rcRestore: { wakeMax: 'many' } }).wakeMax, 4);
});
