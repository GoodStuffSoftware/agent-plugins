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

import { execFile } from 'node:child_process';

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
