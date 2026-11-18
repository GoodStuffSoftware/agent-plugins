/**
 * proc.mjs - which conversations have a Claude CLI running right now (0.5.7).
 *
 * The desktop app starts one `claude.exe ... --resume <conversation id>` per running Code session, and that process holds the session's
 * Remote Control link in memory. A link may only be cleared in the transcript while no such process exists, so the live relink asks the
 * OS first. One hidden PowerShell call reads the command line of every `claude.exe`; only the conversation ids are kept (a command line
 * can carry other flags and paths, and is never printed, logged or stored).
 *
 * The answer is a Set of lower-case ids, or null for "unknown": the OS could not be asked, the script did not reach its end marker, or a
 * `claude.exe` had no readable command line. Unknown means clear nothing.
 *
 * Windows only (the live relink is a Windows feature); elsewhere the answer is null. Test seam: `o.execFileFn` (child_process.execFile).
 */

import { execFile, spawnSync } from 'node:child_process';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** `--resume <id>`, `--resume=<id>`, and the same for `--session-id` (a session the app started fresh), optionally quoted. */
const ID_FLAG = new RegExp(`--(?:resume|session-id)(?:=|\\s+)["']?(${UUID})`, 'gi');

export const END_MARK = 'ok-end';
const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  `Get-CimInstance -ClassName Win32_Process -Filter "Name='claude.exe'" | ForEach-Object { 'P' + [char]9 + [string]$_.CommandLine }`,
  `'${END_MARK}'`,
].join('; ');

/** The ids named by the script's output, or null when the output is not a complete, readable listing. */
export function parseCliIds(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l !== '');
  if (lines[lines.length - 1] !== END_MARK) return null;
  const ids = new Set();
  for (const l of lines.slice(0, -1)) {
    if (!l.startsWith('P\t')) return null;
    const cmd = l.slice(2);
    if (!cmd.trim()) return null;                     // a process whose command line cannot be read could be a live CLI
    ID_FLAG.lastIndex = 0;
    for (let m = ID_FLAG.exec(cmd); m; m = ID_FLAG.exec(cmd)) ids.add(m[1].toLowerCase());
  }
  return ids;
}

/**
 * @param {{platform?:string, timeoutMs?:number, execFileFn?:Function}} o
 * @returns {Promise<Set<string>|null>}
 */
export function liveCliIds(o = {}) {
  if ((o.platform ?? process.platform) !== 'win32') return Promise.resolve(null);
  const run = o.execFileFn ?? execFile;
  return new Promise((resolve) => {
    try {
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT],
        { windowsHide: true, timeout: o.timeoutMs ?? 15000, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => resolve(err ? null : parseCliIds(stdout)));
    } catch { resolve(null); }
  });
}

/* ------------------------------------------------------------------ pids (0.5.8, accounts rc-repair) */

const PID_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  `Get-CimInstance -ClassName Win32_Process -Filter "Name='claude.exe'" | ForEach-Object { 'P' + [char]9 + [string]$_.ProcessId + [char]9 + [string]$_.CommandLine }`,
  `'${END_MARK}'`,
].join('; ');
const RESUME_FLAG = new RegExp(`--resume(?:=|\\s+)["']?(${UUID})`, 'gi');

/**
 * The claude.exe processes of the listing as [{pid, ids:[every conversation id named by --resume or --session-id], resume:[ids named by --resume]}],
 * or null when the listing is not complete and readable. Only pids and ids are kept; a command line is never stored or printed.
 */
export function parseCliProcs(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l !== '');
  if (lines[lines.length - 1] !== END_MARK) return null;
  const out = [];
  for (const l of lines.slice(0, -1)) {
    const m = /^P\t(\d+)\t([\s\S]*)$/.exec(l);
    if (!m || !m[2].trim()) return null;
    const grab = (re) => { const ids = []; re.lastIndex = 0; for (let x = re.exec(m[2]); x; x = re.exec(m[2])) ids.push(x[1].toLowerCase()); return ids; };
    out.push({ pid: Number(m[1]), ids: grab(ID_FLAG), resume: grab(RESUME_FLAG) });
  }
  return out;
}

/** @returns {Promise<Array<{pid:number, ids:string[], resume:string[]}>|null>}  Windows only; null elsewhere or when unknown. */
export function liveCliProcs(o = {}) {
  if ((o.platform ?? process.platform) !== 'win32') return Promise.resolve(null);
  const run = o.execFileFn ?? execFile;
  return new Promise((resolve) => {
    try {
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PID_SCRIPT],
        { windowsHide: true, timeout: o.timeoutMs ?? 15000, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => resolve(err ? null : parseCliProcs(stdout)));
    } catch { resolve(null); }
  });
}

/** Stop the given pids (hidden, one taskkill each, that process only). Returns the pids taskkill reported as stopped. Test seam: o.spawnSyncFn. */
export function stopPids(pids, o = {}) {
  const run = o.spawnSyncFn ?? spawnSync;
  const done = [];
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const r = run('taskkill.exe', ['/PID', String(pid), '/F'], { windowsHide: true, stdio: 'ignore', timeout: 15000 });
    if (r && r.status === 0) done.push(pid);
  }
  return done;
}
