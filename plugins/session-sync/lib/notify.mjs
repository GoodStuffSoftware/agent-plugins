/**
 * notify.mjs — desktop notifications, best-effort and never fatal.
 *
 * A sync that fails silently is worse than one that fails loudly, so the sync
 * says what it is doing. But a missing notifier must never break a backup:
 * every path here swallows its own errors.
 */

import { spawn, spawnSync } from 'node:child_process';
import { platform } from 'node:os';

/**
 * @param {string} title
 * @param {string} body
 * @param {{persist?: boolean, tag?: string}} opts
 *   persist — stay on screen until dismissed. Use for FAILURES and for
 *             "please wait" messages; a default toast vanishes in ~5s, which
 *             is too fast to read a "restoring, don't type yet" warning.
 *   tag     — reuse the same tag for the start and finish of one operation so
 *             the finish REPLACES the start instead of stacking two toasts.
 */
export function notify(title, body, { persist = false, tag = 'session-sync' } = {}) {
  try {
    const p = platform();
    if (p === 'win32') return winToast(title, body, persist, tag);
    if (p === 'darwin') return macToast(title, body);
    return linuxToast(title, body, persist);
  } catch { /* notifications are never worth failing a sync over */ }
}

function winToast(title, body, persist, tag) {
  // scenario="reminder" is what makes a toast persist until dismissed.
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]
  ));
  const scenario = persist ? ' scenario="reminder"' : '';
  const actions = persist
    ? '<actions><action content="Dismiss" arguments="dismiss" activationType="system"/></actions>'
    : '';
  const ps = `
$ErrorActionPreference='SilentlyContinue'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime] | Out-Null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml(@'
<toast${scenario}><visual><binding template="ToastGeneric"><text>${esc(title)}</text><text>${esc(body)}</text></binding></visual>${actions}</toast>
'@)
$t = [Windows.UI.Notifications.ToastNotification]::new($xml)
$t.Tag = '${tag}'
$appId = 'Claude.SessionSync'
if (-not (Test-Path "HKCU:\\SOFTWARE\\Classes\\AppUserModelId\\$appId")) {
  $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
}
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($t)
`;
  detach('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps]);
}

function macToast(title, body) {
  const esc = (s) => String(s).replace(/"/g, '\\"');
  detach('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`]);
}

function linuxToast(title, body, persist) {
  const args = ['-a', 'Claude Session Sync'];
  if (persist) args.push('-u', 'critical');   // critical stays until dismissed
  detach('notify-send', [...args, title, body]);
}

function detach(cmd, args) {
  // Windows: a DETACHED child ignores windowsHide (DETACHED_PROCESS wins), so a
  // detached powershell.exe pops a visible console for every toast. Not detaching
  // is safe there: Windows does not kill children when the parent exits.
  const opts = process.platform === 'win32'
    ? { stdio: 'ignore', windowsHide: true }
    : { detached: true, stdio: 'ignore', windowsHide: true };
  const c = spawn(cmd, args, opts);
  c.on('error', () => {});   // notifier missing (headless, no notify-send) — fine
  c.unref();
}

/**
 * Register a branded notification sender on Windows so toasts read
 * "Claude Session Sync" instead of "Windows PowerShell".
 * HKCU only — no admin, and fully reversible:
 *   Remove-Item "HKCU:\SOFTWARE\Classes\AppUserModelId\Claude.SessionSync" -Recurse
 *
 * DELIBERATELY SYNCHRONOUS (spawnSync), unlike every toast above. This is a
 * ONE-TIME-EVER setup step (the caller gates it behind its own marker file),
 * not a per-run notification, so a single ~0.3s blocking PowerShell call is a
 * fair price for correctness. Fire-and-forget (spawn+unref, like `detach()`)
 * was tried first and measurably failed: when the calling process exits
 * within milliseconds of spawning it — which is now routine, since a
 * hook-triggered push hands off to a background worker and returns almost
 * immediately (see cli.mjs's spawnDetachedSelf) — the non-detached
 * powershell.exe here did not survive long enough to write the registry key.
 * Confirmed by direct reproduction on 2026-09-07: a bare fire-and-forget call
 * with nothing keeping the caller alive silently registered nothing, while
 * the identical call with even a few seconds' delay before the caller exited
 * worked every time. Returns whether the registry write actually succeeded,
 * so the caller only remembers "done" when it is actually done.
 *
 * BOUNDED, because synchronous and unbounded is a session-start hazard. This
 * runs inside the hook-invoked process, BEFORE the detach/hand-off, so a
 * powershell.exe that hangs — AV intercepting a fresh launch, an environment
 * where -ExecutionPolicy Bypass does not suppress every prompt — would block
 * the hook until its own timeout with zero backup happening. And because the
 * caller only writes its "already done" marker on SUCCESS, a hang would
 * repeat on every subsequent push/pull. `timeout` caps that at REGISTER_TIMEOUT_MS;
 * on timeout spawnSync kills the child and returns an `error`, which is
 * treated exactly like any other failure: return false, no marker, retry next
 * time, toasts merely unbranded. Cosmetic branding must never cost a backup.
 *
 * `spawnFn`/`platformFn` are test-only injection points (same escape-hatch
 * pattern as push()'s `map`/`manifestFile` and notifyRoutine()'s `notifyFn`):
 * they let a test assert the timeout is actually passed, and simulate a hung
 * or throwing PowerShell, without touching the real machine's registry.
 */
export const REGISTER_TIMEOUT_MS = 5000;

export function registerWindowsSender(displayName = 'Claude Session Sync', iconPath = null,
                                      { spawnFn = spawnSync, platformFn = platform } = {}) {
  if (platformFn() !== 'win32') return false;
  const icon = iconPath
    ? `New-ItemProperty -Path $k -Name IconUri -Value '${iconPath}' -PropertyType String -Force | Out-Null`
    : '';
  const ps = `
$ErrorActionPreference='Stop'
$k = 'HKCU:\\SOFTWARE\\Classes\\AppUserModelId\\Claude.SessionSync'
New-Item -Path $k -Force | Out-Null
New-ItemProperty -Path $k -Name DisplayName -Value '${displayName}' -PropertyType String -Force | Out-Null
${icon}
`;
  try {
    const r = spawnFn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      windowsHide: true,
      timeout: REGISTER_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    // A timeout surfaces as r.error (ETIMEDOUT) with a null status, so check
    // it explicitly rather than relying on `status === 0` alone.
    if (!r || r.error) return false;
    return r.status === 0;
  } catch { return false; }
}
