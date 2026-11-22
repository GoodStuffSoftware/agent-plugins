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
 *  `retries` is rclone's WHOLE-RUN retry count. push() passes 1: rclone cannot
 *      retry only the files that failed, so with 3 one volatile file re-ran the
 *      whole 15 to 70 minute pass up to three times (observed 2026-11-21).
 *      push() retries the failed files itself, from a stable snapshot.
 *
 *  --local-no-check-updated is NOT enough on its own (rclone v1.74.0, checked):
 *      a file that only GROWS is cut off at the size rclone stat'ed (a clean
 *      prefix, no error), but a file REWRITTEN shorter still fails with
 *      "corrupted on transfer: sizes differ", and a file that vanished fails
 *      with "failed to open source object". That is what failed every push on
 *      2026-11-20/21, so the per-file handling below exists.
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
export function copyFlags({ paced = true, retries = 3 } = {}) {
  const f = [
    '--update',
    '--local-no-check-updated',
    '--ignore-checksum',
    '--retries', String(retries),
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

/**
 * Parse `rclone --use-json-log` output into events { level, msg, object }.
 * A line that is not JSON becomes { level: 'raw', msg: line }: anything we do
 * not understand later counts as a real failure, never as a skippable file.
 */
export function parseRcloneLog(text) {
  const events = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const j = JSON.parse(s);
      if (j && typeof j === 'object' && typeof j.msg === 'string') {
        events.push({ level: String(j.level || 'error'), msg: j.msg, object: typeof j.object === 'string' ? j.object : '' });
        continue;
      }
    } catch { /* not JSON */ }
    events.push({ level: 'raw', msg: s, object: '' });
  }
  return events;
}

/** One short log line per rclone JSON event (the src(...)/dst(...) descriptions are noise). */
export function formatRcloneLine(line) {
  return parseRcloneLog(line)
    .map((e) => `${e.level === 'raw' ? '' : e.level.toUpperCase() + ' '}${e.object ? e.object + ': ' : ''}${e.msg}`
      .replace(/\b(src|dst)\([^)]*\)/g, '$1').slice(0, 400))
    .join('\n');
}

// rclone's end-of-attempt lines ("Attempt 1/1 failed with 3 errors and: ...") name no object.
const SUMMARY_LINE = /^(Attempt \d+\/\d+ |Failed to \w+ with \d+ errors?)/;
// Errors that say the SOURCE file misbehaved while it was read (as opposed to the remote refusing it).
const SOURCE_SIDE = /sizes differ|hashes? differ|source file is being updated|failed to open source object|being used by another process/i;
// A local-remote copy writes to "<name>.<8 hex>.partial" and reports errors under that name.
const PARTIAL_SUFFIX = /\.[0-9a-f]{8}\.partial$/;

/**
 * Split a failed copy's errors into files that misbehaved and real failures.
 *
 * A file is a "volatile file" (skip it now, send it later) only when rclone
 * names it as the object of the error AND it is one we asked rclone to copy AND
 * either its local state changed since the scan (changed size or mtime, or
 * gone) or the error is a source-side one. Everything else (no object, an
 * object we did not send, a remote-side error such as a quota or auth failure,
 * unparseable output) is fatal, so a real failure still fails the run.
 *
 * @param events      parseRcloneLog() output
 * @param known       (rel) => true for a path this copy was meant to send
 * @param localState  (rel) => 'gone' | 'changed' | 'same', judged against the scan
 * @returns {{ perFile: Map<string, {state: string, msg: string}>, fatal: string[] }}
 */
export function classifyCopyErrors(events, { known, localState }) {
  const perFile = new Map();
  const fatal = [];
  for (const e of events) {
    if (e.level !== 'error' && e.level !== 'critical' && e.level !== 'fatal' && e.level !== 'raw') continue;
    if (!e.object) {
      if (e.level === 'error' && SUMMARY_LINE.test(e.msg)) continue;
      fatal.push(e.msg);
      continue;
    }
    let rel = e.object.replace(/\\/g, '/');
    if (!known(rel) && known(rel.replace(PARTIAL_SUFFIX, ''))) rel = rel.replace(PARTIAL_SUFFIX, '');
    if (e.level !== 'error' || !known(rel)) { fatal.push(`${e.object}: ${e.msg}`); continue; }
    const state = localState(rel);
    if (state === 'same' && !SOURCE_SIDE.test(e.msg)) { fatal.push(`${rel}: ${e.msg}`); continue; }
    if (!perFile.has(rel)) perFile.set(rel, { state, msg: e.msg });
  }
  return { perFile, fatal };
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

/**
 * Is this remote actually a local filesystem path?
 *
 * Matters because the pacing flags exist for Google Drive's API quota. Applying
 * --tpslimit 8 to a USB copy throttles ~9,700 files to about twenty minutes for
 * no reason at all.
 *
 * rclone's own rule: "name:" is a remote if a remote by that name is configured;
 * a Windows drive letter is otherwise treated as a path. We mirror that, and
 * fall back to asking the filesystem.
 */
export function isLocalRemote(remote, conf = findRcloneConf()) {
  if (!remote) return false;
  const s = String(remote);
  if (s.startsWith('/') || s.startsWith('./') || s.startsWith('\\')) return true;
  const i = s.indexOf(':');
  if (i < 1) return true;                       // no remote prefix at all
  const name = s.slice(0, i);
  if (name.length === 1) return true;           // C:\... — a drive letter
  if (conf && hasRemote(name, conf)) return false;   // a real configured remote
  return existsSync(s);                          // otherwise: does it exist on disk?
}
