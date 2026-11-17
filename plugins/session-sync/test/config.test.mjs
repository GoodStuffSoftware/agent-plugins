/**
 * Tests for remote validation.
 *
 * A typo in the remote means backups going nowhere while everything reports
 * success — the failure mode this plugin exists to avoid. Validation is the
 * cheapest place to catch it, so it is tested rather than assumed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRemote, DEFAULTS } from '../lib/config.mjs';

test('accepts a normal remote:path', () => {
  const v = validateRemote('gdrive:Claude/live');
  assert.ok(v.ok);
  assert.equal(v.name, 'gdrive');
  assert.equal(v.path, 'Claude/live');
  assert.equal(v.warning, undefined);
});

test('accepts other backends and nested paths', () => {
  for (const r of ['s3:my-bucket/claude', 'r2:bucket/a/b/c', 'nas:/volume1/backups/claude', 'my-remote_2:x']) {
    assert.ok(validateRemote(r).ok, `should accept ${r}`);
  }
});

test('rejects a path with no remote name — the most likely typo', () => {
  const v = validateRemote('myfolder/backups');
  assert.equal(v.ok, false);
  assert.match(v.error, /remote name/i);
});

test('rejects empty and non-string values', () => {
  for (const bad of ['', '   ', null, undefined, 42, {}]) {
    assert.equal(validateRemote(bad).ok, false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('rejects an invalid remote name', () => {
  assert.equal(validateRemote('my remote:path').ok, false, 'spaces are not valid in a remote name');
  assert.equal(validateRemote(':path').ok, false, 'a missing name is not valid');
});

test('rejects backslashes so Windows paths do not silently break', () => {
  const v = validateRemote('gdrive:Claude\\live');
  assert.equal(v.ok, false);
  assert.match(v.error, /forward slashes/i);
});

test('accepts a remote root but WARNS about mixing with other files', () => {
  const v = validateRemote('gdrive:');
  assert.ok(v.ok, 'root is legal');
  assert.ok(v.warning, 'but must warn');
  assert.match(v.warning, /ROOT/);
});

test('the default remote is itself valid', () => {
  assert.ok(validateRemote(DEFAULTS.remote).ok,
    'shipping a default that fails our own validation would be embarrassing');
});

test('accountLink: defaults to ask; the plugin option env var wins; an unknown value never enables linking', async () => {
  const { loadConfig, ACCOUNT_LINK_MODES } = await import('../lib/config.mjs');
  assert.equal(DEFAULTS.accountLink, 'ask');
  assert.deepEqual([...ACCOUNT_LINK_MODES], ['ask', 'auto', 'off']);
  const prior = process.env.CLAUDE_PLUGIN_OPTION_ACCOUNTLINK;
  try {
    process.env.CLAUDE_PLUGIN_OPTION_ACCOUNTLINK = ' AUTO ';
    assert.equal(loadConfig().accountLink, 'auto');
    process.env.CLAUDE_PLUGIN_OPTION_ACCOUNTLINK = 'off';
    assert.equal(loadConfig().accountLink, 'off');
    process.env.CLAUDE_PLUGIN_OPTION_ACCOUNTLINK = 'bogus';
    assert.notEqual(loadConfig().accountLink, 'bogus');
    assert.ok(ACCOUNT_LINK_MODES.includes(loadConfig().accountLink));
    delete process.env.CLAUDE_PLUGIN_OPTION_ACCOUNTLINK;
    assert.ok(ACCOUNT_LINK_MODES.includes(loadConfig().accountLink));
  } finally {
    if (prior === undefined) delete process.env.CLAUDE_PLUGIN_OPTION_ACCOUNTLINK; else process.env.CLAUDE_PLUGIN_OPTION_ACCOUNTLINK = prior;
  }
});

test('rcRestore: defaults, a partial block keeps the other defaults, a bad value falls back, saveConfig merges the block', async () => {
  const { loadConfig, saveConfig, describeConfig, rcSettings, RC_DEFAULTS, CONFIG_FILE } = await import('../lib/config.mjs');
  assert.deepEqual({ ...DEFAULTS.rcRestore }, { enabled: true, days: 3, wake: true });
  assert.deepEqual({ ...RC_DEFAULTS }, { enabled: true, days: 3, wake: true });
  assert.deepEqual(describeConfig({ ...DEFAULTS, remoteFrom: 'default' }).rcRestore, { enabled: true, days: 3, wake: true });
  assert.deepEqual(rcSettings({ rcRestore: { wake: false } }), { enabled: true, days: 3, wake: false });
  assert.equal(rcSettings({ rcRestore: { days: 'x' } }).days, 3);
  assert.equal(rcSettings({ rcRestore: { days: 91 } }).days, 3);
  assert.equal(rcSettings({ rcRestore: { days: 1 } }).days, 1);
  // the file is under the test sandbox (test/sandbox-env.mjs): never the real one
  assert.ok(process.env.SESSION_SYNC_TEST_SANDBOX && CONFIG_FILE.startsWith(process.env.SESSION_SYNC_TEST_SANDBOX), CONFIG_FILE);
  const { existsSync, unlinkSync } = await import('node:fs');
  const had = existsSync(CONFIG_FILE);
  assert.equal(had, false, 'a sandbox with no config file yet');
  try {
    saveConfig({ rcRestore: { days: 5 } });
    saveConfig({ rcRestore: { wake: false } });
    assert.deepEqual(JSON.parse((await import('node:fs')).readFileSync(CONFIG_FILE, 'utf8')).rcRestore, { days: 5, wake: false });
    assert.deepEqual(loadConfig().rcRestore, { enabled: true, days: 5, wake: false });
  } finally { try { unlinkSync(CONFIG_FILE); } catch { /* none */ } }
});
