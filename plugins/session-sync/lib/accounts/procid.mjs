/**
 * procid.mjs - is this pid really the background process a claim file says it is?
 *
 * A live pid is not proof: a runner or waiter that died without releasing its claim leaves a pid the OS hands to the next new
 * process, and ending that pid would end an unrelated program. Before this plugin ends a process it asks the OS for the
 * process's command line and creation time and requires both to match the claim:
 *
 *   Windows        CIM Win32_Process (CommandLine, CreationDate) through a hidden powershell
 *   macOS, Linux   `ps -o lstart= -o command= -p <pid>` with LC_ALL=C (lstart has whole seconds)
 *
 * Every spawn sets windowsHide. Test seam: `o.spawnSyncFn` (spawnSync) and `o.platform`.
 */

import { spawnSync } from 'node:child_process';

/** ps reports whole seconds, and the claim is stamped a moment after the process began: allow this much slack. */
export const START_SLACK_MS = 2000;

const WIN_SCRIPT = (pid) => [
  "$ErrorActionPreference = 'Stop'",
  `$p = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${pid}'`,
  'if (-not $p) { [pscustomobject]@{ gone = $true } | ConvertTo-Json -Compress; exit 0 }',
  '[pscustomobject]@{ cmd = [string]$p.CommandLine; at = ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress',
].join('; ');

/**
 * The command line and creation time of a pid.
 * @returns {{commandLine:string, startedAtMs:number}|{gone:true}|null}  null when the OS could not be asked (the caller must not guess)
 */
export function processInfo(pid, o = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const platform = o.platform ?? process.platform;
  const run = o.spawnSyncFn ?? spawnSync;
  try {
    if (platform === 'win32') {
      const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_SCRIPT(pid)], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
      if (!r || r.error || r.status !== 0) return null;
      const j = JSON.parse(String(r.stdout).trim().split(/\r?\n/).pop());
      if (j.gone) return { gone: true };
      const at = Number(j.at);
      return Number.isFinite(at) && at > 0 ? { commandLine: String(j.cmd ?? ''), startedAtMs: at } : null;
    }
    const r = run('ps', ['-o', 'lstart=', '-o', 'command=', '-p', String(pid)], { windowsHide: true, encoding: 'utf8', timeout: 10000, env: { ...process.env, LC_ALL: 'C' } });
    if (!r || r.error) return null;
    const line = String(r.stdout ?? '').split(/\r?\n/).find((l) => l.trim());
    if (!line) return r.status === 1 ? { gone: true } : null;   // ps exits 1 when the pid does not exist
    const m = /^\s*([A-Za-z]{3} [A-Za-z]{3}\s+\d{1,2} \d\d:\d\d:\d\d \d{4})\s+(.*)$/.exec(line);
    const at = m ? Date.parse(m[1]) : NaN;
    return m && Number.isFinite(at) ? { commandLine: m[2], startedAtMs: at } : null;
  } catch { return null; }
}

/**
 * Is `pid` the process the claim describes? Its command line must match `marker` and it must have started no later than the claim
 * was written (a pid reused after the claimant died belongs to a process created later).
 * @param {number} pid
 * @param {{marker:RegExp, claimedAt:number, info?:Function}} want  `info(pid)` replaces processInfo (tests)
 * @returns {{ok:boolean, reason:'match'|'unverified'|'gone'|'other-command'|'newer-process', info?:object}}
 *   unverified: the OS could not be asked, so nothing may be concluded and nothing may be ended
 */
export function verifyProcess(pid, want, o = {}) {
  const info = (want.info ?? ((p) => processInfo(p, o)))(pid);
  if (!info) return { ok: false, reason: 'unverified' };
  if (info.gone) return { ok: false, reason: 'gone' };
  if (!want.marker.test(info.commandLine)) return { ok: false, reason: 'other-command', info };
  if (Number.isFinite(want.claimedAt) && info.startedAtMs > want.claimedAt + START_SLACK_MS) return { ok: false, reason: 'newer-process', info };
  return { ok: true, reason: 'match', info };
}

/** The runner (`accounts golive-run`) and the waiter (`accounts wait`) as they appear on a command line. */
export const RUNNER_MARKER = /\bgolive-run\b/;
export const WAITER_MARKER = /\baccounts\s+wait\b/;
