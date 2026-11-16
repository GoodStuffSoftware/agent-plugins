/**
 * T3 to T10 - the record engine, against the app simulator and synthetic
 * stores. Each test builds its own temp tree; nothing touches a real store.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync, existsSync, renameSync, statSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { rectify, inventory, classify } from '../lib/accounts/rectify.mjs';
import { emptyState } from '../lib/accounts/state.mjs';
import { liveFolders, makeS1Guard, AppRunningError } from '../lib/accounts/appstate.mjs';
import {
  makeRoot, makeClock, addFolder, putRecord, putTombstone, putSidecars, sidecarHashes, setMtime, inoOf, nlinkOf,
  readRecord, recordId, recordName, recordJson, uuid,
} from './fixtures/store.mjs';
import { createSim } from './fixtures/appsim.mjs';

afterEach(() => { delete process.env.SESSION_SYNC_TEST_APP_STATE; delete process.env.SESSION_SYNC_TEST_FAIL_AFTER; });

const ACCT = { a: uuid('a', 1), b: uuid('b', 1), c: uuid('c', 1) };
const ORG = uuid('1', 1);
const ORG2 = uuid('2', 2);

/** Three folders: A (acct a), B (acct b), C (acct c); every pair answered yes (not needed by the engine). */
function scenario(opts = {}) {
  const r = makeRoot('rect');
  const clock = makeClock();
  const sim = createSim({ clock, appFile: join(r.root, 'app.json') });
  const fA = addFolder(r.store, ACCT.a, ORG);
  const fB = addFolder(r.store, ACCT.b, ORG);
  const fC = addFolder(r.store, opts.cOrg2 ? ACCT.b : ACCT.c, opts.cOrg2 ? ORG2 : ORG);
  const group = [fA, fB, fC].sort((x, y) => (x.key < y.key ? -1 : 1));
  const state = emptyState(r.store);
  const full = (extra = {}) => rectify(group, { mode: 'full', ctx: r.ctx, state, ...extra });
  const live = (liveSet, extra = {}) => rectify(group, { mode: 'live', live: liveSet, ctx: r.ctx, state, ...extra });
  return { r, clock, sim, fA, fB, fC, group, state, full, live, ctx: r.ctx };
}

const names = (f) => readdirSync(f.path).filter((n) => /^local_.*\.json$/.test(n)).sort();
const backupIndex = (ctx) => {
  const f = join(ctx.acc, 'rectify-backups', 'index.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const paths = (s, n) => [s.fA, s.fB, s.fC].map((f) => join(f.path, recordName(n)));

/** Seed: records 1..n in folder A only (mtime from the clock), then a full pass links them everywhere. */
function seedLinked(s, n = 1) {
  for (let i = 1; i <= n; i++) putRecord(s.fA.path, i, {}, s.clock.tick());
  const rep = s.full();
  assert.equal(rep.aborted, false);
  return rep;
}

/* ------------------------------------------------------------------ T3 */

test('T3 link in both directions: A has 5, B has 2, plus an empty org -> 7 names everywhere, one inode, nlink 3', () => {
  const s = scenario({ cOrg2: true });            // folders: A, B/org1, B/org2 (empty)
  for (let i = 1; i <= 5; i++) putRecord(s.fA.path, i, {}, s.clock.tick());
  for (let i = 6; i <= 7; i++) putRecord(s.fB.path, i, {}, s.clock.tick());
  const rep = s.full();
  assert.equal(rep.aborted, false);
  assert.equal(rep.counts.ids, 7);
  assert.equal(rep.counts.add, 14);               // 5*2 + 2*2
  for (const f of s.group) assert.equal(names(f).length, 7, `${f.key} has 7 names`);
  for (let n = 1; n <= 7; n++) {
    const inos = new Set(s.group.map((f) => inoOf(join(f.path, recordName(n)))));
    assert.equal(inos.size, 1, `record ${n}: one inode`);
    assert.equal(nlinkOf(join(s.fA.path, recordName(n))), 3);
  }
  // state: home is where it was first seen, and every folder is listed
  assert.equal(s.state.records[recordId(1)].home, s.fA.key);
  assert.equal(s.state.records[recordId(6)].home, s.fB.key);
  assert.equal(s.state.records[recordId(1)].folders.length, 3);
  // idempotent
  const again = s.full();
  assert.equal(again.counts.add + again.counts.split, 0);
  assert.equal(again.counts.ok, 7);
});

test('T3 a record present in every folder as separate files is re-linked, the newest wins', () => {
  const s = scenario();
  const t0 = s.clock.tick();
  putRecord(s.fA.path, 1, { title: 'older A' }, t0);
  putRecord(s.fB.path, 1, { title: 'newest B' }, t0 + 5000);
  putRecord(s.fC.path, 1, { title: 'old C' }, t0 + 1000);
  s.full();
  for (const p of paths(s, 1)) assert.equal(readRecord(p).title, 'newest B');
  assert.equal(new Set(paths(s, 1).map(inoOf)).size, 1);
});

/* ------------------------------------------------------------------ T4 */

test('T4 a save from either account, then a full rectify: newest everywhere; backup only when the bytes differ', () => {
  const s = scenario();
  seedLinked(s, 2);
  const before = readFileSync(join(s.fA.path, recordName(1)), 'utf8');

  // account B continues conversation 1: the app's save makes a new inode in B only
  s.sim.save(s.fB, recordId(1), { title: 'continued in B' });
  assert.notEqual(inoOf(paths(s, 1)[1]), inoOf(paths(s, 1)[0]), 'the save broke the link');
  s.full();
  for (const p of paths(s, 1)) assert.equal(readRecord(p).title, 'continued in B');
  assert.equal(new Set(paths(s, 1).map(inoOf)).size, 1);
  const idx = backupIndex(s.ctx).filter((e) => e.name === recordName(1));
  assert.equal(idx.length, 1, 'the loser bytes were backed up once (A and C shared the inode)');
  const found = readdirSync(join(s.ctx.acc, 'rectify-backups')).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  assert.equal(found.length, 1);
  const bak = join(s.ctx.acc, 'rectify-backups', found[0], idx[0].folder, recordName(1));
  assert.equal(readFileSync(bak, 'utf8'), before, 'the backup holds the OLD bytes');

  // the other direction: save in A of conversation 2
  s.sim.save(s.fA, recordId(2), { title: 'continued in A' });
  s.full();
  for (const p of paths(s, 2)) assert.equal(readRecord(p).title, 'continued in A');

  // identical bytes in a new inode (the app re-saved without a change): re-linked, nothing backed up
  const n = backupIndex(s.ctx).length;
  const p2 = join(s.fC.path, recordName(2));
  const same = readFileSync(p2);
  writeFileSync(`${p2}.x`, same);
  renameSync(`${p2}.x`, p2);
  setMtime(p2, s.clock.tick());
  assert.notEqual(inoOf(p2), inoOf(join(s.fA.path, recordName(2))));
  s.full();
  assert.equal(new Set(paths(s, 2).map(inoOf)).size, 1);
  assert.equal(backupIndex(s.ctx).length, n, 'identical bytes are not backed up');
});

test('T4 a tie on mtime falls back to lastActivityAt, then the home folder', () => {
  const s = scenario();
  const t = s.clock.tick();
  putRecord(s.fA.path, 1, { title: 'A', lastActivityAt: '2026-10-02T00:00:00.000Z' }, t);
  putRecord(s.fB.path, 1, { title: 'B', lastActivityAt: '2026-10-03T00:00:00.000Z' }, t);
  s.full();
  for (const p of paths(s, 1)) assert.equal(readRecord(p).title, 'B', 'later lastActivityAt wins the tie');
  const s2 = scenario();
  const t2 = s2.clock.tick();
  putRecord(s2.fA.path, 1, { title: 'A' }, t2);
  putRecord(s2.fB.path, 1, { title: 'B' }, t2);
  s2.state.records[recordId(1)] = { home: s2.fB.key, folders: [] };
  s2.full();
  for (const p of paths(s2, 1)) assert.equal(readRecord(p).title, 'B', 'full tie: the home inode wins');
});

/* ------------------------------------------------------------------ T5 */

test('T5 live pass: a split with the loser in a live folder is deferred; the non-live loser is re-linked', () => {
  const s = scenario();
  seedLinked(s, 1);
  s.sim.save(s.fB, recordId(1), { title: 'newer in B' });          // B (not live) holds the newest copy
  const startedAtMs = s.clock.tick(5000);                          // the app starts AFTER that save
  s.sim.setApp({ running: true, signedIn: ACCT.a, startedAtMs });
  const liveSet = liveFolders({ running: true, signedIn: ACCT.a, startedAtMs }, s.group, s.state);
  assert.deepEqual([...liveSet], [s.fA.key]);

  const aBefore = { ino: inoOf(paths(s, 1)[0]), bytes: readFileSync(paths(s, 1)[0], 'utf8') };
  const rep = s.live(liveSet);

  assert.equal(inoOf(paths(s, 1)[0]), aBefore.ino, 'the live folder name is the same inode');
  assert.equal(readFileSync(paths(s, 1)[0], 'utf8'), aBefore.bytes, 'and the same bytes');
  assert.equal(readRecord(paths(s, 1)[2]).title, 'newer in B', 'the non-live loser was re-linked');
  assert.equal(inoOf(paths(s, 1)[2]), inoOf(paths(s, 1)[1]));
  assert.ok(rep.owed.some((o) => o.why === 'split-loser-live' && o.folder === s.fA.key), 'owed is set');
  assert.equal(rep.counts.deferred, 1);

  // the full pass after the app exits finishes the job
  s.sim.stopApp();
  s.full();
  for (const p of paths(s, 1)) assert.equal(readRecord(p).title, 'newer in B');
});

/* ------------------------------------------------------------------ T6 */

test('T6 a new record during an app run: ADD into non-live AND live folders; no existing live name changes', () => {
  const s = scenario();
  seedLinked(s, 1);
  const startedAtMs = s.clock.tick(5000);
  s.sim.setApp({ running: true, signedIn: ACCT.a, startedAtMs });
  s.state.live = { startedAtMs, folders: [s.fC.key] };            // C is live too (a parked session)
  const liveSet = liveFolders({ running: true, signedIn: ACCT.a, startedAtMs }, s.group, s.state);
  assert.deepEqual([...liveSet].sort(), [s.fA.key, s.fC.key].sort());

  const cBefore = { ino: inoOf(paths(s, 1)[2]), bytes: readFileSync(paths(s, 1)[2], 'utf8') };
  const live = (p) => [inoOf(p), readFileSync(p, 'utf8')];
  const aBefore = live(paths(s, 1)[0]);

  s.sim.save(s.fA, recordId(9), { title: 'new in A' });          // created by the app in the signed-in folder
  const rep = s.live(liveSet);

  assert.equal(rep.counts.add, 2);
  for (const f of [s.fB, s.fC]) assert.equal(readRecord(join(f.path, recordName(9))).title, 'new in A');
  assert.equal(nlinkOf(join(s.fA.path, recordName(9))), 3);
  assert.deepEqual([inoOf(paths(s, 1)[2]), readFileSync(paths(s, 1)[2], 'utf8')], [cBefore.ino, cBefore.bytes], 'live C: existing name untouched');
  assert.deepEqual(live(paths(s, 1)[0]), aBefore, 'live A: existing name untouched');
  assert.equal(rep.owed.length, 0);
  assert.equal(s.state.records[recordId(9)].home, s.fA.key);
});

test('T6 a live pass never deletes, never moves tombstones', () => {
  const s = scenario();
  seedLinked(s, 1);
  const startedAtMs = s.clock.tick(5000);
  s.sim.setApp({ running: true, signedIn: ACCT.a, startedAtMs });
  s.sim.del(s.fA, recordId(1));
  const rep = s.live(new Set([s.fA.key]));
  assert.ok(rep.owed.some((o) => o.why === 'delete'));
  for (const p of [paths(s, 1)[1], paths(s, 1)[2]]) assert.ok(existsSync(p), 'mirrors stay until a full pass');
  assert.equal(backupIndex(s.ctx).length, 0);
});

/* ------------------------------------------------------------------ T7 */

test('T7 delete propagation: backup, tombstones in every folder that held it, no comeback after a pull', () => {
  const s = scenario();
  seedLinked(s, 2);
  const id = recordId(1);
  const origBytes = readFileSync(paths(s, 1)[0], 'utf8');
  const origMtime = statSync(paths(s, 1)[0]).mtimeMs;
  const tomb = s.sim.del(s.fA, id);                               // the app deletes it in A: tombstone deleted_<uuid>
  s.clock.tick(5000);

  const rep = s.full();
  assert.equal(rep.counts.delete, 1);
  for (const f of s.group) {
    assert.ok(!existsSync(join(f.path, recordName(1))), `${f.key}: record gone`);
    assert.equal(readFileSync(join(f.path, `deleted_${uuid('c', 1)}`), 'utf8'), String(tomb), `${f.key}: tombstone copy`);
    assert.equal(nlinkOf(join(f.path, `deleted_${uuid('c', 1)}`)), 1, 'tombstones are copies, never links');
  }
  assert.ok(existsSync(paths(s, 2)[1]), 'the other record is untouched');
  assert.equal(s.state.records[id], undefined);
  const idx = backupIndex(s.ctx).filter((e) => e.name === recordName(1));
  assert.equal(idx.length, 1, 'one distinct inode, one backup');
  const day = readdirSync(join(s.ctx.acc, 'rectify-backups')).find((d) => /^\d{4}-/.test(d));
  assert.equal(readFileSync(join(s.ctx.acc, 'rectify-backups', day, idx[0].folder, recordName(1)), 'utf8'), origBytes);

  // next pass: it does not come back
  const again = s.full();
  assert.equal(again.counts.delete + again.counts.add, 0);
  for (const f of s.group) assert.ok(!existsSync(join(f.path, recordName(1))));

  // push and pull round trip: the pull restores the old remote copy under its home folder, old mtime
  s.sim.pull(s.fA, id, JSON.parse(origBytes), origMtime);
  assert.ok(existsSync(paths(s, 1)[0]));
  const after = s.full();
  assert.equal(after.counts.delete, 1, 'the pulled copy loses to the tombstone');
  for (const f of s.group) assert.ok(!existsSync(join(f.path, recordName(1))), `${f.key}: still gone after the round trip`);
  assert.equal(backupIndex(s.ctx).filter((e) => e.name === recordName(1)).length, 1, 'backup deduplicated by (name, sha256)');
});

test('T7 a delete in a folder that holds the only other mirror still propagates (3 folders)', () => {
  const s = scenario();
  seedLinked(s, 1);
  s.sim.del(s.fB, recordId(1));                                    // deleted from B, not from the home
  s.clock.tick(5000);
  s.full();
  for (const f of s.group) assert.ok(!existsSync(join(f.path, recordName(1))));
  assert.ok(existsSync(join(s.fA.path, `deleted_${uuid('c', 1)}`)), 'home folder got a tombstone copy');
});

/* ------------------------------------------------------------------ T8 */

test('T8 resurrection: a save after the tombstone (by more than 2 s) brings it back everywhere', () => {
  const s = scenario();
  seedLinked(s, 1);
  const id = recordId(1);
  s.sim.del(s.fA, id);                                             // tombstone in A
  s.clock.tick(5000);
  s.sim.save(s.fB, id, { title: 'edited after the delete' });      // B (a mirror) saved later
  const rep = s.full();
  assert.equal(rep.counts.resurrect, 1);
  for (const p of paths(s, 1)) assert.equal(readRecord(p).title, 'edited after the delete');
  assert.equal(new Set(paths(s, 1).map(inoOf)).size, 1);
  assert.ok(!existsSync(join(s.fA.path, `deleted_${uuid('c', 1)}`)), 'tombstone moved away');
  const moved = backupIndex(s.ctx).filter((e) => e.name === `deleted_${uuid('c', 1)}`);
  assert.equal(moved.length, 1);
  assert.equal(moved[0].reason, 'tombstone-resurrect');
});

test('T8 a save within 2 s of the tombstone does not count as a resurrection', () => {
  const s = scenario();
  seedLinked(s, 1);
  s.sim.del(s.fA, recordId(1));
  s.clock.tick(500);
  s.sim.save(s.fB, recordId(1), { title: 'raced the delete' });
  s.full();
  for (const f of s.group) assert.ok(!existsSync(join(f.path, recordName(1))));
});

test('T8 resurrection is deferred in a live pass', () => {
  const s = scenario();
  seedLinked(s, 1);
  s.sim.del(s.fA, recordId(1));
  s.clock.tick(5000);
  s.sim.save(s.fB, recordId(1), { title: 'edited' });
  const rep = s.live(new Set([s.fA.key]));
  assert.ok(rep.owed.some((o) => o.why === 'resurrect'));
  assert.ok(existsSync(join(s.fA.path, `deleted_${uuid('c', 1)}`)), 'tombstone untouched in a live pass');
  assert.ok(!existsSync(join(s.fA.path, recordName(1))));
});

/* ------------------------------------------------------------------ T9 */

test('T9 a tombstone matching a cliSessionId on a different record in another folder leaves the other record alone', () => {
  const s = scenario();
  const shared = uuid('9', 9);
  putRecord(s.fA.path, 1, { cliSessionId: shared }, s.clock.tick());     // record X, cli = shared
  putRecord(s.fA.path, 2, {}, s.clock.tick());                           // control
  putTombstone(s.fB.path, shared, s.clock.tick());                       // B deleted ANOTHER record whose key was `shared`
  const rep = s.full();
  assert.ok(existsSync(join(s.fA.path, recordName(1))), 'X untouched in A');
  assert.ok(!existsSync(join(s.fB.path, recordName(1))), 'X is not added where the tombstone says deleted');
  assert.equal(rep.counts.tombstonedHere, 1);
  assert.ok(existsSync(join(s.fC.path, recordName(1))), 'but other folders still get X');
  assert.ok(existsSync(join(s.fB.path, recordName(2))), 'the control record is added to B');
  assert.equal(readFileSync(join(s.fB.path, `deleted_${shared}`), 'utf8').length, 13);
  assert.equal(backupIndex(s.ctx).length, 0, 'nothing displaced');
  const again = s.full();
  assert.equal(again.counts.delete, 0);
  assert.ok(existsSync(join(s.fA.path, recordName(1))));
});

test('T9 the same tombstone DOES delete when this very record was seen in that folder (the guard is "absent where seen")', () => {
  const s = scenario();
  const shared = uuid('9', 9);
  putRecord(s.fA.path, 1, { cliSessionId: shared }, s.clock.tick());
  s.full();                                                              // linked everywhere
  s.sim.del(s.fB, recordId(1), shared);                                  // the app deletes it in B, tombstone keyed by cliSessionId
  s.clock.tick(5000);
  s.full();
  for (const f of s.group) assert.ok(!existsSync(join(f.path, recordName(1))));
});

test('N2 a copy next to its own cliSessionId-keyed tombstone in a folder where it was seen is deleted again; a stranger folder is not', () => {
  const s = scenario();
  const cli = uuid('9', 8);
  putRecord(s.fA.path, 1, { cliSessionId: cli }, s.clock.tick());
  s.full();                                                              // linked everywhere, home A
  // the app deleted it in A (rm record, write tombstone keyed by cliSessionId); a live ADD put the record back in the gap
  putTombstone(s.fA.path, cli, s.clock.tick(5000));
  const rep = s.full();
  assert.equal(rep.counts.delete, 1);
  for (const f of s.group) assert.ok(!existsSync(join(f.path, recordName(1))), `${f.key} no longer holds it`);
  // a tombstone with that key in a folder where this record was never seen does not delete it (T9 guard)
  const t = scenario();
  putRecord(t.fA.path, 2, { cliSessionId: uuid('9', 7) }, t.clock.tick());
  t.full();
  const stranger = addFolder(t.r.store, uuid('d', 1), ORG);
  putTombstone(stranger.path, uuid('9', 7), t.clock.tick(5000));
  putRecord(stranger.path, 3, {}, t.clock.tick());
  const group = [...t.group, stranger];
  rectify(group, { mode: 'full', ctx: t.ctx, state: t.state });
  assert.ok(existsSync(join(t.fA.path, recordName(2))), 'record 2 stays in A');
});

/* ------------------------------------------------------------------ T10 */

test('T10 sidecars are byte-identical before and after every pass', () => {
  const s = scenario();
  for (const f of s.group) putSidecars(f);
  putRecord(s.fA.path, 2, {}, s.clock.tick());
  writeFileSync(join(s.fA.path, `${recordName(2)}.tmp`), '{"saving":true}');    // a save in flight: the id is skipped
  for (let i = 3; i <= 5; i++) putRecord(s.fA.path, i, {}, s.clock.tick());
  putTombstone(s.fC.path, uuid('7', 7), 1_700_000_000_000);                     // an old orphan tombstone
  const base = sidecarHashes(s.r.store);
  assert.ok(Object.keys(base).length >= 6 * 3, 'the fixture has sidecars everywhere');
  const same = (label) => assert.deepEqual(sidecarHashes(s.r.store), base, `sidecars changed after: ${label}`);

  let rep = s.full(); same('first full pass');
  assert.ok(rep.notes.some((n) => /saving/.test(n.msg)), 'the in-flight save was reported, not touched');
  assert.ok(!existsSync(join(s.fB.path, recordName(2))), 'a record with a .tmp sibling is skipped');
  for (let n = 3; n <= 5; n++) assert.ok(existsSync(join(s.fB.path, recordName(n))));

  s.sim.save(s.fB, recordId(3), { title: 'b' }); s.sim.save(s.fC, recordId(4), { title: 'c' });
  const startedAtMs = s.clock.tick(5000);
  s.sim.setApp({ running: true, signedIn: ACCT.a, startedAtMs });
  s.live(new Set([s.fA.key])); same('live pass');
  s.sim.stopApp();
  s.full(); same('second full pass');
  s.sim.del(s.fC, recordId(5)); s.clock.tick(5000);
  s.full(); same('after a delete');
  s.sim.save(s.fA, recordId(5), { title: 'back' });                              // resurrect
  s.full(); same('after a resurrection');
  assert.ok(Object.values(sidecarHashes(s.r.store)).length === Object.values(base).length, 'no sidecar appeared or vanished');
});

/* ------------------------------------------------------------------ extras on the engine's own rules */

test('app returning mid-pass aborts the full pass and owes it', () => {
  const s = scenario();
  for (let i = 1; i <= 3; i++) putRecord(s.fA.path, i, {}, s.clock.tick());
  s.sim.setApp({ running: false });
  let calls = 0;
  const guard = (op, F) => { if (++calls === 2) { s.sim.setApp({ running: true }); } makeS1Guard(s.ctx)(op, F); };
  const rep = s.full({ guard });
  assert.equal(rep.aborted, true);
  assert.equal(s.state.fullPassOwed, true);
  assert.ok(rep.counts.add < 6);
});

test('a full pass is idempotent and resumable after an injected failure', () => {
  const s = scenario();
  for (let i = 1; i <= 4; i++) putRecord(s.fA.path, i, {}, s.clock.tick());
  process.env.SESSION_SYNC_TEST_FAIL_AFTER = '3';
  assert.throws(() => s.full(), /FAIL_AFTER/);
  delete process.env.SESSION_SYNC_TEST_FAIL_AFTER;
  const total = s.group.reduce((n, f) => n + names(f).length, 0);
  assert.ok(total > 4 && total < 12, 'part of the work was done');
  s.full();
  for (const f of s.group) assert.equal(names(f).length, 4);
  for (let n = 1; n <= 4; n++) assert.equal(new Set(paths(s, n).map(inoOf)).size, 1);
});

test('extra links outside the group, unparseable and oversized records are reported, not fatal', () => {
  const s = scenario();
  putRecord(s.fA.path, 1, {}, s.clock.tick());
  writeFileSync(join(s.fA.path, recordName(2)), '{ not json');
  setMtime(join(s.fA.path, recordName(2)), s.clock.tick());
  putRecord(s.fA.path, 3, { pad: 'x'.repeat(10 * 1024 * 1024 + 10) }, s.clock.tick());
  const rep = s.full();
  assert.equal(rep.counts.unparseable, 1);
  assert.equal(rep.counts.oversize, 1);
  assert.ok(existsSync(join(s.fB.path, recordName(3))), 'an oversized record is linked as normal');
  assert.ok(existsSync(join(s.fC.path, recordName(2))), 'an unparseable record is still linked by inode');
  assert.equal(nlinkOf(join(s.fA.path, recordName(2))), 3);
  // an outside link to record 1 shows as "extra links"
  const outside = join(s.r.root, 'conflicts-copy.json');
  linkSync(join(s.fA.path, recordName(1)), outside);
  const rep2 = s.full();
  assert.equal(rep2.counts.extraLinks, 1);
});


test('classify is pure: no mode, no writes', () => {
  const s = scenario();
  seedLinked(s, 2);
  s.sim.save(s.fB, recordId(1), { title: 'x' });
  const before = [...s.group].map((f) => readdirSync(f.path).join(','));
  const plans = classify(inventory(s.group), s.state, { groupKeys: s.group.map((f) => f.key) });
  assert.equal(plans.length, 2);
  const p1 = plans.find((p) => p.id === recordId(1));
  assert.equal(p1.losers.length, 2);
  assert.equal(p1.W.folder, s.fB.key);
  assert.deepEqual([...s.group].map((f) => readdirSync(f.path).join(',')), before);
  assert.ok(recordJson(1).sessionId);
});
