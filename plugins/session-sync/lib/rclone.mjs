/**
 * rclone.mjs — find rclone, find its config, and run it with flags that survive
 * syncing files Claude is actively writing.
 *
 * Each of the workarounds below is here because it broke a real sync, not because
 * it seemed prudent. Dates are when the failure was observed.
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/**
 * Locate the rclone binary.
 * WHY NOT JUST `rclone`: winget installs it to a VERSIONED directory
 *   %LOCALAPPDATA%\Microsoft\WinGet\Packages\Rclone.Rclone_<hash>\rclone-v1.75.0-windows-amd64\
 * which is on the interactive PATH but not necessarily on a hook's or scheduled
 * task's PATH. A plain `rclone` lookup reported "not installed" on a machine
 * where it was installed and working. (2026-08-30)
 */
export function findRclone() {
  const exe = platform() === 'win32' ? 'rclone.exe' : 'rclone';
  const home = homedir();

  const direct = [
    process.env.RCLONE_PATH,
    platform() === 'win32' ? join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', exe) : null,
    platform() === 'win32' ? join(process.env.ProgramFiles || '', 'rclone', exe) : null,
    '/usr/bin/rclone', '/usr/local/bin/rclone', '/opt/homebrew/bin/rclone',
  ].filter(Boolean);

  for (const p of direct) if (isFile(p)) return p;

  // PATH lookup
  const pathDirs = (process.env.PATH || '').split(platform() === 'win32' ? ';' : ':');
  for (const d of pathDirs) {
    if (!d) continue;
    const p = join(d, exe);
    if (isFile(p)) return p;
  }

  // winget's versioned package dir — walk one level of subdirs
  if (platform() === 'win32' && process.env.LOCALAPPDATA) {
    const pkgRoot = join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
    const hit = findShallow(pkgRoot, exe, 3);
    if (hit) return hit;
  }
  return null;
}

/**
 * Locate rclone.conf EXPLICITLY and always pass it with --config.
 * WHY: rclone resolves its config through %APPDATA%, which the MSIX-packaged
 * Claude desktop app redirects for child processes. Every scheduled sync died
 * instantly with `didn't find section in config file ("gdrive")` while the same
 * command worked by hand — for a full day, reporting a clean-looking skip.
 * (2026-08-30)
 */
export function findRcloneConf() {
  const home = homedir();
  const candidates = [
    process.env.RCLONE_CONFIG,
    platform() === 'win32' ? join(home, 'AppData', 'Roaming', 'rclone', 'rclone.conf') : null,
    process.env.APPDATA ? join(process.env.APPDATA, 'rclone', 'rclone.conf') : null,
    join(home, '.config', 'rclone', 'rclone.conf'),
    join(home, '.rclone.conf'),
  ].filter(Boolean);

  for (const p of candidates) if (isFile(p)) return p;
  return null;
}

/** Does the config actually define this remote? Existing isn't enough. */
export function hasRemote(remoteName, confPath = findRcloneConf()) {
  if (!confPath) return false;
  try {
    const txt = readFileSync(confPath, 'utf8');
    return new RegExp(`^\\[${remoteName}\\]`, 'm').test(txt);
  } catch { return false; }
}

/**
 * Flags for copying a tree Claude may be writing RIGHT NOW.
 *
 *  --local-no-check-updated  transcripts are append-only and grow mid-copy;
 *      without this rclone aborts with "source file is being updated" /
 *      "corrupted on transfer: md5 hashes differ". A slightly-short copy is
 *      harmless — the next sync corrects it. Never syncing is the real failure.
 *  --ignore-checksum         same reason: don't fail a file whose hash moved.
 *  --update                  newest-wins per file; never let an older copy win.
 *  --tpslimit / --transfers  rclone's SHARED Google client_id has a small global
 *      quota; ~9,500 transcript files hit rateLimitExceeded and failed every
 *      2-hourly sync for a day. Pacing keeps us under it. The real fix is your
 *      own client_id — see the setup skill. (2026-08-30)
 */
export function copyFlags({ paced = true } = {}) {
  const f = [
    '--update',
    '--local-no-check-updated',
    '--ignore-checksum',
    '--retries', '3',
    '--low-level-retries', '10',
    '--log-level', 'ERROR',
  ];
  if (paced) {
    f.push('--transfers', '4', '--checkers', '8',
           '--tpslimit', '8', '--tpslimit-burst', '8',
           '--drive-pacer-min-sleep', '100ms');
  }
  return f;
}

/** Run rclone, always injecting --config. Resolves { code, stdout, stderr }. */
export function runRclone(args, { rclone = findRclone(), conf = findRcloneConf(), onLine } = {}) {
  return new Promise((resolve, reject) => {
    if (!rclone) return reject(new Error('rclone not found — run /session-sync:setup'));
    const full = conf ? [...args, '--config', conf] : args;
    const child = spawn(rclone, full, { windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; onLine?.(String(d).trim()); });
    child.stderr.on('data', (d) => { stderr += d; onLine?.(String(d).trim()); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function isFile(p) {
  try { return !!p && statSync(p).isFile(); } catch { return false; }
}

function findShallow(root, name, depth) {
  if (depth <= 0 || !existsSync(root)) return null;
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return p;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const hit = findShallow(join(root, e.name), name, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}
