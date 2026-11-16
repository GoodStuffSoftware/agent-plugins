/**
 * T1 - folders and group: junctions and non-UUID dirs are skipped; pairs; the
 * "yes" answers are transitive; the group has exactly the expected folders.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  listFolders, accountsOf, groupOf, groupAccounts, pendingPairs, answerPairs, pairKey, homeOf,
} from '../lib/accounts/folders.mjs';
import { emptyState } from '../lib/accounts/state.mjs';
import { makeRoot, uuid } from './fixtures/store.mjs';

const A = uuid('a', 1); const B = uuid('b', 1); const C = uuid('c', 1);
const O1 = uuid('1', 1); const O2 = uuid('2', 2);

function build() {
  const r = makeRoot('folders');
  for (const [a, o] of [[A, O1], [A, O2], [B, O1], [C, O1]]) mkdirSync(join(r.store, a, o), { recursive: true });
  return r;
}

test('T1 listFolders: only real UUID/UUID directories, sorted', () => {
  const r = build();
  mkdirSync(join(r.store, 'not-a-uuid', O1), { recursive: true });          // account name is not a uuid
  mkdirSync(join(r.store, A, 'backlog-not-org'), { recursive: true });      // org name is not a uuid
  writeFileSync(join(r.store, uuid('d', 4)), 'a file named like an account'); // a file, not a directory
  writeFileSync(join(r.store, A, uuid('d', 5)), 'a file named like an org');
  const got = listFolders(r.store).map((f) => f.key);
  assert.deepEqual(got, [`${A}/${O1}`, `${A}/${O2}`, `${B}/${O1}`, `${C}/${O1}`]);
  assert.deepEqual(accountsOf(listFolders(r.store)), [A, B, C]);
});

test('T1 listFolders: a junction at an org or account level is skipped', (t) => {
  const r = build();
  const target = join(r.root, 'elsewhere');
  mkdirSync(target, { recursive: true });
  try {
    symlinkSync(target, join(r.store, A, uuid('f', 6)), 'junction');
    symlinkSync(target, join(r.store, uuid('f', 7)), 'junction');
  } catch (e) { t.skip(`cannot create a junction/symlink here: ${e.code}`); return; }
  const got = listFolders(r.store).map((f) => f.key);
  assert.deepEqual(got, [`${A}/${O1}`, `${A}/${O2}`, `${B}/${O1}`, `${C}/${O1}`]);
});

test('T1 pendingPairs lists every unordered pair without an answer', () => {
  const s = emptyState();
  assert.deepEqual(pendingPairs(s, [C, A, B]), [pairKey(A, B), pairKey(A, C), pairKey(B, C)]);
  answerPairs(s, [pairKey(A, B)], 'no', 'cli');
  assert.deepEqual(pendingPairs(s, [A, B, C]), [pairKey(A, C), pairKey(B, C)]);
});

test('T1 no answers: no group; a lone "no" joins nothing', () => {
  const folders = listFolders(build().store);
  const s = emptyState();
  assert.deepEqual(groupOf(s, folders), []);
  answerPairs(s, pendingPairs(s, accountsOf(folders)), 'no', 'cli');
  assert.deepEqual(groupOf(s, folders), []);
});

test('T1 group: a yes pair joins every org of both accounts and nobody else', () => {
  const folders = listFolders(build().store);
  const s = emptyState();
  answerPairs(s, [pairKey(A, B)], 'yes', 'cli');
  answerPairs(s, [pairKey(A, C), pairKey(B, C)], 'no', 'cli');
  assert.deepEqual(groupAccounts(s, folders), [A, B]);
  assert.deepEqual(groupOf(s, folders).map((f) => f.key), [`${A}/${O1}`, `${A}/${O2}`, `${B}/${O1}`]);
});

test('T1 group is transitive over yes edges (A-B and B-C pull in A-C)', () => {
  const folders = listFolders(build().store);
  const s = emptyState();
  answerPairs(s, [pairKey(A, B), pairKey(B, C)], 'yes', 'cli');
  assert.deepEqual(groupAccounts(s, folders), [A, B, C]);
  assert.equal(groupOf(s, folders).length, 4);
  // answering all pending pairs at once keeps it that way
  const s2 = emptyState();
  answerPairs(s2, pendingPairs(s2, [A, B, C]), 'yes', 'hook');
  assert.equal(groupOf(s2, folders).length, 4);
  assert.deepEqual(pendingPairs(s2, [A, B, C]), []);
});

test('T1 homeOf: stored home, single copy, remote list, then the smallest key', () => {
  const id = `local_${uuid('c', 1)}`;
  const keys = [`${A}/${O1}`, `${B}/${O1}`, `${C}/${O1}`];
  const s = emptyState();
  assert.equal(homeOf(id, [keys[1]], s, null, keys), keys[1]);                              // only copy
  assert.equal(homeOf(id, [keys[2], keys[1]], s, null, keys), keys[1]);                     // smallest key
  assert.equal(homeOf(id, [keys[1], keys[2]], s, { ids: { [id]: [keys[2]] } }, keys), keys[2]); // the remote says so
  assert.equal(homeOf(id, [keys[1], keys[2]], s, { ids: { [id]: [keys[0], keys[2]] } }, keys), keys[1]); // ambiguous remote: ignore
  s.records[id] = { home: keys[2] };
  assert.equal(homeOf(id, [keys[1], keys[2]], s, null, keys), keys[2]);                     // stored home sticks
  assert.equal(homeOf(id, [keys[0], keys[1]], s, null, [keys[0], keys[1]]), keys[0]);       // stored home left the group
});
