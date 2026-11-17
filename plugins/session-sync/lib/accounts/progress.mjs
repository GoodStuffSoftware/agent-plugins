/**
 * progress.mjs - what the user sees while the go-live runner works with Claude closed (config `progressIcon`, default on).
 *
 * The runner calls `ui.start(info)` when the link begins (phase relist onward) and `ui.end(result)` after the final result is
 * written. Everything the user reads is plain words from this file:
 *
 *   Windows        a tray icon from a hidden helper (progress-tray.ps1: a NotifyIcon and a message loop, no window, no focus).
 *                  Its tooltip is "Syncing accounts: <step>", a balloon opens and closes the run, a double click (or a click on
 *                  the balloon) opens the go-live log in Notepad (a window the user asked for: the one visible thing besides the
 *                  icon). The helper reads the step from `go-live-result.json` (`progress`), never from the runner, so it cannot
 *                  block it, and it removes the icon and exits on its own when the runner dies without a final result.
 *                  It is started through the launcher (CIM, outside the runner's job) so it OUTLIVES the runner and still shows
 *                  the closing balloon after the runner has exited. `progress.run` in the result names the run the helper
 *                  belongs to: a helper whose run is no longer the current one (the link went back to waiting) removes its icon.
 *   macOS, Linux   a notification at the start and one at the end (`osascript`, `notify-send` when present; lib/notify.mjs).
 *
 * The UI layer is injectable (createProgressUi options, `deps.ui` of runGoLive), so tests never show anything. Seam: while
 * SESSION_SYNC_TEST_APP_STATE is set (a sandbox) nothing is shown unless SESSION_SYNC_TEST_PROGRESS_UI is also set.
 * Every spawn sets windowsHide; the tray icon is the only visible element.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notify } from '../notify.mjs';
import { launchProgram } from './launcher.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const TRAY_SCRIPT = join(HERE, 'progress-tray.ps1');
const TRAY_ICON = join(HERE, '..', '..', 'assets', 'icon.ico');
export const TITLE = 'Claude accounts';

/** The step in plain words, by runner phase. */
const STEP_WORDS = {
  'wait-stop': 'waiting for Claude to close',
  relist: 'backing up',
  link: 'backing up and linking',
  verify: 'checking',
  relaunch: 'reopening Claude',
  'wait-start': 'reopening Claude',
  'wait-capability': 'finishing',
  rectify: 'finishing',
  remote: 'finishing',
  finish: 'finishing',
  done: 'finishing',
};

/** Phases that show the UI: the link has begun (the wait for the app to stop shows nothing). */
export const UI_PHASES = Object.freeze(['relist', 'link', 'verify', 'relaunch', 'wait-start', 'wait-capability', 'rectify', 'remote', 'finish']);

export const stepWord = (phase) => STEP_WORDS[phase] ?? 'working';
/** The tray tooltip; a NotifyIcon allows 63 characters. */
export const tooltipFor = (phase) => `Syncing accounts: ${stepWord(phase)}`.slice(0, 63);

export const startText = ({ noRelaunch = false } = {}) => (noRelaunch
  ? 'Syncing your Claude accounts. Open Claude again when it is done.'
  : 'Syncing your Claude accounts. Claude will reopen by itself.');

/** The closing line for a final status (ok, rolled_back, attention, failed). */
export function endText(status) {
  switch (status) {
    case 'ok': return 'Your Claude accounts are linked.';
    case 'rolled_back': return 'The link was undone, so nothing changed.';
    case 'attention': return 'Your accounts are linked, but something needs your attention.';
    default: return 'The sync stopped before it finished.';
  }
}

/**
 * The `progress` block of go-live-result.json: what the helper shows, in words. `headline` only once the result is final.
 * `run` (only while the indicator is shown) names the run the helper belongs to: a helper started for another run removes its icon.
 */
export function progressInfo(phase, status, finalStatuses = ['ok', 'rolled_back', 'attention', 'failed'], run = null) {
  const final = finalStatuses.includes(status);
  return { step: stepWord(phase), tooltip: tooltipFor(phase), headline: final ? endText(status) : null, ...(run ? { run } : {}) };
}

/** The most the runner waits for a helper it could only start as its own child (the CIM start failed) to show the closing balloon. */
export const END_WAIT_MS = 11 * 1000;

const powershellExe = (env) => {
  const p = join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return existsSync(p) ? p : 'powershell.exe';
};

/** A UI that shows nothing. */
export const nullUi = Object.freeze({ start() {}, end() {} });

/**
 * @param {object} o  { enabled (config progressIcon), platform, spawnFn, launchFn, notifyFn, env, script, icon, endWaitMs }
 *   launchFn(exe, args, {env}) starts the Windows helper outside the runner's job (default: launcher.launchProgram). With only
 *   spawnFn given (tests) the helper is started as a plain child of the runner, like the fallback when the launch fails.
 * @returns {{start(info), end(result)}}  never throws
 *   start(info): { resultFile, logFile, runnerPid, noRelaunch, run }
 *   end(result): { status, headline }; on Windows with the fallback child it returns a promise that settles when the helper has
 *   shown the closing balloon and exited (or after END_WAIT_MS), so the runner does not exit under it.
 */
export function createProgressUi(o = {}) {
  const env = o.env ?? process.env;
  if (o.enabled === false) return nullUi;
  if (env.SESSION_SYNC_TEST_APP_STATE && !env.SESSION_SYNC_TEST_PROGRESS_UI) return nullUi;
  const platform = o.platform ?? process.platform;
  const spawnFn = o.spawnFn ?? spawn;
  const launchFn = o.launchFn ?? (o.spawnFn ? null : launchProgram);
  let fallbackChild = null;
  const notifyFn = o.notifyFn ?? notify;
  const script = o.script ?? TRAY_SCRIPT;
  const icon = o.icon ?? TRAY_ICON;
  return {
    start(info = {}) {
      try {
        if (platform === 'win32') {
          const args = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script,
            '-Result', String(info.resultFile), '-RunnerPid', String(info.runnerPid ?? process.pid),
            '-Log', String(info.logFile ?? ''), '-Title', TITLE, '-StartText', startText(info)];
          if (info.run) args.push('-Run', String(info.run));
          if (existsSync(icon)) args.push('-Icon', icon);
          // Started through the launcher (CIM Win32_Process.Create): the helper must outlive the runner, which exits right after
          // the final result, or the closing balloon is never shown. Node puts a NON-detached child in a kill-on-close job, so a
          // plain spawn dies with the runner; a detached powershell.exe ignores windowsHide and shows a console.
          if (launchFn) {
            const r = launchFn(powershellExe(env), args, { env });
            if (r?.ok) return;
          }
          // fallback: a plain hidden child (it ends with the runner, so end() waits for it)
          const child = spawnFn('powershell.exe', args, { windowsHide: true, stdio: 'ignore' });
          child.on?.('error', () => {});
          child.unref?.();
          fallbackChild = child;
          return;
        }
        notifyFn(TITLE, startText(info), { tag: 'accounts-progress' });
      } catch { /* the indicator is never worth failing the go-live over */ }
    },
    end(result = {}) {
      try {
        // Windows: the helper reads the final result itself and shows the closing balloon. One started outside the runner's job
        // needs nothing more; a plain child is waited for, or it would be killed with the runner before it read the result.
        if (platform === 'win32') {
          const child = fallbackChild; fallbackChild = null;
          if (!child?.once) return undefined;
          return new Promise((resolve) => { const t = setTimeout(resolve, o.endWaitMs ?? END_WAIT_MS); t.unref?.(); child.once('exit', () => { clearTimeout(t); resolve(); }); });
        }
        notifyFn(TITLE, result.headline ?? endText(result.status), { tag: 'accounts-progress', persist: result.status !== 'ok' });
      } catch { /* best effort */ }
    },
  };
}
