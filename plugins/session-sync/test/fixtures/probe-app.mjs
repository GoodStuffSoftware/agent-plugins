/**
 * A Windows-shaped "app" for tests that must go through the REAL probe code (appstate.mjs probeDesktop) instead of the
 * SESSION_SYNC_TEST_APP_STATE seam: the lock marker is a real `lockfile` in the scratch userData, and the process probe is a
 * spawnFn that answers exactly as PowerShell does (the marker line, exit status 0), with or without a `claude` process.
 * A seam can never hide a probe-semantics bug (the 0.5.1 stop-detection bug did exactly that).
 */

import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PROBE_MARK } from '../../lib/accounts/appstate.mjs';

const APP_PATH = 'C:\\Program Files\\WindowsApps\\Claude_1.0.0.0_x64__abc\\app\\Claude.exe';

/**
 * @param {object} ctx  a makeRoot() ctx
 * @returns {{ctx, setApp(running:boolean), quit(), start(), probes: number, lock: string}}
 *   broken = true: the probe fails (no end marker, status 1, stderr "boom").
 *   ctx: the same ctx on platform 'win32' with the injected spawnFn; no seam env var is involved.
 */
export function makeProbeApp(ctx) {
  const lock = join(ctx.userData, 'lockfile');
  let proc = false; let probes = 0; let broken = false;
  const spawnFn = (cmd) => {
    if (cmd !== 'powershell.exe') return { status: 1, stdout: '' };
    probes++;
    if (broken) return { status: 1, stdout: '', stderr: 'boom' };   // a probe that never reaches its end marker
    return { status: 0, stdout: `${proc ? `P|4242|${APP_PATH}\r\n` : ''}${PROBE_MARK}\r\n`, stderr: '' };
  };
  const app = {
    ctx: { ...ctx, platform: 'win32', spawnFn },
    lock,
    get probes() { return probes; },
    set broken(v) { broken = !!v; },
    start() { proc = true; writeFileSync(lock, ''); },
    quit() { proc = false; rmSync(lock, { force: true }); },
    setApp(running) { return running ? app.start() : app.quit(); },
  };
  return app;
}
