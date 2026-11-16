/**
 * T11 to T13 - the scheduled-task and backlog merges, plus unit tests of the
 * generic 3-way helpers (merge3). Synthetic stores only.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { mergeTasks, mergeBacklog, splitByOrigin } from '../lib/accounts/tasks.mjs';
import { merge3, mergeKeyed, buildSide } from '../lib/accounts/merge3.mjs';
import { emptyState, readJson } from '../lib/accounts/state.mjs';
import {
  makeRoot, makeClock, addFolder, putTasks, putBacklog, makeTask, readJsonFile, setMtime, uuid,
} from './fixtures/store.mjs';
import { createSim } from './fixtures/appsim.mjs';

afterEach(() => { delete process.env.SESSION_SYNC_TEST_APP_STATE; delete process.env.SESSION_SYNC_TEST_FAIL_AFTER; });

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function world() {
  const r = makeRoot('tasks');
  const clock = makeClock();
  const sim = createSim({ clock, appFile: join(r.root, 'app.json') });
  const fA = addFolder(r.store, uuid('a', 1), uuid('1', 1));
  const fB = addFolder(r.store, uuid('b', 1), uuid('1', 1));
  const group = [fA, fB];
  const state = emptyState(r.store);
  const full = () => mergeTasks(group, { mode: 'full', ctx: r.ctx, state });
  const live = (keys) => mergeTasks(group, { mode: 'live', live: new Set(keys), ctx: r.ctx, state });
  const fileOf = (f) => join(f.path, 'scheduled-tasks.json');
  const tasksOf = (f) => readJsonFile(fileOf(f)).scheduledTasks;
  return { r, clock, sim, fA, fB, group, state, full, live, fileOf, tasksOf };
}

const slotOf = (now, h = 5, m = 20) => {
  const d = new Date(now);
  d.setUTCHours(h, m, 0, 0);
  return d.getTime() > now ? d.getTime() - 86400000 : d.getTime();
};

/* ------------------------------------------------------------------ T11 */

test('T11 tasks: union at first link, ids unchanged, filePath kept per file', () => {
  const w = world();
  putTasks(w.fA.path, [makeTask('t1', { filePath: 'A-path' }), makeTask('t2')], { sundayAliasBoundaryStamped: true }, w.clock.tick());
  putTasks(w.fB.path, [makeTask('t3', { filePath: 'B-path' })], {}, w.clock.tick());
  const rep = w.full();
  assert.deepEqual(rep.bad, []);
  assert.deepEqual(w.tasksOf(w.fA).map((t) => t.id), ['t1', 't2', 't3']);
  assert.deepEqual(w.tasksOf(w.fB).map((t) => t.id), ['t3', 't1', 't2']);
  assert.equal(w.tasksOf(w.fA)[0].filePath, 'A-path');                     // an existing task keeps the file's own value
  assert.equal(w.tasksOf(w.fA)[2].filePath, 'B-path');                     // an added task takes the source value
  assert.equal(readJsonFile(w.fileOf(w.fB)).sundayAliasBoundaryStamped, true);   // OR across files
  const base = readJson(join(w.r.acc, 'tasks-base.json'));
  assert.equal(base.origin.t1, w.fA.key);
  assert.equal(base.origin.t3, w.fB.key);
});

test('T11 tasks: run-times merge by max, so catch-up and one-shots do not fire twice', () => {
  const w = world();
  const now = w.clock.t;
  putTasks(w.fA.path, [makeTask('daily'), makeTask('once', { cronExpression: undefined, fireAt: new Date(now - 3600e3).toISOString() })], {}, w.clock.tick());
  putTasks(w.fB.path, [], {}, w.clock.tick());
  w.full();
  // the app in account A runs both tasks
  const slot = slotOf(now);
  w.sim.runTask(w.fA, 'daily', slot);
  w.sim.runTask(w.fA, 'once', now);
  // without the merge B would fire both
  assert.deepEqual(w.sim.catchUp(w.fileOf(w.fB), now), ['daily', 'once']);
  w.full();
  assert.equal(w.sim.catchUp(w.fileOf(w.fB), now), null);
  const b = Object.fromEntries(w.tasksOf(w.fB).map((t) => [t.id, t]));
  assert.equal(b.daily.lastScheduledFor, new Date(slot).toISOString());
  assert.equal(b.once.lastRunAt, new Date(now).toISOString());
  assert.deepEqual(Object.keys(b).sort(), ['daily', 'once']);               // ids unchanged
});

test('T11 tasks: an older run-time never overwrites a newer one', () => {
  const w = world();
  putTasks(w.fA.path, [makeTask('t1', { lastRunAt: '2026-11-10T05:20:00.000Z' })], {}, w.clock.tick());
  putTasks(w.fB.path, [makeTask('t1', { lastRunAt: '2026-11-12T05:20:00.000Z' })], {}, w.clock.tick());
  w.full();
  assert.equal(w.tasksOf(w.fA)[0].lastRunAt, '2026-11-12T05:20:00.000Z');
  assert.equal(w.tasksOf(w.fB)[0].lastRunAt, '2026-11-12T05:20:00.000Z');
});

test('T11 tasks: an edit wins over a delete; a delete runs only in a full pass and is logged', () => {
  const w = world();
  putTasks(w.fA.path, [makeTask('t1'), makeTask('t2'), makeTask('t3')], {}, w.clock.tick());
  putTasks(w.fB.path, [], {}, w.clock.tick());
  w.full();
  assert.equal(w.tasksOf(w.fB).length, 3);

  // A edits t2, B deletes t2 -> the edit wins (kept in both)
  putTasks(w.fA.path, [makeTask('t1'), makeTask('t2', { displayName: 'edited in A' }), makeTask('t3')], {}, w.clock.tick());
  putTasks(w.fB.path, [makeTask('t1'), makeTask('t3')], {}, w.clock.tick());
  // A deletes t3 and B did not touch it -> a live pass defers it
  putTasks(w.fA.path, [makeTask('t1'), makeTask('t2', { displayName: 'edited in A' })], {}, w.clock.tick());
  const lrep = w.live([w.fA.key]);
  assert.ok(lrep.owed.some((o) => o.why === 'tasks-delete' && o.id === 't3'), 'delete deferred and owed');
  assert.deepEqual(lrep.keptEdits, ['t2']);
  assert.deepEqual(w.tasksOf(w.fB).map((t) => t.id).sort(), ['t1', 't2', 't3'], 'B got t2 back from the edit; t3 stays until a full pass');

  const rep = w.full();
  assert.deepEqual(rep.deleted, ['t3']);
  assert.deepEqual(w.tasksOf(w.fA).map((t) => t.id), ['t1', 't2']);
  assert.deepEqual(w.tasksOf(w.fB).map((t) => t.id), ['t1', 't2']);
  assert.equal(w.tasksOf(w.fB).find((t) => t.id === 't2').displayName, 'edited in A');
  const log = readFileSync(join(w.r.acc, 'tasks-deleted.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log.length, 1);
  assert.equal(log[0].id, 't3');
  assert.equal(log[0].entry.displayName, 'Synthetic task t3');             // full content kept
});

test('T11 tasks: a conflicting field goes to the file with the newest mtime; a tie keeps the base', () => {
  const w = world();
  putTasks(w.fA.path, [makeTask('t1')], {}, w.clock.tick());
  putTasks(w.fB.path, [], {}, w.clock.tick());
  w.full();
  const t = w.clock.t;
  putTasks(w.fA.path, [makeTask('t1', { displayName: 'from A' })], {}, t + 1000);
  putTasks(w.fB.path, [makeTask('t1', { displayName: 'from B' })], {}, t + 5000);
  w.full();
  assert.equal(w.tasksOf(w.fA)[0].displayName, 'from B');
  // a tie keeps the base value (here: B's winner from the last pass)
  putTasks(w.fA.path, [makeTask('t1', { displayName: 'tie A' })], {}, t + 9000);
  putTasks(w.fB.path, [makeTask('t1', { displayName: 'tie B' })], {}, t + 9000);
  w.full();
  assert.equal(w.tasksOf(w.fA)[0].displayName, 'from B');
  assert.equal(w.tasksOf(w.fB)[0].displayName, 'from B');
});

test('T11 tasks: a third folder joining later does not delete anything; a corrupt file is left alone', () => {
  const w = world();
  putTasks(w.fA.path, [makeTask('t1')], {}, w.clock.tick());
  putTasks(w.fB.path, [], {}, w.clock.tick());
  w.full();
  const fC = addFolder(w.r.store, uuid('c', 1), uuid('1', 1));
  const group3 = [w.fA, w.fB, fC];
  mergeTasks(group3, { mode: 'full', ctx: w.r.ctx, state: w.state });
  assert.deepEqual(w.tasksOf(w.fA).map((t) => t.id), ['t1']);
  assert.deepEqual(JSON.parse(readFileSync(join(fC.path, 'scheduled-tasks.json'), 'utf8')).scheduledTasks.map((t) => t.id), ['t1']);
  // corrupt file: reported, byte-identical afterwards
  const bad = join(w.fB.path, 'scheduled-tasks.json');
  writeFileSync(bad, '{ not json');
  const before = sha(bad);
  const rep = mergeTasks(group3, { mode: 'full', ctx: w.r.ctx, state: w.state });
  assert.equal(rep.bad.length, 1);
  assert.equal(sha(bad), before);
});


/* ------------------------------------------------------------------ T12 */

test('T12 tasks while the app runs: the signed-in file is untouched, the other file is updated', () => {
  const w = world();
  putTasks(w.fA.path, [makeTask('t1')], {}, w.clock.tick());
  putTasks(w.fB.path, [makeTask('t1')], {}, w.clock.tick());
  w.full();
  const now = w.clock.t;
  const slot = slotOf(now);
  w.sim.runTask(w.fA, 't1', slot);                                          // the app (account A) ran it
  putTasks(w.fB.path, [makeTask('t1'), makeTask('t9', { displayName: 'new in B', createdAt: now })], {}, w.clock.tick());
  const aFile = w.fileOf(w.fA);
  const before = { sha: sha(aFile), mtime: lstatSync(aFile).mtimeMs };
  const rep = w.live([w.fA.key]);
  assert.equal(sha(aFile), before.sha, 'the live file is byte-identical');
  assert.equal(lstatSync(aFile).mtimeMs, before.mtime);
  assert.deepEqual(rep.skipped, [{ folder: w.fA.key, why: 'live' }]);
  assert.ok(rep.owed.some((o) => o.why === 'tasks-write-live'));
  assert.deepEqual(rep.written, [w.fB.key]);
  const b = w.tasksOf(w.fB);
  assert.equal(b.find((t) => t.id === 't1').lastScheduledFor, new Date(slot).toISOString());
  assert.equal(w.sim.catchUp(w.fileOf(w.fB), now), null);
  // the next full pass brings A up to date
  w.full();
  assert.ok(w.tasksOf(w.fA).some((t) => t.id === 't9'));
});

/* ------------------------------------------------------------------ T13 */

test('T13 backlog merge: items merged by id, version max, regular files, created only when non-empty', () => {
  const w = world();
  putBacklog(w.fA.path, [{ id: 'b1', title: 'one', createdAt: 1 }, { id: 'b2', title: 'two', createdAt: 2 }], 3, w.clock.tick());
  // B has no backlog folder at all
  const rep = mergeBacklog(w.group, { mode: 'full', ctx: w.r.ctx, state: w.state });
  const bFile = join(w.fB.path, 'backlog', 'tasks.json');
  assert.ok(existsSync(bFile));
  assert.deepEqual(rep.written, [w.fB.key]);
  assert.deepEqual(readJsonFile(bFile).items.map((i) => i.id), ['b1', 'b2']);
  assert.equal(readJsonFile(bFile).version, 3);
  assert.equal(lstatSync(bFile).nlink, 1);

  // both sides edit different items, B adds one, A removes b2
  putBacklog(w.fA.path, [{ id: 'b1', title: 'one (A)', createdAt: 1 }], 4, w.clock.tick());
  putBacklog(w.fB.path, [{ id: 'b1', title: 'one', createdAt: 1, done: true }, { id: 'b2', title: 'two', createdAt: 2 }, { id: 'b3', title: 'three', createdAt: 3 }], 3, w.clock.tick());
  mergeBacklog(w.group, { mode: 'full', ctx: w.r.ctx, state: w.state });
  const a = readJsonFile(join(w.fA.path, 'backlog', 'tasks.json'));
  assert.deepEqual(a.items.map((i) => i.id), ['b1', 'b3']);
  assert.equal(a.items[0].title, 'one (A)');
  assert.equal(a.items[0].done, true);                                      // fieldwise: A changed title, B changed done
  assert.equal(a.version, 4);
  assert.equal(readJsonFile(bFile).version, 4);
  assert.equal(lstatSync(join(w.fA.path, 'backlog', 'tasks.json')).nlink, 1);
  assert.ok(existsSync(join(w.r.acc, 'backlog-deleted.jsonl')));

  // empty on both sides: no file is created
  const w2 = world();
  mergeBacklog(w2.group, { mode: 'full', ctx: w2.r.ctx, state: w2.state });
  assert.equal(existsSync(join(w2.fA.path, 'backlog')), false);
});

test('T13 backlog while the app runs: the live folder is not written', () => {
  const w = world();
  putBacklog(w.fA.path, [{ id: 'b1', title: 'one' }], 1, w.clock.tick());
  putBacklog(w.fB.path, [{ id: 'b1', title: 'one' }], 1, w.clock.tick());
  mergeBacklog(w.group, { mode: 'full', ctx: w.r.ctx, state: w.state });
  putBacklog(w.fB.path, [{ id: 'b1', title: 'one' }, { id: 'b2', title: 'two' }], 1, w.clock.tick());
  const aFile = join(w.fA.path, 'backlog', 'tasks.json');
  const before = sha(aFile);
  const rep = mergeBacklog(w.group, { mode: 'live', live: new Set([w.fA.key]), ctx: w.r.ctx, state: w.state });
  assert.equal(sha(aFile), before);
  assert.equal(rep.pending, true);
});

/* ------------------------------------------------------------------ unlink split */

test('splitByOrigin: each file keeps only its own tasks; unknown origin stays', () => {
  const w = world();
  putTasks(w.fA.path, [makeTask('t1')], {}, w.clock.tick());
  putTasks(w.fB.path, [makeTask('t2')], {}, w.clock.tick());
  w.full();
  putTasks(w.fA.path, [...w.tasksOf(w.fA), makeTask('unknown-origin')], {}, w.clock.tick());
  const rep = splitByOrigin(w.group, 'tasks', { ctx: w.r.ctx, state: w.state });
  assert.deepEqual(w.tasksOf(w.fA).map((t) => t.id), ['t1', 'unknown-origin']);
  assert.deepEqual(w.tasksOf(w.fB).map((t) => t.id), ['t2']);
  assert.equal(rep.removedEntries, 2);
});

/* ------------------------------------------------------------------ merge3 units */

test('merge3 value: one changer wins, several go to newest, tie keeps the base, first link takes newest', () => {
  const base = { a: 1, b: 1 };
  assert.deepEqual(merge3('value', base, { a: 2, b: 1 }).result, { a: 2, b: 2 });
  assert.deepEqual(merge3('value', base, { a: 2, b: 3 }, { newest: () => 'b' }).result, { a: 3, b: 3 });
  const tie = merge3('value', base, { a: 2, b: 3 }, { newest: () => null });
  assert.deepEqual(tie.result, { a: 1, b: 1 });
  assert.equal(tie.conflicts, 1);
  assert.deepEqual(merge3('value', null, { a: 2, b: 3 }, { newest: () => 'a' }).result, { a: 2, b: 2 });
  assert.deepEqual(merge3('value', null, { a: 2, b: 3 }, { newest: () => null }).result, { a: 2, b: 3 }, 'no base, tie: each side keeps its own');
});

test('merge3 or, max: monotone; a trivial value is never created on an absent side', () => {
  assert.deepEqual(merge3('or', null, { a: true, b: undefined }).result, { a: true, b: true });
  assert.deepEqual(merge3('or', null, { a: false, b: undefined }).result, { a: false, b: undefined });
  assert.deepEqual(merge3('max', { a: 1, b: 1 }, { a: 5, b: 3 }).result, { a: 5, b: 5 });
  assert.deepEqual(merge3('max', null, { a: 0, b: undefined }).result, { a: 0, b: undefined });
});

test('merge3 set: (base ∪ added) − removed; a re-add elsewhere wins; seeded baselines are not unified', () => {
  const base = { a: ['x', 'y'], b: ['x', 'y'] };
  assert.deepEqual(merge3('set', base, { a: ['x', 'y', 'z'], b: ['y'] }).result, { a: ['y', 'z'], b: ['y', 'z'] });
  assert.deepEqual(merge3('set', base, { a: ['y'], b: ['x', 'y', 'x2'] }).result, { a: ['y', 'x2'], b: ['y', 'x2'] }, 'removed in a, kept as is in b: removed');
  assert.deepEqual(merge3('set', { a: ['x'], b: ['x'] }, { a: ['y'], b: ['x', 'y'] }).result, { a: ['y'], b: ['y'] });
  // seeded: different baselines, nothing changed -> nothing changes
  const seeded = { a: ['t1', 't2'], b: [] };
  const m = merge3('set', seeded, { a: ['t1', 't2'], b: [] });
  assert.deepEqual(m.changed, []);
  // first link: union
  assert.deepEqual(merge3('set', null, { a: ['p'], b: ['q'] }).result, { a: ['p', 'q'], b: ['q', 'p'] });
});

test('merge3 map (deep): per key, removal needs an unchanged key elsewhere', () => {
  const base = { a: { k1: 'v', k2: 'w' }, b: { k1: 'v', k2: 'w' } };
  const r = merge3('map', base, { a: { k1: 'v2', k2: 'w' }, b: { k1: 'v', k3: 'n' } });
  assert.deepEqual(r.result.a, { k1: 'v2', k3: 'n' });
  assert.deepEqual(r.result.b, { k1: 'v2', k3: 'n' });
  const nested = merge3('map', null, { a: { s: { x: 1 } }, b: { s: { y: 2 } } });
  assert.deepEqual(nested.result.a, { s: { x: 1, y: 2 } });
  assert.deepEqual(nested.result.b, { s: { y: 2, x: 1 } });
});

test('merge3 keyed-array: union by id, conflict by lastUsedAt, removal propagates', () => {
  const P = (id, name, lastUsedAt, createdAt = 1) => ({ id, name, lastUsedAt, createdAt });
  const first = merge3('keyed-array', null, { a: [P('1', 'one', 10), P('2', 'two', 10)], b: [P('2', 'two b', 20), P('3', 'three', 5)] });
  assert.deepEqual(first.result.a.map((p) => p.id), ['1', '2', '3']);
  assert.equal(first.result.a.find((p) => p.id === '2').name, 'two b');
  assert.deepEqual(first.result.b.map((p) => p.id), ['2', '3', '1']);
  const base = { a: first.result.a, b: first.result.b };
  const next = merge3('keyed-array', base, { a: first.result.a.filter((p) => p.id !== '1'), b: first.result.b });
  assert.deepEqual(next.result.b.map((p) => p.id), ['2', '3']);
  // a side with no array yet receives the union
  const g = merge3('keyed-array', null, { a: [P('1', 'one', 1)], b: undefined });
  assert.deepEqual(g.result.b.map((p) => p.id), ['1']);
});

test('mergeKeyed/buildSide keep a side\'s own key order and ignore fields', () => {
  const cur = { a: [{ id: 'x', n: 1, filePath: 'A' }], b: [{ id: 'x', n: 2, filePath: 'B' }] };
  const base = { a: new Map([['x', { id: 'x', n: 1, filePath: 'A' }]]), b: new Map([['x', { id: 'x', n: 1, filePath: 'A' }]]) };
  const m = mergeKeyed({ cur, base, fieldwise: true, ignore: ['filePath'] });
  assert.equal(m.merged.get('x').n, 2);
  const a = buildSide(cur.a, m.merged, { ignore: ['filePath'] });
  assert.deepEqual(a, [{ id: 'x', n: 2, filePath: 'A' }]);
});
