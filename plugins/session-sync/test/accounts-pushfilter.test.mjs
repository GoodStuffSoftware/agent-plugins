/**
 * The home-only push filter (plan 5.11) and the scan hook it rides on. Pure fs, no rclone.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { accountsPushFilter } from '../lib/sync.mjs';
import { scanTree } from '../lib/manifest.mjs';
import { emptyState } from '../lib/accounts/state.mjs';
import { pairKey, answerPairs } from '../lib/accounts/folders.mjs';
import { makeRoot, addFolder, putRecord, recordName, recordId, uuid } from './fixtures/store.mjs';

const A = uuid('a', 1); const B = uuid('b', 1); const C = uuid('c', 1);
const OA = uuid('1', 1); const OB = uuid('2', 2); const OC = uuid('3', 3);

function world() {
  const r = makeRoot('pfilter');
  const fA = addFolder(r.store, A, OA);
  const fB = addFolder(r.store, B, OB);
  const fC = addFolder(r.store, C, OC);              // a third account, not in the group
  putRecord(fA.path, 1, {}, 1000);
  linkSync(join(fA.path, recordName(1)), join(fB.path, recordName(1)));   // mirrored name
  putRecord(fB.path, 2, {}, 1000);
  putRecord(fC.path, 3, {}, 1000);
  const state = emptyState(r.store);
  answerPairs(state, [pairKey(A, B)], 'yes', 'cli', 1);
  state.linked = true;
  state.group = [fA.key, fB.key];
  state.records[recordId(1)] = { home: fA.key };
  return { r, fA, fB, fC, state };
}

test('push filter: null when not linked or when fewer than two folders are in the group', () => {
  const w = world();
  assert.equal(accountsPushFilter({ ctx: w.r.ctx, state: { ...w.state, linked: false } }), null);
  assert.equal(accountsPushFilter({ ctx: { ...w.r.ctx, store: null }, state: w.state }), null);
  const one = emptyState(w.r.store); one.linked = true;
  assert.equal(accountsPushFilter({ ctx: w.r.ctx, state: one }), null);
});

test('push filter: a record uploads only from its home; temp names never; other names and folders always', () => {
  const w = world();
  const f = accountsPushFilter({ ctx: w.r.ctx, state: w.state });
  assert.equal(typeof f, 'function');
  assert.equal(f(`${A}/${OA}/${recordName(1)}`), true, 'home');
  assert.equal(f(`${B}/${OB}/${recordName(1)}`), false, 'mirrored name');
  assert.equal(f(`${B}/${OB}/${recordName(2)}`), true, 'a record only in B has B as home');
  assert.equal(f(`${C}/${OC}/${recordName(3)}`), true, 'a folder outside the group is never filtered');
  assert.equal(f(`${A}/${OA}/.session-sync-link-0123456789ab`), false, 'our temp name');
  assert.equal(f(`${A}/${OA}/deleted_${uuid('c', 1)}`), true, 'tombstones keep uploading');
  assert.equal(f(`${A}/${OA}/scheduled-tasks.json`), true);
  assert.equal(f('some/other/path.txt'), true);
});

test('push filter: without a stored home the remote list decides, then the first folder; a vanished home falls to a holder', () => {
  const w = world();
  const st = { ...w.state, records: {} };
  const viaRemote = accountsPushFilter({ ctx: w.r.ctx, state: st, remoteList: { ids: { [recordId(1)]: [w.fB.key] } } });
  assert.equal(viaRemote(`${B}/${OB}/${recordName(1)}`), true, 'the remote has it under B only');
  assert.equal(viaRemote(`${A}/${OA}/${recordName(1)}`), false);
  const noRemote = accountsPushFilter({ ctx: w.r.ctx, state: st });
  assert.equal(noRemote(`${A}/${OA}/${recordName(1)}`), true, 'smallest folder key');
  const vanished = accountsPushFilter({ ctx: w.r.ctx, state: { ...w.state, records: { [recordId(2)]: { home: w.fA.key } } } });
  assert.equal(vanished(`${B}/${OB}/${recordName(2)}`), true, 'home name is gone: upload from the folder that has it, never nowhere');
});

test('push filter: scanTree skips filtered names so they never reach the manifest or the file list', () => {
  const w = world();
  writeFileSync(join(w.fA.path, 'scheduled-tasks.json'), '{}');
  const f = accountsPushFilter({ ctx: w.r.ctx, state: w.state });
  const all = scanTree(w.r.store);
  const filtered = scanTree(w.r.store, { fileFilter: f });
  const rels = Object.keys(filtered);
  assert.ok(Object.keys(all).includes(`${B}/${OB}/${recordName(1)}`), 'an unfiltered scan sees the mirrored name');
  assert.equal(rels.includes(`${B}/${OB}/${recordName(1)}`), false);
  assert.ok(rels.includes(`${A}/${OA}/${recordName(1)}`));
  assert.ok(rels.includes(`${A}/${OA}/scheduled-tasks.json`));
  assert.equal(rels.length, Object.keys(all).length - 1);
});
