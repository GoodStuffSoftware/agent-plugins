/**
 * T23 - the claude.ai lists (plan 5.17): connectors, published artifacts and plugins that the
 * current account lacks but another account on this machine has. Local records only.
 * The output stays narrow: a name and a redacted URL, an artifact URL and title, a plugin name.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { accountLists } from '../lib/accounts/lists.mjs';
import { collectStatus, formatStatus } from '../lib/accounts/report.mjs';
import { listFolders, answerPairs, pairKey } from '../lib/accounts/folders.mjs';
import { emptyState, saveState } from '../lib/accounts/state.mjs';
import { makeRoot, makeClock, addFolder, putRecord, uuid } from './fixtures/store.mjs';

const A = uuid('a', 1); const B = uuid('b', 1);
const OA = uuid('1', 1); const OB = uuid('2', 2);

function world() {
  const r = makeRoot('lists');
  const clock = makeClock();
  const fA = addFolder(r.store, A, OA);
  const fB = addFolder(r.store, B, OB);
  putRecord(fA.path, 1, {
    lastActivityAt: '2026-10-05T00:00:00.000Z',
    remoteMcpServersConfig: [
      { uuid: uuid('e', 7), name: 'Tracker', url: 'https://tracker.example.test/mcp/abcdefghijklmnopqrstuvwxyz123456?key=SECRETKEY#frag', tools: ['SECRETTOOL'], instructions: 'SECRET INSTRUCTIONS', headers: { authorization: 'Bearer SECRETHEADER' } },
      { uuid: uuid('e', 8), name: 'Docs', url: 'https://docs.example.test/mcp' },
    ],
    publishedArtifacts: [
      { url: 'https://claude.ai/public/artifacts/aaa?x=1', title: 'Plan', updatedAt: '2026-10-02T00:00:00.000Z', sourcePath: 'C:\\secret\\path\\plan.html' },
      { url: 'https://claude.ai/public/artifacts/bbb', title: 'Shared', updatedAt: '2026-09-01T00:00:00.000Z' },
      { url: 'https://evil.example.test/x', title: 'Not claude.ai', updatedAt: '2026-10-09T00:00:00.000Z' },
    ],
  }, clock.tick());
  putRecord(fA.path, 2, {
    lastActivityAt: '2026-10-08T00:00:00.000Z',
    remoteMcpServersConfig: [{ uuid: uuid('e', 9), name: 'Wiki', url: 'https://wiki.example.test/sse' }],
    publishedArtifacts: [
      { url: 'https://claude.ai/public/artifacts/aaa', title: 'Plan v2', updatedAt: '2026-10-05T00:00:00.000Z' },
      { url: 'https://claude.ai/public/artifacts/ccc', title: 'Third', updatedAt: '2026-10-09T00:00:00.000Z' },
      { url: 'https://claude.ai/public/artifacts/ddd', title: 'Undated' },
    ],
  }, clock.tick());
  putRecord(fB.path, 3, {
    lastActivityAt: '2026-10-06T00:00:00.000Z',
    remoteMcpServersConfig: [{ uuid: uuid('e', 8), name: 'Docs', url: 'https://docs.example.test/mcp/' }],     // same URL, trailing slash
    publishedArtifacts: [{ url: 'https://claude.ai/public/artifacts/bbb?z=2', title: 'Shared', updatedAt: '2026-09-01T00:00:00.000Z' }],
  }, clock.tick());
  for (const [acct, org, names] of [[A, OA, ['alpha', 'beta']], [B, OB, ['beta']]]) {
    const d = join(r.userData, 'plugin-list', acct, org);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'plugins.json'), JSON.stringify({ plugins: names.map((name) => ({ name, source: 'SECRETSOURCE' })) }));
  }
  const state = emptyState(r.store);
  answerPairs(state, [pairKey(A, B)], 'yes', 'cli', clock.t);
  saveState(r.ctx, state);
  return { r, ctx: r.ctx, folders: listFolders(r.store), state };
}

test('T23 lists: what the current account lacks, newest first, deduplicated, redacted', () => {
  const w = world();
  const out = accountLists(w.ctx, w.folders, w.state, { signedIn: B });
  assert.equal(out.current, B.slice(0, 8));
  assert.equal(out.views.length, 1);
  const v = out.views[0];
  assert.equal(v.account, B.slice(0, 8));
  assert.deepEqual(v.connectorsMissing.map((c) => c.name), ['Wiki', 'Tracker'], 'newest lastActivityAt first; Docs (same URL, trailing slash) is not missing');
  assert.equal(v.connectorsMissing[1].url, 'https://tracker.example.test/mcp/<redacted>', 'token-like path segment redacted; no query, no fragment');
  assert.deepEqual(v.artifactsFromOthers.map((a) => a.url), [
    'https://claude.ai/public/artifacts/ccc', 'https://claude.ai/public/artifacts/aaa', 'https://claude.ai/public/artifacts/ddd',
  ], 'newest first, undated last; the current account\'s own artifact and the non-claude.ai URL are dropped');
  assert.equal(v.artifactsFromOthers[1].title, 'Plan v2', 'the newest copy of a duplicate wins');
  assert.deepEqual(v.pluginsMissing, ['alpha']);
});

test('T23 lists: output never carries tools, instructions, headers, source paths, uuids or query strings', () => {
  const w = world();
  const all = JSON.stringify(accountLists(w.ctx, w.folders, w.state, { signedIn: null }));
  for (const secret of ['SECRETKEY', 'SECRETTOOL', 'SECRET INSTRUCTIONS', 'SECRETHEADER', 'SECRETSOURCE', 'sourcePath', 'C:\\\\secret', 'tools', 'instructions', 'headers', '?x=1', '#frag']) {
    assert.equal(all.includes(secret), false, `leaked ${secret}`);
  }
  assert.equal(all.includes(uuid('e', 7)), false, 'connector uuid');
  assert.equal(all.includes(A), false, 'full account uuid');
  assert.equal(all.includes(uuid('c', 1)), false, 'record id');
});

test('T23 lists: signed-in unknown gives every account its own view; an account missing nothing gets empty lists', () => {
  const w = world();
  const out = accountLists(w.ctx, w.folders, w.state, { signedIn: null });
  assert.equal(out.current, null);
  assert.equal(out.views.length, 2);
  const a = out.views.find((v) => v.account === A.slice(0, 8));
  assert.deepEqual(a.connectorsMissing, []);
  assert.deepEqual(a.artifactsFromOthers, [], 'B only holds what A also has');
  assert.deepEqual(a.pluginsMissing, []);
});

test('T23 lists: one account has nothing to compare', () => {
  const r = makeRoot('lists1');
  const f = addFolder(r.store, A, OA);
  putRecord(f.path, 1, {}, 1);
  const out = accountLists(r.ctx, listFolders(r.store), emptyState(r.store), { signedIn: A });
  assert.deepEqual(out.views, []);
});

test('T23 status text: counts and a short list, the secrets stay out, --all lifts the cap', () => {
  const w = world();
  const st = collectStatus(w.ctx, { probe: false });
  const text = formatStatus({ ...st, lists: accountLists(w.ctx, w.folders, w.state, { signedIn: B }) }).join('\n');
  assert.match(text, /Connectors missing: 2/);
  assert.match(text, /Tracker \(https:\/\/tracker\.example\.test\/mcp\/<redacted>\)/);
  assert.match(text, /Artifacts from other accounts: 3/);
  assert.match(text, /Plugins missing: alpha/);
  assert.doesNotMatch(text, /SECRET|sourcePath/);
  const lists = accountLists(w.ctx, w.folders, w.state, { signedIn: B });
  const many = { ...lists, views: [{ ...lists.views[0], artifactsFromOthers: Array.from({ length: 30 }, (_, i) => ({ url: `https://claude.ai/public/artifacts/n${i}`, title: `n${i}`, updatedAt: null })) }] };
  const capped = formatStatus({ ...st, lists: many }).join('\n');
  assert.match(capped, /newest 20/);
  assert.doesNotMatch(capped, /artifacts\/n25/);
  assert.match(formatStatus({ ...st, lists: many }, { all: true }).join('\n'), /artifacts\/n25/);
});
