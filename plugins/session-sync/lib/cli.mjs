#!/usr/bin/env node
/**
 * cli.mjs — entry point for hooks and manual runs.
 *
 *   node lib/cli.mjs status         what would sync, and is the machine ready
 *   node lib/cli.mjs push           local -> remote
 *   node lib/cli.mjs pull           remote -> local
 *   node lib/cli.mjs auto-pull      pull ONLY if another machine pushed since ours
 *
 * Remote comes from CLAUDE_SESSION_SYNC_REMOTE, else "gdrive:Claude/live".
 *
 * Hooks call this. Exit code 0 always for hook-invoked paths unless --strict:
 * a sync problem should surface as a notification, never as a blocked session.
 */

import { push, pull, preflight, remoteNewer } from './sync.mjs';
import { notify } from './notify.mjs';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const REMOTE = process.env.CLAUDE_SESSION_SYNC_REMOTE || 'gdrive:Claude/live';
const STATE_DIR = join(homedir(), '.claude', 'session-sync');
const LOG = join(STATE_DIR, 'sync.log');
const LAST_PULL = join(STATE_DIR, 'last-pull.txt');
const SETUP_NAGGED = join(STATE_DIR, 'setup-reminded.txt');

function ensureState() { try { mkdirSync(STATE_DIR, { recursive: true }); } catch {} }
function log(line) {
  ensureState();
  const s = `${new Date().toISOString()}  ${line}\n`;
  try { appendFileSync(LOG, s); } catch {}
  if (process.env.CLAUDE_SESSION_SYNC_VERBOSE) process.stderr.write(s);
}

const cmd = process.argv[2] || 'status';
const strict = process.argv.includes('--strict');
const quiet = process.argv.includes('--quiet');

/**
 * An unconfigured plugin is INERT, and silence is how it stays that way: the
 * hook runs, finds no rclone, logs, exits 0, and the user never learns their
 * conversations aren't syncing. Tell them — once. Nagging every session for a
 * setup step they may have deliberately deferred is its own failure.
 */
function remindSetupOnce(reason) {
  log(`not configured: ${reason}`);
  if (quiet || existsSync(SETUP_NAGGED)) return;
  try {
    ensureState();
    writeFileSync(SETUP_NAGGED, new Date().toISOString());
    notify(
      'Claude session sync is not set up',
      `${reason} Your conversations are NOT syncing. Run /session-sync:setup to finish.`,
      { persist: true, tag: 'session-sync-setup' },
    );
  } catch {}
}

// Sync commands are pointless without a working rclone + remote. Check once,
// up front, so the failure is a clear message rather than a stack trace.
if (cmd === 'push' || cmd === 'pull' || cmd === 'auto-pull') {
  const p = preflight(REMOTE);
  if (!p.rclone) { remindSetupOnce('rclone is not installed.'); process.exit(0); }
  if (!p.remoteConfigured) { remindSetupOnce(`No rclone remote matching "${REMOTE}".`); process.exit(0); }
  // Configured again after a lapse — allow a future reminder.
  try { if (existsSync(SETUP_NAGGED)) unlinkSync(SETUP_NAGGED); } catch {}
}

try {
  if (cmd === 'status') {
    const p = preflight(REMOTE);
    console.log(JSON.stringify(p, null, 2));
    process.exit(p.ready ? 0 : 1);
  }

  if (cmd === 'push') {
    log(`push -> ${REMOTE}`);
    const r = await push(REMOTE, { quiet, onLog: log });
    log(`push ${r.ok ? 'ok' : 'FAILED'} (${r.mins} min)`);
    process.exit(r.ok || !strict ? 0 : 1);
  }

  if (cmd === 'pull') {
    log(`pull <- ${REMOTE}`);
    const r = await pull(REMOTE, { quiet, onLog: log });
    if (r.ok) { ensureState(); writeFileSync(LAST_PULL, new Date().toISOString()); }
    log(`pull ${r.ok ? 'ok' : 'FAILED'} (${r.secs}s)`);
    process.exit(r.ok || !strict ? 0 : 1);
  }

  if (cmd === 'auto-pull') {
    // Cheap: reads one tiny marker file. Safe to call often.
    const since = existsSync(LAST_PULL) ? readFileSync(LAST_PULL, 'utf8').trim() : null;
    const hit = await remoteNewer(REMOTE, since);
    if (!hit) { log('auto-pull: nothing newer'); process.exit(0); }
    log(`auto-pull: ${hit.machine} pushed at ${hit.ts} — pulling`);
    const r = await pull(REMOTE, { quiet, onLog: log });
    if (r.ok) { ensureState(); writeFileSync(LAST_PULL, new Date().toISOString()); }
    process.exit(0);
  }

  console.error(`unknown command: ${cmd}`);
  process.exit(2);
} catch (err) {
  log(`fatal: ${err?.message || err}`);
  // Never block a Claude session because a backup had a bad day.
  process.exit(strict ? 1 : 0);
}
