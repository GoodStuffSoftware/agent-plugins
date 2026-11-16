/**
 * desktop.mjs - what go-live needs to know about, and do to, the Claude desktop app.
 *
 *   desktopCopies(ctx)   the app's own copies of session-sync (`<userData>/rpm/<acct>/<org>/plugin_*`),
 *                        each judged by CAPABILITY (has the account engine and the home-only push
 *                        filter), never by its version label: the app's copy can hold 0.4.0 code
 *                        while its label still says 0.3.0.
 *   resolveAumid()       Windows: the MSIX app id, read from the installed package.
 *   relaunchApp(ctx)     start the app: `explorer.exe shell:AppsFolder\<AUMID>` on Windows,
 *                        `open -a Claude` on macOS.
 *
 * Safety: while the app-state test seam (SESSION_SYNC_TEST_APP_STATE) is set, relaunchApp NEVER
 * starts anything; it flips the seam file to "running" instead.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';

const CAPABILITY_FILES = ['lib/accounts/pass.mjs', 'lib/accounts/waiter.mjs', 'lib/accounts/folders.mjs'];
const PUSH_FILTER_MARKER = 'accountsPushFilter';

const subdirs = (d) => { try { return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } };

/** Can this plugin copy run the account link safely? Reads two small facts from disk. */
export function copyCapability(root) {
  const missing = CAPABILITY_FILES.filter((f) => !existsSync(join(root, f)));
  let hasFilter = false;
  try { hasFilter = readFileSync(join(root, 'lib', 'sync.mjs'), 'utf8').includes(PUSH_FILTER_MARKER); } catch { /* no sync.mjs */ }
  return { capable: missing.length === 0 && hasFilter, accounts: missing.length === 0, pushFilter: hasFilter };
}

/** Every desktop-app copy of session-sync: [{path, version, capable, accounts, pushFilter}]. */
export function desktopCopies(ctx) {
  const out = [];
  if (!ctx.userData) return out;
  const rpm = join(ctx.userData, 'rpm');
  for (const a of subdirs(rpm)) {
    for (const o of subdirs(join(rpm, a))) {
      for (const p of subdirs(join(rpm, a, o))) {
        if (!p.startsWith('plugin_')) continue;
        const root = join(rpm, a, o, p);
        let meta = null;
        try { meta = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')); } catch { /* not a plugin */ }
        if (meta?.name !== 'session-sync') continue;
        out.push({ path: root, version: String(meta.version ?? ''), ...copyCapability(root) });
      }
    }
  }
  return out;
}

const AUMID_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$pkg = Get-AppxPackage -Name Claude | Where-Object { $_.InstallLocation -like '*WindowsApps*' } | Select-Object -First 1",
  'if ($pkg) { $m = Get-AppxPackageManifest -Package $pkg; $id = @($m.Package.Applications.Application)[0].Id; if ($id) { $pkg.PackageFamilyName + "!" + $id; exit 0 } }',
  "$s = Get-StartApps | Where-Object { $_.Name -eq 'Claude' -and $_.AppID -like '*!*' } | Select-Object -First 1",
  'if ($s) { $s.AppID }',
].join('; ');

/** The MSIX AUMID (`<PackageFamilyName>!<AppId>`) of the installed Claude app, or null. */
export function resolveAumid({ spawnSyncFn = spawnSync } = {}) {
  try {
    const r = spawnSyncFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', AUMID_SCRIPT], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
    const line = String(r?.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).find((s) => /^[^\s!]+![^\s!]+$/.test(s));
    return line ?? null;
  } catch { return null; }
}

/**
 * Start the desktop app. Returns {ok, method, aumid?, error?}; never throws.
 * `o`: { platform, spawnFn, spawnSyncFn, env }.
 */
export function relaunchApp(ctx, o = {}) {
  const env = o.env ?? process.env;
  const platform = o.platform ?? ctx.platform ?? process.platform;
  try {
    if (env.SESSION_SYNC_TEST_APP_STATE) {
      const f = env.SESSION_SYNC_TEST_APP_STATE;
      let cur = {};
      try { cur = JSON.parse(readFileSync(f, 'utf8')); } catch { /* new */ }
      writeFileSync(f, JSON.stringify({ ...cur, running: true, startedAtMs: Date.now() }));
      return { ok: true, method: 'test-seam' };
    }
    const spawnFn = o.spawnFn ?? nodeSpawn;
    if (platform === 'win32') {
      const aumid = resolveAumid({ spawnSyncFn: o.spawnSyncFn });
      if (!aumid) return { ok: false, method: 'explorer', error: 'could not find the Claude app id (is the Store version installed?)' };
      const c = spawnFn('explorer.exe', [`shell:AppsFolder\\${aumid}`], { detached: true, stdio: 'ignore', windowsHide: true });
      c.on?.('error', () => {});
      c.unref?.();
      return { ok: true, method: 'explorer', aumid };
    }
    if (platform === 'darwin') {
      const c = spawnFn('open', ['-a', 'Claude'], { detached: true, stdio: 'ignore', windowsHide: true });
      c.on?.('error', () => {});
      c.unref?.();
      return { ok: true, method: 'open' };
    }
    return { ok: false, method: 'none', error: 'relaunching the app is not supported on this platform' };
  } catch (e) {
    return { ok: false, method: 'none', error: String(e?.message ?? e) };
  }
}
