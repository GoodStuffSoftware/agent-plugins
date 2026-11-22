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
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync, unlinkSync, copyFileSync, truncateSync, utimesSync, openSync, readSync, closeSync } from 'node:fs';
import { relative, dirname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveAll, SESSION_DIRS } from './paths.mjs';
import { planIncremental, commitManifest, loadManifest } from './manifest.mjs';
import { classifyReplacement, lostCount } from './transcript.mjs';
import { runRclone, copyFlags, findRclone, findRcloneConf, hasRemote, isLocalRemote, parseRcloneLog, formatRcloneLine, classifyCopyErrors } from './rclone.mjs';
import { notify } from './notify.mjs';
import { makeCtx, loadState, accPath, readJson, journalRead, ACC } from './accounts/state.mjs';
import { listFolders, groupOf, homeOf, RECORD, TOMB, UUID, OURTMP } from './accounts/folders.mjs';

const MARKER = '.last-push';
const MANIFEST_FILE = join(homedir(), '.claude', 'session-sync', 'manifest.json');
const CONFLICT_ROOT = join(homedir(), '.claude', 'session-sync', 'conflicts');
const FIRST_SUCCESS_MARKER = join(homedir(), '.claude', 'session-sync', '.first-success-notified');
// The files the last push could not copy because they were changing under it.
// Informational only (the manifest is what makes the next pass retry them).
const DEFERRED_FILES = join(homedir(), '.claude', 'session-sync', 'deferred-files.json');

/**
 * Gate a ROUTINE (non-failure) toast behind `notifyMode`.
 *   'all'       — always show it (legacy behaviour, still the default for
 *                 direct callers of push()/pull() that don't pass a mode).
 *   'failures'  — never show it; only ERROR/conflict notify() calls remain.
 *   'first-run' — show it once, ever, to confirm the plugin is actually
 *                 talking to the remote, then go quiet. This is cli.mjs's
 *                 configured default: failures and the pull "please wait"
 *                 warning are never gated by this at all (see their own
 *                 notify() calls), only the four routine start/success toasts.
 *
 * `markerFile`/`notifyFn` are test-only escape hatches (default to the real
 * marker path and the real notify()), same pattern as push()'s `manifestFile`
 * — this lets a test exercise the actual gating decision AND its on-disk
 * side effect without touching the real state dir or popping a real toast.
 *
 * Returns whether it actually notified, for tests to assert on directly.
 */
export function notifyRoutine(mode, title, body, opts = {}, { markerFile = FIRST_SUCCESS_MARKER, notifyFn = notify } = {}) {
  if (mode === 'failures') return false;
  if (mode === 'first-run') {
    if (existsSync(markerFile)) return false;
    try {
      mkdirSync(dirname(markerFile), { recursive: true });
      writeFileSync(markerFile, new Date().toISOString());
    } catch { /* best-effort — worst case it notifies once more than intended */ }
  }
  notifyFn(title, body, opts);
  return true;
}

/**
 * The exclusion set the INCREMENTAL diff (planIncremental -> scanTree) runs
 * with. Exported so a test can exercise the exact list production uses rather
 * than a hand-copied approximation of it — a hand-rolled duplicate is how the
 * previous round of tests missed that this list drops real user files.
 *
 * `session-sync` lives in excludeRootDirs, NOT excludeDirs: it is this
 * plugin's own state dir at `<root>/session-sync` and nothing else. Matching
 * the name at any depth (which is what shipped) silently dropped 21 real files
 * under `~/.claude/plugins/marketplaces/goodstuff/plugins/session-sync/` from
 * every incremental backup on a live machine. See scanTree()'s doc comment and
 * test/exclusions.test.mjs.
 *
 * The other names keep their historical any-depth matching: widening them
 * would quietly change what gets uploaded, which is a separate decision from
 * fixing a data-loss bug. (Noted for later: `cache`/`statsig`/`shell-snapshots`
 * ARE anchored globs in paths.mjs's rclone-level excludes, so the two
 * mechanisms still disagree for those three names.)
 */
export const SCAN_EXCLUDES = Object.freeze({
  excludeDirs: ['cache', 'shell-snapshots', 'statsig', 'node_modules'],
  excludeRootDirs: ['session-sync'],
  excludeFiles: ['.credentials.json', '.claude.json', 'mcp.json',
                 '.deckhand-bus-token', '.deckhand-machine-oauth.json'],
});

/** Write an rclone --files-from list (one relative path per line). */
function writeFileList(files) {
  const dir = mkdtempSync(join(tmpdir(), 'session-sync-list-'));
  const f = join(dir, 'files.txt');
  writeFileSync(f, files.join('\n') + '\n', 'utf8');
  return f;
}

/** Does `folder` hold a `deleted_<key>` tombstone for the uuid, the stored keys or the record's cliSessionId? */
function homeTombstoned(folder, uuid, storedKeys, recordPath) {
  if (!folder) return false;
  const keys = new Set([String(uuid).toLowerCase(), ...(storedKeys ?? []).map((k) => String(k).toLowerCase())]);
  try {
    const cli = JSON.parse(readFileSync(recordPath, 'utf8'))?.cliSessionId;
    if (typeof cli === 'string') keys.add(cli.toLowerCase());
  } catch { /* unreadable record: the uuid and stored keys still count */ }
  try {
    for (const n of readdirSync(folder.path)) {
      const t = TOMB.exec(n);
      if (t && keys.has(t[1].toLowerCase())) return true;
    }
  } catch { /* unreadable home folder: no tombstone known */ }
  return false;
}

/**
 * The home-only push filter for the Code-tab store when accounts are linked
 * (plan 5.11): a record `<acct>/<org>/local_<id>.json` is uploaded only from its
 * HOME folder, so a mirrored name (a hard link to the same inode) never uploads and
 * the remote holds each conversation once. Our own temp names never upload.
 *
 * Returns `(rel) => boolean`, or null when no group is linked (single-account
 * machines keep the unfiltered behaviour). The record-to-folders map is built on
 * the first call. It fails OPEN: if the filter cannot be built the push uploads
 * everything (duplicates on the remote are reported and harmless; a skipped
 * backup is not).
 */
export function accountsPushFilter({ ctx = makeCtx(), state = null, remoteList = null } = {}) {
  try {
    if (!ctx.store) return null;
    const st = state ?? loadState(ctx);
    // A first link that stopped part way (journal op `link`) has already mirrored names: filter from then on.
    if (!st.linked && journalRead(ctx)?.op !== 'link') return null;
    const group = groupOf(st, listFolders(ctx.store));
    if (group.length < 2) return null;
    const groupKeys = new Set(group.map((f) => f.key));
    const rl = remoteList ?? readJson(accPath(ctx, 'remote-list.json'), null);
    let present = null;
    const build = () => {
      present = new Map();
      for (const f of group) {
        let names = [];
        try { names = readdirSync(f.path); } catch { /* unreadable folder: no names */ }
        for (const n of names) {
          const m = RECORD.exec(n);
          if (!m) continue;
          const id = `local_${m[1].toLowerCase()}`;
          if (!present.has(id)) present.set(id, []);
          present.get(id).push(f.key);
        }
      }
    };
    const homes = new Map();
    return (rel) => {
      const parts = rel.split('/');
      if (parts.length !== 3 || !UUID.test(parts[0]) || !UUID.test(parts[1])) return true;
      const key = `${parts[0]}/${parts[1]}`;
      if (!groupKeys.has(key)) return true;
      if (OURTMP.test(parts[2])) return false;
      const m = RECORD.exec(parts[2]);
      if (!m) return true;
      const id = `local_${m[1].toLowerCase()}`;
      if (!homes.has(id)) {
        if (!present) build();
        const here = (present.get(id) ?? []).sort();
        let home = homeOf(id, here, st, rl, [...groupKeys]);
        if (here.length && !here.includes(home)) {
          // Home name gone: upload from the first holder, never nowhere, UNLESS the home folder holds a tombstone for
          // one of the record's keys (uuid or cliSessionId): the app deleted it and the full pass has not yet removed
          // the mirrors, so uploading one would resurrect a deleted conversation on the remote (S2).
          const holder = group.find((f) => f.key === here[0]);
          home = homeTombstoned(group.find((f) => f.key === home), m[1], st.records?.[id]?.keys, holder && join(holder.path, parts[2])) ? null : here[0];
        }
        homes.set(id, home);
      }
      return homes.get(id) === key;
    };
  } catch { return null; }
}

/** Build the local<->remote mapping for whatever this machine actually has. */
export function buildMap(remote) {
  const r = resolveAll();
  const map = [
    { local: r.claudeHome, remote: `${remote}/dot-claude`, excludes: r.excludes, label: '~/.claude' },
  ];
  for (const name of SESSION_DIRS) {
    if (r.sessionStores[name]) {
      const entry = { local: r.sessionStores[name], remote: `${remote}/${name}`, excludes: [], label: name };
      if (name === 'claude-code-sessions') {
        const fileFilter = accountsPushFilter({ ctx: makeCtx({ store: r.sessionStores[name] }) });
        if (fileFilter) entry.fileFilter = fileFilter;
      }
      map.push(entry);
    }
  }
  return { map, resolved: r };
}

/**
 * One listing of the remote's Code-tab records, grouped by id (plan 5.11): an id
 * under more than one `<acct>/<org>` is a duplicate. REPORTED, never deleted.
 * Returns `{ok, ids:{<id>:[folderKey]}, duplicates:{<id>:[folderKey]}, count}`.
 */
export async function remoteRecordList(remote) {
  const { code, stdout } = await runRclone([
    'lsf', '-R', '--files-only', '--include', '/*/*/local_*.json', `${remote}/claude-code-sessions`, '--log-level', 'ERROR',
  ]);
  // rclone exit 3 = "directory not found": nothing was ever pushed here, so there are 0 records and 0 duplicates.
  if (code === 3) return { ok: true, ids: {}, duplicates: {}, count: 0, neverPushed: true };
  if (code !== 0) return { ok: false, ids: {}, duplicates: {}, count: 0 };
  const ids = {};
  for (const line of String(stdout).split(/\r?\n/)) {
    const parts = line.trim().replace(/\\/g, '/').split('/');
    if (parts.length !== 3 || !UUID.test(parts[0]) || !UUID.test(parts[1])) continue;
    const m = RECORD.exec(parts[2]);
    if (!m) continue;
    const id = `local_${m[1].toLowerCase()}`;
    (ids[id] ||= []).push(`${parts[0]}/${parts[1]}`);
  }
  const duplicates = {};
  for (const [id, keys] of Object.entries(ids)) { keys.sort(); if (keys.length > 1) duplicates[id] = keys; }
  return { ok: true, ids, duplicates, count: Object.keys(ids).length };
}

function withExcludes(args, excludes) {
  const out = [...args];
  for (const e of excludes) out.push('--exclude', e);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A transcript snapshot cut at its last complete line gets a remote mtime this
// much OLDER than the local file, so a pull (rclone --update, newer wins) can
// never see the shorter prefix as equal-or-newer than the longer local file.
const PARTIAL_TAIL_SKEW_MS = 5000;

/** Byte length of file[0,size) up to and including its last "\n"; 0 when it has none. */
function lengthThroughLastNewline(file, size) {
  const fd = openSync(file, 'r');
  try {
    const CHUNK = 64 * 1024;
    const buf = Buffer.alloc(CHUNK);
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - CHUNK);
      const n = readSync(fd, buf, 0, end - start, start);
      for (let i = n - 1; i >= 0; i--) if (buf[i] === 0x0a) return start + i + 1;
      end = start;
    }
    return 0;
  } finally { closeSync(fd); }
}

/**
 * Copy one file that is changing under us into `stageRoot` as a consistent,
 * self-contained snapshot, ready to upload. Returns
 *   { status: 'gone' }                         the file no longer exists
 *   { status: 'unstable' }                     it kept changing for every attempt
 *   { status: 'ok', sig, complete }            snapshot is in stageRoot/<rel>
 * `sig` is the "size:mtime" the manifest should hold once the snapshot is on
 * the remote. `complete` is false when a JSONL transcript was cut at its last
 * complete line (the writer was mid-line): the snapshot is still safe to upload
 * (it ends on a line boundary) but the file is not up to date, so the caller
 * must not advance the manifest for it.
 *
 * Plain files must hold still across the copy (same size and mtime before and
 * after). JSONL files are append-only: bytes past the size we stat'ed first are
 * dropped, a file that came out SHORTER than that stat is retried, and the
 * snapshot is trimmed to the last "\n". The snapshot keeps the file's mtime
 * (minus a skew when it was trimmed, see PARTIAL_TAIL_SKEW_MS).
 */
export async function snapshotFile(root, rel, stageRoot, { attempts = 3, pauseMs = 150, copy = copyFileSync } = {}) {
  const parts = rel.split('/');
  const abs = join(root, ...parts);
  const dest = join(stageRoot, ...parts);
  const jsonl = rel.toLowerCase().endsWith('.jsonl');
  const gone = (e) => e && (e.code === 'ENOENT' || e.code === 'ENOTDIR');
  mkdirSync(dirname(dest), { recursive: true });
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(pauseMs);
    try {
      const st1 = statSync(abs);
      copy(abs, dest);
      const st2 = statSync(abs);
      let len = statSync(dest).size;
      let complete = true;
      if (jsonl) {
        if (len > st1.size) { truncateSync(dest, st1.size); len = st1.size; complete = false; }   // grew while we copied it
        if (st2.size !== st1.size) complete = false;                                        // ... or right after
        if (len < st1.size) continue;                       // shrank or was replaced: not append-only, retry
        const cut = lengthThroughLastNewline(dest, len);
        if (len > 0 && cut === 0) continue;                 // no complete line yet
        if (cut < len) { truncateSync(dest, cut); complete = false; }
      } else if (st2.size !== st1.size || st2.mtimeMs !== st1.mtimeMs || len !== st1.size) {
        continue;                                           // changed while we copied it
      }
      const mtimeMs = complete ? st1.mtimeMs : st1.mtimeMs - PARTIAL_TAIL_SKEW_MS;
      utimesSync(dest, st1.atimeMs / 1000, mtimeMs / 1000);
      return { status: 'ok', sig: `${st1.size}:${Math.floor(st1.mtimeMs)}`, complete };
    } catch (e) {
      if (gone(e)) { rmSync(dest, { force: true }); return { status: 'gone' }; }
      // anything else (a sharing violation, a read error): treat it as "still changing" and retry
    }
  }
  rmSync(dest, { force: true });
  return { status: 'unstable' };
}

/** One log line naming the deferred files, capped: "deferred 3 file(s) to the next pass (2 unstable, 1 partial-tail): a, b, c". */
export function summarizeDeferred(deferred, cap = 20) {
  if (!deferred?.length) return '';
  const by = {};
  for (const d of deferred) by[d.reason] = (by[d.reason] || 0) + 1;
  const reasons = Object.entries(by).map(([r, n]) => `${n} ${r}`).join(', ');
  const names = deferred.slice(0, cap).map((d) => `${d.label}/${d.path}`).join(', ');
  const more = deferred.length - cap;
  return `deferred ${deferred.length} file(s) to the next pass (${reasons}): ${names}${more > 0 ? ` (+${more} more)` : ''}`;
}

/** The deferred-files record the last push left, or null (none, or unreadable). */
export function readDeferredFiles(file = DEFERRED_FILES) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * PUSH — local -> remote. Read-only against local files, so it is safe to run
 * while Claude is open; it does not need the app closed.
 *
 * A file that changes or vanishes WHILE rclone copies it never fails the run
 * and never causes a whole-run retry: it is snapshotted and sent on its own, or
 * deferred to the next pass (see settleVolatile). Real failures still return
 * ok:false.
 *
 * `map`, `manifestFile`, `deferredFile`, `snapshotOpts` and `runner` (an
 * rclone runner) are test-only escape hatches: production callers
 * never pass them, so buildMap(remote)/MANIFEST_FILE (real ~/.claude,
 * real state dir) are used exactly as before. Tests pass a throwaway map and
 * manifest path so they can drive a real push() end-to-end (real rclone,
 * against a local-folder "remote") without ever touching the user's actual
 * home directory.
 */
export async function push(remote, { quiet = false, onLog = () => {}, force = false, map: mapOverride = null, manifestFile = MANIFEST_FILE, notifyMode = 'all', firstRunMarker = FIRST_SUCCESS_MARKER, deferredFile = DEFERRED_FILES, snapshotOpts = {}, runner = runRclone } = {}) {
  const { map, resolved } = mapOverride ? { map: mapOverride, resolved: { missing: [] } } : buildMap(remote);
  const paced = !isLocalRemote(remote);   // API pacing is pointless on a local disk
  if (resolved.missing.length) {
    onLog(`warning: session store(s) not found: ${resolved.missing.join(', ')} — the desktop sidebar may not restore on the far side`);
  }

  // Work out what actually changed BEFORE touching the network.
  const { plan, nextForRemote } = planIncremental(map, manifestFile, remote, SCAN_EXCLUDES);

  const todo = plan.filter((p) => force || p.full || p.files.length);
  if (!todo.length) {
    // Nothing changed. Say so and stop — no scan, no transfer, no toast.
    const gone = plan.reduce((n, p) => n + (p.removed?.length || 0), 0);
    onLog(`nothing to push — no local changes since last sync${gone ? ` (${gone} file(s) removed locally; left on the remote)` : ''}`);
    recordDeferred(deferredFile, []);   // nothing is pending any more: drop a stale deferred list
    return { ok: true, failed: 0, mins: '0.0', skipped: true };
  }

  const summary = todo.map((p) => p.full ? `${p.label}: full` : `${p.label}: +${p.counts.added}/~${p.counts.changed}`).join(', ');
  onLog(`pushing — ${summary}`);
  if (!quiet) notifyRoutine(notifyMode, 'Backing up Claude…', `Syncing ${summary}. Safe to keep working.`, { tag: 'sync' }, { markerFile: firstRunMarker });

  const t0 = Date.now();
  let failed = 0;
  // Files that changed or vanished while rclone copied them (Claude is writing
  // to them right now). They never fail the run: see settleVolatile below.
  const prevAll = loadManifest(manifestFile)[remote] || {};
  const deferred = [];            // { label, path, reason } left for the next pass
  let vanished = 0, staged = 0;
  const stageDirs = [];
  try {
  for (const m of todo) {
    let args;
    // A filtered entry (account-link home-only filter) always goes through
    // --files-from, full mode included: a plain `copy` of the tree would upload the
    // mirrored names the filter exists to keep out. `m.full` (and `force` with
    // nothing changed) uses every key of the filtered scan.
    let list = null;
    if (m.fileFilter) {
      list = (m.full || (force && !m.files.length)) ? Object.keys(nextForRemote[m.label] || {}) : m.files;
      if (!list.length) { onLog(`ok: ${m.label} (nothing to send after the home-only filter)`); continue; }
    } else if (!m.full && m.files.length) {
      list = m.files;
    }
    if (list) {
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
      const listFile = writeFileList(list);
      args = ['copy', m.local, m.remote, ...copyFlags({ paced, retries: 1 }), '--use-json-log', '--files-from', listFile, '--no-traverse'];
    } else {
      args = withExcludes(['copy', m.local, m.remote, ...copyFlags({ paced, retries: 1 }), '--use-json-log'], m.excludes);
    }
    const { code, stdout, stderr } = await runner(args, { onLine: (l) => l && onLog(`  ${formatRcloneLine(l)}`) });
    if (code === 0) {
      onLog(`ok: ${m.label}${list ? ` (${list.length} file(s))` : m.full ? ' (full)' : ` (${m.files.length} file(s))`}`);
      continue;
    }

    // rclone could not copy something. Whole-run retries are for REAL failures
    // only (network, auth, quota); a file that changed or vanished under the
    // copy is settled here, per file, and never fails the run.
    const scan = nextForRemote[m.label] || {};
    const sent = list ? new Set(list) : null;
    const events = parseRcloneLog(`${stdout}\n${stderr}`);
    const cls = classifyCopyErrors(events, {
      known: (rel) => (sent ? sent.has(rel) : Object.hasOwn(scan, rel)),
      localState: (rel) => {
        try {
          const st = statSync(join(m.local, ...rel.split('/')));
          return `${st.size}:${Math.floor(st.mtimeMs)}` === scan[rel] ? 'same' : 'changed';
        } catch (e) { return (e.code === 'ENOENT' || e.code === 'ENOTDIR') ? 'gone' : 'changed'; }
      },
    });
    if (cls.fatal.length || !cls.perFile.size) {
      failed++;
      const why = cls.fatal[0] || (stderr ? formatRcloneLine(stderr.trim().split('\n')[0]) : '');
      onLog(`ERROR (${code}): ${m.label}${why ? ' — ' + why : ''}`);
      continue;
    }

    let r;
    try {
      r = await settleVolatile(m, cls.perFile, scan, prevAll[m.label], { paced, onLog, stageDirs, snapshotOpts, runner });
      deferred.push(...r.deferred);
      vanished += r.vanished;
      staged += r.staged;
      if (r.failed) { failed++; continue; }
    } catch (e) {
      failed++;
      onLog(`ERROR: ${m.label} — could not settle the changing files: ${e.message}`);
      continue;
    }
    onLog(`ok: ${m.label} (${cls.perFile.size} file(s) were changing: ${r.vanished} gone, ${r.staged} sent from a snapshot, ${r.deferred.length} deferred)`);
  }
  } finally {
    // Always, including when rclone cannot even be spawned: stage dirs hold full copies of live transcripts.
    for (const d of stageDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  }

  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  if (deferred.length) onLog(summarizeDeferred(deferred));
  if (failed) {
    if (!quiet) notify('Claude backup FAILED', `Sync did not complete after ${mins} min. Your data is still safe locally.`, { persist: true, tag: 'sync' });
    return { ok: false, failed, mins };
  }

  // Only now is the new state a valid baseline. Committing it after a partial
  // failure would make the next run skip files that never landed. Deferred
  // files were put back to their previous mark (or removed from the scan) by
  // settleVolatile, so the baseline never advances past a file that is not on
  // the remote in full.
  const committed = commitManifest(manifestFile, remote, nextForRemote);
  recordDeferred(deferredFile, deferred);
  if (!committed) {
    // saveManifest() swallows its own write errors (disk full, AV lock, a
    // permissions hiccup) and returns false rather than throwing — this used
    // to vanish silently, so the next run re-scanned everything and reported
    // it as "changed" forever with no clue why. Surface it instead.
    onLog(`warning: manifest commit did not persist to ${manifestFile} — the next sync will re-diff more than it needs to`);
  }
  await writeMarker(remote, onLog);
  if (!quiet) notifyRoutine(notifyMode, 'Claude backed up', `Conversations and memory are current (${mins} min${deferred.length ? `; ${deferred.length} file(s) still being written will follow next time` : ''}). Safe to pick up on another machine.`, { tag: 'sync' }, { markerFile: firstRunMarker });
  return { ok: true, failed: 0, mins, committed, deferred, vanished, staged };
}

/** Persist (or clear) the list of files the last push deferred. Never throws. */
function recordDeferred(file, deferred) {
  try {
    if (!deferred.length) { rmSync(file, { force: true }); return; }
    const byReason = {};
    for (const d of deferred) byReason[d.reason] = (byReason[d.reason] || 0) + 1;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), count: deferred.length, byReason, files: deferred.slice(0, 200) }, null, 2));
  } catch { /* informational only */ }
}

/**
 * Deal with the files rclone named as changed or gone while it copied them.
 *
 *   gone       dropped from the baseline (the next scan sees it as removed).
 *   otherwise  snapshotFile() into a stage folder, then ONE upload of the
 *              snapshots. A snapshot that kept changing is DEFERRED; so is a
 *              transcript that had to be cut at its last complete line (the
 *              cut copy IS uploaded, but the file is not current). A deferred
 *              file goes back to its previous baseline mark, or out of the
 *              baseline if it had none, so the next pass sends it again.
 *
 * Mutates `scan` (the label's slice of the new baseline). Any failure of the
 * snapshot upload is a real failure: { failed: true }.
 */
async function settleVolatile(m, perFile, scan, prev, { paced, onLog, stageDirs, snapshotOpts, runner }) {
  const out = { deferred: [], vanished: 0, staged: 0, failed: false };
  const rewind = (rel) => { if (prev && Object.hasOwn(prev, rel)) scan[rel] = prev[rel]; else delete scan[rel]; };
  const stage = mkdtempSync(join(tmpdir(), 'session-sync-stage-'));
  stageDirs.push(stage);

  const ready = [];
  for (const [rel, info] of perFile) {
    const s = info.state === 'gone' ? { status: 'gone' } : await snapshotFile(m.local, rel, stage, snapshotOpts);
    if (s.status === 'gone') { out.vanished++; delete scan[rel]; }
    else if (s.status === 'unstable') { out.deferred.push({ label: m.label, path: rel, reason: 'unstable', ...(info.msg ? { msg: String(info.msg).slice(0, 200) } : {}) }); rewind(rel); }
    else ready.push({ rel, s });
  }
  if (!ready.length) return out;

  const listFile = writeFileList(ready.map((x) => x.rel));
  const up = await runner(['copy', stage, m.remote, ...copyFlags({ paced }), '--files-from', listFile, '--no-traverse'], { onLine: (l) => l && onLog(`  ${l}`) });
  if (up.code !== 0) {
    onLog(`ERROR (${up.code}): ${m.label} — uploading the snapshots${up.stderr ? ': ' + up.stderr.trim().split('\n')[0] : ''}`);
    out.failed = true;
    return out;
  }
  for (const { rel, s } of ready) {
    out.staged++;
    if (s.complete) scan[rel] = s.sig;
    else { out.deferred.push({ label: m.label, path: rel, reason: 'partial-tail' }); rewind(rel); }
  }
  return out;
}

/**
 * PULL — remote -> local.
 * Safe to run while Claude is open: everything synced is FLAT files (jsonl
 * transcripts and local_<uuid>.json session records). The live LevelDB/SQLite
 * stores (IndexedDB, Local Storage) are never synced, so there is no database
 * to corrupt. Worst case a brand-new chat needs an app restart to appear.
 */
export async function pull(remote, opts = {}) {
  // Tell the account-link engine a pull is in flight: rectify stands down while a live
  // `pull-active` is younger than 6 h (plan 5.11). Always removed on the way out.
  const pullActive = join(ACC, 'pull-active');
  try { mkdirSync(ACC, { recursive: true }); writeFileSync(pullActive, JSON.stringify({ pid: process.pid, at: Date.now() })); } catch { /* best effort */ }
  try {
    return await pullImpl(remote, opts);
  } finally {
    try { unlinkSync(pullActive); } catch { /* already gone */ }
  }
}

async function pullImpl(remote, { quiet = false, onLog = () => {}, notifyMode = 'all', firstRunMarker = FIRST_SUCCESS_MARKER, map: mapOverride = null } = {}) {
  const { map } = mapOverride ? { map: mapOverride } : buildMap(remote);
  const paced = !isLocalRemote(remote);
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
      ['copy', m.remote, m.local, ...copyFlags({ paced }), '--backup-dir', join(backupDir, m.label.replace(/[^\w.-]/g, '_'))],
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
    // Routine success, and NOT a "please wait" warning — persist: true here
    // just meant it sat in the Action Center forever after every single pull.
    notifyRoutine(notifyMode, 'Conversations restored', `Up to date (${secs}s). If a chat is not listed yet, restart Claude.`, { tag: 'sync' }, { markerFile: firstRunMarker });
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
  // A local filesystem path is a perfectly valid rclone target and has no
  // [section] in rclone.conf. Demanding one refused legitimate configs such as
  // a USB drive, which is the fastest way to seed a new machine.
  const local = isLocalRemote(remote, conf);
  const configured = local ? existsSync(String(remote).replace(/\//g, sep)) || existsSync(String(remote))
                           : (!!conf && hasRemote(remoteName, conf));
  return {
    ...resolved,
    rclone,
    rcloneConf: conf,
    remote,
    remoteIsLocal: local,
    remoteConfigured: configured,
    ready: !!rclone && configured && resolved.claudeHomeExists,
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
