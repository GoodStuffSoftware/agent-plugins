/**
 * The foreign Remote Control spawn fix (0.5.9, rcspawn.mjs): a session started from claude.ai under another account keeps a live
 * `remoteControlSpawn` and `cse_` bridge ids of the old account. Detection is read only; the repair edits the record IN PLACE (every hard
 * link shows it) with the app stopped, after a byte-exact backup. Synthetic stores and transcripts in temp folders only; the app state is
 * the lock marker file or an injected `stopped`, so nothing here starts a process or touches the live store.
 */
import { test, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, linkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { makeRoot, addFolder, putRecord, recordName, uuid, inoOf, nlinkOf, readRecord, makeClock } from './fixtures/store.mjs';
import { spawnSync } from 'node:child_process';
import { cworld, cleanupWorlds, CLI } from './fixtures/cliworld.mjs';
import { createSim } from './fixtures/appsim.mjs';
import {
  spawnPlan, spawnFixCore, spawnFixStep, spawnLook, spawnStatus, spawnLine, spawnFixMode, applySpawnFix, liveSpawn,
} from '../lib/accounts/rcspawn.mjs';
import { rcQuitStep, rcLogonStep } from '../lib/accounts/rcrestore.mjs';
import { switchHistoryFile } from '../lib/accounts/rclinks.mjs';
import { collectStatus, formatStatus } from '../lib/accounts/report.mjs';
import { fullPass } from '../lib/accounts/pass.mjs';
import { emptyState, saveState, resetMutations } from '../lib/accounts/state.mjs';
import { answerPairs, pairKey } from '../lib/accounts/folders.mjs';

after(cleanupWorlds);
afterEach(() => { delete process.env.SESSION_SYNC_TEST_APP_STATE; resetMutations(); });

const ME = '00000000-0000-4000-8000-0000000000a1';
const OLD = '00000000-0000-4000-8000-0000000000a2';
const THIRD = '00000000-0000-4000-8000-0000000000a3';
const ORG = uuid('f', 1); const ORG2 = uuid('f', 2); const ORG3 = uuid('f', 3);
const SWITCH = Date.parse('2026-11-16T18:21:47Z');
const NOW = Date.parse('2026-11-18T15:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const keyOf = (n) => `C:\\synthetic\\project-${n}`.replace(/[^a-zA-Z0-9]/g, '-');
const DAY = 86400_000;

/** Signed in as ME (switched from OLD at SWITCH); folders of ME, OLD and a third account; a transcripts dir; no lock marker. */
function world() {
  const r = makeRoot('spawn');
  writeFileSync(join(r.userData, 'config.json'), JSON.stringify({ lastKnownAccountUuid: ME }));
  const projects = join(r.root, 'projects');
  mkdirSync(projects, { recursive: true });
  r.ctx.platform = 'win32';
  r.ctx.rcLog = null;
  r.ctx.setNow(NOW);
  mkdirSync(r.acc, { recursive: true });
  writeFileSync(switchHistoryFile(r.ctx), JSON.stringify([{ at: iso(SWITCH - 30 * DAY), acct: OLD }, { at: iso(SWITCH), acct: ME }]));
  const fMe = addFolder(r.store, ME, ORG);
  const fOld = addFolder(r.store, OLD, ORG2);
  const fThird = addFolder(r.store, THIRD, ORG3);
  const lock = join(r.userData, 'lockfile');
  return { ...r, projects, fMe, fOld, fThird, lock, runApp: () => writeFileSync(lock, ''), logs: [], log(l) { this.logs.push(l); } };
}

/** The transcript of session n: `cse_old` first named before the switch, `cse_new` after it. Bridge lines carry no timestamp, as in life. */
function transcript(w, n, { old = 'cse_old', fresh = 'cse_new' } = {}) {
  const dir = join(w.projects, keyOf(n));
  mkdirSync(dir, { recursive: true });
  const ts = (ms) => ({ timestamp: iso(ms) });
  const bridge = (id) => JSON.stringify({ type: 'bridge-session', sessionId: uuid('d', n), bridgeSessionId: id, lastSequenceNum: 3 });
  const lines = [
    JSON.stringify({ type: 'user', ...ts(SWITCH - 5 * DAY), message: 'hello' }),
    bridge(old),
    JSON.stringify({ type: 'assistant', ...ts(SWITCH - 5 * DAY + 1000), message: 'hi' }),
    JSON.stringify({ type: 'user', ...ts(SWITCH + 3600_000), message: 'again' }),
    bridge(fresh),
    JSON.stringify({ type: 'assistant', ...ts(SWITCH + 3600_000 + 1000), message: 'yes' }),
  ];
  writeFileSync(join(dir, `${uuid('d', n)}.jsonl`), lines.join('\n') + '\n');
}

const SPAWN = (id, extra = {}) => ({ ccrSessionId: id, startedAt: SWITCH - 5 * DAY, ...extra });

/** A record in ME's folder, hard-linked into the other two accounts' folders (the shape the account link makes). */
function linked(w, n, over = {}) {
  const p = putRecord(w.fMe.path, n, { createdAt: iso(SWITCH - 6 * DAY), ...over });
  linkSync(p, join(w.fOld.path, recordName(n)));
  linkSync(p, join(w.fThird.path, recordName(n)));
  return [p, join(w.fOld.path, recordName(n)), join(w.fThird.path, recordName(n))];
}

const foreignRec = { remoteControlSpawn: SPAWN('cse_old'), bridgeSessionIds: ['cse_old', 'cse_new', 'session_keep'] };
const bytes = (p) => readFileSync(p);
const stopped = () => true;
const opts = (w, o = {}) => ({ projects: w.projects, rcLog: null, now: NOW, stopped, log: (l) => w.log(l), ...o });
const backupFiles = (w) => {
  const root = join(w.acc, 'rc-restore', 'backup');
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((d) => readdirSync(join(root, d)).map((f) => join(root, d, f)));
};

/* ------------------------------------------------------------------ detection */

test('P1 a record hard-linked into 3 account folders with a foreign spawn and foreign bridge ids is flagged once, with all 3 links', () => {
  const w = world();
  const links = linked(w, 1, foreignRec);
  transcript(w, 1);
  const plan = spawnPlan(w.ctx, opts(w));
  assert.equal(plan.flagged.length, 1);
  const s = plan.flagged[0];
  assert.equal(s.spawn, true);
  assert.deepEqual(s.ids, ['cse_old']);
  assert.equal(s.targets.length, 1, 'one inode, one decision');
  assert.equal(s.targets[0].nlink, 3);
  assert.deepEqual([...s.targets[0].links].sort(), [...links].sort());
  assert.equal(plan.scanned, 1);
});

test('P2 own-account spawns, detached spawns, undated spawns and records with no spawn are never flagged', () => {
  const w = world();
  // 2: a spawn minted after the switch (current account)
  putRecord(w.fMe.path, 2, { createdAt: iso(SWITCH + 1000), remoteControlSpawn: SPAWN('cse_new'), bridgeSessionIds: ['cse_new'] });
  transcript(w, 2);
  // 3: a foreign spawn the app already detached; its (foreign) ids stay as they are
  putRecord(w.fMe.path, 3, { remoteControlSpawn: SPAWN('cse_old', { detachedAt: SWITCH + 5 }), bridgeSessionIds: ['cse_old'] });
  transcript(w, 3);
  // 4: no spawn, no cse_ ids
  putRecord(w.fMe.path, 4, { bridgeSessionIds: ['session_plain'] });
  // 5: a spawn nothing can date (no transcript, no createdAt)
  const five = putRecord(w.fMe.path, 5, { createdAt: undefined, remoteControlSpawn: SPAWN('cse_nowhere'), bridgeSessionIds: [] });
  // 6: foreign spawn but archived
  putRecord(w.fMe.path, 6, { ...foreignRec, isArchived: true });
  transcript(w, 6);
  // 7: the other account's folder only (not the signed-in account's records)
  putRecord(w.fOld.path, 7, { ...foreignRec });
  transcript(w, 7);
  const before = bytes(five);
  const plan = spawnPlan(w.ctx, opts(w));
  assert.deepEqual(plan.flagged, []);
  assert.deepEqual(plan.skipped.map((s) => s.reason), ['undated']);
  assert.deepEqual(bytes(five), before);
  assert.equal(liveSpawn({ remoteControlSpawn: { detachedAt: 1 } }), false);
  assert.equal(liveSpawn({ remoteControlSpawn: { ccrSessionId: 'x' } }), true);
});

test('P3 a record with no transcript is dated by createdAt against the switch history: before the switch is foreign, after it is not', () => {
  const w = world();
  putRecord(w.fMe.path, 1, { createdAt: iso(SWITCH - 2 * DAY), remoteControlSpawn: SPAWN('cse_a'), bridgeSessionIds: [] });
  putRecord(w.fMe.path, 2, { createdAt: iso(SWITCH + 2 * DAY), remoteControlSpawn: SPAWN('cse_b'), bridgeSessionIds: [] });
  const plan = spawnPlan(w.ctx, opts(w));
  assert.deepEqual(plan.flagged.map((s) => s.id), [`local_${uuid('c', 1)}`]);
});

test('P4 a foreign cse_ id in bridgeSessionIds alone (no spawn at all) is flagged; the own id and non-cse ids stay', async () => {
  const w = world();
  const [p] = linked(w, 1, { bridgeSessionIds: ['cse_old', 'cse_new', 'session_keep'] });
  transcript(w, 1);
  const plan = spawnPlan(w.ctx, opts(w));
  assert.equal(plan.flagged.length, 1);
  assert.equal(plan.flagged[0].spawn, false);
  const r = spawnFixCore(w.ctx, opts(w, { apply: true }));
  assert.equal(r.fixed.length, 1);
  const rec = readRecord(p);
  assert.deepEqual(rec.bridgeSessionIds, ['cse_new', 'session_keep']);
  assert.equal(rec.remoteControlSpawn, undefined, 'no spawn was invented');
});

/* ------------------------------------------------------------------ the repair */

test('P5 repair: every hard link shows the change, inode and link count are unchanged, the backup holds the pre-edit bytes, nothing else moves', () => {
  const w = world();
  const links = linked(w, 1, foreignRec);
  transcript(w, 1);
  const pre = bytes(links[0]);
  const preRec = readRecord(links[0]);
  const inos = links.map(inoOf);
  const r = spawnFixCore(w.ctx, opts(w, { apply: true }));
  assert.equal(r.status, 'ok');
  assert.deepEqual([r.found, r.fixed.length, r.failed.length, r.pending.length], [1, 1, 0, 0]);
  for (const l of links) {
    const rec = readRecord(l);
    assert.equal(rec.remoteControlSpawn.ccrSessionId, 'cse_old');
    assert.equal(rec.remoteControlSpawn.detachedAt, NOW, `${l} shows the detach`);
    assert.deepEqual(rec.bridgeSessionIds, ['cse_new', 'session_keep']);
    assert.equal(nlinkOf(l), 3);
  }
  assert.deepEqual(links.map(inoOf), inos, 'same inodes');
  assert.deepEqual(links.map((l) => bytes(l).toString()), [bytes(links[0]).toString(), bytes(links[0]).toString(), bytes(links[0]).toString()]);
  const back = backupFiles(w);
  assert.equal(back.length, 1);
  assert.ok(bytes(back[0]).equals(pre), 'the backup is the record as it was');
  // only the two named fields changed
  const post = readRecord(links[0]);
  assert.deepEqual({ ...post, remoteControlSpawn: preRec.remoteControlSpawn, bridgeSessionIds: preRec.bridgeSessionIds }, preRec);
  assert.deepEqual(Object.keys(post), Object.keys(preRec), 'the key order stays');
  // a second run finds nothing to do and writes nothing
  const again = bytes(links[1]);
  const r2 = spawnFixCore(w.ctx, opts(w, { apply: true }));
  assert.deepEqual([r2.found, r2.fixed.length], [0, 0]);
  assert.ok(bytes(links[1]).equals(again));
  assert.equal(backupFiles(w).length, 1);
  // the result is remembered for status, and logged
  assert.equal(spawnStatus(w.ctx, opts(w)).fixed.length, 1);
  assert.ok(w.logs.some((l) => /^rc-spawn: found 1, fixed 1 \(/.test(l)), w.logs.join('\n'));
});

test('P6 the app running (lock marker) refuses: nothing is written, no backup, the session is reported pending', () => {
  const w = world();
  const links = linked(w, 1, foreignRec);
  transcript(w, 1);
  w.runApp();
  const pre = bytes(links[0]);
  const r = spawnFixCore(w.ctx, { projects: w.projects, rcLog: null, now: NOW, apply: true, log: (l) => w.log(l) });   // the real lock check
  assert.equal(r.status, 'refused_app_running');
  assert.deepEqual([r.found, r.fixed.length, r.pending.length], [1, 0, 1]);
  assert.ok(bytes(links[0]).equals(pre));
  assert.equal(backupFiles(w).length, 0);
  assert.ok(w.logs.some((l) => /pending 1/.test(l)));
});

test('P7 the app starting mid-repair: the record in hand fails with nothing written, the ones after it stay pending, nothing is written anywhere', () => {
  const w = world();
  const one = linked(w, 1, foreignRec); transcript(w, 1);
  const two = linked(w, 2, { ...foreignRec, remoteControlSpawn: SPAWN('cse_old2'), bridgeSessionIds: ['cse_old2'] });
  transcript(w, 2, { old: 'cse_old2', fresh: 'cse_new2' });
  const pre = [bytes(one[0]), bytes(two[0])];
  let asks = 0;
  const plan = spawnPlan(w.ctx, opts(w));
  assert.equal(plan.flagged.length, 2);
  // stopped() answers: the gate, the first session's loop check and its target check; the check right before the write says "started"
  const res = applySpawnFix(w.ctx, plan, { now: NOW, stopped: () => ++asks <= 3, log: (l) => w.log(l) });
  assert.equal(res.status, 'partial');
  assert.deepEqual([res.fixed.length, res.failed.length, res.pending.length], [0, 1, 1]);
  assert.match(res.failed[0].detail, /the app started/);
  assert.ok(bytes(one[0]).equals(pre[0]) && bytes(two[0]).equals(pre[1]), 'nothing was written');
});

test('P8 a record whose unedited round trip is not byte-identical is left alone and reported failed', () => {
  const w = world();
  const [p] = linked(w, 1, foreignRec);
  transcript(w, 1);
  writeFileSync(p, JSON.stringify(readRecord(p), null, 3).replace('{', '{ '));   // formatting the plugin cannot reproduce
  const pre = bytes(p);
  const r = spawnFixCore(w.ctx, opts(w, { apply: true }));
  assert.deepEqual([r.fixed.length, r.failed.length, r.status], [0, 1, 'partial']);
  assert.match(r.failed[0].detail, /round trip/);
  assert.ok(bytes(p).equals(pre));
  assert.equal(backupFiles(w).length, 0);
});

/* ------------------------------------------------------------------ the setting, the dry run, the quiet paths */

test('P9 spawnFix off: the automatic paths (core, step, look, quit step) do nothing and read nothing', async () => {
  const w = world();
  const links = linked(w, 1, foreignRec);
  transcript(w, 1);
  const pre = bytes(links[0]);
  const off = { spawnFix: 'off' };
  const core = spawnFixCore(w.ctx, opts(w, { ...off, apply: true }));
  assert.deepEqual([core.ran, core.mode, core.fixed.length], [false, 'off', 0]);
  const step = await spawnFixStep(w.ctx, opts(w, { ...off, apply: true }));
  assert.equal(step.ran, false);
  assert.deepEqual(spawnLook(w.ctx, opts(w, off)), { ran: false, reason: 'off' });
  const q = await rcQuitStep(w.ctx, opts(w, off));
  assert.equal(q.spawn.ran, false);
  assert.ok(bytes(links[0]).equals(pre));
  assert.equal(backupFiles(w).length, 0);
  assert.deepEqual(w.logs, []);
  assert.equal(spawnFixMode({ settings: { spawnFix: 'off' } }), 'off');
  assert.equal(spawnFixMode({ spawnFix: 'weird' }), 'auto');
  // the logon step: with rc restore off AND the spawn fix off it is disabled; the app state is not read
  const boom = () => { throw new Error('must not be read'); };
  assert.equal((await rcLogonStep(w.ctx, { settings: { enabled: false, spawnFix: 'off' }, readApp: boom })).reason, 'disabled');
});

test('P10 dryRun detects and reports but never writes, even with the app stopped', () => {
  const w = world();
  const links = linked(w, 1, foreignRec);
  transcript(w, 1);
  const pre = bytes(links[0]);
  const r = spawnFixCore(w.ctx, opts(w, { apply: true, dryRun: true }));
  assert.deepEqual([r.apply, r.found, r.fixed.length, r.pending.length], [false, 1, 0, 1]);
  assert.ok(bytes(links[0]).equals(pre));
  assert.equal(backupFiles(w).length, 0);
  assert.equal(existsSync(join(w.acc, 'rc-spawn.json')), false);
  assert.equal(existsSync(join(w.acc, 'rc-links.json')), false, 'a read-only pass does not even fill the ledger');
});

test('P11 the quit step runs the fix (rc restore on or off), and the logon step runs it when only it is owed', async () => {
  const w = world();
  const links = linked(w, 1, foreignRec);
  transcript(w, 1);
  const q = await rcQuitStep(w.ctx, opts(w));
  assert.deepEqual([q.spawn.found, q.spawn.fixed.length], [1, 1]);
  assert.equal(readRecord(links[2]).remoteControlSpawn.detachedAt, NOW);
  // the logon step, rc restore off: the spawn fix alone still repairs a record that is flagged
  const w2 = world();
  const l2 = linked(w2, 1, foreignRec);
  transcript(w2, 1);
  const stopApp = { running: false, fullAllowed: true, signedIn: ME };
  const r = await rcLogonStep(w2.ctx, { settings: { enabled: false, spawnFix: 'auto' }, readApp: () => stopApp, projects: w2.projects, rcLog: null, now: NOW, log: (l) => w2.log(l) });
  assert.equal(r.ran, true);
  assert.equal(r.spawn.fixed.length, 1);
  assert.equal(readRecord(l2[1]).remoteControlSpawn.detachedAt, NOW);
  // and with the app running it writes nothing and says so
  const w3 = world();
  const l3 = linked(w3, 1, foreignRec);
  transcript(w3, 1);
  const pre = bytes(l3[0]);
  const r3 = await rcLogonStep(w3.ctx, { settings: { enabled: true, spawnFix: 'auto' }, readApp: () => ({ running: true, fullAllowed: false, signedIn: ME }), projects: w3.projects, rcLog: null, tries: 1, log: () => {} });
  assert.deepEqual([r3.ran, r3.reason], [false, 'app-running']);
  assert.ok(bytes(l3[0]).equals(pre));
});

test('P12 the look (wake hook, waiter) only reports: the app running, a throttle of 10 minutes, a line only when something is flagged, no record write', () => {
  const w = world();
  const links = linked(w, 1, foreignRec);
  transcript(w, 1);
  w.runApp();
  const pre = bytes(links[0]);
  const a = spawnLook(w.ctx, opts(w, { now: NOW }));
  assert.equal(a.ran, true);
  assert.equal(a.result.pending.length, 1);
  assert.equal(a.result.apply, false);
  assert.ok(w.logs.some((l) => /pending 1.*fixed at the next quit of Claude or account switch/.test(l)), w.logs.join('\n'));
  assert.deepEqual(spawnLook(w.ctx, opts(w, { now: NOW + 5 * 60_000 })), { ran: false, reason: 'recent' });
  assert.equal(spawnLook(w.ctx, opts(w, { now: NOW + 11 * 60_000 })).ran, true);
  assert.ok(bytes(links[0]).equals(pre), 'nothing written');
  assert.equal(backupFiles(w).length, 0);
  // an app-stopped look still never writes (it is detect only by construction)
  const w2 = world();
  const l2 = linked(w2, 1, foreignRec);
  transcript(w2, 1);
  const pre2 = bytes(l2[0]);
  spawnLook(w2.ctx, opts(w2));
  assert.ok(bytes(l2[0]).equals(pre2));
  // nothing flagged: no log line
  const w3 = world();
  putRecord(w3.fMe.path, 1, { bridgeSessionIds: [] });
  spawnLook(w3.ctx, opts(w3));
  assert.deepEqual(w3.logs, []);
});

test('P13 spawnLine, spawnStatus and the status text: pending sessions, the off mode, and the ones fixed earlier', () => {
  const w = world();
  linked(w, 1, foreignRec);
  transcript(w, 1);
  assert.equal(spawnLine({ found: 2, fixed: [{ id: 'local_abcdef012345' }], pending: [{}], skipped: [{ reason: 'undated' }], failed: [] }), 'rc-spawn: found 2, fixed 1 (abcdef01), pending 1, skipped 1 (undated 1)');
  const st = collectStatus(w.ctx, { probe: false, spawn: undefined });
  assert.equal(st.rcSpawn.pending.length, 1);
  assert.match(formatStatus(st).join('\n'), /Remote Control: 1 session started from claude\.ai under another account cannot be resumed \(pending\)/);
  assert.match(formatStatus({ ...st, rcSpawn: { ...st.rcSpawn, mode: 'off' } }).join('\n'), /automatic fix is off \(rcRestore\.spawnFix\)/);
  spawnFixCore(w.ctx, opts(w, { apply: true }));
  const after = collectStatus(w.ctx, { probe: false });
  assert.deepEqual([after.rcSpawn.pending.length, after.rcSpawn.fixed.length], [0, 1]);
  assert.match(formatStatus(after).join('\n'), /Remote Control: fixed earlier: /);
  const clean = world();
  assert.deepEqual(formatStatus(collectStatus(clean.ctx, { probe: false })).filter((l) => /^Remote Control/.test(l)), []);
});

/* ------------------------------------------------------------------ the account pass (a switch, a link) */

test('P14 the full account pass repairs the spawn after the switch: the signed-in account\'s record, every link, a backup first', async () => {
  const r = makeRoot('spawnpass');
  const clock = makeClock();
  const sim = createSim({ clock, appFile: join(r.root, 'app.json') });
  const A = ME; const B = OLD;
  const fA = addFolder(r.store, A, ORG);
  const fB = addFolder(r.store, B, ORG2);
  writeFileSync(join(r.userData, 'config.json'), JSON.stringify({ lastKnownAccountUuid: A }));
  r.ctx.platform = 'win32';
  r.ctx.rcLog = null;
  mkdirSync(r.acc, { recursive: true });
  writeFileSync(switchHistoryFile(r.ctx), JSON.stringify([{ at: iso(SWITCH - 30 * DAY), acct: B }, { at: iso(SWITCH), acct: A }]));
  const p = putRecord(fA.path, 1, { createdAt: iso(SWITCH - 6 * DAY), ...foreignRec }, clock.tick());
  putRecord(fB.path, 2, { title: 'B record' }, clock.tick());
  sim.setApp({ running: false });
  const state = emptyState(r.store);
  answerPairs(state, [pairKey(A, B)], 'yes', 'cli', clock.t);
  saveState(r.ctx, state);
  const logs = [];
  const rep = await fullPass(r.ctx, { log: (l) => logs.push(l) });
  assert.equal(rep.ok, true, JSON.stringify(rep).slice(0, 400));
  assert.equal(rep.spawn.found, 1);
  assert.equal(rep.spawn.fixed.length, 1);
  const rec = readRecord(p);
  assert.equal(typeof rec.remoteControlSpawn.detachedAt, 'number');
  assert.deepEqual(rec.bridgeSessionIds, ['cse_new', 'session_keep']);
  for (const f of [fA, fB]) { const q = join(f.path, recordName(1)); if (existsSync(q)) assert.equal(readRecord(q).remoteControlSpawn.detachedAt, rec.remoteControlSpawn.detachedAt, 'every copy shows it'); }
  assert.ok(logs.some((l) => /^rc-spawn: found 1, fixed 1/.test(l)), logs.join('\n'));
});

/* ------------------------------------------------------------------ the command */

test('P15 accounts rc-spawn-fix --dry-run reports the flagged session and writes nothing; --json is machine readable', () => {
  const w = cworld({ accounts: 1, records: 1 });
  const A = uuid('a', 1);
  writeFileSync(join(w.userData, 'config.json'), JSON.stringify({ lastKnownAccountUuid: A }));
  mkdirSync(w.acc, { recursive: true });
  writeFileSync(join(w.acc, 'switch-history.json'), JSON.stringify([{ at: '2026-10-01T00:00:00.000Z', acct: uuid('b', 1) }, { at: '2026-11-16T18:00:00.000Z', acct: A }]));
  const rp = join(w.fA.path, recordName(1));
  writeFileSync(rp, JSON.stringify({ ...readRecord(rp), createdAt: '2026-11-01T10:00:00.000Z', remoteControlSpawn: { ccrSessionId: 'cse_x', startedAt: 1 }, bridgeSessionIds: ['cse_x'], title: 'From the phone' }));
  const pre = readFileSync(rp);
  w.setApp({ running: true, signedIn: A, startedAtMs: 1 });   // a dry run works while the app runs
  const out = w.run(['accounts', 'rc-spawn-fix', '--dry-run', '--json'], { SESSION_SYNC_RC_LOG: '' });
  assert.equal(out.status, 0, out.stderr);
  const j = JSON.parse(out.stdout);
  assert.deepEqual([j.command, j.dryRun, j.found], ['rc-spawn-fix', true, 1]);
  assert.equal(j.sessions[0].title, 'From the phone');
  assert.ok(readFileSync(rp).equals(pre));
  assert.equal(existsSync(join(w.acc, 'rc-restore', 'backup')), false);
  // a real run with the app running refuses with a non-zero exit and writes nothing
  const real = w.run(['accounts', 'rc-spawn-fix', '--json'], { SESSION_SYNC_RC_LOG: '' });
  assert.equal(real.status, 3);
  assert.equal(JSON.parse(real.stdout).reason, 'app-running');
  assert.ok(readFileSync(rp).equals(pre));
});

/* ------------------------------------------------------------------ the watcher */

test('P16 the watcher: while the app runs it only reports (once per change); at the stop the spawn is repaired, with rc restore off', async () => {
  const r = makeRoot('spawnwait');
  const clock = makeClock();
  const A = ME; const B = OLD;
  const fA = addFolder(r.store, A, ORG);
  const fB = addFolder(r.store, B, ORG2);
  putRecord(fB.path, 9, { title: 'B record' }, clock.tick());
  writeFileSync(join(r.userData, 'config.json'), JSON.stringify({ lastKnownAccountUuid: A }));
  r.ctx.platform = 'win32';
  r.ctx.rcLog = null;
  r.ctx.setNow(NOW);
  mkdirSync(r.acc, { recursive: true });
  writeFileSync(switchHistoryFile(r.ctx), JSON.stringify([{ at: iso(SWITCH - 30 * DAY), acct: B }, { at: iso(SWITCH), acct: A }]));
  const appFile = join(r.root, 'app.json');
  const setApp = (running) => writeFileSync(appFile, JSON.stringify(running ? { running: true, signedIn: A, startedAtMs: 1 } : { running: false }));
  process.env.SESSION_SYNC_TEST_APP_STATE = appFile;
  setApp(false);
  const state = emptyState(r.store);
  answerPairs(state, [pairKey(A, B)], 'yes', 'cli', clock.t);
  saveState(r.ctx, state);
  const stepper = (onSleep) => { let t = 0; let n = 0; return { clock: () => (t += 100), sleep: async () => { n++; await onSleep(n); } }; };
  const common = { watchLockfile: false, gapMs: 150, pollMs: 1, probeEveryMs: 1, watch: true, reason: 'watch', notify: () => {}, liveEveryMs: 1 };
  // link first (nothing flagged yet), then the flagged record appears while the app runs
  const linkRun = stepper(() => {});
  await (await import('../lib/accounts/waiter.mjs')).runWaiter(r.ctx, { ...common, watch: false, reason: 'link', clock: linkRun.clock, sleep: linkRun.sleep });
  const p = putRecord(fA.path, 1, { createdAt: iso(SWITCH - 6 * DAY), ...foreignRec }, clock.tick());
  const pre = readFileSync(p);
  setApp(true);
  const logs = []; let whileRunning = null; let logsWhileRunning = [];
  const s = stepper((i) => {
    if (i === 8) { whileRunning = readFileSync(p); logsWhileRunning = logs.filter((l) => /rc-spawn/.test(l)); }
    if (i === 9) setApp(false);
    if (i >= 40) { try { unlinkSync(join(r.acc, 'waiter.claim')); } catch { /* gone */ } }
  });
  const out = await (await import('../lib/accounts/waiter.mjs')).runWaiter(r.ctx, { ...common, clock: s.clock, sleep: s.sleep, rcRestore: { enabled: false, days: 3, spawnFix: 'auto' }, rcOpts: { projects: join(r.root, 'projects'), rcLog: null }, log: (l) => logs.push(l) });
  assert.equal(out.exit, 'lost-claim');
  assert.ok(whileRunning.equals(pre), 'nothing is written while the app runs');
  assert.equal(logsWhileRunning.length, 1, `reported once while it runs: ${logsWhileRunning.join(' | ')}`);
  assert.match(logsWhileRunning[0], /^rc-spawn: found 1, fixed 0, pending 1/);
  assert.equal(typeof readRecord(p).remoteControlSpawn.detachedAt, 'number', 'repaired at the stop');
  assert.ok(logs.some((l) => /^rc-spawn: found 1, fixed 1/.test(l)), logs.join('\n'));
});

test('P17 the rc-wake hook looks (report only, throttled) on a real prompt and not on a slash command', () => {
  const w = cworld({ accounts: 1, records: 1 });
  const A = uuid('a', 1);
  writeFileSync(join(w.userData, 'config.json'), JSON.stringify({ lastKnownAccountUuid: A }));
  mkdirSync(w.acc, { recursive: true });
  writeFileSync(join(w.acc, 'switch-history.json'), JSON.stringify([{ at: '2026-10-01T00:00:00.000Z', acct: uuid('b', 1) }, { at: '2026-11-16T18:00:00.000Z', acct: A }]));
  const rp = join(w.fA.path, recordName(1));
  writeFileSync(rp, JSON.stringify({ ...readRecord(rp), createdAt: '2026-11-01T10:00:00.000Z', remoteControlSpawn: { ccrSessionId: 'cse_x', startedAt: 1 }, bridgeSessionIds: ['cse_x'] }));
  const pre = readFileSync(rp);
  w.setApp({ running: true, signedIn: A, startedAtMs: 1 });
  const env = { ...process.env, USERPROFILE: w.home, HOME: w.home, APPDATA: join(w.home, 'AppData', 'Roaming'), XDG_CONFIG_HOME: join(w.home, '.config'), SESSION_SYNC_TEST_APP_STATE: w.appFile, SESSION_SYNC_RC_LOG: '' };
  const hook = (prompt) => spawnSync(process.execPath, [CLI, 'rc-wake', '--from-hook'], { input: JSON.stringify({ session_id: uuid('9', 1), prompt }), encoding: 'utf8', windowsHide: true, timeout: 30000, env });
  const syncLog = () => { try { return readFileSync(join(w.stateDir, 'sync.log'), 'utf8'); } catch { return ''; } };
  assert.equal(hook('/clear').status, 0);
  assert.equal(existsSync(join(w.acc, 'rc-spawn-look.json')), false, 'a slash command does not look');
  const r = hook('hello');
  assert.equal(r.status, 0, r.stderr);
  assert.match(syncLog(), /rc-spawn: found 1, fixed 0, pending 1.*fixed at the next quit/);
  assert.ok(readFileSync(rp).equals(pre), 'the hook never writes a record');
  assert.equal(existsSync(join(w.acc, 'rc-restore', 'backup')), false);
  const lines = () => syncLog().split('\n').filter((l) => /rc-spawn: found/.test(l)).length;
  const n = lines();
  hook('again');
  assert.equal(lines(), n, 'throttled: no second pass within 10 minutes');
});
