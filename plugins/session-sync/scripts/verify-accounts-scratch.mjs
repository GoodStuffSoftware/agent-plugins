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
 *   4. Prints a PASS/FAIL table, asserts the SOURCE tree is unchanged, and exits 0 only when
 *      every check passed. The scratch folder is kept for inspection; delete it by hand.
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
/** Names the rollback leaves alone (invariant I3): skipped when comparing trees after a rollback. */
const ROLLBACK_UNTOUCHED = /(^|\/)(waiting-input\/|owed-bridge-delete_|archived-sessions\.idx$|imported-staging)|\.tmp$|\.bak-|\.partial$/;

/* ------------------------------------------------------------------ arguments and refusals */

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
if (argv.includes('--help') || argv.includes('-h') || !opt('--source') || !opt('--scratch')) {
  console.log('Usage: node scripts/verify-accounts-scratch.mjs --source <claude-code-sessions dir or its parent> --scratch <new dir>');
  process.exit(argv.includes('--help') || argv.includes('-h') ? 0 : 2);
}

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

/** names, sizes and mtimes of a tree (the "source unchanged" proof). */
function treeShape(root) {
  const m = new Map();
  for (const p of walk(root)) { const s = lstatSync(p); m.set(rel(root, p), `${s.size}:${Math.round(s.mtimeMs)}`); }
  return m;
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
  const lk = cli(['accounts', 'link', '--now', '--json']);
  linked = lk.code === 0 && !!state()?.linked;
  check('link --now succeeds', linked, `exit ${lk.code}${lk.json?.reason ? ` ${lk.json.reason}` : ''}${lk.err ? ` ${lk.err.trim().split('\n')[0]}` : ''}`);
  if (!linked) throw new Error('the link failed; the rest of the flow is skipped');
  const inv1 = inventory(STORE);
  check('every conversation is in every folder', [...inv1.values()].every((m) => m.size === nFolders) && inv1.size === ids0.size, `${inv1.size} of ${ids0.size}, ${nFolders} folders`);
  check('one inode per conversation', unlinkedIds(inv1, nFolders).length === 0, `${unlinkedIds(inv1, nFolders).length} not linked`);
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
} catch (e) {
  check('flow completed', false, e?.message ?? e);
}

/* ------------------------------------------------------------------ source untouched, report */

const sourceAfter = treeShape(SOURCE);
const sd = diffMaps(sourceBefore, sourceAfter);
check('the source tree is unchanged (names, sizes, mtimes)', sd.length === 0, sd.length ? `${sd.length} differences, first: ${sd.slice(0, 3).join('; ')}` : `${sourceBefore.size} files`);

const w = Math.max(...results.map((r) => r.name.length));
console.log('');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}${r.detail ? `  ${r.detail}` : ''}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed. Accounts ${accounts.length}, folders ${nFolders}, conversations ${ids0.size}; signed in ${SIGNED_IN.slice(0, 8)}.`);
console.log(`Scratch kept at ${SCRATCH} (delete it by hand).`);
process.exit(failed ? 1 : 0);
