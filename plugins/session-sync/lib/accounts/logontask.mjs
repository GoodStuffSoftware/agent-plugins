/**
 * logontask.mjs - the hidden Windows "At log on" task that runs the Remote Control relink after a Windows restart (0.5.6).
 *
 * When the operator shuts Windows down instead of quitting Claude from the tray, the app dies with the session and the waiter never gets
 * to run its quit step (new processes cannot start while the session ends). The next logon is the first moment with time: Claude itself
 * starts about 85 s after logon (from the Run key). The task runs `accounts rc-restore --if-app-stopped` before that.
 *
 *   task      "session-sync RC restore", per current user, trigger "At log on", registered from an XML file (a logon trigger for
 *             the current user needs no elevation that way)
 *   action    wscript.exe //B //Nologo <dir>\rc-restore-logon.vbs     (no console, no flash)
 *   shim      the .vbs starts `node <dir>\rc-restore-logon.mjs` with window style 0
 *   launcher  the .mjs (a copy of rc-logon-launcher.mjs) resolves the newest installed session-sync copy and runs its CLI, so the
 *             task never points into a versioned plugin folder
 *
 * <dir> is ~/.claude/session-sync. Everything is injectable (dir, platform, scheduler runner, node path, user): the tests never register
 * a real task. Windows only; elsewhere every function is a no-op.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';
import { STATE_DIR, loadConfig, rcSettings } from '../config.mjs';

export const TASK_NAME = 'session-sync RC restore';
export const LAUNCHER_NAME = 'rc-restore-logon.mjs';
export const SHIM_NAME = 'rc-restore-logon.vbs';
export const STAMP_NAME = 'rc-restore-logon.json';
const HERE = dirname(fileURLToPath(import.meta.url));
export const LAUNCHER_SOURCE = join(HERE, 'rc-logon-launcher.mjs');
/** The automatic path re-asks the scheduler at most this often when nothing changed. */
export const VERIFY_EVERY_MS = 24 * 3600 * 1000;

const isWin = (o) => (o.platform ?? process.platform) === 'win32';
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The scheduler binary of this machine (full path: the task and the calls do not depend on PATH). */
export const schtasksExe = (env = process.env) => join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32', 'schtasks.exe');
export const wscriptExe = (env = process.env) => join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32', 'wscript.exe');

/** DOMAIN\user of the current user, as the task XML wants it. */
export function currentUser(env = process.env) {
  let name = env.USERNAME; try { name = userInfo().username || name; } catch { /* keep the env value */ }
  const dom = env.USERDOMAIN || env.COMPUTERNAME;
  return dom ? `${dom}\\${name}` : name;
}

/** The VBScript shim: runs the launcher with window style 0. The launcher sits next to it; node is the one that installed it, else PATH. */
export function shimText(nodePath) {
  const node = String(nodePath).replace(/"/g, '');
  return [
    "' session-sync: starts the RC restore launcher with no window (style 0). Written by session-sync; the next install rewrites it.",
    'On Error Resume Next',
    'Dim sh, fso, here, node',
    'Set sh = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'here = fso.GetParentFolderName(WScript.ScriptFullName)',
    `node = "${node}"`,
    'If Not fso.FileExists(node) Then node = "node"',
    `sh.Run """" & node & """ """ & here & "\\${LAUNCHER_NAME}""", 0, True`,
    '',
  ].join('\r\n');
}

/** The task definition. A logon trigger for the current user, run with the user's own rights, hidden window by the shim. */
export function taskXml({ user, shimPath, wscript }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>session-sync: after a Windows restart, resets stale Remote Control links before Claude starts. Runs hidden at log on. Remove with: accounts rc-restore uninstall-logon-task</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEsc(user)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEsc(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT20M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEsc(wscript)}</Command>
      <Arguments>//B //Nologo "${xmlEsc(shimPath)}"</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/** Test seam: SESSION_SYNC_TEST_SCHTASKS=<file> answers every scheduler call from a log file instead of running schtasks. */
export function fakeScheduler(file) {
  return (_exe, args) => {
    const op = String(args[0] ?? '').toLowerCase().replace(/^\//, '');
    let lines = []; try { lines = readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { /* none yet */ }
    const present = lines.reduce((p, l) => { const k = JSON.parse(l).op; return k === 'create' ? true : k === 'delete' ? false : p; }, false);
    appendFileSync(file, `${JSON.stringify({ op, args })}\n`);
    if (op === 'query') return { status: present ? 0 : 1, stdout: '', stderr: '' };
    if (op === 'delete' && !present) return { status: 1, stdout: '', stderr: 'not found' };
    return { status: 0, stdout: '', stderr: '' };
  };
}

/** The scheduler runner: injected, else the test seam, else the real schtasks (never under `node --test`). */
function schedulerOf(o) {
  if (o.run) return o.run;
  if (process.env.SESSION_SYNC_TEST_SCHTASKS) return fakeScheduler(process.env.SESSION_SYNC_TEST_SCHTASKS);
  if (process.env.NODE_TEST_CONTEXT || process.env.SESSION_SYNC_TEST_APP_STATE) return () => ({ status: 1, stdout: '', stderr: 'a test never registers a real scheduled task' });
  return (exe, args) => spawnSync(exe, args, { windowsHide: true, encoding: 'utf8', timeout: 20000 });
}

const dirOf = (o) => o.dir ?? STATE_DIR;
const stampFile = (o) => join(dirOf(o), STAMP_NAME);
const readStamp = (o) => { try { return JSON.parse(readFileSync(stampFile(o), 'utf8')); } catch { return null; } };

function writeIfChanged(file, content) {
  try { if (readFileSync(file).equals(content)) return false; } catch { /* absent */ }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
  return true;
}

/** What install would put on disk, and the hash that identifies it. */
function plan(o) {
  const dir = dirOf(o);
  const nodePath = o.nodePath ?? process.execPath;
  const user = o.user ?? currentUser();
  const launcher = readFileSync(o.launcherSource ?? LAUNCHER_SOURCE);
  const shim = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(shimText(nodePath), 'utf16le')]);   // UTF-16 LE with BOM: wscript reads non-ASCII paths right
  const shimPath = join(dir, SHIM_NAME);
  const xml = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml({ user, shimPath, wscript: wscriptExe(o.env) }), 'utf16le')]);
  const hash = createHash('sha256').update(launcher).update(shim).update(xml).digest('hex').slice(0, 16);
  return { dir, launcher, shim, shimPath, xml, hash, launcherPath: join(dir, LAUNCHER_NAME) };
}

const exists = (run, o) => {
  const r = run(schtasksExe(o.env), ['/Query', '/TN', TASK_NAME], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
  return !!r && r.status === 0;
};

/**
 * Write the launcher and the shim and (re)register the task. Idempotent: the files are rewritten only when they differ, and the task is
 * created with /F, so a second run changes nothing visible.
 * o: { dir, platform, run (scheduler runner), nodePath, user, env, now, launcherSource }
 * @returns {{ok:boolean, action:'installed'|'skipped', reason?:string, error?:string, task?:string, hash?:string}}
 */
export function installLogonTask(o = {}) {
  if (!isWin(o)) return { ok: true, action: 'skipped', reason: 'platform' };
  const run = schedulerOf(o);
  let p;
  try {
    p = plan(o);
    writeIfChanged(p.launcherPath, p.launcher);
    writeIfChanged(p.shimPath, p.shim);
  } catch (e) { return { ok: false, action: 'skipped', error: `could not write the launcher: ${String(e?.message ?? e).slice(0, 200)}` }; }
  const xmlFile = join(p.dir, `${STAMP_NAME}.${process.pid}.task.xml`);
  try {
    writeFileSync(xmlFile, p.xml);
    const r = run(schtasksExe(o.env), ['/Create', '/TN', TASK_NAME, '/XML', xmlFile, '/F'], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
    if (!r || r.status !== 0) return { ok: false, action: 'skipped', error: `schtasks /Create failed (status ${r?.status ?? 'none'}): ${String(r?.stderr || r?.error?.message || '').trim().slice(0, 300)}` };
  } catch (e) {
    return { ok: false, action: 'skipped', error: `schtasks /Create did not run: ${String(e?.message ?? e).slice(0, 200)}` };
  } finally { try { unlinkSync(xmlFile); } catch { /* none */ } }
  try { writeFileSync(stampFile(o), JSON.stringify({ v: 1, hash: p.hash, task: TASK_NAME, installedAt: new Date((o.now ?? Date.now)()).toISOString(), checkedAt: (o.now ?? Date.now)() })); } catch { /* the stamp only saves work */ }
  return { ok: true, action: 'installed', task: TASK_NAME, hash: p.hash, launcher: p.launcherPath, shim: p.shimPath };
}

/**
 * Remove the task and the files this module wrote. Idempotent: nothing to remove is a success.
 * @returns {{ok:boolean, action:'removed'|'not-installed'|'skipped', error?:string}}
 */
export function uninstallLogonTask(o = {}) {
  if (!isWin(o)) return { ok: true, action: 'skipped', reason: 'platform' };
  const run = schedulerOf(o);
  let had = false;
  try {
    had = exists(run, o);
    if (had) {
      const r = run(schtasksExe(o.env), ['/Delete', '/TN', TASK_NAME, '/F'], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
      if (!r || r.status !== 0) return { ok: false, action: 'skipped', error: `schtasks /Delete failed (status ${r?.status ?? 'none'}): ${String(r?.stderr || r?.error?.message || '').trim().slice(0, 300)}` };
    }
  } catch (e) { return { ok: false, action: 'skipped', error: `schtasks did not run: ${String(e?.message ?? e).slice(0, 200)}` }; }
  for (const f of [stampFile(o), join(dirOf(o), LAUNCHER_NAME), join(dirOf(o), SHIM_NAME)]) { try { unlinkSync(f); } catch { /* none */ } }
  return { ok: true, action: had ? 'removed' : 'not-installed' };
}

/**
 * The automatic setup (the SessionStart hook step, and `config rcRestore.logonTask`): install when rcRestore is enabled and rcRestore.logonTask
 * is on, remove it when either is off. Cheap on the usual run: a stamp holds the hash of what is installed, and the scheduler is asked again
 * only when that changed or a day has passed.
 * o: { settings (rcSettings of the config), force (ignore the stamp: the user asked now), + the options of installLogonTask }
 * @returns {{ok:boolean, action:'none'|'unchanged'|'installed'|'removed'|'not-installed'|'skipped', ...}}
 */
export function ensureLogonTask(o = {}) {
  if (!isWin(o)) return { ok: true, action: 'skipped', reason: 'platform' };
  const s = o.settings ?? rcSettings(loadConfig());
  const stamp = readStamp(o);
  if (!s.enabled || !s.logonTask) return stamp ? uninstallLogonTask(o) : { ok: true, action: 'none', reason: 'opted-out' };
  const now = (o.now ?? Date.now)();
  let p;
  try { p = plan(o); } catch (e) { return { ok: false, action: 'skipped', error: String(e?.message ?? e).slice(0, 200) }; }
  const same = !o.force && stamp?.hash === p.hash;
  if (same && stamp.failedAt && now - (Number(stamp.checkedAt) || 0) < VERIFY_EVERY_MS) return { ok: true, action: 'skipped', reason: 'failed-recently' };   // the last install failed: asked again after a day
  if (same && now - (Number(stamp.checkedAt) || 0) < VERIFY_EVERY_MS) return { ok: true, action: 'unchanged' };
  if (same) {   // a day on: is it still registered?
    const run = schedulerOf(o);
    let there = false; try { there = exists(run, o); } catch { /* treat as missing */ }
    if (there) { try { writeFileSync(stampFile(o), JSON.stringify({ v: 1, hash: stamp.hash, task: TASK_NAME, installedAt: stamp.installedAt, checkedAt: now })); } catch { /* ignore */ } return { ok: true, action: 'unchanged' }; }
  }
  const r = installLogonTask(o);
  if (!r.ok) { try { writeFileSync(stampFile(o), JSON.stringify({ v: 1, hash: p.hash, failedAt: now, checkedAt: now })); } catch { /* ignore */ } }   // a failing scheduler is asked again after a day, not at every session start
  return r;
}
