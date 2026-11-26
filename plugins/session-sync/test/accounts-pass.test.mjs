/**
 * T16 and the pass tests - link (one-time backup first), live pass, full pass,
 * owed work, unlink. Synthetic store, simulated app; no live files.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fullPass, livePass, link, unlink, owedWork } from '../lib/accounts/pass.mjs';
import { loadState, emptyState, saveState, journalRead, readJson, resetMutations } from '../lib/accounts/state.mjs';
import { answerPairs, pairKey, listFolders } from '../lib/accounts/folders.mjs';
import { AppRunningError } from '../lib/accounts/appstate.mjs';
import { memoryRoot } from '../lib/accounts/cowork-memory.mjs';
import {
  makeRoot, makeClock, addFolder, putRecord, recordName, recordId, nlinkOf, inoOf, putTasks, makeTask, readJsonFile,
  putBacklog, uuid, readRecord,
} from './fixtures/store.mjs';
import { createSim } from './fixtures/appsim.mjs';

afterEach(() => { delete process.env.SESSION_SYNC_TEST_APP_STATE; delete process.env.SESSION_SYNC_TEST_FAIL_AFTER; resetMutations(); });

const A = uuid('a', 1); const B = uuid('b', 1);
const OA = uuid('1', 1); const OB = uuid('2', 2);

function world() {
  const r = makeRoot('pass');
  const clock = makeClock();
  const sim = createSim({ clock, appFile: join(r.root, 'app.json') });
  const fA = addFolder(r.store, A, OA);
  const fB = addFolder(r.store, B, OB);
  const group = [fA, fB];
  for (let i = 1; i <= 3; i++) putRecord(fA.path, i, { title: `A record ${i}` }, clock.tick());
  for (let i = 4; i <= 5; i++) putRecord(fB.path, i, { title: `B record ${i}` }, clock.tick());
  putTasks(fA.path, [makeTask('tA', { cronExpression: '20 5 * * *' })], {}, clock.tick());
  putTasks(fB.path, [makeTask('tB', { cronExpression: '40 6 * * *' })], {}, clock.tick());
  putBacklog(fA.path, [{ id: 'bA', title: 'backlog A' }], 1, clock.tick());
  putBacklog(fB.path, [{ id: 'bB', title: 'backlog B' }], 1, clock.tick());
  writeFileSync(join(r.userData, 'claude_desktop_config.json'), JSON.stringify({ preferences: { bypassPermissionsOptInByAccount: { [A]: true } } }, null, 2));
  writeFileSync(join(r.userData, 'config.json'), JSON.stringify({ lastKnownAccountUuid: A }));
  const memFile = join(memoryRoot(r.ctx, fA), 'note.md');
  mkdirSync(dirname(memFile), { recursive: true });
  writeFileSync(memFile, 'memory from A');
  sim.setApp({ running: false });
  const state = emptyState(r.store);
  answerPairs(state, [pairKey(A, B)], 'yes', 'cli', clock.t);
  saveState(r.ctx, state);
  const names = (F) => readdirSync(F.path).filter((n) => /^local_.*\.json$/.test(n)).sort();
  return { r, ctx: r.ctx, clock, sim, fA, fB, group, state, names };
}

const backupDirs = (w) => (existsSync(join(w.r.acc, 'backup')) ? readdirSync(join(w.r.acc, 'backup')) : []);

test('T16 pre: no live pass before the first link; a full pass needs the app stopped', async () => {
  const w = world();
  assert.equal((await livePass(w.ctx, { app: { running: true, signedIn: A, startedAtMs: 1 } })).skipped, 'not-linked');
  w.sim.setApp({ running: true, signedIn: A, startedAtMs: 1 });
  const rep = await fullPass(w.ctx, {});
  assert.equal(rep.ok, false);
  assert.equal(rep.reason, 'app-running');
  assert.deepEqual(backupDirs(w), []);
  assert.deepEqual(w.names(w.fB), [recordName(4), recordName(5)].sort());
});

test('link: backup first and verified, then every merge; a second pass takes no new backup', async () => {
  const w = world();
  const rep = await link(w.ctx, {});
  assert.equal(rep.ok, true, JSON.stringify(rep));
  assert.equal(backupDirs(w).length, 1);
  assert.equal(readJson(join(w.r.acc, 'backup', rep.backupId, 'manifest.json')).verified, true);
  // records: every name in both folders, one inode
  assert.deepEqual(w.names(w.fA), w.names(w.fB));
  assert.equal(w.names(w.fA).length, 5);
  for (let i = 1; i <= 5; i++) {
    assert.equal(inoOf(join(w.fA.path, recordName(i))), inoOf(join(w.fB.path, recordName(i))));
    assert.equal(nlinkOf(join(w.fA.path, recordName(i))), 2);
  }
  // tasks and backlog merged, regular files
  for (const F of w.group) {
    assert.deepEqual(readJsonFile(join(F.path, 'scheduled-tasks.json')).scheduledTasks.map((t) => t.id).sort(), ['tA', 'tB']);
    assert.deepEqual(readJsonFile(join(F.path, 'backlog', 'tasks.json')).items.map((t) => t.id).sort(), ['bA', 'bB']);
    assert.equal(nlinkOf(join(F.path, 'scheduled-tasks.json')), 1);
  }
  // settings and memory
  assert.equal(readJsonFile(join(w.r.userData, 'claude_desktop_config.json')).preferences.bypassPermissionsOptInByAccount[B], true);
  assert.equal(readFileSync(join(memoryRoot(w.ctx, w.fB), 'note.md'), 'utf8'), 'memory from A');
  // state
  const st = loadState(w.ctx);
  assert.equal(st.linked, true);
  assert.deepEqual(st.group, [w.fA.key, w.fB.key].sort());
  assert.equal(st.backupId, rep.backupId);
  assert.equal(st.fullPassOwed, false);
  assert.ok(st.lastFullPass);
  assert.equal(journalRead(w.ctx), null);
  for (const b of ['tasks-base.json', 'backlog-base.json', 'settings-base.json', 'memory-base.json']) assert.ok(existsSync(join(w.r.acc, b)), b);
  // a second full pass: no new backup, nothing owed
  const again = await fullPass(w.ctx, {});
  assert.equal(again.ok, true);
  assert.equal(again.backupId, undefined);
  assert.equal(backupDirs(w).length, 1);
  assert.equal(owedWork(w.ctx, {}).owed, false);
});

test('an injected failure mid-link keeps the pristine backup; the retry reuses it and completes', async () => {
  const w = world();
  process.env.SESSION_SYNC_TEST_FAIL_AFTER = '3';
  await assert.rejects(() => link(w.ctx, {}), /SESSION_SYNC_TEST_FAIL_AFTER/);
  delete process.env.SESSION_SYNC_TEST_FAIL_AFTER; resetMutations();
  const st = loadState(w.ctx);
  assert.equal(st.linked, false);
  assert.ok(st.backupId, 'the backup id is persisted before any change');
  assert.equal(journalRead(w.ctx)?.op, 'link');
  assert.equal(backupDirs(w).length, 1);
  const firstId = st.backupId;
  const rep = await link(w.ctx, {});
  assert.equal(rep.ok, true, JSON.stringify(rep));
  assert.equal(rep.backupReused, true);
  assert.equal(rep.backupId, firstId);
  assert.equal(backupDirs(w).length, 1, 'no second backup of a half-linked store');
  assert.equal(journalRead(w.ctx), null);
  assert.equal(loadState(w.ctx).linked, true);
});

test('an app that starts mid-pass aborts it and leaves a full pass owed', async () => {
  const w = world();
  let calls = 0;
  const guard = () => { if (++calls > 2) throw new AppRunningError('started'); };
  const rep = await fullPass(w.ctx, { guard });
  assert.equal(rep.ok, false);
  assert.equal(rep.aborted, true);
  const st = loadState(w.ctx);
  assert.equal(st.fullPassOwed, true);
  assert.equal(st.linked, false);
});

test('live pass: the signed-in (live) folder is untouched, the other is updated, a delete is deferred, settings and memory wait', async () => {
  const w = world();
  assert.equal((await link(w.ctx, {})).ok, true);
  const cfgBefore = readFileSync(join(w.r.userData, 'claude_desktop_config.json'), 'utf8');
  // the app starts, signed in as A; A saves record 1, creates record 6, A's task runs, B's file gets a task edit
  w.sim.setApp({ running: true, signedIn: A, startedAtMs: w.clock.t });
  w.sim.save(w.fA, recordId(1), { title: 'edited in A' });
  putRecord(w.fA.path, 6, { title: 'new in A' }, w.clock.tick());
  const aTasksBefore = readFileSync(join(w.fA.path, 'scheduled-tasks.json'), 'utf8');
  w.sim.runTask(w.fA, 'tA', w.clock.tick());
  const aTasksRan = readFileSync(join(w.fA.path, 'scheduled-tasks.json'), 'utf8');
  assert.notEqual(aTasksBefore, aTasksRan);
  writeFileSync(join(w.r.userData, 'claude_desktop_config.json'), JSON.stringify({ preferences: { bypassPermissionsOptInByAccount: { [A]: false, [B]: true } } }, null, 2));
  const cfgNow = readFileSync(join(w.r.userData, 'claude_desktop_config.json'), 'utf8');
  // a delete of a non-live record in B: the app deletes record 4 there
  w.sim.del(w.fB, recordId(4));
  const rep = await livePass(w.ctx, {});
  assert.equal(rep.ok, true, JSON.stringify(rep));
  assert.deepEqual(rep.live, [w.fA.key]);
  // add reached B; record 1's edit relinks into B (non-live loser); live folder A's record 1 name keeps its inode
  assert.ok(existsSync(join(w.fB.path, recordName(6))));
  assert.equal(readRecord(join(w.fB.path, recordName(1))).title, 'edited in A');
  // the live task file was not written; B's task file received the run-time
  assert.equal(readFileSync(join(w.fA.path, 'scheduled-tasks.json'), 'utf8'), aTasksRan);
  assert.ok(readJsonFile(join(w.fB.path, 'scheduled-tasks.json')).scheduledTasks.find((t) => t.id === 'tA').lastRunAt);
  // the delete waits (record 4 still in A), settings untouched
  assert.ok(existsSync(join(w.fA.path, recordName(4))));
  assert.equal(readFileSync(join(w.r.userData, 'claude_desktop_config.json'), 'utf8'), cfgNow);
  assert.notEqual(cfgNow, cfgBefore);
  assert.equal(rep.owed, true);
  assert.equal(rep.armWaiter, true);
  assert.equal(loadState(w.ctx).fullPassOwed, true);
  assert.equal(owedWork(w.ctx, {}).owed, true);
  // the app exits: the full pass finishes the work
  w.sim.stopApp();
  const full = await fullPass(w.ctx, {});
  assert.equal(full.ok, true, JSON.stringify(full));
  assert.equal(existsSync(join(w.fA.path, recordName(4))), false, 'the delete is applied');
  assert.equal(loadState(w.ctx).fullPassOwed, false);
  assert.equal(readJsonFile(join(w.r.userData, 'claude_desktop_config.json')).preferences.bypassPermissionsOptInByAccount[B], false, 'A turned it off: the change reaches B');
  assert.equal(owedWork(w.ctx, {}).owed, false);
});

test('live pass with an unknown signed-in account treats every folder as live: no task or backlog file is written', async () => {
  const w = world();
  assert.equal((await link(w.ctx, {})).ok, true);
  w.sim.setApp({ running: true, signedIn: null, startedAtMs: w.clock.t });
  w.sim.runTask(w.fA, 'tA', w.clock.tick());
  const before = ['A', 'B'].map((x) => readFileSync(join((x === 'A' ? w.fA : w.fB).path, 'scheduled-tasks.json'), 'utf8'));
  const rep = await livePass(w.ctx, {});
  assert.equal(rep.ok, true);
  assert.deepEqual(rep.live.sort(), [w.fA.key, w.fB.key].sort());
  const after = ['A', 'B'].map((x) => readFileSync(join((x === 'A' ? w.fA : w.fB).path, 'scheduled-tasks.json'), 'utf8'));
  assert.deepEqual(after, before);
  assert.equal(rep.owed, true);
});

test("S5 live pass: after an in-app switch A -> B, B's task run reaches A's file once A has cooled, so switching back does not re-fire the catch-up", async () => {
  const w = world();
  assert.equal((await link(w.ctx, {})).ok, true);
  const started = w.clock.tick();
  w.sim.setApp({ running: true, signedIn: A, startedAtMs: started });
  assert.equal((await livePass(w.ctx, {})).ok, true);
  w.sim.setApp({ running: true, signedIn: B, startedAtMs: started });         // in-app switch to B
  const now = w.clock.tick();
  const d = new Date(now); d.setUTCHours(5, 20, 0, 0);
  const slot = d.getTime() > now ? d.getTime() - 86400000 : d.getTime();
  w.sim.runTask(w.fB, 'tA', slot);                                            // the scheduler runs tA under B
  const rep = await livePass(w.ctx, {});
  assert.equal(rep.ok, true, JSON.stringify(rep));
  assert.deepEqual(rep.live, [w.fB.key], 'B is the loaded folder');
  assert.deepEqual(rep.cooling, [w.fA.key], 'A was just switched away from');
  assert.equal(rep.tasks.skipped.some((x) => x.folder === w.fA.key), true, 'the task file of A waits while A cools (its sessions still flush)');
  w.ctx.setNow(w.ctx.now() + 16000);                                          // the cooling period (15 s) is over: A is free
  const rep2 = await livePass(w.ctx, {});
  assert.deepEqual(rep2.cooling, []);
  assert.equal(rep2.tasks.skipped.some((x) => x.folder === w.fA.key), false, 'the task file of A is written now');
  w.sim.setApp({ running: true, signedIn: A, startedAtMs: started });         // switch back: the scheduler re-reads A's file
  const fired = w.sim.catchUp(join(w.fA.path, 'scheduled-tasks.json'), now) ?? [];
  assert.equal(fired.includes('tA'), false, 'the slot B already ran must not fire again');   // tB never ran anywhere: it may fire
});

/* ---------------------------------------------------------------- unlink (T16) */

test('T16 unlink: each record only in its home with the newest bytes; tasks and backlog only in their origin; run-times at max', async () => {
  const w = world();
  assert.equal((await link(w.ctx, {})).ok, true);
  // B's app edits record 1 (home A) and runs task tA (origin A); then the app stops
  w.sim.setApp({ running: true, signedIn: B, startedAtMs: w.clock.t });
  w.sim.save(w.fB, recordId(1), { title: 'newest, edited in B' });
  w.sim.runTask(w.fB, 'tA', w.clock.tick());
  w.sim.stopApp();
  const full = await fullPass(w.ctx, {});
  assert.equal(full.ok, true, JSON.stringify(full));
  const homes = Object.fromEntries(Object.entries(loadState(w.ctx).records).map(([id, r]) => [id, r.home]));
  assert.equal(homes[recordId(1)], w.fA.key);
  assert.equal(homes[recordId(4)], w.fB.key);

  // refused while the app runs
  w.sim.setApp({ running: true, signedIn: A, startedAtMs: 1 });
  assert.equal((await unlink(w.ctx, {})).reason, 'app-running');
  w.sim.stopApp();

  const rep = await unlink(w.ctx, {});
  assert.equal(rep.ok, true, JSON.stringify(rep));
  assert.deepEqual(w.names(w.fA), [1, 2, 3].map(recordName).sort());
  assert.deepEqual(w.names(w.fB), [4, 5].map(recordName).sort());
  assert.equal(readRecord(join(w.fA.path, recordName(1))).title, 'newest, edited in B');
  for (let i = 1; i <= 5; i++) assert.equal(nlinkOf(join((i <= 3 ? w.fA : w.fB).path, recordName(i))), 1);
  // tasks and backlog: only the origin's entries; the run-time max stays
  const ta = readJsonFile(join(w.fA.path, 'scheduled-tasks.json')).scheduledTasks;
  assert.deepEqual(ta.map((t) => t.id), ['tA']);
  assert.ok(ta[0].lastRunAt, 'the run in B is kept on the origin task');
  assert.deepEqual(readJsonFile(join(w.fB.path, 'scheduled-tasks.json')).scheduledTasks.map((t) => t.id), ['tB']);
  assert.deepEqual(readJsonFile(join(w.fA.path, 'backlog', 'tasks.json')).items.map((t) => t.id), ['bA']);
  assert.deepEqual(readJsonFile(join(w.fB.path, 'backlog', 'tasks.json')).items.map((t) => t.id), ['bB']);
  // state
  const st = loadState(w.ctx);
  assert.equal(st.linked, false);
  assert.equal(st.pairs[pairKey(A, B)].answer, 'no');
  assert.equal(st.pairs[pairKey(A, B)].via, 'unlink');
  assert.deepEqual(st.records, {});
  for (const b of ['tasks-base.json', 'backlog-base.json', 'settings-base.json', 'memory-base.json']) assert.equal(existsSync(join(w.r.acc, b)), false, b);
  // settings and memory stay as they are
  assert.equal(readFileSync(join(memoryRoot(w.ctx, w.fB), 'note.md'), 'utf8'), 'memory from A');
  // a later link starts from a fresh backup
  answerPairs(st, [pairKey(A, B)], 'yes', 'cli', w.clock.t);
  saveState(w.ctx, st);
  const relink = await link(w.ctx, {});
  assert.equal(relink.ok, true, JSON.stringify(relink));
  assert.equal(backupDirs(w).length, 2);
});

test('unlink after a split: the displaced bytes are in backup and home carries the newest', async () => {
  const w = world();
  assert.equal((await link(w.ctx, {})).ok, true);
  // B's app saves record 2 (tmp + rename): B's name is now a separate file with newer bytes
  w.sim.setApp({ running: true, signedIn: B, startedAtMs: 1 });
  w.sim.save(w.fB, recordId(2), { title: 'split in B' });
  w.sim.stopApp();
  const oldBytes = readFileSync(join(w.fA.path, recordName(2)), 'utf8');
  const rep = await unlink(w.ctx, {});
  assert.equal(rep.ok, true);
  assert.equal(w.names(w.fB).includes(recordName(2)), false);
  assert.equal(readRecord(join(w.fA.path, recordName(2))).title, 'split in B', 'home carries the newest bytes');
  const idx = readFileSync(join(w.r.acc, 'rectify-backups', 'index.jsonl'), 'utf8');
  assert.ok(idx.includes(createHash('sha256').update(oldBytes).digest('hex')), 'the displaced bytes are in backup');
});

test('unlink with the pass interrupted by an injected failure can be run again', async () => {
  const w = world();
  assert.equal((await link(w.ctx, {})).ok, true);
  process.env.SESSION_SYNC_TEST_FAIL_AFTER = '2';
  await assert.rejects(() => unlink(w.ctx, {}), /SESSION_SYNC_TEST_FAIL_AFTER/);
  delete process.env.SESSION_SYNC_TEST_FAIL_AFTER; resetMutations();
  assert.equal(loadState(w.ctx).linked, true);
  assert.equal(journalRead(w.ctx)?.op, 'unlink');
  const rep = await unlink(w.ctx, {});
  assert.equal(rep.ok, true, JSON.stringify(rep));
  assert.equal(journalRead(w.ctx), null);
  assert.deepEqual(w.names(w.fB), [4, 5].map(recordName).sort());
});

test('unlink of a group that was never linked is refused', async () => {
  const w = world();
  assert.equal((await unlink(w.ctx, {})).reason, 'not-linked');
  assert.equal(listFolders(w.r.store).length, 2);
});

test('0.5.14 live pass: an in-app switch A -> B leaves a connector-check marker (from, to, switch time), even when the history already holds B', async () => {
  const w = world();
  assert.equal((await link(w.ctx, {})).ok, true);
  w.sim.setApp({ running: true, signedIn: A, startedAtMs: w.clock.tick() });
  assert.equal((await livePass(w.ctx, {})).ok, true);
  assert.equal(existsSync(join(w.r.acc, 'connector-check.json')), false, 'no switch yet: no marker');
  // the history already ends with B (as when remote-control.log seeded it), so recordSwitch has nothing to add
  writeFileSync(join(w.r.acc, 'switch-history.json'), JSON.stringify([{ at: new Date(w.clock.t).toISOString(), acct: B }]));
  w.sim.setApp({ running: true, signedIn: B, startedAtMs: w.clock.t });
  const at = w.clock.tick();
  assert.equal((await livePass(w.ctx, {})).ok, true);
  const m = readJson(join(w.r.acc, 'connector-check.json'), null);
  assert.ok(m, 'the marker is written');
  assert.equal(m.from, A);
  assert.equal(m.to, B);
  assert.ok(Date.parse(m.switchAt) >= at - 1000);
});
