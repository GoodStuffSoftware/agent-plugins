/**
 * Proves, from inside the test run, that `npm test` cannot reach the real
 * user's Claude data.
 *
 * This is not decoration. An adversarial review verified BY EXECUTION that the
 * previous harness — which overrode only USERPROFILE, per child process —
 * still located the real `claude-code-sessions` / `local-agent-mode-sessions`
 * on a developer machine (lib/paths.mjs probes `process.env.APPDATA` directly
 * by design) and copied real conversation index data into a scratch temp
 * folder on every run. It cleaned up after itself, but a test process killed
 * before its `finally` would have left private transcript content sitting in a
 * world-readable temp directory.
 *
 * These assertions fail loudly if the sandbox preload (test/sandbox-env.mjs)
 * is ever dropped from the `npm test` command or stops covering a variable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { claudeHome, sessionStores, desktopDataRoots } from '../lib/paths.mjs';
import { STATE_DIR, CONFIG_FILE } from '../lib/config.mjs';

const SANDBOX = process.env.SESSION_SYNC_TEST_SANDBOX;

function inSandbox(p) {
  // No sandbox at all counts as "outside" — so a dropped preload reports the
  // real path it would have used, rather than a confusing TypeError.
  if (!SANDBOX || !p) return false;
  return resolve(String(p)).toLowerCase().startsWith(resolve(SANDBOX).toLowerCase());
}

test('the sandbox preload actually ran — without it every assertion below is vacuous', () => {
  assert.ok(SANDBOX, 'SESSION_SYNC_TEST_SANDBOX is unset: npm test must run with `--import ./test/sandbox-env.mjs`, or the suite is pointed at the real ~/.claude');
});

test('every env var the plugin can find real Claude data through is redirected into the sandbox', () => {
  for (const key of ['USERPROFILE', 'HOME', 'APPDATA', 'XDG_CONFIG_HOME']) {
    assert.ok(process.env[key], `${key} must be set, so nothing falls back to a machine default`);
    assert.ok(inSandbox(process.env[key]), `${key} points outside the sandbox: ${process.env[key]}`);
  }
  assert.equal(process.env.CLAUDE_SESSION_SYNC_REMOTE, undefined,
    'a remote inherited from the developer\'s shell could point a test push at real cloud storage');
});

test('and they are genuinely different from this machine\'s real ones', () => {
  const realProfile = process.env.SESSION_SYNC_TEST_REAL_USERPROFILE;
  const realAppData = process.env.SESSION_SYNC_TEST_REAL_APPDATA;
  if (realProfile) {
    assert.notEqual(process.env.USERPROFILE, realProfile);
    assert.ok(!inSandbox(realProfile), 'sanity: the real profile is not itself inside the sandbox');
  }
  if (realAppData) assert.notEqual(process.env.APPDATA, realAppData);
});

test('claudeHome(), the state dir and the config file all resolve inside the sandbox', () => {
  assert.ok(inSandbox(homedir()), `os.homedir() escaped the sandbox: ${homedir()}`);
  assert.ok(inSandbox(claudeHome()), `claudeHome() escaped the sandbox: ${claudeHome()}`);
  assert.ok(inSandbox(STATE_DIR), `the plugin state dir escaped the sandbox: ${STATE_DIR}`);
  assert.ok(inSandbox(CONFIG_FILE), `config.json escaped the sandbox: ${CONFIG_FILE}`);
});

test('NO desktop session-store candidate points at real data — this is the APPDATA hole that leaked conversations', () => {
  for (const root of desktopDataRoots()) {
    assert.ok(inSandbox(root), `desktop data root escaped the sandbox: ${root}`);
  }
  for (const [name, dir] of Object.entries(sessionStores())) {
    assert.ok(inSandbox(dir), `${name} resolved to real user data: ${dir}`);
  }
});

test('the real claude-code-sessions / local-agent-mode-sessions are specifically NOT what got resolved', () => {
  const realAppData = process.env.SESSION_SYNC_TEST_REAL_APPDATA;
  if (!realAppData) return;   // not Windows, or no APPDATA to leak through
  const resolved = Object.values(sessionStores()).map((p) => resolve(p).toLowerCase());
  for (const name of ['claude-code-sessions', 'local-agent-mode-sessions']) {
    const real = resolve(join(realAppData, 'Claude', name)).toLowerCase();
    assert.ok(!resolved.includes(real), `the test run resolved the REAL ${name} at ${real}`);
  }
});
