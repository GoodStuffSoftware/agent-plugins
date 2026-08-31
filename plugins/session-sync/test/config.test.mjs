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
