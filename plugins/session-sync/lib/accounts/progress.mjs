/**
 * progress.mjs - what the user sees while the go-live runner works with Claude closed (config `progressIcon`, default on).
 *
 * The runner calls `ui.start(info)` when the link begins (phase relist onward) and `ui.end(result)` after the final result is
 * written. Everything the user reads is plain words from this file:
 *
 *   Windows        a tray icon from a hidden helper (progress-tray.ps1: a NotifyIcon and a message loop, no window, no focus).
 *                  Its tooltip is "Syncing accounts: <step>", a balloon opens and closes the run, a double click (or a click on
 *                  the balloon) opens the go-live log. The helper reads the step from `go-live-result.json` (`progress`), never
 *                  from the runner, so it cannot block it, and it removes the icon and exits on its own when the runner dies.
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

/** The `progress` block of go-live-result.json: what the helper shows, in words. `headline` only once the result is final. */
export function progressInfo(phase, status, finalStatuses = ['ok', 'rolled_back', 'attention', 'failed']) {
  const final = finalStatuses.includes(status);
  return { step: stepWord(phase), tooltip: tooltipFor(phase), headline: final ? endText(status) : null };
}

/** A UI that shows nothing. */
export const nullUi = Object.freeze({ start() {}, end() {} });

/**
 * @param {object} o  { enabled (config progressIcon), platform, spawnFn, notifyFn, env, script, icon }
 * @returns {{start(info), end(result)}}  never throws
 *   start(info): { resultFile, logFile, runnerPid, noRelaunch }
 *   end(result): { status, headline }
 */
export function createProgressUi(o = {}) {
  const env = o.env ?? process.env;
  if (o.enabled === false) return nullUi;
  if (env.SESSION_SYNC_TEST_APP_STATE && !env.SESSION_SYNC_TEST_PROGRESS_UI) return nullUi;
  const platform = o.platform ?? process.platform;
  const spawnFn = o.spawnFn ?? spawn;
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
          if (existsSync(icon)) args.push('-Icon', icon);
          // not detached: a detached child ignores windowsHide and shows a console; a plain child outlives its parent on Windows
          const child = spawnFn('powershell.exe', args, { windowsHide: true, stdio: 'ignore' });
          child.on?.('error', () => {});
          child.unref?.();
          return;
        }
        notifyFn(TITLE, startText(info), { tag: 'accounts-progress' });
      } catch { /* the indicator is never worth failing the go-live over */ }
    },
    end(result = {}) {
      try {
        // Windows: the helper reads the final result itself and shows the closing balloon
        if (platform === 'win32') return;
        notifyFn(TITLE, result.headline ?? endText(result.status), { tag: 'accounts-progress', persist: result.status !== 'ok' });
      } catch { /* best effort */ }
    },
  };
}
