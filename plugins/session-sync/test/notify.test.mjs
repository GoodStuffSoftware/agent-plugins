/**
 * registerWindowsSender() must be BOUNDED and NON-FATAL.
 *
 * It is the one deliberately synchronous PowerShell call in the plugin, and it
 * runs inside the hook-invoked process BEFORE the background hand-off. With no
 * timeout, a powershell.exe that hangs (AV intercepting a fresh launch, an
 * environment where -ExecutionPolicy Bypass still prompts) blocks the hook
 * until its own timeout with zero backup happening — and because the caller
 * only writes its "already done" marker on success, the hang repeats on every
 * subsequent push and pull. All this call buys is the toast reading
 * "Claude Session Sync" instead of "Windows PowerShell"; branding must never
 * cost a backup.
 *
 * The real call is never made here: spawnFn/platformFn are injected, so no
 * registry is touched (an HKCU write is a real change to the machine running
 * the tests, not something a suite should do as a side effect) and the cases
 * below run identically on any platform.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerWindowsSender, REGISTER_TIMEOUT_MS } from '../lib/notify.mjs';

const win32 = () => 'win32';

test('the PowerShell call is given a finite timeout — a hung shell cannot block session start forever', () => {
  let opts = null;
  const spawnFn = (_cmd, _args, o) => { opts = o; return { status: 0 }; };

  assert.equal(registerWindowsSender('Claude Session Sync', null, { spawnFn, platformFn: win32 }), true);
  assert.ok(Number.isFinite(opts.timeout) && opts.timeout > 0,
    'spawnSync must be passed a timeout; without one a hung powershell.exe blocks the hook indefinitely');
  assert.ok(opts.timeout <= 30000, `${opts.timeout}ms is too long to block a session start on cosmetic branding`);
  assert.equal(opts.timeout, REGISTER_TIMEOUT_MS);
  assert.equal(opts.windowsHide, true, 'and it must still not flash a console window');
});

test('a TIMED-OUT PowerShell is non-fatal: returns false, does not throw', () => {
  // Exactly what spawnSync returns when it kills a child on timeout.
  const timedOut = () => ({ error: Object.assign(new Error('spawnSync powershell ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null, signal: 'SIGKILL' });

  let result;
  assert.doesNotThrow(() => { result = registerWindowsSender('x', null, { spawnFn: timedOut, platformFn: win32 }); },
    'a hung registration must never propagate an error into the sync path');
  assert.equal(result, false,
    'a timeout must report failure so the caller does NOT write its one-time marker — branding retries later instead of being disabled forever');
});

test('a THROWING spawn (no powershell on PATH, locked-down host) is non-fatal too', () => {
  const boom = () => { throw new Error('spawnSync powershell ENOENT'); };
  let result;
  assert.doesNotThrow(() => { result = registerWindowsSender('x', null, { spawnFn: boom, platformFn: win32 }); });
  assert.equal(result, false);
});

test('a non-zero exit reports failure rather than a false success', () => {
  const failed = () => ({ status: 1, stderr: 'Access to the registry key is denied.' });
  assert.equal(registerWindowsSender('x', null, { spawnFn: failed, platformFn: win32 }), false);
});

test('off Windows it is a no-op and spawns nothing at all', () => {
  let calls = 0;
  const spawnFn = () => { calls++; return { status: 0 }; };
  assert.equal(registerWindowsSender('x', null, { spawnFn, platformFn: () => 'darwin' }), false);
  assert.equal(calls, 0, 'there is no HKCU to write on macOS or Linux — do not launch anything');
});
