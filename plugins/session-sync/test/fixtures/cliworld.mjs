/**
 * fixtures/cliworld.mjs - a sandbox home with a synthetic two-account desktop store, for tests that
 * run the real cli.mjs as a child process. Never touches the live store or ~/.claude/session-sync.
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { emptyState, saveState, readJson } from '../../lib/accounts/state.mjs';
import { addFolder, putRecord, uuid, makeClock } from './store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CLI = join(HERE, '..', '..', 'lib', 'cli.mjs');
export const A = uuid('a', 1); export const B = uuid('b', 1);
export const OA = uuid("1", 1); export const OB = uuid("2", 2);

export const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function waitFor(pred, { timeoutMs = 15000, intervalMs = 100 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (pred()) return true; sleepMs(intervalMs); }
  return pred();
}

const worlds = [];
/** A sandbox home with two accounts (or one) in the desktop store and an app-state file. */
export function cworld({ config = {}, accounts = 2, records = 2 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ss-acli-home-'));
  const remote = mkdtempSync(join(tmpdir(), 'ss-acli-remote-'));
  const stateDir = join(home, '.claude', 'session-sync');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'rules');
  writeFileSync(join(stateDir, 'sender-registered.txt'), new Date().toISOString());
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ notifications: false, ...config }, null, 2));
  // The desktop app's userData dir per platform, as lib/paths.mjs desktopDataRoots resolves it.
  const userData = process.platform === 'win32' ? join(home, 'AppData', 'Roaming', 'Claude')
    : process.platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Claude')
    : join(home, '.config', 'Claude');
  const store = join(userData, 'claude-code-sessions');
  mkdirSync(store, { recursive: true });
  const clock = makeClock();
  const fA = addFolder(store, A, OA);
  const folders = [fA];
  if (accounts > 1) folders.push(addFolder(store, B, OB));
  for (let i = 1; i <= records; i++) putRecord(fA.path, i, { title: `A ${i}` }, clock.tick());
  if (accounts > 1) for (let i = records + 1; i <= records * 2; i++) putRecord(folders[1].path, i, { title: `B ${i}` }, clock.tick());
  const appFile = join(home, 'app.json');
  const w = {
    home, remote, stateDir, userData, store, fA, fB: folders[1], appFile, acc: join(stateDir, 'accounts'),
    setApp(o) { writeFileSync(appFile, JSON.stringify(o)); },
    state: () => readJson(join(stateDir, 'accounts', 'state.json'), null),
    putState(mut) { const s = emptyState(store); mut(s); saveState({ acc: join(stateDir, 'accounts') }, s); },
    run(args, env = {}) {
      return spawnSync(process.execPath, [CLI, ...args], {
        env: {
          ...process.env, USERPROFILE: home, HOME: home, APPDATA: join(home, 'AppData', 'Roaming'), XDG_CONFIG_HOME: join(home, '.config'),
          CLAUDE_SESSION_SYNC_REMOTE: remote, SESSION_SYNC_TEST_APP_STATE: appFile, SESSION_SYNC_TEST_POLL_MS: '100', SESSION_SYNC_TEST_LAUNCH: 'spawn', ...env,
        },
        encoding: 'utf8', timeout: 30000, windowsHide: true,
      });
    },
    cleanup() {
      waitFor(() => !existsSync(join(stateDir, 'accounts', 'waiter.claim')), { timeoutMs: 5000 });
      for (const d of [home, remote]) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ } }
    },
  };
  w.setApp({ running: false });
  worlds.push(w);
  return w;
}
export function cleanupWorlds() { for (const w of worlds) w.cleanup(); }

