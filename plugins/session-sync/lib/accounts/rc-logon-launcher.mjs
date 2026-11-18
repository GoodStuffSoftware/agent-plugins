/**
 * rc-logon-launcher.mjs - the stable launcher of the "session-sync RC restore" logon task.
 *
 * logontask.mjs copies this file, unchanged, to ~/.claude/session-sync/rc-restore-logon.mjs. That path never moves, so the scheduled task
 * survives plugin updates. At every logon it finds the newest installed copy of session-sync and runs
 * `cli.mjs accounts rc-restore --if-app-stopped` from it, hidden (the VBScript shim starts this file with window style 0, and the child
 * is spawned with windowsHide).
 *
 * Self-contained on purpose: it imports nothing from the plugin (the copy lives outside it) and must keep working while a plugin
 * update replaces the folders it looks in.
 */

import { readdirSync, existsSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const CLI_ARGS = Object.freeze(['accounts', 'rc-restore', '--if-app-stopped']);
/** A copy older than the logon command has no such file: it is skipped (an older copy would answer "unknown command"). */
export const NEEDS = join('lib', 'accounts', 'logontask.mjs');

/** [major, minor, patch] of a plain `x.y.z` folder name (a pre-release suffix is ignored), or null for any other name. */
export function parseVersion(name) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(name));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * The newest installed copy that has the logon command: the user plugin cache first
 * (`~/.claude/plugins/cache/goodstuff/session-sync/<version>`, highest version), then the marketplace clone.
 * @returns {{cli:string, source:'cache'|'marketplace', version?:string}|null}
 */
export function resolveCli({ home = homedir(), exists = existsSync, list = readdirSync } = {}) {
  const cache = join(home, '.claude', 'plugins', 'cache', 'goodstuff', 'session-sync');
  let names = [];
  try { names = list(cache); } catch { /* no cache */ }
  const versions = names.map((n) => ({ n, v: parseVersion(n) })).filter((x) => x.v).sort((a, b) => compareVersions(b.v, a.v));
  for (const { n } of versions) {
    const root = join(cache, n);
    if (exists(join(root, NEEDS)) && exists(join(root, 'lib', 'cli.mjs'))) return { cli: join(root, 'lib', 'cli.mjs'), source: 'cache', version: n };
  }
  const market = join(home, '.claude', 'plugins', 'marketplaces', 'goodstuff', 'plugins', 'session-sync');
  if (exists(join(market, NEEDS)) && exists(join(market, 'lib', 'cli.mjs'))) return { cli: join(market, 'lib', 'cli.mjs'), source: 'marketplace' };
  return null;
}

function note(line, home) {
  try { appendFileSync(join(home, '.claude', 'session-sync', 'sync.log'), `${new Date().toISOString()} ${line}\n`); } catch { /* the log is best effort */ }
}

/** Run the CLI of the resolved copy; the exit code of the run, or 0 when no copy is installed. */
export function main({ home = homedir(), run = spawnSync, resolve = resolveCli } = {}) {
  const found = resolve({ home });
  if (!found) { note('rc-restore logon launcher: no installed session-sync copy found, nothing to run', home); return 0; }
  const r = run(process.execPath, [found.cli, ...CLI_ARGS], { windowsHide: true, stdio: 'ignore', timeout: 10 * 60 * 1000 });
  if (r.error) note(`rc-restore logon launcher: could not run ${found.cli}: ${String(r.error.message ?? r.error).slice(0, 200)}`, home);
  return r.status ?? 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());
