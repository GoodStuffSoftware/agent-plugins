/**
 * T15 - Cowork memory: file-level 3-way merge. Copies, deletes to backup, and
 * nothing written outside a full pass. Synthetic files only.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, statSync, readdirSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { mergeCoworkMemory, memoryRoot } from '../lib/accounts/cowork-memory.mjs';
import { emptyState, readJson } from '../lib/accounts/state.mjs';
import { AppRunningError } from '../lib/accounts/appstate.mjs';
import { makeRoot, addFolder, setMtime, uuid, sha256 } from './fixtures/store.mjs';

afterEach(() => { delete process.env.SESSION_SYNC_TEST_FAIL_AFTER; });

const A = uuid('a', 1); const B = uuid('b', 1); const C = uuid('c', 1);
const OA = uuid('1', 1); const OB = uuid('2', 2); const OC = uuid('3', 3);

function world(n = 2) {
  const r = makeRoot('memory');
  const fs = [addFolder(r.store, A, OA), addFolder(r.store, B, OB), addFolder(r.store, C, OC)].slice(0, n);
  const state = emptyState(r.store);
  const put = (F, rel, text, ms) => {
    const p = join(memoryRoot(r.ctx, F), ...rel.split('/'));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
    if (ms !== undefined) setMtime(p, ms);
    return p;
  };
  const path = (F, rel) => join(memoryRoot(r.ctx, F), ...rel.split('/'));
  const read = (F, rel) => (existsSync(path(F, rel)) ? readFileSync(path(F, rel), 'utf8') : null);
  const merge = (extra = {}) => mergeCoworkMemory(fs, { mode: 'full', ctx: r.ctx, state, ...extra });
  const backups = () => {
    const idx = join(r.acc, 'rectify-backups', 'index.jsonl');
    return existsSync(idx) ? readFileSync(idx, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  return { r, fs, state, put, path, read, merge, backups, A: fs[0], B: fs[1], C: fs[2] };
}

const T0 = 1_800_000_000_000;

test('T15 first link: files are copied to the side that lacks them, with mtime, as regular files', () => {
  const w = world();
  w.put(w.A, 'notes/a.md', 'from A', T0);
  w.put(w.A, 'top.md', 'top A', T0 + 1000);
  w.put(w.B, 'b-only.md', 'from B', T0 + 2000);
  const rep = w.merge();
  assert.equal(rep.pending, true);
  assert.equal(w.read(w.B, 'notes/a.md'), 'from A');
  assert.equal(w.read(w.B, 'top.md'), 'top A');
  assert.equal(w.read(w.A, 'b-only.md'), 'from B');
  assert.equal(Math.round(statSync(w.path(w.B, 'notes/a.md')).mtimeMs), T0);
  assert.equal(lstatSync(w.path(w.B, 'notes/a.md')).nlink, 1);
  assert.equal(lstatSync(w.path(w.A, 'notes/a.md')).nlink, 1);
  const base = readJson(join(w.r.acc, 'memory-base.json'));
  assert.deepEqual(Object.keys(base.files).sort(), ['b-only.md', 'notes/a.md', 'top.md']);
  assert.deepEqual(base.folders, [w.A.key, w.B.key]);
  // nothing left behind, second pass is a no-op
  assert.deepEqual(readdirSync(dirname(w.path(w.B, 'top.md'))).filter((n) => n.startsWith('.session-sync-link-')), []);
  assert.equal(w.merge().pending, false);
});

test('T15 an edit on one side spreads; the displaced old version goes to backup', () => {
  const w = world();
  w.put(w.A, 'm.md', 'v1', T0); w.put(w.B, 'm.md', 'v1', T0);
  w.merge();
  w.put(w.B, 'm.md', 'v2 edited in B', T0 + 5000);
  const rep = w.merge();
  assert.deepEqual(rep.copied, [{ rel: 'm.md', folder: w.A.key }]);
  assert.equal(w.read(w.A, 'm.md'), 'v2 edited in B');
  assert.equal(w.backups().filter((e) => e.reason === 'memory-merge').length, 1);
  assert.equal(w.backups()[0].sha256, sha256(Buffer.from('v1')));
});

test('T15 conflict: the newest mtime wins and the loser is backed up; a tie goes to the smallest folder key', () => {
  const w = world();
  w.put(w.A, 'c.md', 'base', T0); w.put(w.B, 'c.md', 'base', T0);
  w.merge();
  w.put(w.A, 'c.md', 'A newer', T0 + 9000);
  w.put(w.B, 'c.md', 'B older', T0 + 3000);
  const rep = w.merge();
  assert.equal(rep.conflicts.length, 1);
  assert.equal(rep.conflicts[0].winner, w.A.key);
  assert.equal(w.read(w.B, 'c.md'), 'A newer');
  assert.ok(w.backups().some((e) => e.sha256 === sha256(Buffer.from('B older'))), 'the loser is in backup');
  // tie
  w.put(w.A, 'c.md', 'A tie', T0 + 20000);
  w.put(w.B, 'c.md', 'B tie', T0 + 20000);
  w.merge();
  assert.equal(w.read(w.A, 'c.md'), 'A tie');
  assert.equal(w.read(w.B, 'c.md'), 'A tie');
  assert.ok(w.backups().some((e) => e.sha256 === sha256(Buffer.from('B tie'))));
});

test('T15 delete: a removal spreads as a move to backup; an edit beats a delete; a reset spreads', () => {
  const w = world();
  w.put(w.A, 'del.md', 'keep me', T0); w.put(w.B, 'del.md', 'keep me', T0);
  w.put(w.A, 'edit.md', 'e1', T0); w.put(w.B, 'edit.md', 'e1', T0);
  w.put(w.A, 'reset/one.md', '1', T0); w.put(w.B, 'reset/one.md', '1', T0);
  w.put(w.A, 'reset/two.md', '2', T0); w.put(w.B, 'reset/two.md', '2', T0);
  w.merge();
  unlinkSync(w.path(w.A, 'del.md'));
  unlinkSync(w.path(w.A, 'edit.md'));
  w.put(w.B, 'edit.md', 'e2 edited', T0 + 4000);
  unlinkSync(w.path(w.A, 'reset/one.md')); unlinkSync(w.path(w.A, 'reset/two.md'));
  const rep = w.merge();
  assert.equal(w.read(w.B, 'del.md'), null, 'deleted on B');
  assert.ok(w.backups().some((e) => e.reason === 'memory-delete' && e.sha256 === sha256(Buffer.from('keep me'))), 'the deleted file is in backup');
  assert.equal(w.read(w.A, 'edit.md'), 'e2 edited', 'edit beats delete');
  assert.equal(w.read(w.B, 'edit.md'), 'e2 edited');
  assert.equal(w.read(w.B, 'reset/one.md'), null);
  assert.equal(w.read(w.B, 'reset/two.md'), null);
  assert.equal(rep.deleted.length, 3);
  const base = readJson(join(w.r.acc, 'memory-base.json'));
  assert.deepEqual(Object.keys(base.files), ['edit.md']);
  // the file is not resurrected by the next pass
  assert.equal(w.merge().pending, false);
  assert.equal(w.read(w.A, 'del.md'), null);
});

test('T15 a folder that joins later gets the files and its extra files spread; nothing is deleted', () => {
  const w = world(3);
  const two = [w.A, w.B];
  w.put(w.A, 'x.md', 'x', T0); w.put(w.B, 'x.md', 'x', T0);
  mergeCoworkMemory(two, { mode: 'full', ctx: w.r.ctx, state: w.state });
  w.put(w.C, 'c-own.md', 'c', T0 + 1000);
  const rep = w.merge();
  assert.equal(rep.deleted.length, 0);
  assert.equal(w.read(w.C, 'x.md'), 'x');
  assert.equal(w.read(w.A, 'c-own.md'), 'c');
  assert.equal(w.read(w.B, 'c-own.md'), 'c');
  assert.deepEqual(readJson(join(w.r.acc, 'memory-base.json')).folders, [w.A.key, w.B.key, w.C.key]);
});

test('T15 full pass only: a live or dry run reports what is owed and writes nothing', () => {
  const w = world();
  w.put(w.A, 'a.md', 'A', T0);
  const before = readdirSync(w.r.userData, { recursive: true }).length;
  const rep = w.merge({ mode: 'live' });
  assert.equal(rep.pending, true);
  assert.equal(w.read(w.B, 'a.md'), null);
  assert.equal(existsSync(join(w.r.acc, 'memory-base.json')), false);
  assert.equal(w.merge({ dry: true }).pending, true);
  assert.equal(readdirSync(w.r.userData, { recursive: true }).length, before);
  assert.equal(w.backups().length, 0);
});

test('T15 the S1 guard aborts a copy when the app starts; an injected failure leaves whole files', () => {
  const w = world();
  w.put(w.A, 'a.md', 'A', T0); w.put(w.B, 'b.md', 'B', T0);
  assert.throws(() => w.merge({ guard: () => { throw new AppRunningError('started'); } }), AppRunningError);
  assert.equal(w.read(w.B, 'a.md'), null);
  assert.deepEqual(readdirSync(memoryRoot(w.r.ctx, w.B)).filter((n) => n.startsWith('.session-sync-link-')), []);
  process.env.SESSION_SYNC_TEST_FAIL_AFTER = '0';
  assert.throws(() => w.merge(), /SESSION_SYNC_TEST_FAIL_AFTER/);
  assert.equal(w.read(w.A, 'a.md'), 'A');
  delete process.env.SESSION_SYNC_TEST_FAIL_AFTER;
  assert.equal(w.merge().pending, true);
  assert.equal(w.read(w.B, 'a.md'), 'A');
  assert.equal(w.read(w.A, 'b.md'), 'B');
});

test('T15 no memory dirs at all: nothing happens, no base file', () => {
  const w = world();
  const rep = w.merge();
  assert.equal(rep.pending, false);
  assert.equal(w.backups().length, 0);
});
