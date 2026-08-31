/**
 * sync.mjs — push local Claude data up, pull it back down, and know when the
 * OTHER machine has newer data.
 *
 * MODEL: single-writer roaming. Newest file wins per-file; there is no merge.
 * Transcripts and session files are keyed by session UUID, so two machines
 * normally write DISJOINT file sets and never actually collide. The shared,
 * genuinely-collidable files are the small ones: CLAUDE.md, memory/*.md,
 * settings.json. Use one machine at a time and none of it matters; use two and
 * the worst case is a lost edit to one of those, not a corrupted history.
 */

import { hostname } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolveAll, SESSION_DIRS } from './paths.mjs';
import { runRclone, copyFlags, findRclone, findRcloneConf, hasRemote } from './rclone.mjs';
import { notify } from './notify.mjs';

const MARKER = '.last-push';

/** Build the local<->remote mapping for whatever this machine actually has. */
export function buildMap(remote) {
  const r = resolveAll();
  const map = [
    { local: r.claudeHome, remote: `${remote}/dot-claude`, excludes: r.excludes, label: '~/.claude' },
  ];
  for (const name of SESSION_DIRS) {
    if (r.sessionStores[name]) {
      map.push({ local: r.sessionStores[name], remote: `${remote}/${name}`, excludes: [], label: name });
    }
  }
  return { map, resolved: r };
}

function withExcludes(args, excludes) {
  const out = [...args];
  for (const e of excludes) out.push('--exclude', e);
  return out;
}

/**
 * PUSH — local -> remote. Read-only against local files, so it is safe to run
 * while Claude is open; it does not need the app closed.
 */
export async function push(remote, { quiet = false, onLog = () => {} } = {}) {
  const { map, resolved } = buildMap(remote);
  if (resolved.missing.length) {
    onLog(`warning: session store(s) not found: ${resolved.missing.join(', ')} — the desktop sidebar may not restore on the far side`);
  }
  if (!quiet) notify('Backing up Claude…', 'Syncing conversations and memory. Safe to keep working.', { tag: 'sync' });

  const t0 = Date.now();
  let failed = 0;
  for (const m of map) {
    const args = withExcludes(['copy', m.local, m.remote, ...copyFlags()], m.excludes);
    const { code, stderr } = await runRclone(args, { onLine: (l) => l && onLog(`  ${l}`) });
    if (code !== 0) { failed++; onLog(`ERROR (${code}): ${m.label}${stderr ? ' — ' + stderr.trim().split('\n')[0] : ''}`); }
    else onLog(`ok: ${m.label}`);
  }

  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  if (failed) {
    if (!quiet) notify('Claude backup FAILED', `Sync did not complete after ${mins} min. Your data is still safe locally.`, { persist: true, tag: 'sync' });
    return { ok: false, failed, mins };
  }

  await writeMarker(remote, onLog);
  if (!quiet) notify('Claude backed up', `Conversations and memory are current (${mins} min). Safe to pick up on another machine.`, { tag: 'sync' });
  return { ok: true, failed: 0, mins };
}

/**
 * PULL — remote -> local.
 * Safe to run while Claude is open: everything synced is FLAT files (jsonl
 * transcripts and local_<uuid>.json session records). The live LevelDB/SQLite
 * stores (IndexedDB, Local Storage) are never synced, so there is no database
 * to corrupt. Worst case a brand-new chat needs an app restart to appear.
 */
export async function pull(remote, { quiet = false, onLog = () => {} } = {}) {
  const { map } = buildMap(remote);
  if (!quiet) notify('Restoring your conversations…', 'Pulling the latest from your remote. Please wait before asking anything — history is still loading.', { persist: true, tag: 'sync' });

  const t0 = Date.now();
  let failed = 0;
  for (const m of map) {
    // '--update' keeps a NEWER local file: a stale remote can never clobber
    // work you just did on this machine.
    const args = withExcludes(['copy', m.remote, m.local, ...copyFlags()], m.excludes);
    const { code } = await runRclone(args, { onLine: (l) => l && onLog(`  ${l}`) });
    if (code !== 0) { failed++; onLog(`ERROR (${code}): ${m.label}`); } else onLog(`ok: ${m.label}`);
  }

  const secs = Math.round((Date.now() - t0) / 1000);
  if (failed) {
    if (!quiet) notify('Restore failed', 'Continuing on local data. Check the sync log.', { persist: true, tag: 'sync' });
    return { ok: false, failed, secs };
  }
  if (!quiet) notify('Conversations restored', `Up to date (${secs}s). If a chat is not listed yet, restart Claude.`, { persist: true, tag: 'sync' });
  return { ok: true, failed: 0, secs };
}

/**
 * Machine identity for the marker.
 *
 * NORMALISED ON PURPOSE. Different writers report the host differently:
 * Node's os.hostname() gave "Workstation-01" while PowerShell's $env:COMPUTERNAME
 * gave "WORKSTATION-01" on the SAME machine. A case-sensitive compare therefore
 * read our own marker as "another machine pushed" and kicked off a full pull —
 * on every session start, forever. Caught in testing 2026-08-30.
 */
function machineId() {
  return hostname().trim().toLowerCase();
}

/** Strip a UTF-8 BOM. Markers written by PowerShell's Set-Content carry one. */
function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Stamp MACHINE|utc so other machines can tell this one pushed. */
async function writeMarker(remote, onLog = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'session-sync-'));
  const f = join(dir, MARKER);
  writeFileSync(f, `${machineId()}|${new Date().toISOString()}`, 'utf8');
  const { code } = await runRclone(['copyto', f, `${remote}/${MARKER}`, '--log-level', 'ERROR']);
  if (code !== 0) onLog('warning: could not write the sync marker');
}

/**
 * Has a DIFFERENT machine pushed since we last looked?
 * This is what makes switching machines work when you never close Claude —
 * an app-start hook alone never fires if the app never restarts.
 */
export async function remoteNewer(remote, sinceIso = null) {
  const dir = mkdtempSync(join(tmpdir(), 'session-sync-'));
  const f = join(dir, MARKER);
  const { code } = await runRclone(['copyto', `${remote}/${MARKER}`, f, '--log-level', 'ERROR']);
  if (code !== 0 || !existsSync(f)) return null;
  const raw = stripBom(readFileSync(f, 'utf8')).trim();
  const [machineRaw, ts] = raw.split('|');
  if (!machineRaw || !ts) return null;
  const machine = machineRaw.trim().toLowerCase();          // see machineId()
  if (machine === machineId()) return null;                 // our own push
  const when = new Date(ts);
  if (Number.isNaN(when.getTime())) return null;            // unparseable stamp
  if (sinceIso && when <= new Date(sinceIso)) return null;
  return { machine, ts };
}

/** Everything the status skill needs, without doing any transfer. */
export function preflight(remote) {
  const { resolved } = buildMap(remote);
  const rclone = findRclone();
  const conf = findRcloneConf();
  const remoteName = String(remote).split(':')[0];
  return {
    ...resolved,
    rclone,
    rcloneConf: conf,
    remote,
    remoteConfigured: !!conf && hasRemote(remoteName, conf),
    ready: !!rclone && !!conf && hasRemote(remoteName, conf) && resolved.claudeHomeExists,
  };
}
