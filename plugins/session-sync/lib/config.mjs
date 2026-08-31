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

export const DEFAULTS = Object.freeze({
  // <rclone remote>:<path>. The path is yours — put it wherever you keep things.
  remote: 'gdrive:Claude/live',
  // Turn syncing off on one machine without uninstalling (e.g. a shared box).
  enabled: true,
  // Desktop notifications for sync start/finish. Failures always notify.
  notifications: true,
  // Extra rclone --exclude patterns, on top of the built-in credential excludes.
  extraExcludes: [],
});

export function loadConfig() {
  let file = {};
  try { file = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch { /* absent or corrupt -> defaults */ }
  const cfg = { ...DEFAULTS, ...file };
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
    extraExcludes: cfg.extraExcludes || [],
    configFile: CONFIG_FILE,
    configExists: existsSync(CONFIG_FILE),
    valid: v.ok,
    problem: v.ok ? (v.warning || null) : v.error,
  };
}
