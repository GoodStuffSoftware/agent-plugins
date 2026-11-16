/**
 * launcher.mjs - the ONE way this plugin starts a long-lived background process of its own
 * (the account waiter and the go-live runner).
 *
 * The process must outlive the desktop app's quit AND the launching session being archived or
 * the account being switched. The app ends a session's whole process job on archive, delete and
 * account switch, and a plain `detached` node child stays inside that job. So:
 *
 *   Windows        CIM Win32_Process.Create (via a hidden powershell): the child belongs to the
 *                  WMI provider host, outside every job and outside the app's process tree.
 *                  Started hidden (ShowWindow 0; a CreateFlags value is rejected with code 21). If CIM is unavailable it
 *                  falls back to a detached spawn and says so in `method`.
 *   macOS, Linux   a detached spawn (node calls setsid), so the child leads its own session.
 *
 * Every spawn sets windowsHide. Test seams (never set in production):
 *   SESSION_SYNC_TEST_LAUNCH_LOG=<file>  append the request as a JSON line and start nothing
 *   SESSION_SYNC_TEST_LAUNCH=spawn       always use the detached spawn (no CIM)
 */

import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CLI_PATH = join(HERE, '..', 'cli.mjs');
const PRELOAD = join(HERE, 'launch-env.mjs');

/** Variables a CIM child needs, because it starts with the machine environment, not ours. */
const FORWARD_ALWAYS = /^(SESSION_SYNC_|CLAUDE_SESSION_SYNC_|CLAUDE_PLUGIN_OPTION_)/;
const FORWARD_NAMES = ['RCLONE_CONFIG', 'RCLONE_PATH'];
/** Only when the app-state seam is set (a sandbox): the redirected home and app-data roots. */
const SANDBOX_NAMES = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME'];

export function forwardedEnv(env = process.env) {
  const out = {};
  const sandbox = !!env.SESSION_SYNC_TEST_APP_STATE;
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string') continue;
    if (FORWARD_ALWAYS.test(k) || FORWARD_NAMES.includes(k) || (sandbox && SANDBOX_NAMES.includes(k))) out[k] = v;
  }
  return out;
}

const q = (s) => (/[\s"]/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : String(s));

const CIM_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }',
  '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:SS_LAUNCH_CMD; ProcessStartupInformation = $si }',
  '[pscustomobject]@{ rc = [int]$r.ReturnValue; pid = [int]$r.ProcessId } | ConvertTo-Json -Compress',
].join('; ');

/**
 * Start `node cli.mjs <args>` as a background process that survives its launcher.
 * @param {string[]} args  CLI arguments, e.g. ['accounts', 'wait', '--reason', 'link']
 * @param {object} o  { ctx, env, platform, spawnFn (spawn), spawnSyncFn (spawnSync), execPath, cli }
 * @returns {{ok:boolean, pid:number|null, method:string, error?:string}}  never throws
 */
export function launchDetached(args, o = {}) {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const execPath = o.execPath ?? process.execPath;
  const cli = o.cli ?? CLI_PATH;
  try {
    if (env.SESSION_SYNC_TEST_LAUNCH_LOG) {
      mkdirSync(dirname(env.SESSION_SYNC_TEST_LAUNCH_LOG), { recursive: true });
      appendFileSync(env.SESSION_SYNC_TEST_LAUNCH_LOG, `${JSON.stringify({ args })}\n`);
      return { ok: true, pid: null, method: 'test-log' };
    }
    if (platform === 'win32' && env.SESSION_SYNC_TEST_LAUNCH !== 'spawn') {
      const r = launchCim(args, { ...o, env, execPath, cli });
      if (r.ok) return r;
      const fb = launchSpawn(args, { ...o, env, execPath, cli });
      return fb.ok ? { ...fb, method: 'spawn-fallback', note: `CIM launch failed: ${r.error}` } : fb;
    }
    return launchSpawn(args, { ...o, env, execPath, cli });
  } catch (e) {
    return { ok: false, pid: null, method: 'none', error: String(e?.message ?? e) };
  }
}

function launchSpawn(args, { env, execPath, cli, spawnFn = nodeSpawn }) {
  const child = spawnFn(execPath, [cli, ...args], { detached: true, stdio: 'ignore', windowsHide: true, env });
  child.on?.('error', () => {});
  child.unref?.();
  return { ok: !!child.pid, pid: child.pid ?? null, method: 'detached-spawn' };
}

function launchCim(args, { ctx, env, execPath, cli, spawnSyncFn = spawnSync }) {
  const forward = forwardedEnv(env);
  const tail = [];
  let envFile = null;
  if (Object.keys(forward).length) {
    const dir = ctx?.acc ?? env.TEMP ?? env.TMP ?? '.';
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `launch-env-${randomBytes(6).toString('hex')}.json`);
    writeFileSync(file, JSON.stringify(forward));
    envFile = file;
    tail.push('--ss-env-file', file);
  }
  const cmd = [q(execPath), '--import', q(pathToFileURL(PRELOAD).href), q(cli), ...args.map(q), ...tail.map(q)].join(' ');
  const r = spawnSyncFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', CIM_SCRIPT], {
    windowsHide: true, encoding: 'utf8', timeout: 30000, env: { ...env, SS_LAUNCH_CMD: cmd },
  });
  const fail = (error) => { if (envFile) { try { unlinkSync(envFile); } catch { /* gone */ } } return { ok: false, pid: null, method: 'cim', error }; };
  if (!r || r.error || r.status !== 0) return fail(String(r?.error?.message ?? r?.stderr ?? 'powershell failed').trim().slice(0, 300));
  let out = null;
  try { out = JSON.parse(String(r.stdout).trim().split(/\r?\n/).pop()); } catch { /* unparsed */ }
  if (!out || out.rc !== 0) return fail(`Win32_Process.Create returned ${out?.rc ?? 'no result'}`);
  return { ok: true, pid: out.pid || null, method: 'cim' };
}
