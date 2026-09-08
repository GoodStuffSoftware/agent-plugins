/**
 * Integration tests for cli.mjs's hook-only behaviour: the debounce (item 5)
 * and detaching a long sync from the hook's synchronous await (item 6).
 *
 * cli.mjs runs top-level code the moment it's imported (it calls
 * process.exit()), so it cannot be unit-tested via `import` the way the lib/
 * modules are — it has to be exercised as a real child process, the way a
 * hook actually invokes it.
 *
 * SANDBOXING: the whole run is already redirected by test/sandbox-env.mjs
 * (see its header — overriding USERPROFILE alone was NOT enough; paths.mjs
 * probes APPDATA directly and that hole reached real conversation data).
 * `run()` narrows it further to a per-test home so cases cannot see each
 * other's state, and re-points APPDATA inside that home for the same reason.
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
  // Real desktop toasts are a side effect on the developer's actual machine,
  // not something a test should produce. This is the master kill switch.
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ notifications: false }, null, 2));
  return { home, remote, stateDir };
}

function run(args, home, remote, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      USERPROFILE: home,
      HOME: home,
      // paths.mjs probes APPDATA directly, so it has to move with the home or
      // the child re-discovers the real desktop session stores. See
      // test/sandbox-env.mjs.
      APPDATA: join(home, 'AppData', 'Roaming'),
      XDG_CONFIG_HOME: join(home, '.config'),
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
    assert.match(log, /deferred worker pid \d+/, 'a hook-triggered push must delegate to a background worker, not run inline');

    // The parent already returned; the detached child keeps going on its own.
    const landed = waitFor(() => existsSync(join(remote, 'dot-claude', 'CLAUDE.md')));
    assert.ok(landed, 'the detached background push must still actually finish the copy — this is the fix for a 262-minute push getting killed by the hook timeout');
    const succeeded = waitFor(() => existsSync(join(stateDir, 'last-push.txt')));
    assert.ok(succeeded, 'the background push must record success once it completes');
  } finally { cleanup(home, remote); }
});

test('a manual push ignores the debounce window entirely, and records no deferred request', { skip: skipReason }, () => {
  const { home, remote, stateDir } = sandbox();
  try {
    writeFileSync(join(stateDir, 'last-push.txt'), new Date().toISOString());   // "just synced"
    const r = run(['push'], home, remote);   // no --from-hook
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(remote, 'dot-claude', 'CLAUDE.md')),
      'an explicit manual push (the sync skill, or a user typing the command) must always run now, regardless of the last automatic sync');
    assert.equal(existsSync(join(stateDir, 'deferred-push.json')), false,
      'a manual push runs immediately and therefore owes nothing — it must not leave a deferral record behind');
  } finally { cleanup(home, remote); }
});

test('a manual pull is never debounced either — it runs immediately no matter how recent the last pull', { skip: skipReason }, () => {
  const { home, remote, stateDir } = sandbox();
  try {
    // Something waiting on the remote, and a pull that "just happened".
    mkdirSync(join(remote, 'dot-claude'), { recursive: true });
    writeFileSync(join(remote, 'dot-claude', 'FROM-REMOTE.md'), 'restored');
    writeFileSync(join(stateDir, 'last-pull.txt'), new Date().toISOString());

    const r = run(['pull'], home, remote);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(home, '.claude', 'FROM-REMOTE.md')),
      'a manual pull must fetch synchronously and immediately — the sync skill promises exactly that');
  } finally { cleanup(home, remote); }
});

// ---- the coalescing deferral, driven through the REAL cli.mjs -------------
// These are the end-to-end counterpart to test/defer.test.mjs: they prove the
// wiring, not just the bookkeeping. A short debounce (0.05 min = 3s) and a
// short retry (env-only, never set in production) keep them quick.

const DEFERRED = 'deferred-push.json';
const countOf = (log, re) => (log.match(re) || []).length;

test('a debounced hook push is DEFERRED, not dropped: it still actually runs once the window lapses', { skip: skipReason }, () => {
  const { home, remote, stateDir } = sandbox();
  try {
    assert.equal(run(['config', 'debounceMinutes', '0.05'], home, remote).status, 0);   // 3s
    writeFileSync(join(stateDir, 'last-push.txt'), new Date().toISOString());           // "just synced"

    const r = run(['push', '--from-hook'], home, remote);
    assert.equal(r.status, 0, r.stderr);

    const log = readFileSync(join(stateDir, 'sync.log'), 'utf8');
    assert.match(log, /scheduled: deferred worker pid \d+ runs in ~[1-9]\d*s/,
      'a push inside the debounce window must be scheduled for later, not skipped');
    assert.ok(existsSync(join(stateDir, DEFERRED)), 'the request must be recorded on disk while it waits');

    // The whole point: it eventually happens on its own, with no further trigger.
    assert.ok(waitFor(() => existsSync(join(remote, 'dot-claude', 'CLAUDE.md')), { timeoutMs: 30000 }),
      'the deferred push MUST eventually run — a debounce that permanently discards the last push of a conversation loses that conversation');
    assert.ok(waitFor(() => !existsSync(join(stateDir, DEFERRED)), { timeoutMs: 15000 }),
      'once the push has actually succeeded, nothing is owed and the record must be cleared');
  } finally { cleanup(home, remote); }
});

test('rapid repeated hook pushes COLLAPSE into one background run, and none of them is lost', { skip: skipReason }, () => {
  const { home, remote, stateDir } = sandbox();
  try {
    assert.equal(run(['config', 'debounceMinutes', '0.05'], home, remote).status, 0);
    writeFileSync(join(stateDir, 'last-push.txt'), new Date().toISOString());

    for (let i = 0; i < 3; i++) {
      assert.equal(run(['push', '--from-hook'], home, remote).status, 0, `request ${i} should return cleanly`);
    }

    const scheduling = readFileSync(join(stateDir, 'sync.log'), 'utf8');
    assert.equal(countOf(scheduling, /\(scheduled: deferred worker/g), 1,
      'three conversations ending together must spawn exactly ONE worker');
    assert.equal(countOf(scheduling, /\(coalesced: deferred worker/g), 2,
      'the other two must coalesce onto it — recorded, not discarded');

    assert.ok(waitFor(() => existsSync(join(remote, 'dot-claude', 'CLAUDE.md')), { timeoutMs: 30000 }));
    assert.ok(waitFor(() => !existsSync(join(stateDir, DEFERRED)), { timeoutMs: 15000 }));

    const done = readFileSync(join(stateDir, 'sync.log'), 'utf8');
    assert.equal(countOf(done, /deferred push ok/g), 1,
      'three requests must produce ONE push — that is the throttling the debounce is for');
  } finally { cleanup(home, remote); }
});

test('a hook push blocked by the sync lock keeps its request and retries — it is never silently lost', { skip: skipReason }, () => {
  const { home, remote, stateDir } = sandbox();
  try {
    // Hold the lock with a pid that is genuinely alive (this test process).
    const lockFile = join(stateDir, 'sync.lock');
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now(), host: 'test' }));

    // No debounce, so the worker starts at once and goes straight at the lock.
    const env = { CLAUDE_SESSION_SYNC_DEFER_RETRY_MS: '400', CLAUDE_SESSION_SYNC_DEFER_MAX_ATTEMPTS: '60' };
    assert.equal(run(['config', 'debounceMinutes', '0'], home, remote).status, 0);
    assert.equal(run(['push', '--from-hook'], home, remote, env).status, 0);

    assert.ok(waitFor(() => /deferred push: another sync is running/.test(readFileSync(join(stateDir, 'sync.log'), 'utf8')), { timeoutMs: 15000 }),
      'the worker must report waiting on the lock rather than exiting');
    assert.ok(existsSync(join(stateDir, DEFERRED)),
      'the request must still be recorded while the lock is held — the old behaviour discarded it here');
    assert.equal(existsSync(join(remote, 'dot-claude')), false, 'sanity: nothing has been pushed yet');

    // Release it. Nothing else fires a hook — the retry alone must finish the job.
    rmSync(lockFile, { force: true });
    assert.ok(waitFor(() => existsSync(join(remote, 'dot-claude', 'CLAUDE.md')), { timeoutMs: 30000 }),
      'once the lock frees, the DEFERRED request must complete on its own with no new trigger');
    assert.ok(waitFor(() => !existsSync(join(stateDir, DEFERRED)), { timeoutMs: 15000 }));
  } finally { cleanup(home, remote); }
});

test('a request left behind by a dead worker (machine shut down mid-window) is picked up by the next session', { skip: skipReason }, () => {
  const { home, remote, stateDir } = sandbox();
  try {
    // Exactly what a hard shutdown leaves: a push still owed, its worker gone,
    // and its runAt already in the past.
    writeFileSync(join(stateDir, DEFERRED), JSON.stringify({
      requestedAt: Date.now() - 600000, runAt: Date.now() - 300000, pid: 999999,
    }));
    assert.equal(run(['config', 'debounceMinutes', '0'], home, remote).status, 0);
    assert.equal(run(['push', '--from-hook'], home, remote).status, 0);

    const log = readFileSync(join(stateDir, 'sync.log'), 'utf8');
    assert.match(log, /\(scheduled: deferred worker/, 'a dead worker must be replaced, not trusted');
    assert.ok(waitFor(() => existsSync(join(remote, 'dot-claude', 'CLAUDE.md')), { timeoutMs: 30000 }),
      'the push owed from the previous session must actually happen');
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
