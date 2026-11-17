#!/usr/bin/env node
/**
 * verify-accounts-scratch.mjs - run the whole account-link flow against a COPY of a real
 * Code-tab store, inside a scratch sandbox. Run by hand (never in CI, never in `npm test`).
 *
 *   node scripts/verify-accounts-scratch.mjs --source <claude-code-sessions dir, or its parent> --scratch <new dir>
 *
 * What it does
 *   1. Copies ONLY `claude-code-sessions` from --source into
 *      <scratch>/home/<the platform's app-data folder>/Claude/claude-code-sessions, and writes a
 *      synthetic `config.json` (just the signed-in account id). No other file is copied.
 *   2. Points every child process (USERPROFILE, HOME, APPDATA, XDG_CONFIG_HOME) at <scratch>/home,
 *      the rclone remote at a local folder <scratch>/remote and rclone's config at an empty file, and
 *      the app-state seam at <scratch>/app.json (the app is "running" or "stopped" by rewriting it).
 *   3. Runs the flow with the real CLI: status, a refused link while the app "runs", `link --now`,
 *      simulated app saves from both accounts (a split) then rectify, a delete then rectify, push
 *      and the remote duplicate check, unlink, a re-link with an injected mid-link failure, and
 *      rollback checked byte for byte against the tree as it was just before that re-link.
 *   3b. After the rollback it links again and rehearses the account switches of the desktop app over the
 *      copy (a simulated app on the seam, virtual time, the watcher's targeted pass): 50 saves in A, a
 *      sign-out window, a sign-in to B, 20 saves in B, a switch back, a flush race with a stale load, a delete
 *      and an archive, a never-linked third account, then the quit. It checks that B loads the newest copy, a
 *      loaded or just-left folder is never rewritten, no content is lost (every displaced version is in the
 *      backups), one inode per conversation after the quit, nothing owed, and the push filter picks each
 *      conversation from exactly one folder. It never signs out, switches, quits or starts the real app and
 *      never reads or writes the real config.json.
 *   4. Prints a PASS/FAIL/WARN/INFO table (INFO rows give the record count of every account folder
 *      before and after the link), asserts the SOURCE tree was not changed BY THIS SCRIPT, and exits 0
 *      only when every check passed. The scratch folder is kept for inspection; delete it by hand.
 *
 * Options
 *   --expect <sessionId>   (repeatable; `local_<uuid>` or the bare uuid) after the link, check that this
 *                          record exists in every account folder: one PASS/FAIL row per id.
 *
 * The source is snapshotted before the copy. The desktop app may be running and rewriting records (tmp +
 * rename) while the script runs: a source file whose mtime moved forward is a WARN naming it, never a
 * failure. Only a change this script could have made fails: a new, deleted or linked name, or a changed
 * file whose mtime did not move forward.
 *
 * Safety
 *   - Refuses when --scratch is inside (or equal to) %APPDATA%\Claude, the desktop app's data
 *     folders or ~/.claude, or overlaps --source.
 *   - The source is only ever read. Its tree (names, sizes, mtimes) is compared before and after.
 *   - Never reads credentials, tokens or config files of the machine; the one `config.json` it uses is
 *     written fresh into the scratch.
 *   - Every child process is spawned with windowsHide: true.
 */

import {
  existsSync, mkdirSync, readdirSync, statSync, lstatSync, readFileSync, writeFileSync, cpSync, renameSync,
  utimesSync, unlinkSync, realpathSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve, relative, sep, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { desktopDataRoots } from '../lib/paths.mjs';
import { findRclone } from '../lib/rclone.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'lib', 'cli.mjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECORD = /^local_([0-9a-f-]{36})\.json$/i;
/** The app's own save temp name; it comes and goes while the app runs. */
const APP_TMP = /\.json\.tmp$/;
/** Names the rollback leaves alone (invariant I3): skipped when comparing trees after a rollback. */
const ROLLBACK_UNTOUCHED = /(^|\/)(waiting-input\/|owed-bridge-delete_|archived-sessions\.idx$|imported-staging)|\.tmp$|\.bak-|\.partial$/;

/* ------------------------------------------------------------------ arguments and refusals */

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const optAll = (n) => argv.flatMap((a, i) => (a === n && argv[i + 1] !== undefined ? [argv[i + 1]] : []));
if (argv.includes('--help') || argv.includes('-h') || !opt('--source') || !opt('--scratch')) {
  console.log('Usage: node scripts/verify-accounts-scratch.mjs --source <claude-code-sessions dir or its parent> --scratch <new dir> [--expect <sessionId>]...');
  console.log('  --expect <sessionId>  (repeatable) after the link, check that this record exists in every account folder; PASS/FAIL per id');
  process.exit(argv.includes('--help') || argv.includes('-h') ? 0 : 2);
}
/** `--expect` ids: `local_<uuid>` or the bare uuid, normalised to the bare lowercase uuid. */
const EXPECT = optAll('--expect').map((s) => s.trim().replace(/^local_/i, '').toLowerCase());
const badExpect = EXPECT.filter((s) => !UUID.test(s));
if (badExpect.length) { console.error(`Refusing: --expect takes a session id (local_<uuid> or the uuid); not valid: ${badExpect.join(', ')}`); process.exit(2); }

const norm = (p) => (platform() === 'win32' ? resolve(p).toLowerCase() : resolve(p));
const isInside = (child, parent) => {
  const rel = relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
/** realpath of the nearest existing ancestor + the rest, so a symlinked parent cannot hide a forbidden target. */
function realish(p) {
  let cur = resolve(p); const rest = [];
  while (!existsSync(cur)) { rest.unshift(basename(cur)); const up = dirname(cur); if (up === cur) break; cur = up; }
  let base = cur; try { base = realpathSync(cur); } catch { /* keep */ }
  return join(base, ...rest);
}

// Captured BEFORE the environment is redirected: what must never be a scratch target.
const REAL_HOME = homedir();
const FORBIDDEN = [
  join(REAL_HOME, '.claude'),
  ...desktopDataRoots(),
  process.env.APPDATA ? join(process.env.APPDATA, 'Claude') : null,
].filter(Boolean);

let sourceArg = resolve(opt('--source'));
const SCRATCH = resolve(opt('--scratch'));
for (const f of FORBIDDEN) {
  if (isInside(SCRATCH, f) || isInside(realish(SCRATCH), f)) {
    console.error(`Refusing: the scratch dir is inside ${f}. Pick a folder outside the Claude app data and ~/.claude.`);
    process.exit(2);
  }
}
if (existsSync(SCRATCH) && readdirSync(SCRATCH).length) { console.error('Refusing: the scratch dir exists and is not empty.'); process.exit(2); }
const SOURCE = (!existsSync(join(sourceArg, 'claude-code-sessions')) && basename(sourceArg) === 'claude-code-sessions') ? sourceArg : join(sourceArg, 'claude-code-sessions');
if (!existsSync(SOURCE) || !statSync(SOURCE).isDirectory()) { console.error(`Refusing: no claude-code-sessions folder at ${SOURCE}.`); process.exit(2); }
if (isInside(SCRATCH, SOURCE) || isInside(SOURCE, SCRATCH)) { console.error('Refusing: the scratch dir and the source overlap.'); process.exit(2); }

/* ------------------------------------------------------------------ small helpers */

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail: String(detail) }); };
/** A line in the table that is neither a pass nor a failure: a WARN (needs a look) or an INFO (facts). */
const note = (level, name, detail = '') => { results.push({ name, ok: true, level, detail: String(detail) }); };
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const inoOf = (p) => { const s = statSync(p, { bigint: true }); return `${s.dev}:${s.ino}`; };

function walk(root) {
  const out = [];
  const rec = (abs) => {
    let ents;
    try { ents = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(abs, e.name);
      if (e.isDirectory()) rec(p);
      else if (e.isFile()) out.push(p);
    }
  };
  rec(root);
  return out;
}
const rel = (root, p) => relative(root, p).split(sep).join('/');

/** names, sizes, mtimes and link counts of a tree (the "source unchanged" proof). */
function treeShape(root) {
  const m = new Map();
  for (const p of walk(root)) { const s = lstatSync(p); m.set(rel(root, p), { size: s.size, mtimeMs: s.mtimeMs, nlink: s.nlink }); }
  return m;
}
/**
 * Compare the source before and after. The desktop app may be running and rewrite records (tmp + rename) while the
 * script runs, so a file whose mtime moved FORWARD is only a warning. A failure is a change the script itself could
 * have made: a deleted, new or linked name, or a changed file whose mtime did not move forward.
 */
function compareSource(before, after) {
  const fails = []; const warns = [];
  for (const [k, b] of before) {
    const a = after.get(k);
    if (!a && APP_TMP.test(k)) { warns.push(`app save in flight finished (temp name gone): ${k}`); continue; }
    if (!a) { fails.push(`deleted: ${k}`); continue; }
    if (a.nlink > b.nlink) { fails.push(`linked: ${k}`); continue; }
    if (a.size === b.size && a.mtimeMs === b.mtimeMs) continue;
    if (a.mtimeMs > b.mtimeMs) warns.push(`rewritten by the app (mtime moved forward): ${k}`);
    else fails.push(`changed with ${a.mtimeMs < b.mtimeMs ? 'an older' : 'the same'} mtime: ${k}`);
  }
  for (const k of after.keys()) if (!before.has(k)) (APP_TMP.test(k) ? warns : fails).push(`${APP_TMP.test(k) ? 'app save in flight (temp name)' : 'new name'}: ${k}`);
  return { fails, warns };
}
/** Record count per `<acct>/<org>` folder, as text. */
function folderCounts(store) {
  return listFolders(store).map((f) => `${f.acct.slice(0, 8)}/${f.org.slice(0, 8)}=${readdirSync(f.path).filter((x) => RECORD.test(x)).length}`).join('  ');
}
/** names and sha256 of a tree (the byte-for-byte proof). */
function treeHashes(root, skip = null) {
  const m = new Map();
  for (const p of walk(root)) { const r = rel(root, p); if (!skip || !skip.test(r)) m.set(r, sha(readFileSync(p))); }
  return m;
}
function diffMaps(a, b) {
  const out = [];
  for (const [k, v] of a) { if (!b.has(k)) out.push(`missing: ${k}`); else if (b.get(k) !== v) out.push(`changed: ${k}`); }
  for (const k of b.keys()) if (!a.has(k)) out.push(`extra: ${k}`);
  return out;
}

/** `<store>/<acct>/<org>` folders. */
function listFolders(store) {
  const out = [];
  for (const a of readdirSync(store, { withFileTypes: true })) {
    if (!a.isDirectory() || !UUID.test(a.name)) continue;
    for (const o of readdirSync(join(store, a.name), { withFileTypes: true })) {
      if (o.isDirectory() && UUID.test(o.name)) out.push({ acct: a.name, org: o.name, key: `${a.name}/${o.name}`, path: join(store, a.name, o.name) });
    }
  }
  return out;
}
/** id -> Map(folderKey -> {abs, ino}) over every folder. */
function inventory(store) {
  const ids = new Map();
  for (const f of listFolders(store)) {
    for (const n of readdirSync(f.path)) {
      const m = RECORD.exec(n);
      if (!m) continue;
      const id = m[1].toLowerCase();
      if (!ids.has(id)) ids.set(id, new Map());
      const abs = join(f.path, n);
      ids.get(id).set(f.key, { abs, ino: inoOf(abs) });
    }
  }
  return ids;
}
/** Ids that do not have exactly one inode across `nFolders` names. */
function unlinkedIds(inv, nFolders) {
  const bad = [];
  for (const [id, byKey] of inv) {
    const inos = new Set([...byKey.values()].map((e) => e.ino));
    if (byKey.size !== nFolders || inos.size !== 1) bad.push(id);
  }
  return bad;
}

/** What the app's atomic save does: tmp file, set mtime, rename over the name. */
function appSave(abs, mutate, mtimeMs) {
  const rec = JSON.parse(readFileSync(abs, 'utf8'));
  mutate(rec);
  const tmp = `${abs}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec));
  utimesSync(tmp, mtimeMs / 1000, mtimeMs / 1000);
  renameSync(tmp, abs);
  return sha(readFileSync(abs));
}
const touch = (rec, label, ms) => {
  rec.scratchEdit = label;
  rec.lastActivityAt = typeof rec.lastActivityAt === 'number' ? ms : new Date(ms).toISOString();
};

/* ------------------------------------------------------------------ sandbox */

const HOME = join(SCRATCH, 'home');
const USERDATA = platform() === 'win32' ? join(HOME, 'AppData', 'Roaming', 'Claude')
  : platform() === 'darwin' ? join(HOME, 'Library', 'Application Support', 'Claude')
    : join(HOME, '.config', 'Claude');
const STORE = join(USERDATA, 'claude-code-sessions');
const STATE_DIR = join(HOME, '.claude', 'session-sync');
const ACC = join(STATE_DIR, 'accounts');
const REMOTE = join(SCRATCH, 'remote');
const APP = join(SCRATCH, 'app.json');
const EMPTY_CONF = join(SCRATCH, 'empty.conf');

const sourceBefore = treeShape(SOURCE);
mkdirSync(join(HOME, '.claude'), { recursive: true });
mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(REMOTE, { recursive: true });
mkdirSync(USERDATA, { recursive: true });
writeFileSync(EMPTY_CONF, '');
writeFileSync(join(HOME, '.claude', 'CLAUDE.md'), 'scratch rules\n');
writeFileSync(join(STATE_DIR, 'config.json'), JSON.stringify({ notifications: false }, null, 2));
writeFileSync(join(STATE_DIR, 'sender-registered.txt'), new Date().toISOString());
cpSync(SOURCE, STORE, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });

const folders0 = listFolders(STORE);
const accounts = [...new Set(folders0.map((f) => f.acct))];
const countOf = (acct) => folders0.filter((f) => f.acct === acct).reduce((n, f) => n + readdirSync(f.path).filter((x) => RECORD.test(x)).length, 0);
// the "new" account is the one with the fewest records (the signed-in one after a switch)
const SIGNED_IN = [...accounts].sort((a, b) => countOf(a) - countOf(b))[0];
writeFileSync(join(USERDATA, 'config.json'), JSON.stringify({ lastKnownAccountUuid: SIGNED_IN }));
const setApp = (running) => writeFileSync(APP, JSON.stringify({ running, signedIn: SIGNED_IN, startedAtMs: running ? Date.now() - 600000 : 0 }));
setApp(false);

const CHILD_ENV = {
  ...process.env,
  USERPROFILE: HOME, HOME, APPDATA: join(HOME, 'AppData', 'Roaming'), XDG_CONFIG_HOME: join(HOME, '.config'),
  CLAUDE_SESSION_SYNC_REMOTE: REMOTE, RCLONE_CONFIG: EMPTY_CONF, SESSION_SYNC_TEST_APP_STATE: APP,
};
delete CHILD_ENV.CLAUDE_PLUGIN_OPTION_ACCOUNTLINK;
delete CHILD_ENV.SESSION_SYNC_TEST_FAIL_AFTER;

function cli(args, env = {}, timeout = 600000) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...CHILD_ENV, ...env }, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 256 * 1024 * 1024,
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not a --json call */ }
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '', json };
}
const state = () => { try { return JSON.parse(readFileSync(join(ACC, 'state.json'), 'utf8')); } catch { return null; } };

// In-process helpers run against the SCRATCH only: the environment is redirected first, then the library loads.
Object.assign(process.env, { USERPROFILE: HOME, HOME, APPDATA: CHILD_ENV.APPDATA, XDG_CONFIG_HOME: CHILD_ENV.XDG_CONFIG_HOME });
const { makeCtx, loadState, saveState } = await import('../lib/accounts/state.mjs');
const { listFolders: libFolders, accountsOf, pendingPairs, answerPairs, pairKey } = await import('../lib/accounts/folders.mjs');
const { livePass, fullPass, owedWork } = await import('../lib/accounts/pass.mjs');
const { accountsPushFilter } = await import('../lib/sync.mjs');
const { G_SWITCH_MS } = await import('../lib/accounts/appstate.mjs');
const ctx = makeCtx({ store: STORE, userData: USERDATA, acc: ACC });
function answerYes() {
  const st = loadState(ctx);
  const pend = pendingPairs(st, accountsOf(libFolders(STORE)));
  if (pend.length) { answerPairs(st, pend, 'yes', 'cli', Date.now()); saveState(ctx, st); }
  return pend.length;
}
/** unlink resets every pair to "no" and `accounts answer yes` only covers undecided pairs, so the re-link step records yes directly. */
function forceYes() {
  const st = loadState(ctx);
  const accts = accountsOf(libFolders(STORE)).sort();
  const keys = [];
  for (let i = 0; i < accts.length; i++) for (let j = i + 1; j < accts.length; j++) keys.push(pairKey(accts[i], accts[j]));
  answerPairs(st, keys, 'yes', 'cli', Date.now());
  saveState(ctx, st);
}

/* ------------------------------------------------------------------ the flow */

const rclone = findRclone();
const s0 = treeHashes(STORE);
const ids0 = inventory(STORE);
const nFolders = folders0.length;
let linked = false;

try {
  // 1. status
  const st1 = cli(['accounts', 'status', '--json']);
  check('status: at least 2 accounts and 2 folders', st1.json && st1.json.accounts.length >= 2 && st1.json.folders.length >= 2,
    st1.json ? `${st1.json.accounts.length} accounts, ${st1.json.folders.length} folders, ${ids0.size} conversations` : `exit ${st1.code}`);
  check('status: a pair is pending and nothing is linked', st1.json && st1.json.pending >= 1 && st1.json.linked === false, st1.json ? `pending ${st1.json.pending}` : '');
  check('status: the synthetic config names the signed-in account', st1.json && st1.json.app.signedIn === SIGNED_IN.slice(0, 8), st1.json?.app?.signedIn ?? '');

  // 2. a yes answer, then the app "running": the link is refused and nothing changes
  check('answer yes recorded', answerYes() >= 1);
  setApp(true);
  const refused = cli(['accounts', 'link', '--now']);
  check('link --now with the app running is refused (exit 3)', refused.code === 3, `exit ${refused.code}`);
  check('refused link left the store untouched', diffMaps(s0, treeHashes(STORE)).length === 0);

  // 3. the app stopped: link
  setApp(false);
  note('INFO', 'records per account folder before the link', folderCounts(STORE));
  const lk = cli(['accounts', 'link', '--now', '--json']);
  note('INFO', 'records per account folder after the link', folderCounts(STORE));
  linked = lk.code === 0 && !!state()?.linked;
  check('link --now succeeds', linked, `exit ${lk.code}${lk.json?.reason ? ` ${lk.json.reason}` : ''}${lk.err ? ` ${lk.err.trim().split('\n')[0]}` : ''}`);
  if (!linked) throw new Error('the link failed; the rest of the flow is skipped');
  const inv1 = inventory(STORE);
  check('every conversation is in every folder', [...inv1.values()].every((m) => m.size === nFolders) && inv1.size === ids0.size, `${inv1.size} of ${ids0.size}, ${nFolders} folders`);
  check('one inode per conversation', unlinkedIds(inv1, nFolders).length === 0, `${unlinkedIds(inv1, nFolders).length} not linked`);
  // --expect: each named record must exist in every account folder after the link
  for (const id of EXPECT) {
    const missing = folders0.filter((f) => !existsSync(join(f.path, `local_${id}.json`))).map((f) => `${f.acct.slice(0, 8)}/${f.org.slice(0, 8)}`);
    const inSource = ids0.has(id);
    check(`expected record local_${id} is in every account folder`, missing.length === 0,
      missing.length ? `missing from ${missing.length} of ${nFolders}: ${missing.join(', ')}${inSource ? '' : ' (it was not in the source either)'}` : `${nFolders} of ${nFolders} folders`);
  }
  const bk = state()?.backupId;
  check('a verified backup and the standalone rollback exist', !!bk && existsSync(join(ACC, 'backup', bk, 'manifest.json')) && existsSync(join(ACC, 'backup', bk, 'rollback.mjs')), bk ?? 'no backup id');
  const hl = cli(['accounts', 'status', '--json']);
  check('status after the link: 0 split, 0 missing', hl.json?.health && hl.json.health.split === 0 && hl.json.health.missing === 0, JSON.stringify(hl.json?.health ?? null));

  // 4. simulated saves from both accounts (a split), a new conversation, then rectify
  const ids = [...inv1.keys()].sort();
  const [fa, fb] = [folders0[0], folders0.find((f) => f.acct !== folders0[0].acct) ?? folders0[1]];
  const pathIn = (f, id) => join(f.path, `local_${id}.json`);
  const base = (id) => Math.max(Date.now() - 60000, statSync(pathIn(fa, id)).mtimeMs);
  let expectedSplit = null; let expectedOnly = null;
  if (ids.length >= 3) {
    const [id1, id2] = ids;
    const b1 = base(id1);
    appSave(pathIn(fa, id1), (r) => touch(r, 'from-A', b1 + 1000), b1 + 1000);
    expectedSplit = appSave(pathIn(fb, id1), (r) => touch(r, 'from-B', b1 + 2000), b1 + 2000);     // the newer save wins
    const b2 = base(id2);
    expectedOnly = appSave(pathIn(fa, id2), (r) => touch(r, 'from-A-only', b2 + 1000), b2 + 1000);
    const split = unlinkedIds(inventory(STORE), nFolders);
    check('simulated saves split two conversations', split.length === 2, `${split.length} split`);
  }
  const newId = randomUUID();
  const template = JSON.parse(readFileSync(pathIn(fa, ids[0]), 'utf8'));
  template.sessionId = `local_${newId}`; template.cliSessionId = randomUUID(); template.title = 'scratch new conversation';
  const newPath = pathIn(fb, newId);
  writeFileSync(newPath, JSON.stringify(template));
  utimesSync(newPath, (Date.now() - 30000) / 1000, (Date.now() - 30000) / 1000);
  const rc = cli(['accounts', 'rectify', '--json']);
  check('rectify (app stopped) succeeds', rc.code === 0 && rc.json?.ok === true, `exit ${rc.code}${rc.json?.reason ? ` ${rc.json.reason}` : ''}`);
  const inv2 = inventory(STORE);
  check('after rectify every name is one inode again', unlinkedIds(inv2, nFolders).length === 0 && inv2.size === ids0.size + 1, `${unlinkedIds(inv2, nFolders).length} not linked`);
  check('the new conversation reached every folder', (inv2.get(newId)?.size ?? 0) === nFolders);
  if (expectedSplit) {
    const winner = sha(readFileSync(pathIn(fa, ids[0])));
    check('the newest save wins a split (B over A)', winner === expectedSplit);
    check('the lone save is kept in every folder', sha(readFileSync(pathIn(fb, ids[1]))) === expectedOnly);
    const idx = join(ACC, 'rectify-backups', 'index.jsonl');
    check('the displaced copy went to the rectify backup', existsSync(idx) && readFileSync(idx, 'utf8').includes(`local_${ids[0]}.json`));
  }

  // 5. delete propagation: the app removes a name and writes a tombstone
  if (ids.length >= 3) {
    const doomed = ids[2];
    unlinkSync(pathIn(fa, doomed));
    writeFileSync(join(fa.path, `deleted_${doomed}`), String(Date.now()));
    const dl = cli(['accounts', 'rectify', '--json']);
    const inv3 = inventory(STORE);
    check('delete propagates to every folder', dl.code === 0 && !inv3.has(doomed), `exit ${dl.code}`);
    const idx = join(ACC, 'rectify-backups', 'index.jsonl');
    check('the deleted conversation was copied to the backup first', existsSync(idx) && readFileSync(idx, 'utf8').includes(`local_${doomed}.json`));
    check('a tombstone sits in every folder', folders0.every((f) => existsSync(join(f.path, `deleted_${doomed}`))));
  }

  // 6. push and the remote duplicate check (needs rclone)
  if (!rclone) {
    check('push + remote check', true, 'SKIPPED: rclone not found (install it to run this step)');
  } else {
    const push = cli(['push', '--strict']);
    check('push to the local remote succeeds', push.code === 0, `exit ${push.code}${push.err ? ` ${push.err.trim().split('\n')[0]}` : ''}`);
    const remoteRoot = join(REMOTE, 'claude-code-sessions');
    const remoteIds = new Map();
    for (const p of existsSync(remoteRoot) ? walk(remoteRoot) : []) {
      const parts = rel(remoteRoot, p).split('/');
      const m = parts.length === 3 && RECORD.exec(parts[2]);
      if (!m) continue;
      const id = m[1].toLowerCase();
      if (!remoteIds.has(id)) remoteIds.set(id, []);
      remoteIds.get(id).push(`${parts[0]}/${parts[1]}`);
    }
    const localIds = inventory(STORE);
    const dupes = [...remoteIds].filter(([, v]) => v.length > 1).length;
    check('the remote holds each conversation once', dupes === 0 && remoteIds.size === localIds.size, `${remoteIds.size} remote, ${localIds.size} local, ${dupes} duplicated`);
    const homes = state()?.records ?? {};
    const wrongHome = [...remoteIds].filter(([id, v]) => homes[`local_${id}`]?.home && homes[`local_${id}`].home !== v[0]).length;
    check('every upload came from the conversation\'s home folder', wrongHome === 0, `${wrongHome} from a mirror`);
    const rs = cli(['accounts', 'status', '--remote', '--json']);
    check('status --remote reports 0 duplicates', rs.json?.remote && rs.json.remote.duplicates === 0, JSON.stringify(rs.json?.remote ?? null));
  }

  // 7. unlink
  const before = inventory(STORE);
  const ul = cli(['accounts', 'unlink', '--json']);
  const inv4 = inventory(STORE);
  check('unlink succeeds', ul.code === 0 && state()?.linked === false, `exit ${ul.code}`);
  check('unlink keeps every conversation, once, in its home folder', inv4.size === before.size && [...inv4.values()].every((m) => m.size === 1), `${inv4.size} of ${before.size}`);

  // 8. a re-link with an injected mid-link failure, then rollback against the tree just before it
  forceYes();
  const s1 = treeHashes(STORE);
  const fail = cli(['accounts', 'link', '--now'], { SESSION_SYNC_TEST_FAIL_AFTER: '5' });
  check('the injected mid-link failure aborts the link', fail.code !== 0, `exit ${fail.code} ${(fail.out + fail.err).trim().split('\n')[0]}`);
  check('the store is partly changed (the failure was mid-way)', diffMaps(s1, treeHashes(STORE)).length > 0);
  const rb = cli(['accounts', 'rollback']);
  check('rollback succeeds', rb.code === 0, `exit ${rb.code}${rb.err ? ` ${rb.err.trim().split('\n')[0]}` : ''}`);
  const d = diffMaps(treeHashes(STORE, ROLLBACK_UNTOUCHED), new Map([...s1].filter(([k]) => !ROLLBACK_UNTOUCHED.test(k))));
  check('after rollback the store matches the pre-link tree byte for byte', d.length === 0, d.length ? `${d.length} differences, first: ${d.slice(0, 3).join('; ')}` : `${s1.size} files compared`);
  check('after rollback nothing is linked', state()?.linked === false);

  // 9. account switches. The app is simulated over the scratch copy: it loads a folder only at sign-in, saves by tmp + rename, and
  //    writes config.json (lastKnownAccountUuid) when the account changes. The targeted pass is what the watcher runs; time is virtual,
  //    so the grace window after a switch passes without waiting. Nothing here touches the real app, store or config.
  forceYes();
  const rl = cli(['accounts', 'link', '--now', '--json']);
  check('switch rehearsal: the accounts are linked again', rl.code === 0 && state()?.linked === true, `exit ${rl.code}`);
  if (state()?.linked) {
    let vt = Date.now();
    const vctx = { ...ctx, now: () => vt };
    const tick = (ms = 1000) => (vt += ms);
    const runStart = vt - 600000;
    const A = fa.acct; const B = fb.acct;
    process.env.SESSION_SYNC_TEST_APP_STATE = APP;
    const seam = (running, acct) => writeFileSync(APP, JSON.stringify({ running, signedIn: running ? acct : null, startedAtMs: running ? runStart : 0 }));
    const setConfig = (acct) => writeFileSync(join(USERDATA, 'config.json'), JSON.stringify({ lastKnownAccountUuid: acct }));
    const allIds = [...inventory(STORE).keys()].sort();
    const idx = join(ACC, 'rectify-backups', 'index.jsonl');
    const backupShas = () => new Set(existsSync(idx) ? readFileSync(idx, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).sha256) : []);
    const versions = () => { const s = new Set(); for (const m of inventory(STORE).values()) for (const e of m.values()) s.add(sha(readFileSync(e.abs))); return s; };
    const save = (f, id, label, extra = (() => {})) => { const t = tick(); return appSave(pathIn(f, id), (r) => { touch(r, label, t); extra(r); }, t); };
    let lost = 0; let passes = 0;
    /** a targeted pass with the "no content lost" check: every version that left every folder is in the backups */
    const pass = async (label) => {
      const before = versions();
      const res = await livePass(vctx, {});
      passes++;
      check(`switch: ${label}: the targeted pass ran`, res.ok === true, res.ok ? '' : `skipped ${res.skipped ?? JSON.stringify(res).slice(0, 120)}`);
      const after = versions(); const bk = backupShas();
      for (const v of before) if (!after.has(v) && !bk.has(v)) lost++;
      return res;
    };
    const sameInode = (id, f1, f2) => existsSync(pathIn(f1, id)) && existsSync(pathIn(f2, id)) && inoOf(pathIn(f1, id)) === inoOf(pathIn(f2, id));
    const pool = allIds.filter((id) => existsSync(pathIn(fa, id)) && existsSync(pathIn(fb, id)));

    // the app is on A
    setConfig(A); seam(true, A);
    await pass('first sight of the signed-in account');
    const burst = pool.slice(0, Math.min(50, pool.length));
    for (let i = 0; i < burst.length; i++) { save(fa, burst[i], `A-save-${i}`); if (i % 10 === 9) await pass(`saves in A ${i + 1}`); }
    await pass('saves in A, last');
    check('switch: 50 saves in A are current in B while A is still loaded', burst.every((id) => sameInode(id, fa, fb)), `${burst.length} conversations`);
    // a sign-out window: the running session saves and a new conversation appears
    const idS = pool[0];
    save(fa, idS, 'while-signed-out');
    const newA = randomUUID(); const tpl = JSON.parse(readFileSync(pathIn(fa, idS), 'utf8'));
    tpl.sessionId = `local_${newA}`; tpl.cliSessionId = randomUUID(); tpl.title = 'scratch new in A while signed out';
    writeFileSync(pathIn(fa, newA), JSON.stringify(tpl)); utimesSync(pathIn(fa, newA), tick() / 1000, vt / 1000);
    await pass('sign-out window');
    check('switch: the sign-out window\'s save and new conversation reached B', sameInode(idS, fa, fb) && existsSync(pathIn(fb, newA)));
    tick(60000);
    // sign in to B: it loads the current copy of everything
    setConfig(B); seam(true, B);
    const shaA = new Map([...inventory(STORE)].map(([id, m]) => [id, m.has(fa.key) ? sha(readFileSync(m.get(fa.key).abs)) : null]));
    const stale = [...shaA].filter(([id, s]) => s && existsSync(pathIn(fb, id)) && sha(readFileSync(pathIn(fb, id))) !== s).length;
    check('switch: B loads the newest copy of every conversation', stale === 0, `${stale} stale`);
    const toB = await pass('switch to B');
    check('switch: the switch is seen and A cools', toB.switched === true && (toB.cooling ?? []).includes(fa.key), `cooling ${(toB.cooling ?? []).length}`);
    const inB = pool.slice(0, Math.min(20, pool.length));
    for (let i = 0; i < inB.length; i++) save(fb, inB[i], `B-save-${i}`);
    const aBefore = new Map(inB.map((id) => [id, inoOf(pathIn(fa, id))]));
    await pass('saves in B');
    check('switch: A is left alone during the grace window', inB.every((id) => inoOf(pathIn(fa, id)) === aBefore.get(id)));
    tick(G_SWITCH_MS + 1000);
    await pass('after the grace window');
    check('switch: A is current in A after the grace window', inB.every((id) => sameInode(id, fa, fb)), `${inB.length} conversations`);
    // back to A
    setConfig(A); seam(true, A);
    await pass('switch back to A');
    const inA = pool.slice(0, Math.min(10, pool.length));
    for (let i = 0; i < inA.length; i++) save(fa, inA[i], `A2-save-${i}`);
    await pass('saves in A again');
    check('switch: B is current after the switch back', inA.every((id) => sameInode(id, fa, fb)));
    // the flush race: a last save in A, and the app loads B before any pass could run
    const idR = pool[1];
    save(fa, idR, 'A-flush');
    setConfig(B); seam(true, B);
    const stalePre = inoOf(pathIn(fb, idR));
    const raced = await pass('flush race, first pass');
    check('switch: the loaded folder is not rewritten (B keeps the stale copy it loaded)', inoOf(pathIn(fb, idR)) === stalePre && (raced.rectify?.owed ?? []).some((o) => `local_${idR}` === o.id || idR === o.id.replace(/^local_/, '')));
    save(fb, idR, 'B-continued', (r) => { r.cliSessionId = randomUUID(); });
    tick(G_SWITCH_MS + 1000);
    await pass('flush race, after the grace window');
    const conflict = state()?.conflicts?.[`local_${idR}`];
    check('switch: the stale continuation is recorded as a conflict (transcript changed: toast)', !!conflict && conflict.cliChanged === true, JSON.stringify(conflict ?? null));
    check('switch: the newest copy is in A too', sameInode(idR, fa, fb));
    // a delete and an archive made in B
    const idD = pool[2]; const idV = pool[3];
    unlinkSync(pathIn(fb, idD)); writeFileSync(join(fb.path, `deleted_${idD}`), String(tick()));
    save(fb, idV, 'archived', (r) => { r.isArchived = true; });
    await pass('delete and archive');
    check('switch: the delete reached A (backup first, tombstone written)', !existsSync(pathIn(fa, idD)) && existsSync(join(fa.path, `deleted_${idD}`)) && existsSync(idx) && readFileSync(idx, 'utf8').includes(`local_${idD}.json`));
    check('switch: the archive reached A', JSON.parse(readFileSync(pathIn(fa, idV), 'utf8')).isArchived === true);
    // a never-linked account C signs in: a synthetic folder in the scratch store, its pairs answered
    const C = randomUUID(); const OC = randomUUID(); const fc = { acct: C, org: OC, key: `${C}/${OC}`, path: join(STORE, C, OC) };
    mkdirSync(fc.path, { recursive: true });
    const cId = randomUUID(); const ctpl = JSON.parse(readFileSync(pathIn(fa, pool[4] ?? pool[0]), 'utf8'));
    ctpl.sessionId = `local_${cId}`; ctpl.cliSessionId = randomUUID(); ctpl.title = 'scratch conversation of a new account';
    writeFileSync(pathIn(fc, cId), JSON.stringify(ctpl)); utimesSync(pathIn(fc, cId), tick() / 1000, vt / 1000);
    forceYes();
    seam(true, A); setConfig(A);
    const joined = await pass('a new account joins the group');
    check('switch: the joined account is held (names only) until the full pass', (joined.cooling ?? []).includes(fc.key) && state()?.fullPassOwed === true);
    check('switch: its conversation reached the other accounts', existsSync(pathIn(fa, cId)) && existsSync(pathIn(fb, cId)));
    setConfig(C); seam(true, C);
    await pass('switch to the new account');
    // the quit: one full pass finishes everything
    seam(false, null);
    tick(G_SWITCH_MS + 1000);
    const fin = await fullPass(vctx, {});
    check('switch: the quit runs the full pass', fin.ok === true, fin.ok ? '' : String(fin.reason ?? ''));
    const nAll = listFolders(STORE).length;
    const invEnd = inventory(STORE);
    check('switch: one inode per conversation in every folder after the quit', unlinkedIds(invEnd, nAll).length === 0, `${invEnd.size} conversations, ${nAll} folders, ${unlinkedIds(invEnd, nAll).length} not linked`);
    check('switch: nothing is owed after the quit', owedWork(vctx, {}).owed === false);
    check('switch: no content was lost (every displaced version is in the backups)', lost === 0, `${lost} lost over ${passes} passes`);
    const filter = accountsPushFilter({ ctx: vctx, state: loadState(ctx) });
    let multi = 0;
    for (const [id, byKey] of invEnd) if ([...byKey.keys()].filter((k) => filter(`${k}/local_${id}.json`)).length !== 1) multi++;
    check('switch: every conversation uploads from exactly one folder (home-only push)', multi === 0, `${multi} of ${invEnd.size} do not`);
    delete process.env.SESSION_SYNC_TEST_APP_STATE;
  }
} catch (e) {
  check('flow completed', false, e?.message ?? e);
}

/* ------------------------------------------------------------------ source untouched, report */

const sourceAfter = treeShape(SOURCE);
const sd = compareSource(sourceBefore, sourceAfter);
for (const x of sd.warns) note('WARN', 'the source tree changed while the script ran (the app is probably running)', x);
check('the source tree is unchanged by this script (no new, deleted or linked name, no older mtime)', sd.fails.length === 0,
  sd.fails.length ? `${sd.fails.length} differences, first: ${sd.fails.slice(0, 3).join('; ')}` : `${sourceBefore.size} files${sd.warns.length ? `, ${sd.warns.length} rewritten by the app (WARN)` : ''}`);

const w = Math.max(...results.map((r) => r.name.length));
console.log('');
for (const r of results) console.log(`${(r.level ?? (r.ok ? 'PASS' : 'FAIL')).padEnd(4)}  ${r.name.padEnd(w)}${r.detail ? `  ${r.detail}` : ''}`);
const failed = results.filter((r) => !r.ok).length;
const warned = results.filter((r) => r.level === 'WARN').length;
const passed = results.filter((r) => r.ok && !r.level).length;
console.log(`\n${passed} passed, ${failed} failed${warned ? `, ${warned} warning(s)` : ''}. Accounts ${accounts.length}, folders ${nFolders}, conversations ${ids0.size}; signed in ${SIGNED_IN.slice(0, 8)}.`);
console.log(`Scratch kept at ${SCRATCH} (delete it by hand).`);
process.exit(failed ? 1 : 0);
