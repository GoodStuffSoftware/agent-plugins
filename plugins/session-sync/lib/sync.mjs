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

import { hostname, homedir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync, unlinkSync } from 'node:fs';
import { relative, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveAll, SESSION_DIRS } from './paths.mjs';
import { planIncremental, commitManifest } from './manifest.mjs';
import { classifyReplacement, lostCount } from './transcript.mjs';
import { runRclone, copyFlags, findRclone, findRcloneConf, hasRemote } from './rclone.mjs';
import { notify } from './notify.mjs';

const MARKER = '.last-push';
const MANIFEST_FILE = join(homedir(), '.claude', 'session-sync', 'manifest.json');
const CONFLICT_ROOT = join(homedir(), '.claude', 'session-sync', 'conflicts');

/** Write an rclone --files-from list (one relative path per line). */
function writeFileList(files) {
  const dir = mkdtempSync(join(tmpdir(), 'session-sync-list-'));
  const f = join(dir, 'files.txt');
  writeFileSync(f, files.join('\n') + '\n', 'utf8');
  return f;
}

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
export async function push(remote, { quiet = false, onLog = () => {}, force = false } = {}) {
  const { map, resolved } = buildMap(remote);
  if (resolved.missing.length) {
    onLog(`warning: session store(s) not found: ${resolved.missing.join(', ')} — the desktop sidebar may not restore on the far side`);
  }

  // Work out what actually changed BEFORE touching the network.
  const { plan, nextForRemote } = planIncremental(map, MANIFEST_FILE, remote, {
    excludeDirs: ['cache', 'shell-snapshots', 'statsig', 'node_modules'],
    excludeFiles: ['.credentials.json', '.claude.json', 'mcp.json',
                   '.deckhand-bus-token', '.deckhand-machine-oauth.json'],
  });

  const todo = plan.filter((p) => force || p.full || p.files.length);
  if (!todo.length) {
    // Nothing changed. Say so and stop — no scan, no transfer, no toast.
    const gone = plan.reduce((n, p) => n + (p.removed?.length || 0), 0);
    onLog(`nothing to push — no local changes since last sync${gone ? ` (${gone} file(s) removed locally; left on the remote)` : ''}`);
    return { ok: true, failed: 0, mins: '0.0', skipped: true };
  }

  const summary = todo.map((p) => p.full ? `${p.label}: full` : `${p.label}: +${p.counts.added}/~${p.counts.changed}`).join(', ');
  onLog(`pushing — ${summary}`);
  if (!quiet) notify('Backing up Claude…', `Syncing ${summary}. Safe to keep working.`, { tag: 'sync' });

  const t0 = Date.now();
  let failed = 0;
  for (const m of todo) {
    let args;
    if (!m.full && m.files.length) {
      // Hand rclone the exact paths instead of making it walk and compare the
      // whole tree against a rate-limited remote.
      //
      // NOTE: --files-from CANNOT be combined with --exclude. rclone refuses:
      //   "the usage of --files-from overrides all other filters, it should be
      //    used alone or with --files-from-raw or --files-from0"
      // That is safe here because the file list comes from scanTree(), which
      // applied the SAME exclusions when building it — an excluded file can
      // never appear in the list. (Its match is by basename, so it is if
      // anything stricter than the rclone patterns.)
      const listFile = writeFileList(m.files);
      args = ['copy', m.local, m.remote, ...copyFlags(), '--files-from', listFile, '--no-traverse'];
    } else {
      args = withExcludes(['copy', m.local, m.remote, ...copyFlags()], m.excludes);
    }
    const { code, stderr } = await runRclone(args, { onLine: (l) => l && onLog(`  ${l}`) });
    if (code !== 0) { failed++; onLog(`ERROR (${code}): ${m.label}${stderr ? ' — ' + stderr.trim().split('\n')[0] : ''}`); }
    else onLog(`ok: ${m.label}${m.full ? ' (full)' : ` (${m.files.length} file(s))`}`);
  }

  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  if (failed) {
    if (!quiet) notify('Claude backup FAILED', `Sync did not complete after ${mins} min. Your data is still safe locally.`, { persist: true, tag: 'sync' });
    return { ok: false, failed, mins };
  }

  // Only now is the new state a valid baseline. Committing it after a partial
  // failure would make the next run skip files that never landed.
  commitManifest(MANIFEST_FILE, remote, nextForRemote);
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

  // Anything about to be OVERWRITTEN goes here first instead of being destroyed.
  // Without this, a transcript you extended on this machine is silently replaced
  // by the remote copy and those messages are gone.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(CONFLICT_ROOT, stamp);

  for (const m of map) {
    // '--update' keeps a NEWER local file: a stale remote can never clobber
    // work you just did on this machine.
    const args = withExcludes(
      ['copy', m.remote, m.local, ...copyFlags(), '--backup-dir', join(backupDir, m.label.replace(/[^\w.-]/g, '_'))],
      m.excludes,
    );
    const { code } = await runRclone(args, { onLine: (l) => l && onLog(`  ${l}`) });
    if (code !== 0) { failed++; onLog(`ERROR (${code}): ${m.label}`); } else onLog(`ok: ${m.label}`);
  }

  // Decide which displaced files were real conflicts and which were harmless.
  const conflicts = reconcileBackups(backupDir, map, onLog);

  const secs = Math.round((Date.now() - t0) / 1000);
  if (failed) {
    if (!quiet) notify('Restore failed', 'Continuing on local data. Check the sync log.', { persist: true, tag: 'sync' });
    return { ok: false, failed, secs };
  }
  if (conflicts.length) {
    const total = conflicts.reduce((n, c) => n + c.lost, 0);
    if (!quiet) notify(
      `${conflicts.length} conversation(s) differ between machines`,
      `Both versions kept — ${total} message(s) exist only in the local copy. See ${CONFLICT_ROOT}.`,
      { persist: true, tag: 'sync-conflict' },
    );
  } else if (!quiet) {
    notify('Conversations restored', `Up to date (${secs}s). If a chat is not listed yet, restart Claude.`, { persist: true, tag: 'sync' });
  }
  return { ok: true, failed: 0, secs, conflicts };
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


/**
 * Walk what rclone moved aside during a pull and keep only genuine conflicts.
 *
 * fast-forward / identical -> the replacement contains everything the displaced
 *   copy had, so the copy is noise. Delete it; leaving it would train the user
 *   to ignore a directory that sometimes matters.
 * diverged / unknown -> both files hold messages the other lacks. Keep it and
 *   report it. We never merge: see transcript.mjs.
 */
function reconcileBackups(backupDir, map, onLog = () => {}) {
  if (!existsSync(backupDir)) return [];
  const conflicts = [];

  const walk = (dir, onFile) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, onFile);
      else if (e.isFile()) onFile(p);
    }
  };

  for (const m of map) {
    const sub = join(backupDir, m.label.replace(/[^\w.-]/g, '_'));
    if (!existsSync(sub)) continue;
    walk(sub, (displaced) => {
      const rel = relative(sub, displaced);
      const current = join(m.local, rel);
      const verdict = existsSync(current) ? classifyReplacement(displaced, current) : 'unknown';

      if (verdict === 'fast-forward' || verdict === 'identical') {
        try { unlinkSync(displaced); } catch {}
        return;
      }
      const lost = existsSync(current) ? lostCount(displaced, current) : 0;
      conflicts.push({ file: rel, kept: displaced, lost, verdict });
      onLog(`CONFLICT (${verdict}): ${rel} — ${lost} message(s) only in the displaced copy, kept at ${displaced}`);
    });
  }

  // Remove the timestamp folder entirely if nothing was worth keeping.
  if (!conflicts.length) { try { rmSync(backupDir, { recursive: true, force: true }); } catch {} }
  return conflicts;
}
