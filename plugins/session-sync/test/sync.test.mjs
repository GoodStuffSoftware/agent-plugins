/**
 * End-to-end tests for push()'s orchestration — the thing manifest.test.mjs
 * and config.test.mjs could NOT catch between them.
 *
 * BACKGROUND: a live machine's manifest.json sat untouched for 52 hours while
 * dozens of "pushing — ..." log lines kept appearing, "added" counts climbing
 * every run. The prior read-only diagnosis assumed commitManifest() just
 * wasn't persisting; live sync.log evidence instead showed every push since
 * that timestamp starting and then NEVER logging "push ok" or "push FAILED"
 * at all — the process was being killed mid-copy (hook timeout / conversation
 * teardown) before it ever reached commitManifest(). commitManifest() and
 * saveManifest() themselves were already covered by manifest.test.mjs and are
 * fine; what nothing exercised was push() ACTUALLY calling them, end-to-end,
 * with a real disk round-trip, on success, and NOT on failure.
 *
 * These use a real rclone against a local-folder "remote" (a plain directory
 * is a valid rclone destination — see rclone.mjs's isLocalRemote) so the test
 * exercises the true code path, not a mock of it. Skipped if rclone truly
 * isn't installed anywhere on the machine running the tests.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { push, notifyRoutine } from '../lib/sync.mjs';
import { loadManifest } from '../lib/manifest.mjs';
import { findRclone } from '../lib/rclone.mjs';

const haveRclone = !!findRclone();
const skipReason = haveRclone ? false : 'rclone is not installed on this machine — cannot exercise a real copy';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ss-push-'));
  const localSrc = join(root, 'home');
  const remoteDir = join(root, 'remote');
  mkdirSync(localSrc, { recursive: true });
  mkdirSync(remoteDir, { recursive: true });
  writeFileSync(join(localSrc, 'CLAUDE.md'), 'rules');
  const manifestFile = join(root, 'manifest.json');
  const map = [{ local: localSrc, remote: remoteDir, excludes: [], label: '~/.claude' }];
  return { root, localSrc, remoteDir, manifestFile, map };
}

function cleanup(root) { rmSync(root, { recursive: true, force: true }); }

test('a successful push commits the manifest to disk, and it reads back', { skip: skipReason }, async () => {
  const { root, remoteDir, manifestFile, map } = fixture();
  try {
    const r = await push(remoteDir, { map, manifestFile, quiet: true });
    assert.ok(r.ok, 'push should succeed against a local-folder remote');
    assert.equal(r.committed, true, 'push() must report that the manifest actually persisted');
    assert.ok(existsSync(manifestFile), 'the manifest file must exist on disk after a successful push');
    const all = loadManifest(manifestFile);
    assert.ok(all[remoteDir], 'a baseline must be recorded under this remote key');
    assert.ok(all[remoteDir]['~/.claude']['CLAUDE.md'], 'the file that was actually pushed must be in the committed baseline');
    assert.ok(existsSync(join(remoteDir, 'CLAUDE.md')), 'the file must have actually landed on the "remote"');
  } finally { cleanup(root); }
});

test('a second push with nothing changed is skipped, not re-sent', { skip: skipReason }, async () => {
  const { root, remoteDir, manifestFile, map } = fixture();
  try {
    const first = await push(remoteDir, { map, manifestFile, quiet: true });
    assert.ok(first.ok);
    const second = await push(remoteDir, { map, manifestFile, quiet: true });
    assert.equal(second.skipped, true, 'an idle second push must be a no-op, not a re-send');
  } finally { cleanup(root); }
});

test('a failed push (bad destination) never commits the manifest', { skip: skipReason }, async () => {
  const { root, localSrc, manifestFile } = fixture();
  try {
    // A remote naming a config section that doesn't exist reproduces the
    // exact "didn't find section in config file" failure seen in production.
    const badMap = [{ local: localSrc, remote: 'ss-test-doesnotexist:nope/x', excludes: [], label: '~/.claude' }];
    const r = await push('ss-test-doesnotexist:nope/x', { map: badMap, manifestFile, quiet: true });
    assert.equal(r.ok, false, 'push must report failure rather than swallowing it');
    const all = loadManifest(manifestFile);
    assert.equal(all['ss-test-doesnotexist:nope/x'], undefined,
      'a failed push must never advance the baseline — that would make the next run skip files that never actually landed');
  } finally { cleanup(root); }
});

test('the plugin\'s own state dir is excluded: growing sync.log never looks like a real change, and is never sent', { skip: skipReason }, async () => {
  const { root, localSrc, remoteDir, manifestFile } = fixture();
  // Mirror buildMap()'s real '~/.claude' entry: excludes is where the FULL
  // (first-ever) rclone copy actually gets its --exclude flags from — the
  // incremental path also relies on planIncremental()'s excludeDirs, which
  // push() hardcodes and this test cannot see from outside, but the FULL
  // path is push()'s own responsibility to pass excludes through correctly.
  const map = [{ local: localSrc, remote: remoteDir, excludes: ['session-sync/**'], label: '~/.claude' }];
  try {
    mkdirSync(join(localSrc, 'session-sync'), { recursive: true });
    writeFileSync(join(localSrc, 'session-sync', 'sync.log'), 'line1\n');

    const r1 = await push(remoteDir, { map, manifestFile, quiet: true });
    assert.ok(r1.ok);

    // Simulate what a live run does to its own log on every single sync.
    writeFileSync(join(localSrc, 'session-sync', 'sync.log'), 'line1\nline2\nline3\n');

    const r2 = await push(remoteDir, { map, manifestFile, quiet: true });
    assert.equal(r2.skipped, true,
      'sync.log (and the rest of session-sync/**) must be invisible to the diff — this is the self-sustaining "always something changed" loop');
    assert.equal(existsSync(join(remoteDir, 'session-sync')), false,
      'the plugin\'s own bookkeeping must never be copied to the remote at all');
  } finally { cleanup(root); }
});

// ---- notifyRoutine: the volume-cut logic (item 7), tested WITHOUT a real
// toast — notifyFn is a plain counter, markerFile is a throwaway temp path.
test('notifyRoutine: "all" always notifies, ignoring the marker', () => {
  const root = mkdtempSync(join(tmpdir(), 'ss-notify-'));
  const markerFile = join(root, 'marker');
  let calls = 0;
  const notifyFn = () => { calls++; };
  notifyRoutine('all', 't', 'b', {}, { markerFile, notifyFn });
  notifyRoutine('all', 't', 'b', {}, { markerFile, notifyFn });
  assert.equal(calls, 2, '"all" must notify every single time');
  rmSync(root, { recursive: true, force: true });
});

test('notifyRoutine: "failures" never notifies for a routine (non-failure) toast', () => {
  const root = mkdtempSync(join(tmpdir(), 'ss-notify-'));
  const markerFile = join(root, 'marker');
  let calls = 0;
  const notified = notifyRoutine('failures', 't', 'b', {}, { markerFile, notifyFn: () => { calls++; } });
  assert.equal(notified, false);
  assert.equal(calls, 0, 'routine toasts must be fully silent under "failures"');
  rmSync(root, { recursive: true, force: true });
});

test('notifyRoutine: "first-run" notifies once, then goes quiet, and persists that across calls', () => {
  const root = mkdtempSync(join(tmpdir(), 'ss-notify-'));
  const markerFile = join(root, 'marker');
  let calls = 0;
  const notifyFn = () => { calls++; };

  const first = notifyRoutine('first-run', 't', 'b', {}, { markerFile, notifyFn });
  assert.equal(first, true, 'the very first routine toast must show, to confirm the plugin is alive');
  assert.equal(calls, 1);
  assert.ok(existsSync(markerFile), 'first-run must persist that it already notified once');

  const second = notifyRoutine('first-run', 't', 'b', {}, { markerFile, notifyFn });
  assert.equal(second, false, 'a second routine toast under first-run must be suppressed');
  assert.equal(calls, 1, 'notifyFn must not be called a second time');

  rmSync(root, { recursive: true, force: true });
});
