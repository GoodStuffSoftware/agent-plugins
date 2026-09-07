/**
 * Integration tests for cli.mjs's hook-only behaviour: the debounce (item 5)
 * and detaching a long sync from the hook's synchronous await (item 6).
 *
 * cli.mjs runs top-level code the moment it's imported (it calls
 * process.exit()), so it cannot be unit-tested via `import` the way the lib/
 * modules are — it has to be exercised as a real child process, the way a
 * hook actually invokes it. `USERPROFILE` is what Node's os.homedir() reads
 * on Windows, so overriding it per-child-process fully sandboxes STATE_DIR,
 * CONFIG_FILE, and claudeHome() away from the real ~/.claude — confirmed
 * directly before relying on it here.
 *
 * A plain local directory is a valid rclone destination (see rclone.mjs's
 * isLocalRemote), so these drive the real cli.mjs against a real rclone with
 * no network and no real user data anywhere near the test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { findRclone } from '../lib/rclone.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'lib', 'cli.mjs');
const haveRclone = !!findRclone();
const skipReason = haveRclone ? false : 'rclone is not installed on this machine';

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'ss-cli-home-'));
  const remote = mkdtempSync(join(tmpdir(), 'ss-cli-remote-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'rules');
  const stateDir = join(home, '.claude', 'session-sync');
  mkdirSync(stateDir, { recursive: true });
  // Registering a branded toast sender touches the REAL machine's registry —
  // never something a test suite should do as a side effect. Pre-seeding the
  // "already done" marker inside the SANDBOXED state dir skips that branch
  // entirely while leaving everything this test actually cares about intact.
  writeFileSync(join(stateDir, 'sender-registered.txt'), new Date().toISOString());
  return { home, remote, stateDir };
}

function run(args, home, remote, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      USERPROFILE: home,
      CLAUDE_SESSION_SYNC_REMOTE: remote,
      ...extraEnv,
    },
    encoding: 'utf8',
    timeout: 15000,
  });
}

function cleanup(...dirs) { for (const d of dirs) rmSync(d, { recursive: true, force: true }); }

function waitFor(predicate, { timeoutMs = 5000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    // Deliberately blocking: this is test setup, not production code, and the
    // work being waited on is a background OS process, not something in-process.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, intervalMs);
  }
  return predicate();
}

test('a manual push (no --from-hook) runs synchronously: done by the time the process exits', { skip: skipReason }, () => {
  const { home, remote, stateDir } = sandbox();
  try {
    const r = run(['push'], home, remote);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(stateDir, 'last-push.txt')), 'a synchronous manual push must have already recorded success');
    assert.ok(existsSync(join(remote, 'dot-claude', 'CLAUDE.md')), 'the file must have actually landed on the remote before the process exited');
  } finally { cleanup(home, remote); }
});

test('a hook-triggered push (--from-hook) hands off in the background and still completes the real work', { skip: skipReason }, () => {
  const { home, remote, stateDir } = sandbox();
  try {
    const r = run(['push', '--from-hook'], home, remote);
    assert.equal(r.status, 0, r.stderr);
    const log = readFileSync(join(stateDir, 'sync.log'), 'utf8');
    assert.match(log, /handed off to background pid \d+/, 'a hook-triggered push must delegate to a background process, not run inline');

    // The parent already returned; the detached child keeps going on its own.
    const landed = waitFor(() => existsSync(join(remote, 'dot-claude', 'CLAUDE.md')));
    assert.ok(landed, 'the detached background push must still actually finish the copy — this is the fix for a 262-minute push getting killed by the hook timeout');
    const succeeded = waitFor(() => existsSync(join(stateDir, 'last-push.txt')));
    assert.ok(succeeded, 'the background push must record success once it completes');
  } finally { cleanup(home, remote); }
});

test('a hook-triggered push within the debounce window is skipped and never spawns anything', { skip: skipReason }, () => {
  const { home, remote, stateDir } = sandbox();
  try {
    // Pretend a push JUST succeeded.
    writeFileSync(join(stateDir, 'last-push.txt'), new Date().toISOString());
    const r = run(['push', '--from-hook'], home, remote);
    assert.equal(r.status, 0, r.stderr);
    const log = readFileSync(join(stateDir, 'sync.log'), 'utf8');
    assert.match(log, /push skipped.*debounce/, 'a push inside the debounce window must be skipped, not retried');
    assert.ok(!log.includes('handed off to background'), 'debounce must be checked BEFORE spawning anything — no wasted background process');
    assert.equal(existsSync(join(remote, 'dot-claude')), false, 'nothing should have been copied at all');
  } finally { cleanup(home, remote); }
});

test('a manual push ignores the debounce window entirely', { skip: skipReason }, () => {
  const { home, remote, stateDir } = sandbox();
  try {
    writeFileSync(join(stateDir, 'last-push.txt'), new Date().toISOString());   // "just synced"
    const r = run(['push'], home, remote);   // no --from-hook
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(remote, 'dot-claude', 'CLAUDE.md')),
      'an explicit manual push (the sync skill, or a user typing the command) must always run now, regardless of the last automatic sync');
  } finally { cleanup(home, remote); }
});

test('config debounceMinutes and notifyMode round-trip through the config command', { skip: skipReason }, () => {
  const { home, remote } = sandbox();
  try {
    let r = run(['config', 'debounceMinutes', '2'], home, remote);
    assert.equal(r.status, 0, r.stderr);
    r = run(['config', 'notifyMode', 'all'], home, remote);
    assert.equal(r.status, 0, r.stderr);
    r = run(['config'], home, remote);
    const cfg = JSON.parse(r.stdout);
    assert.equal(cfg.debounceMinutes, 2);
    assert.equal(cfg.notifyMode, 'all');
  } finally { cleanup(home, remote); }
});

test('config rejects an invalid notifyMode rather than silently accepting it', { skip: skipReason }, () => {
  const { home, remote } = sandbox();
  try {
    const r = run(['config', 'notifyMode', 'sometimes'], home, remote);
    assert.notEqual(r.status, 0, 'an unrecognised notifyMode must be refused, not saved');
  } finally { cleanup(home, remote); }
});
