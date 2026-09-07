/**
 * REGRESSION: the incremental diff's `session-sync` exclusion must be anchored
 * to the sync ROOT, not matched by bare directory name at any depth.
 *
 * WHAT WENT WRONG (reproduced on a real machine, not hypothesised):
 * scanTree() skipped any directory literally named `session-sync` at EVERY
 * depth. On a live ~/.claude that silently dropped 21 real files under
 *
 *   ~/.claude/plugins/marketplaces/goodstuff/plugins/session-sync/
 *
 * — the marketplace's own checkout of this plugin — from every future
 * incremental backup, with no warning logged anywhere. The plugin's own state
 * directory only ever lives at `<root>/session-sync`, so matching it anywhere
 * else is pure collateral damage: any user-created directory called
 * `session-sync` (a skill, an agent, a project folder) would be excluded from
 * all future backups, permanently and silently.
 *
 * These tests use the ACTUAL colliding path, and drive the ACTUAL exclusion
 * list production uses (`SCAN_EXCLUDES`, imported — never a hand-copied
 * duplicate, which is exactly how the previous test round missed this).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanTree, planIncremental } from '../lib/manifest.mjs';
import { push, SCAN_EXCLUDES } from '../lib/sync.mjs';
import { findRclone } from '../lib/rclone.mjs';

const haveRclone = !!findRclone();
const skipReason = haveRclone ? false : 'rclone is not installed on this machine';

// The real path, verbatim, that the unanchored match dropped from live backups.
const MARKETPLACE_DIR = 'plugins/marketplaces/goodstuff/plugins/session-sync';
const MARKETPLACE_FILE = `${MARKETPLACE_DIR}/lib/cli.mjs`;
const MARKETPLACE_MANIFEST = `${MARKETPLACE_DIR}/.claude-plugin/plugin.json`;
// A user's own directory that just happens to share the name.
const USER_DIR_FILE = 'projects/my-app/session-sync/notes.md';
// The plugin's own state dir — a DIRECT child of the root. Must stay excluded.
const STATE_FILE = 'session-sync/sync.log';

function fakeClaudeHome() {
  const root = mkdtempSync(join(tmpdir(), 'ss-excl-'));
  const write = (rel, body) => {
    const full = join(root, ...rel.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  };
  write('CLAUDE.md', 'rules');
  write(STATE_FILE, 'a log line\n');
  write('session-sync/manifest.json', '{}');
  write(MARKETPLACE_FILE, 'export const x = 1;\n');
  write(MARKETPLACE_MANIFEST, '{"name":"session-sync"}');
  write(USER_DIR_FILE, 'my notes\n');
  return { root, write };
}

function cleanup(root) { rmSync(root, { recursive: true, force: true }); }

test('scanTree keeps the marketplace checkout of this plugin — plugins/marketplaces/goodstuff/plugins/session-sync/** is REAL user data', () => {
  const { root } = fakeClaudeHome();
  try {
    const tree = scanTree(root, SCAN_EXCLUDES);
    assert.ok(tree[MARKETPLACE_FILE],
      `${MARKETPLACE_FILE} must be INCLUDED — it is the marketplace's own checkout, not this plugin's state dir. Dropping it silently removed 21 real files from every backup on a live machine.`);
    assert.ok(tree[MARKETPLACE_MANIFEST],
      `${MARKETPLACE_MANIFEST} must be INCLUDED for the same reason`);
    assert.ok(tree[USER_DIR_FILE],
      'a user directory that merely shares the name "session-sync" must never be excluded from their backup');
  } finally { cleanup(root); }
});

test('scanTree still excludes the plugin\'s OWN state dir at the root — the self-sustaining sync.log loop stays fixed', () => {
  const { root } = fakeClaudeHome();
  try {
    const tree = scanTree(root, SCAN_EXCLUDES);
    assert.equal(tree[STATE_FILE], undefined,
      '<root>/session-sync/sync.log is this plugin\'s own bookkeeping and must stay out of the diff');
    assert.equal(tree['session-sync/manifest.json'], undefined,
      '<root>/session-sync/manifest.json must stay out of the diff too');
    assert.ok(tree['CLAUDE.md'], 'sanity: ordinary root files are still scanned');
  } finally { cleanup(root); }
});

test('planIncremental carries the anchoring through — a change under the marketplace path is a change to be pushed', () => {
  const { root, write } = fakeClaudeHome();
  const manifestFile = join(root, '..', `ss-excl-manifest-${process.pid}.json`);
  try {
    const map = [{ local: root, remote: 'x:y', excludes: [], label: '~/.claude' }];
    // First plan: no baseline, so record one and commit it by hand.
    const first = planIncremental(map, manifestFile, 'x:y', SCAN_EXCLUDES);
    assert.equal(first.plan[0].full, true, 'sanity: no baseline yet means a full sync');
    writeFileSync(manifestFile, JSON.stringify({ 'x:y': first.nextForRemote }));

    write(MARKETPLACE_FILE, 'export const x = 2;   // edited\n');
    const second = planIncremental(map, manifestFile, 'x:y', SCAN_EXCLUDES);
    const files = second.plan[0].files;
    assert.ok(files.includes(MARKETPLACE_FILE),
      `an edit to ${MARKETPLACE_FILE} must show up as a file to push; the unanchored exclusion made it invisible forever`);
  } finally {
    cleanup(root);
    try { rmSync(manifestFile, { force: true }); } catch { /* best effort */ }
  }
});

test('end-to-end: a file under plugins/marketplaces/.../session-sync/ actually reaches the remote on an INCREMENTAL push', { skip: skipReason }, async () => {
  const { root, write } = fakeClaudeHome();
  const remoteDir = mkdtempSync(join(tmpdir(), 'ss-excl-remote-'));
  const manifestFile = join(remoteDir, '..', `ss-excl-e2e-${process.pid}.json`);
  try {
    const map = [{ local: root, remote: remoteDir, excludes: ['session-sync/**'], label: '~/.claude' }];
    const first = await push(remoteDir, { map, manifestFile, quiet: true });
    assert.ok(first.ok, 'the initial full push must succeed');

    // Now the incremental path — the one the unanchored exclusion broke.
    write(MARKETPLACE_FILE, 'export const x = 3;   // edited after the baseline\n');
    const second = await push(remoteDir, { map, manifestFile, quiet: true });
    assert.ok(second.ok, 'the incremental push must succeed');
    assert.notEqual(second.skipped, true,
      'an edit under the marketplace path must NOT read as "nothing to push" — that is the silent data loss');

    const landed = join(remoteDir, ...MARKETPLACE_FILE.split('/'));
    assert.ok(existsSync(landed), `${MARKETPLACE_FILE} must exist on the remote after the incremental push`);

    assert.equal(existsSync(join(remoteDir, 'session-sync')), false,
      'the plugin\'s own state dir must still never be copied');
  } finally {
    cleanup(root);
    cleanup(remoteDir);
    try { rmSync(manifestFile, { force: true }); } catch { /* best effort */ }
  }
});
