/**
 * Tests for incremental planning.
 *
 * The risk here is not a crash — it is a sync that quietly sends LESS than it
 * should and reports success. Every test below is about that: a changed file
 * must never be treated as unchanged.
 *
 * Run: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanTree, diffTrees, loadManifest, saveManifest, commitManifest } from '../lib/manifest.mjs';

function fixture() {
  const d = mkdtempSync(join(tmpdir(), 'ss-test-'));
  mkdirSync(join(d, 'projects', 'proj-a'), { recursive: true });
  mkdirSync(join(d, 'cache'), { recursive: true });
  writeFileSync(join(d, 'CLAUDE.md'), 'rules');
  writeFileSync(join(d, 'projects', 'proj-a', 'chat.jsonl'), 'line1\n');
  writeFileSync(join(d, 'cache', 'junk.bin'), 'x'.repeat(100));
  writeFileSync(join(d, '.credentials.json'), 'SECRET');
  return d;
}

test('scan finds real files and honours directory excludes', () => {
  const d = fixture();
  const tree = scanTree(d, { excludeDirs: ['cache'], excludeFiles: ['.credentials.json'] });
  const paths = Object.keys(tree).sort();
  assert.deepEqual(paths, ['CLAUDE.md', 'projects/proj-a/chat.jsonl']);
  rmSync(d, { recursive: true, force: true });
});

test('excluded credentials never enter the manifest', () => {
  const d = fixture();
  const tree = scanTree(d, { excludeDirs: ['cache'], excludeFiles: ['.credentials.json'] });
  assert.ok(!Object.keys(tree).some((p) => p.includes('credentials')),
    'a credential file must never be listed for sync');
  rmSync(d, { recursive: true, force: true });
});

test('paths are posix-style so they work as rclone --files-from entries', () => {
  const d = fixture();
  const tree = scanTree(d, { excludeDirs: ['cache'] });
  for (const p of Object.keys(tree)) {
    assert.ok(!p.includes('\\'), `path must not contain a backslash: ${p}`);
  }
  rmSync(d, { recursive: true, force: true });
});

test('an appended file is detected as changed', () => {
  const d = fixture();
  const before = scanTree(d, { excludeDirs: ['cache'] });
  writeFileSync(join(d, 'projects', 'proj-a', 'chat.jsonl'), 'line1\nline2\n');   // grows
  const after = scanTree(d, { excludeDirs: ['cache'] });
  const { changed } = diffTrees(before, after);
  assert.deepEqual(changed, ['projects/proj-a/chat.jsonl']);
  rmSync(d, { recursive: true, force: true });
});

test('a same-size edit is still detected via mtime', () => {
  const d = fixture();
  const before = scanTree(d, { excludeDirs: ['cache'] });
  const f = join(d, 'CLAUDE.md');
  writeFileSync(f, 'ruleZ');                       // same length, different content
  const t = new Date(Date.now() + 5000);
  utimesSync(f, t, t);                             // ensure mtime moves
  const after = scanTree(d, { excludeDirs: ['cache'] });
  assert.deepEqual(diffTrees(before, after).changed, ['CLAUDE.md']);
  rmSync(d, { recursive: true, force: true });
});

test('a new file is added, not silently skipped', () => {
  const d = fixture();
  const before = scanTree(d, { excludeDirs: ['cache'] });
  writeFileSync(join(d, 'projects', 'proj-a', 'second.jsonl'), 'new');
  const { added } = diffTrees(before, scanTree(d, { excludeDirs: ['cache'] }));
  assert.deepEqual(added, ['projects/proj-a/second.jsonl']);
  rmSync(d, { recursive: true, force: true });
});

test('an unchanged tree yields nothing to send', () => {
  const d = fixture();
  const a = scanTree(d, { excludeDirs: ['cache'] });
  const b = scanTree(d, { excludeDirs: ['cache'] });
  const { added, changed } = diffTrees(a, b);
  assert.equal(added.length + changed.length, 0, 'an idle sync must transfer nothing');
  rmSync(d, { recursive: true, force: true });
});

test('deletions are reported but never turned into remote deletes', () => {
  const d = fixture();
  const before = scanTree(d, { excludeDirs: ['cache'] });
  rmSync(join(d, 'CLAUDE.md'));
  const { removed, added, changed } = diffTrees(before, scanTree(d, { excludeDirs: ['cache'] }));
  assert.deepEqual(removed, ['CLAUDE.md']);
  assert.equal(added.length + changed.length, 0,
    'a deletion must not appear in the send list — push only ever copies');
  rmSync(d, { recursive: true, force: true });
});

test('the manifest is keyed per remote, so switching remotes forces a full sync', () => {
  const d = mkdtempSync(join(tmpdir(), 'ss-man-'));
  const file = join(d, 'manifest.json');
  commitManifest(file, 'gdrive:a', { '~/.claude': { 'x.md': '1:2' } });
  const all = loadManifest(file);
  assert.ok(all['gdrive:a'], 'baseline stored under its own remote');
  assert.equal(all['s3:other'], undefined, 'a different remote has no baseline -> full sync');
  rmSync(d, { recursive: true, force: true });
});

test('a corrupt manifest degrades to a full sync instead of throwing', () => {
  const d = mkdtempSync(join(tmpdir(), 'ss-bad-'));
  const file = join(d, 'manifest.json');
  writeFileSync(file, '{ not json at all');
  assert.deepEqual(loadManifest(file), {}, 'unreadable baseline must mean "sync everything"');
  rmSync(d, { recursive: true, force: true });
});
