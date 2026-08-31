/**
 * notify.mjs — desktop notifications, best-effort and never fatal.
 *
 * A sync that fails silently is worse than one that fails loudly, so the sync
 * says what it is doing. But a missing notifier must never break a backup:
 * every path here swallows its own errors.
 */

import { spawn } from 'node:child_process';
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
  const c = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
  c.on('error', () => {});   // notifier missing (headless, no notify-send) — fine
  c.unref();
}

/**
 * Register a branded notification sender on Windows so toasts read
 * "Claude Session Sync" instead of "Windows PowerShell".
 * HKCU only — no admin, and fully reversible:
 *   Remove-Item "HKCU:\SOFTWARE\Classes\AppUserModelId\Claude.SessionSync" -Recurse
 */
export function registerWindowsSender(displayName = 'Claude Session Sync', iconPath = null) {
  if (platform() !== 'win32') return false;
  const icon = iconPath
    ? `New-ItemProperty -Path $k -Name IconUri -Value '${iconPath}' -PropertyType String -Force | Out-Null`
    : '';
  const ps = `
$k = 'HKCU:\\SOFTWARE\\Classes\\AppUserModelId\\Claude.SessionSync'
New-Item -Path $k -Force | Out-Null
New-ItemProperty -Path $k -Name DisplayName -Value '${displayName}' -PropertyType String -Force | Out-Null
${icon}
`;
  detach('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps]);
  return true;
}
