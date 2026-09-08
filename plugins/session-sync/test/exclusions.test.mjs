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
import { findRclone, runRclone } from '../lib/rclone.mjs';
import { resolveAll } from '../lib/paths.mjs';

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

// Real shapes for the CACHE family, read off a live ~/.claude on 2026-09-08.
// `plugins/cache` is the big one: 892 files / 9.1 MB of downloaded plugin
// payloads, re-fetched on demand from `plugins/marketplaces/**` (which IS
// synced). Nothing under it is authored by the user.
const ROOT_CACHE_FILE = 'cache/changelog.md';
const NESTED_CACHE_FILE = 'plugins/cache/goodstuff/session-sync/0.2.1/lib/sync.mjs';
const NESTED_CACHE_FILE2 = 'plugins/cache/deckhand/deckhand/2.1.28/.claude-plugin/plugin.json';
const ROOT_SNAPSHOT_FILE = 'shell-snapshots/snapshot-bash-1781782922594-d7mokb.sh';
const ROOT_STATSIG_FILE = 'statsig/statsig.cached.evaluations.2891273';
// No `statsig` / `shell-snapshots` / `node_modules` directory exists at depth on
// a live machine today. These pin the two mechanisms TOGETHER at depth anyway so
// they cannot silently drift apart the way `session-sync` did. The shape is a
// plugin checkout under plugins/marketplaces/**, the one place a nested
// directory of any of those names could plausibly turn up.
const PLUGIN_CHECKOUT = 'plugins/marketplaces/goodstuff/plugins/session-sync';
const NESTED_STATSIG_FILE = PLUGIN_CHECKOUT + '/statsig/cached.json';
const NESTED_SNAPSHOT_FILE = PLUGIN_CHECKOUT + '/shell-snapshots/snapshot-bash-1.sh';
const NESTED_MODULES_FILE = PLUGIN_CHECKOUT + '/node_modules/left-pad/index.js';
// A machine-bound secret. Excluded at EVERY depth by both mechanisms.
const ROOT_CREDENTIALS = '.credentials.json';

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
  write(ROOT_CACHE_FILE, '# changelog');
  write(NESTED_CACHE_FILE, 'export const cached = 1;');
  write(NESTED_CACHE_FILE2, '{"name":"deckhand"}');
  write(ROOT_SNAPSHOT_FILE, 'export PATH=/usr/bin');
  write(ROOT_STATSIG_FILE, '{}');
  write(NESTED_STATSIG_FILE, '{}');
  write(NESTED_SNAPSHOT_FILE, 'export PATH=/usr/bin');
  write(NESTED_MODULES_FILE, 'module.exports = 1;');
  write(ROOT_CREDENTIALS, '{"token":"never-leaves-this-machine"}');
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
    const map = [{ local: root, remote: remoteDir, excludes: resolveAll().excludes, label: '~/.claude' }];
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

/* ---------------------------------------------------------------------------
 * REGRESSION (v0.2.2): the two exclusion mechanisms must agree.
 *
 * There are two of them and they are written in different languages:
 *
 *   1. SCAN_EXCLUDES  -> scanTree(), which builds the INCREMENTAL file list.
 *                        Bare directory names, matched at any depth
 *                        (`excludeDirs`) or only at the sync root
 *                        (`excludeRootDirs`).
 *   2. resolveAll().excludes -> rclone `--exclude` globs, used on FULL pushes
 *                        and on EVERY pull.
 *
 * A note left in sync.mjs claimed `cache`/`statsig`/`shell-snapshots` disagreed
 * because the rclone globs were "anchored". Measured against rclone v1.74.0,
 * that was backwards: a pattern WITHOUT a leading `/` matches a complete path
 * element at ANY depth, so those three already agreed. The name that actually
 * disagreed was `session-sync` — v0.2.1 anchored the scan half of the 21-file
 * data-loss bug and left `session-sync/**` (any-depth) on the rclone half, so
 * full pushes and every pull still dropped the marketplace checkout. Same for
 * `node_modules`, which the scan dropped at any depth and rclone did not drop
 * at all.
 *
 * These tests run the ACTUAL rclone binary against the ACTUAL production
 * exclude list, so the parity is measured rather than taken from the docs.
 * ------------------------------------------------------------------------- */

const PROD_EXCLUDES = resolveAll().excludes;

/** What rclone would actually transfer out of `root`, as relative POSIX paths. */
async function rcloneSurvivors(root, excludes) {
  const args = ['lsf', '-R', '--files-only', root];
  for (const e of excludes) args.push('--exclude', e);
  const { code, stdout, stderr } = await runRclone(args);
  assert.equal(code, 0, `rclone lsf failed (${code}): ${stderr}`);
  return new Set(stdout.split('\n').map((l) => l.trim()).filter(Boolean));
}

test('scanTree drops the regenerable cache family at ANY depth — ~/.claude/plugins/cache is 892 files of re-fetchable payload, not user data', () => {
  const { root } = fakeClaudeHome();
  try {
    const tree = scanTree(root, SCAN_EXCLUDES);
    for (const rel of [ROOT_CACHE_FILE, NESTED_CACHE_FILE, NESTED_CACHE_FILE2,
                       ROOT_SNAPSHOT_FILE, ROOT_STATSIG_FILE,
                       NESTED_STATSIG_FILE, NESTED_SNAPSHOT_FILE, NESTED_MODULES_FILE]) {
      assert.equal(tree[rel], undefined,
        `${rel} is a regenerable cache and must stay out of the incremental diff at every depth`);
    }
    assert.equal(tree[ROOT_CREDENTIALS], undefined,
      '.credentials.json is machine-bound and must never enter the diff');
    assert.ok(tree[MARKETPLACE_FILE],
      'sanity: the marketplace checkout is still real user data and still scanned');
  } finally { cleanup(root); }
});

test('PARITY: rclone and scanTree select the SAME files out of a real ~/.claude shape', { skip: skipReason }, async () => {
  const { root } = fakeClaudeHome();
  try {
    const scanned = new Set(Object.keys(scanTree(root, SCAN_EXCLUDES)));
    const survivors = await rcloneSurvivors(root, PROD_EXCLUDES);

    const rcloneOnly = [...survivors].filter((p) => !scanned.has(p)).sort();
    const scanOnly = [...scanned].filter((p) => !survivors.has(p)).sort();

    assert.deepEqual(rcloneOnly, [],
      `these files reach the remote on a FULL push but are invisible to every incremental push — uploaded once, then never updated again: ${rcloneOnly.join(', ')}`);
    assert.deepEqual(scanOnly, [],
      `these files count as changes to push but the rclone filter drops them on a full push and on every pull — exactly the shape of the 21-file session-sync bug: ${scanOnly.join(', ')}`);
    assert.ok(scanned.size > 0, 'sanity: the fixture is not empty');
  } finally { cleanup(root); }
});

test('PARITY: rclone keeps the marketplace checkout and still drops the plugin state dir — the half of the v0.2.1 fix that was missing', { skip: skipReason }, async () => {
  const { root } = fakeClaudeHome();
  try {
    const survivors = await rcloneSurvivors(root, PROD_EXCLUDES);

    assert.ok(survivors.has(MARKETPLACE_FILE),
      `${MARKETPLACE_FILE} must survive the rclone filter. Under the unanchored 'session-sync/**' it did not, so all 21 marketplace files were still dropped by every full push and every pull even after v0.2.1.`);
    assert.ok(survivors.has(MARKETPLACE_MANIFEST), 'the marketplace manifest must survive too');
    assert.ok(survivors.has(USER_DIR_FILE),
      'a user directory that merely shares the name "session-sync" must survive the rclone filter as well');

    assert.equal(survivors.has(STATE_FILE), false,
      "<root>/session-sync/sync.log is this plugin's own bookkeeping — anchoring must not un-exclude it");
    assert.equal(survivors.has('session-sync/manifest.json'), false,
      '<root>/session-sync/manifest.json must stay excluded too');
  } finally { cleanup(root); }
});

test('PARITY: the rclone glob list mirrors SCAN_EXCLUDES, anchoring included — a name added to one list without the other fails here', () => {
  const excludes = new Set(PROD_EXCLUDES);

  for (const name of SCAN_EXCLUDES.excludeDirs) {
    assert.ok(excludes.has(`${name}/**`),
      `SCAN_EXCLUDES.excludeDirs matches "${name}" at any depth, so the rclone list needs the UNANCHORED glob "${name}/**". Anchoring it (or omitting it) makes full pushes and incremental pushes disagree about what to upload.`);
    assert.equal(excludes.has(`/${name}/**`), false,
      `"/${name}/**" is anchored to the sync root, which contradicts excludeDirs' any-depth match`);
  }

  for (const name of SCAN_EXCLUDES.excludeRootDirs) {
    assert.ok(excludes.has(`/${name}/**`),
      `SCAN_EXCLUDES.excludeRootDirs matches "${name}" only at the sync root, so the rclone list needs the ANCHORED glob "/${name}/**". The unanchored form is what dropped 21 real files under plugins/marketplaces/goodstuff/plugins/${name}/.`);
    assert.equal(excludes.has(`${name}/**`), false,
      `the unanchored "${name}/**" must be gone — it is the bug`);
  }

  for (const name of SCAN_EXCLUDES.excludeFiles) {
    assert.ok(excludes.has(name),
      `SCAN_EXCLUDES.excludeFiles drops "${name}" by basename at any depth; the rclone list needs the same bare (unanchored) pattern`);
  }

  // ...and nothing in the rclone list without a counterpart on the scan side.
  const scanDirs = new Set(SCAN_EXCLUDES.excludeDirs);
  const scanRootDirs = new Set(SCAN_EXCLUDES.excludeRootDirs);
  const scanFiles = new Set(SCAN_EXCLUDES.excludeFiles);
  for (const pattern of PROD_EXCLUDES) {
    if (pattern.startsWith('/') && pattern.endsWith('/**')) {
      const name = pattern.slice(1, -3);
      assert.ok(scanRootDirs.has(name),
        `rclone excludes "/${name}/**" at the root but SCAN_EXCLUDES.excludeRootDirs does not list "${name}" — the incremental push would keep uploading it`);
    } else if (pattern.endsWith('/**')) {
      const name = pattern.slice(0, -3);
      assert.ok(scanDirs.has(name),
        `rclone excludes "${name}/**" at any depth but SCAN_EXCLUDES.excludeDirs does not list "${name}"`);
    } else {
      assert.ok(scanFiles.has(pattern),
        `rclone excludes the file "${pattern}" but SCAN_EXCLUDES.excludeFiles does not`);
    }
  }
});

test('end-to-end: a FULL push carries the marketplace checkout to the remote and leaves the caches behind', { skip: skipReason }, async () => {
  const { root } = fakeClaudeHome();
  const remoteDir = mkdtempSync(join(tmpdir(), 'ss-excl-full-'));
  const manifestFile = join(remoteDir, '..', `ss-excl-full-${process.pid}.json`);
  try {
    // No baseline manifest -> planIncremental returns full:true -> push() takes
    // the rclone --exclude path. That is the path v0.2.1 never fixed.
    const map = [{ local: root, remote: remoteDir, excludes: PROD_EXCLUDES, label: '~/.claude' }];
    const res = await push(remoteDir, { map, manifestFile, quiet: true });
    assert.ok(res.ok, 'the full push must succeed');

    const onRemote = (rel) => existsSync(join(remoteDir, ...rel.split('/')));

    assert.ok(onRemote(MARKETPLACE_FILE),
      `${MARKETPLACE_FILE} must land on a FULL push. Before this fix the anchoring lived only in the manifest scan, so a first push, a --force push, or any push after the manifest was lost silently omitted all 21 files.`);
    assert.ok(onRemote(USER_DIR_FILE), 'a user dir sharing the name must land too');
    assert.ok(onRemote('CLAUDE.md'), 'sanity: ordinary files land');

    assert.equal(onRemote(STATE_FILE), false, "the plugin's own state dir must never be copied");
    assert.equal(onRemote(NESTED_CACHE_FILE), false, 'plugins/cache/** is regenerable and must not be uploaded');
    assert.equal(onRemote(ROOT_CACHE_FILE), false, 'cache/** must not be uploaded');
    assert.equal(onRemote(NESTED_MODULES_FILE), false, 'node_modules/** must not be uploaded');
    assert.equal(onRemote(ROOT_CREDENTIALS), false, 'credentials must never leave the machine');
  } finally {
    cleanup(root);
    cleanup(remoteDir);
    try { rmSync(manifestFile, { force: true }); } catch { /* best effort */ }
  }
});
