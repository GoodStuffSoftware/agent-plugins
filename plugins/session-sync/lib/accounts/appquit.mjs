/**
 * appquit.mjs - ask the Claude desktop app to quit (go-live `--quit-app`). The go-live RUNNER calls this a
 * few seconds after it starts, so the `go-live` command has already returned to the agent that ran it.
 *
 *   macOS    `osascript -e 'quit app "Claude"'`: the app's normal quit (same as the Quit menu item).
 *   Windows  NOT supported. Proven on a throwaway Electron app (45.3.3, hidden window): a synthetic
 *            WM_QUERYENDSESSION then WM_ENDSESSION to the main window fires `session-end`, and Electron then
 *            ends the process about 100 ms later, whether or not the app asked to wait. The real app's
 *            session-end handler only calls app.quit(); its quit cleanup is asynchronous (up to 75 s of
 *            flushing), so it would be cut off. That is a kill in all but name, so it is not offered.
 *   Linux    not supported.
 * When unsupported the user quits Claude from the tray icon (closing the window only hides it) and the
 * runner waits. Nothing here ever kills the app.
 */

import { spawnSync } from 'node:child_process';

export const WINDOWS_REASON = 'on Windows an outside quit ends the app before its own shutdown has saved everything';

/** What `--quit-app` can do on this platform, without doing it. @returns {{supported:boolean, reason?:string}} */
export function quitSupport(platform = process.platform) {
  if (platform === 'darwin') return { supported: true };
  if (platform === 'win32') return { supported: false, reason: WINDOWS_REASON };
  return { supported: false, reason: 'asking the app to quit is not available on this system' };
}

/**
 * Ask the app to quit. `deps.platform` and `deps.spawnSyncFn` are for tests.
 * @returns {Promise<{supported:boolean, requested?:boolean, reason?:string}>}
 */
export async function requestAppQuit(deps = {}) {
  const platform = deps.platform ?? process.platform;
  const sup = quitSupport(platform);
  if (!sup.supported) return sup;
  // safety: while the app-state test seam is set, a real app is never asked to quit
  if ((deps.env ?? process.env).SESSION_SYNC_TEST_APP_STATE) return { supported: true, requested: false, reason: 'test mode: no real app is quit' };
  const run = deps.spawnSyncFn ?? spawnSync;
  let r;
  try {
    r = run('osascript', ['-e', 'quit app "Claude"'], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
  } catch (e) {
    return { supported: true, requested: false, reason: String(e?.message ?? e) };
  }
  if (r?.error) return { supported: true, requested: false, reason: String(r.error.message ?? r.error) };
  if (r?.status !== 0) return { supported: true, requested: false, reason: String(r?.stderr ?? '').trim() || `osascript exited with ${r?.status}` };
  return { supported: true, requested: true };
}
