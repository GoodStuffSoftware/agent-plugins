/**
 * config.mjs — user settings, editable conversationally.
 *
 * An environment variable is a bad home for "where do my backups go". You can't
 * see it, you set it differently on every OS, a scheduled task or hook may not
 * inherit it, and you cannot ask Claude to change it. So the real setting lives
 * in a small JSON file next to the sync state, and the skills read and write it.
 *
 *   ~/.claude/session-sync/config.json
 *
 * Precedence, highest first:
 *   1. CLAUDE_SESSION_SYNC_REMOTE   (env — for CI or a one-off override)
 *   2. config.json
 *   3. the built-in default
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export const STATE_DIR = join(homedir(), '.claude', 'session-sync');
export const CONFIG_FILE = join(STATE_DIR, 'config.json');

/** Remote Control restore (accounts/rcrestore.mjs). Defined here, with the other settings; rcrestore.mjs re-exports it. */
export const RC_DEFAULTS = Object.freeze({ enabled: true, days: 3, wake: true, wakeMax: 4 });

/** The `rcRestore` settings from a loaded config, validated: a partial block keeps the other defaults, a bad value falls back. */
export function rcSettings(cfg = {}) {
  const raw = cfg?.rcRestore && typeof cfg.rcRestore === 'object' ? cfg.rcRestore : {};
  const days = Number(raw.days);
  const wakeMax = Number(raw.wakeMax);
  return {
    enabled: raw.enabled === undefined ? RC_DEFAULTS.enabled : raw.enabled !== false,
    days: Number.isFinite(days) && days >= 1 && days <= 90 ? days : RC_DEFAULTS.days,
    wake: raw.wake === undefined ? RC_DEFAULTS.wake : raw.wake !== false,
    wakeMax: Number.isInteger(wakeMax) && wakeMax >= 1 && wakeMax <= 50 ? wakeMax : RC_DEFAULTS.wakeMax,
  };
}

export const DEFAULTS = Object.freeze({
  // <rclone remote>:<path>. The path is yours — put it wherever you keep things.
  remote: 'gdrive:Claude/live',
  // Turn syncing off on one machine without uninstalling (e.g. a shared box).
  enabled: true,
  // Desktop notifications for sync start/finish. Failures always notify;
  // this is the master kill switch — false silences EVERYTHING, failures
  // included, because that's a deliberate opt-out, not a filter.
  notifications: true,
  // How chatty ROUTINE (non-failure) toasts are, once `notifications` is true:
  //   'all'       — a toast for every start and every success (the old, only,
  //                 behaviour — noisy on a machine with many short sessions).
  //   'first-run' — show the routine "backing up" / "backed up" / "restored"
  //                 toasts once, ever, to confirm the plugin is alive, then
  //                 go quiet. DEFAULT.
  //   'failures'  — routine toasts never show; only failures and conflicts do.
  // Failures, the pull "please wait" warning, and conflict notices are NEVER
  // gated by this — see notify.mjs's own doc comment on `persist`.
  notifyMode: 'first-run',
  // Minimum minutes between two successful pushes, independent of the sync
  // lock. The lock only stops two pushes running AT ONCE; on its own, a hook
  // that fires seconds after the last one finished gets a fresh lock instantly
  // and syncs again. This is what actually caps "N conversations in an hour
  // = N syncs." auto-pull's cheap remoteNewer() check is never throttled by
  // this — only the expensive, notifying pull() call is.
  debounceMinutes: 5,
  // Extra rclone --exclude patterns, on top of the built-in credential excludes.
  extraExcludes: [],
  // Several claude.ai accounts signed into the desktop app on this machine:
  //   'ask'  — ask once (via the SessionStart hook) whether to share conversations,
  //            tasks and settings between them. DEFAULT.
  //   'auto' — share without asking.
  //   'off'  — never ask, never touch the per-account folders.
  // Env CLAUDE_PLUGIN_OPTION_ACCOUNTLINK overrides the file when set to a valid value.
  accountLink: 'ask',
  // While the account go-live runs with Claude closed, show progress: a tray icon with the current step and a start and end
  // balloon on Windows, a start and end notification on macOS and Linux. false: nothing is shown (the go-live still runs).
  progressIcon: true,
  // Remote Control restore after a restart of the Claude desktop app (accounts/rcrestore.mjs). Windows only; elsewhere it does nothing.
  //   enabled: relink stale links and mark sessions so the app reconnects them at its next start (free, no model turn)
  //   days:    only sessions active within this many days are looked at (1-90)
  //   wake:    after the restart, the first prompt of one session wakes the rest with one short turn each (costs a turn per session)
  rcRestore: RC_DEFAULTS,
});

export const ACCOUNT_LINK_MODES = Object.freeze(['ask', 'auto', 'off']);

export function loadConfig() {
  let file = {};
  try { file = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch { /* absent or corrupt -> defaults */ }
  const cfg = { ...DEFAULTS, ...file };
  cfg.rcRestore = rcSettings(file);   // nested: a partial block keeps the other defaults, a bad value falls back
  const fromEnv = String(process.env.CLAUDE_PLUGIN_OPTION_ACCOUNTLINK ?? '').trim().toLowerCase();
  const fromFile = String(cfg.accountLink ?? '').trim().toLowerCase();
  // an unknown value never enables linking: it falls back to the default ('ask')
  cfg.accountLink = ACCOUNT_LINK_MODES.includes(fromEnv) ? fromEnv
    : ACCOUNT_LINK_MODES.includes(fromFile) ? fromFile : DEFAULTS.accountLink;
  // env wins, but only when actually set to something
  if (process.env.CLAUDE_SESSION_SYNC_REMOTE) {
    cfg.remote = process.env.CLAUDE_SESSION_SYNC_REMOTE;
    cfg.remoteFrom = 'env';
  } else {
    cfg.remoteFrom = file.remote ? 'config' : 'default';
  }
  return cfg;
}

export function saveConfig(patch) {
  let current = {};
  try { current = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  const next = { ...current, ...patch };
  if (patch.rcRestore && typeof patch.rcRestore === 'object') next.rcRestore = { ...(current.rcRestore && typeof current.rcRestore === 'object' ? current.rcRestore : {}), ...patch.rcRestore };
  // Never persist derived fields
  delete next.remoteFrom;
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n');
  return next;
}

/**
 * Validate a remote string before we save it — a typo here means backups
 * silently going nowhere, which is the failure mode this whole plugin is
 * paranoid about. This checks SHAPE only; whether the remote exists is
 * answered by rclone in preflight.
 */
export function validateRemote(remote) {
  if (typeof remote !== 'string' || !remote.trim()) {
    return { ok: false, error: 'Remote must be a non-empty string, e.g. "gdrive:Claude/live".' };
  }
  const s = remote.trim();
  const idx = s.indexOf(':');
  if (idx < 1) {
    return { ok: false, error: `"${s}" is missing the remote name. Use "<remote>:<path>", e.g. "gdrive:Claude/live" or "s3:my-bucket/claude".` };
  }
  const name = s.slice(0, idx);
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    return { ok: false, error: `"${name}" is not a valid rclone remote name (letters, digits, _ . - only).` };
  }
  if (s.includes('\\')) {
    return { ok: false, error: 'Use forward slashes in the remote path.' };
  }
  const path = s.slice(idx + 1);
  if (!path) {
    return {
      ok: true, value: s, name, path: '',
      warning: `"${s}" writes to the ROOT of that remote. Consider a subfolder like "${name}:Claude/live" so the backup does not mix with your other files.`,
    };
  }
  return { ok: true, value: s, name, path };
}

/** Human-readable summary for the status/setup skills. */
export function describeConfig(cfg = loadConfig()) {
  const v = validateRemote(cfg.remote);
  return {
    remote: cfg.remote,
    remoteName: v.ok ? v.name : null,
    remotePath: v.ok ? v.path : null,
    source: cfg.remoteFrom,          // env | config | default
    enabled: cfg.enabled !== false,
    notifications: cfg.notifications !== false,
    notifyMode: cfg.notifyMode || DEFAULTS.notifyMode,
    debounceMinutes: Number.isFinite(cfg.debounceMinutes) ? cfg.debounceMinutes : DEFAULTS.debounceMinutes,
    accountLink: cfg.accountLink || DEFAULTS.accountLink,
    progressIcon: cfg.progressIcon !== false,
    rcRestore: rcSettings(cfg),
    extraExcludes: cfg.extraExcludes || [],
    configFile: CONFIG_FILE,
    configExists: existsSync(CONFIG_FILE),
    valid: v.ok,
    problem: v.ok ? (v.warning || null) : v.error,
  };
}
