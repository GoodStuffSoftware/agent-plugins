/**
 * T17 (store part) - rollback byte for byte, including an injected failure in
 * the middle of the link. The standalone rollback.mjs is run from the copied
 * location with cwd elsewhere and nothing of the plugin on its path.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, writeFileSync, existsSync, readdirSync, linkSync, statSync, mkdirSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { rectify } from '../lib/accounts/rectify.mjs';
import { takeBackup, verifyBackup } from '../lib/accounts/backup.mjs';
import { emptyState, saveState, resetMutations, loadState, readJson } from '../lib/accounts/state.mjs';
import { answerPairs, pairKey } from '../lib/accounts/folders.mjs';
import { link, fullPass } from '../lib/accounts/pass.mjs';
import { putTasks, makeTask, readJsonFile } from './fixtures/store.mjs';
import {
  makeRoot, makeClock, addFolder, putRecord, putTombstone, putSidecars, treeHashes, setMtime, inoOf, nlinkOf,
  recordId, recordName, uuid, tasksJson,
} from './fixtures/store.mjs';
import { createSim } from './fixtures/appsim.mjs';

afterEach(() => { delete process.env.SESSION_SYNC_TEST_APP_STATE; delete process.env.SESSION_SYNC_TEST_FAIL_AFTER; });

const SECRET = 'FAKE-SECRET-VALUE-MUST-NEVER-BE-COPIED';

function world() {
  const r = makeRoot('rb');
  const clock = makeClock();
  const sim = createSim({ clock, appFile: join(r.root, 'app.json') });
  const a = uuid('a', 1); const b = uuid('b', 1); const c = uuid('c', 1);
  const fA = addFolder(r.store, a, uuid('1', 1));
  const fB = addFolder(r.store, b, uuid('1', 1));
  const fC = addFolder(r.store, c, uuid('1', 1));
  const group = [fA, fB, fC];
  for (let i = 1; i <= 4; i++) putRecord(fA.path, i, {}, clock.tick());
  for (let i = 5; i <= 6; i++) putRecord(fB.path, i, {}, clock.tick());
  // an existing link group: record 7 is ONE inode in A and B
  putRecord(fA.path, 7, { title: 'linked before' }, clock.tick());
  linkSync(join(fA.path, recordName(7)), join(fB.path, recordName(7)));
  // the same bytes as two separate files
  putRecord(fA.path, 8, { title: 'twin' }, clock.tick());
  putRecord(fB.path, 8, { title: 'twin' }, statSync(join(fA.path, recordName(8))).mtimeMs);
  putTombstone(fC.path, uuid('7', 7), 1_700_000_000_000);
  writeFileSync(join(fA.path, 'scheduled-tasks.json'), JSON.stringify(tasksJson([{ id: 'task-1', enabled: true }])));
  mkdirSync(join(fA.path, 'backlog'), { recursive: true });
  writeFileSync(join(fA.path, 'backlog', 'tasks.json'), JSON.stringify({ version: 1, items: [] }));
  for (const f of group) putSidecars(f);
  writeFileSync(join(r.userData, 'ccd-session-presets.json'), JSON.stringify({ byAccount: { [a]: { presets: [] } } }, null, '\t'));
  writeFileSync(join(r.userData, 'mcp-user-tool-toggles.json'), JSON.stringify({ owners: { [a]: ['x:y'] } }));
  writeFileSync(join(r.userData, 'claude_desktop_config.json'), JSON.stringify({ preferences: {}, mcpServers: { s: { env: { TOKEN: SECRET } } } }));
  writeFileSync(join(r.userData, 'config.json'), JSON.stringify({ 'oauth:tokenCache': SECRET, lastKnownAccountUuid: a }));
  sim.setApp({ running: false });
  const state = emptyState(r.store);
  answerPairs(state, [pairKey(a, b), pairKey(a, c), pairKey(b, c)], 'yes', 'cli', clock.t);
  return { r, ctx: r.ctx, clock, sim, fA, fB, fC, group, state, a, b, c };
}

function backupNow(w) {
  const bk = takeBackup(w.ctx, { group: w.group });
  w.state.backupId = bk.id;
  w.bk = bk;
  return bk;
}

function runRollback(w, args = [], env = {}) {
  const script = join(w.bk.dir, 'rollback.mjs');
  return spawnSync(process.execPath, [script, ...args], {
    cwd: tmpdir(), windowsHide: true, encoding: 'utf8', env: { ...process.env, ...env },
  });
}

const storeHashes = (w) => treeHashes(w.r.store);

/** Every manifest entry back exactly; inode groups rebuilt; excluded names left as they are now. */
function assertRestored(w, { excludedNow = {} } = {}) {
  const mf = readJson(join(w.bk.dir, 'manifest.json'));
  const excluded = (rel) => /(^|\/)waiting-input\/|owed-bridge-delete_|archived-sessions\.idx$|\.tmp$|\.bak-|imported-staging$/.test(rel);
  const byIno = new Map();
  for (const e of mf.entries.filter((x) => x.area === 'store')) {
    const p = join(w.r.store, ...e.rel.split('/'));
    if (excluded(e.rel)) {
      assert.ok(existsSync(p), `${e.rel} kept`);
      if (excludedNow[e.rel] !== undefined) assert.equal(readFileSync(p, 'utf8'), excludedNow[e.rel], `${e.rel} left as it was before the rollback`);
      continue;
    }
    assert.equal(treeHashes(w.r.store, (rel) => rel === e.rel)[e.rel], e.sha256, `sha of ${e.rel}`);
    assert.ok(Math.abs(statSync(p).mtimeMs - e.mtimeMs) <= 2, `mtime of ${e.rel}`);
    const k = inoOf(p);
    if (!byIno.has(k)) byIno.set(k, []);
    byIno.get(k).push(e);
  }
  for (const list of byIno.values()) {
    const groups = new Set(list.map((e) => e.inodeGroup ?? `solo:${e.rel}`));
    assert.equal(groups.size, 1, `names sharing an inode share a recorded group: ${list.map((e) => e.rel).join(', ')}`);
    if (list[0].inodeGroup) assert.equal(list.length, mf.entries.filter((e) => e.inodeGroup === list[0].inodeGroup).length, 'the whole group is linked');
    else assert.equal(list.length, 1, 'a file that was alone stays alone');
  }
  for (const e of mf.entries.filter((x) => x.area === 'global')) {
    assert.equal(treeHashes(w.r.userData, (rel) => rel === e.rel)[e.rel], e.sha256, `global ${e.rel}`);
  }
}

/* ------------------------------------------------------------------ backup */

test('T17 backup: verified manifest, rollback.mjs, README, inode groups, and no secrets copied', () => {
  const w = world();
  const bk = backupNow(w);
  const mf = readJson(join(bk.dir, 'manifest.json'));
  assert.equal(mf.verified, true);
  assert.ok(existsSync(join(bk.dir, 'rollback.mjs')) && existsSync(join(bk.dir, 'README.txt')));
  const e7a = mf.entries.find((e) => e.rel.endsWith(recordName(7)) && e.rel.startsWith(w.a));
  const e7b = mf.entries.find((e) => e.rel.endsWith(recordName(7)) && e.rel.startsWith(w.b));
  assert.ok(e7a.inodeGroup && e7a.inodeGroup === e7b.inodeGroup, 'the existing link group is recorded');
  const e8a = mf.entries.find((e) => e.rel.endsWith(recordName(8)) && e.rel.startsWith(w.a));
  assert.equal(e8a.inodeGroup, null, 'separate files with equal bytes are not a group');
  assert.ok(mf.entries.some((e) => e.area === 'global' && e.rel === 'ccd-session-presets.json'));
  assert.ok(mf.entries.some((e) => e.rel.endsWith('waiting-input/manifest.json')), 'sidecars are in the backup too');
  // nothing secret-bearing was copied anywhere in the backup
  for (const f of walkFiles(bk.dir)) assert.ok(!readFileSync(f, 'utf8').includes(SECRET), `no secret in ${f}`);
  assert.ok(!mf.entries.some((e) => /config\.json$/.test(e.rel) && !/^ccd|^mcp/.test(e.rel) && e.area === 'global'));
  assert.equal(verifyBackup(bk.dir).ok, true);
  // a damaged copy is noticed
  const victim = join(bk.dir, 'files', 'claude-code-sessions', w.a, uuid('1', 1), recordName(1));
  writeFileSync(victim, 'damaged');
  assert.equal(verifyBackup(bk.dir).ok, false);
});

function walkFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p)); else out.push(p);
  }
  return out;
}

/* ------------------------------------------------------------------ rollback */

test('T17 rollback after a link that failed in the middle restores every file byte for byte', () => {
  const w = world();
  const before = storeHashes(w);
  const g0 = treeHashes(w.r.userData, (rel) => /^(ccd|mcp)/.test(rel));
  backupNow(w);

  process.env.SESSION_SYNC_TEST_FAIL_AFTER = '4';
  resetMutations();
  assert.throws(() => rectify(w.group, { mode: 'full', ctx: w.ctx, state: w.state }), /FAIL_AFTER/);
  delete process.env.SESSION_SYNC_TEST_FAIL_AFTER;
  assert.notDeepEqual(storeHashes(w), before, 'the failed link left a half-linked store');

  // life goes on after the failure: a new conversation, an edit of a global file, queue/hint changes
  const post = w.sim.save(w.fB, recordId(20), { title: 'created after the backup' });
  writeFileSync(join(w.r.userData, 'ccd-session-presets.json'), '{"changed":true}');
  const queued = join(w.fA.path, 'waiting-input', 'manifest.json');
  writeFileSync(queued, '{"queued":"after backup"}');
  const idx = join(w.fB.path, 'archived-sessions.idx');
  writeFileSync(idx, '{"v":1,"archived":["x"]}');
  w.state.records[recordId(20)] = { home: w.fB.key, folders: [w.fB.key] };
  saveState(w.ctx, w.state);

  w.sim.setApp({ running: false });
  const res = runRollback(w);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /restored \d+ file/);

  assertRestored(w, { excludedNow: {
    'waiting-input/manifest.json': undefined,
    [`${w.a}/${uuid('1', 1)}/waiting-input/manifest.json`]: '{"queued":"after backup"}',
    [`${w.b}/${uuid('1', 1)}/archived-sessions.idx`]: '{"v":1,"archived":["x"]}',
  } });
  assert.deepEqual(treeHashes(w.r.userData, (rel) => /^(ccd|mcp)/.test(rel)), g0, 'whole-file areas restored');
  // the post-backup record is back in its home folder, alone
  const home = join(w.fB.path, recordName(20));
  assert.ok(existsSync(home));
  assert.equal(nlinkOf(home), 1);
  assert.equal(readFileSync(home, 'utf8'), readFileSync(post, 'utf8'));
  for (const f of [w.fA, w.fC]) assert.ok(!existsSync(join(f.path, recordName(20))));
  // no mirror survived, no link temp name either
  for (const f of w.group) assert.ok(!readdirSync(f.path).some((n) => n.startsWith('.session-sync-link-')));
  // the state before the rollback is kept in a snapshot
  const snap = readdirSync(w.ctx.acc).find((d) => d.startsWith('pre-rollback-'));
  assert.ok(snap, 'pre-rollback snapshot exists');
  assert.ok(existsSync(join(w.ctx.acc, snap, 'files', 'claude-code-sessions', w.b, uuid('1', 1), recordName(20))));
  assert.equal(readFileSync(join(w.ctx.acc, snap, 'files', 'global', 'ccd-session-presets.json'), 'utf8'), '{"changed":true}');
});

test('T17 rollback after a COMPLETE link with saves, a delete and a post-backup record', () => {
  const w = world();
  backupNow(w);
  const rep = rectify(w.group, { mode: 'full', ctx: w.ctx, state: w.state });
  assert.equal(rep.aborted, false);
  w.sim.save(w.fC, recordId(1), { title: 'edited in C' });
  w.sim.save(w.fA, recordId(7), { title: 'edited 7 after linking' });   // breaks the pre-existing link group A7+B7
  w.sim.del(w.fB, recordId(2)); w.clock.tick(5000);
  w.sim.save(w.fA, recordId(30), { title: 'post-backup A' });
  rectify(w.group, { mode: 'full', ctx: w.ctx, state: w.state });
  saveState(w.ctx, w.state);
  assert.ok(!existsSync(join(w.fA.path, recordName(2))), 'the delete propagated');
  const postBytes = readFileSync(join(w.fA.path, recordName(30)), 'utf8');

  const res = runRollback(w);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assertRestored(w);
  for (const f of w.group) assert.ok(!readdirSync(f.path).some((n) => /^deleted_/.test(n) && n !== `deleted_${uuid('7', 7)}`), 'feature tombstones removed');
  assert.ok(existsSync(join(w.fA.path, recordName(2))), 'the deleted record is back');
  assert.equal(readFileSync(join(w.fA.path, recordName(30)), 'utf8'), postBytes, 'post-backup record kept in its home');
  assert.equal(nlinkOf(join(w.fA.path, recordName(30))), 1);
  for (const f of [w.fB, w.fC]) assert.ok(!existsSync(join(f.path, recordName(30))));

  // state: pairs answer "no" again, nothing is linked, the next link needs a new backup
  const st = loadState(w.ctx);
  assert.equal(st.linked, false);
  assert.equal(st.backupId, null);
  assert.deepEqual(st.records, {});
  for (const p of Object.values(st.pairs)) assert.deepEqual([p.answer, p.via], ['no', 'rollback']);

  // running it again changes nothing (idempotent)
  const h = storeHashes(w);
  const again = runRollback(w);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.deepEqual(storeHashes(w), h);
  assertRestored(w);
});

test('T17 a post-backup record without a state entry goes to its only folder, or the smallest key', () => {
  const w = world();
  backupNow(w);
  putRecord(w.fC.path, 40, {}, w.clock.tick());                              // only in C
  putRecord(w.fB.path, 41, {}, w.clock.tick());
  putRecord(w.fA.path, 41, { title: 'older copy' }, w.clock.tick(-5000));    // in A and B, no state: smallest key (A)
  w.clock.tick(5000);
  const res = runRollback(w);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.ok(existsSync(join(w.fC.path, recordName(40))), 'a lone post-backup record stays where it is');
  assert.ok(existsSync(join(w.fA.path, recordName(41))) && !existsSync(join(w.fB.path, recordName(41))));
  assert.equal(JSON.parse(readFileSync(join(w.fA.path, recordName(41)), 'utf8')).title, 'Synthetic conversation 41', 'the newest copy was kept');
});

test('T17 rollback refuses while the app runs, and with an unknown or stale state', () => {
  const w = world();
  backupNow(w);
  rectify(w.group, { mode: 'full', ctx: w.ctx, state: w.state });
  const h = storeHashes(w);
  w.sim.setApp({ running: true });
  let res = runRollback(w);
  assert.equal(res.status, 3, res.stdout + res.stderr);
  assert.match(res.stderr, /running/);
  w.sim.setApp({ s1: false, s2: null });
  assert.equal(runRollback(w).status, 3, 'unknown process state is a refusal');
  w.sim.setApp({ s1: true, s2: false });
  assert.equal(runRollback(w).status, 3, 'a lockfile alone is a refusal');
  assert.deepEqual(storeHashes(w), h, 'nothing changed');
  assert.ok(!readdirSync(w.ctx.acc).some((d) => d.startsWith('pre-rollback-')), 'no snapshot either');
  const ok = runRollback(w, ['--ignore-stale-lockfile']);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
});

test('T17 --dry-run changes nothing; a damaged backup copy aborts before any change', () => {
  const w = world();
  backupNow(w);
  rectify(w.group, { mode: 'full', ctx: w.ctx, state: w.state });
  const h = storeHashes(w);
  const dry = runRollback(w, ['--dry-run']);
  assert.equal(dry.status, 0, dry.stdout + dry.stderr);
  assert.match(dry.stdout, /dry run/);
  assert.deepEqual(storeHashes(w), h);
  assert.ok(!readdirSync(w.ctx.acc).some((d) => d.startsWith('pre-rollback-')));

  writeFileSync(join(w.bk.dir, 'files', 'claude-code-sessions', w.a, uuid('1', 1), recordName(1)), 'damaged');
  const bad = runRollback(w);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /damaged|missing/);
  assert.deepEqual(storeHashes(w), h, 'nothing was changed');
});

test('T17 rollback.mjs is standalone: node builtins only, run from the backup with no plugin on the path', () => {
  const w = world();
  backupNow(w);
  const src = readFileSync(join(w.bk.dir, 'rollback.mjs'), 'utf8');
  const imports = [...src.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.ok(imports.length > 3);
  for (const i of imports) assert.match(i, /^node:/, `only builtins: ${i}`);
  assert.ok(!/\brequire\(|\bimport\(/.test(src));
  // copy the whole backup somewhere unrelated to the plugin and run it there with a bare environment
  const away = join(w.r.root, 'elsewhere', 'accounts', 'backup', w.bk.id);
  mkdirSync(away, { recursive: true });
  for (const f of ['rollback.mjs', 'manifest.json']) writeFileSync(join(away, f), readFileSync(join(w.bk.dir, f)));
  const res = spawnSync(process.execPath, [join(away, 'rollback.mjs'), '--dry-run'], {
    cwd: tmpdir(), windowsHide: true, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' },
  });
  assert.equal(res.status, 1, 'with the file copies missing it refuses, proving it reads only next to itself');
  rmSync(join(w.r.root, 'elsewhere'), { recursive: true, force: true });
});

/* ------------------------------------------------------------------ T17 (stage 2): tasks step 6, path-level areas */

const P_SECRET = 'FAKE-SECRET-IN-MCP-ENV-NEVER-COPIED';

function pworld() {
  const r = makeRoot('rbp');
  const clock = makeClock();
  const sim = createSim({ clock, appFile: join(r.root, 'app.json') });
  const a = uuid('a', 1); const b = uuid('b', 1);
  const oa = uuid('1', 1); const ob = uuid('2', 2);
  const fA = addFolder(r.store, a, oa);
  const fB = addFolder(r.store, b, ob);
  const group = [fA, fB];
  for (let i = 1; i <= 3; i++) putRecord(fA.path, i, {}, clock.tick());
  putRecord(fB.path, 4, {}, clock.tick());
  putTasks(fA.path, [makeTask('tA', { cronExpression: '20 5 * * *' })], {}, clock.tick());
  putTasks(fB.path, [makeTask('tB', { cronExpression: '40 6 * * *' })], {}, clock.tick());
  const cfg = {
    preferences: {
      sidebarMode: 'code',
      bypassPermissionsOptInByAccount: { [a]: true },
      epitaxyPrefs: { [`epitaxy-auto-mode-denial-count.${a}`]: 4 },
    },
    mcpServers: { s: { command: 'node', env: { TOKEN: P_SECRET } } },
    'oauth:tokenCache': `enc-${P_SECRET}`,
  };
  const rc = { version: 1, telemetrySalt: `salt-${P_SECRET}`, identities: { [`${oa}:${a}`]: { serve: 'on', folders: { 'C:\\x': { mode: 'a' } }, pendingDelete: ['q'] } } };
  writeFileSync(join(r.userData, 'claude_desktop_config.json'), JSON.stringify(cfg, null, 2));
  writeFileSync(join(r.userData, 'remote-control-state.json'), `${JSON.stringify(rc, null, 2)}\n`);
  writeFileSync(join(r.userData, 'ccd-session-presets.json'), JSON.stringify({ byAccount: { [a]: { presets: [{ id: 'p1', name: 'P', createdAt: 1 }] } } }, null, '\t'));
  writeFileSync(join(r.userData, 'mcp-user-tool-toggles.json'), JSON.stringify({ v: 3, owners: { [a]: ['x:y'] } }, null, 2));
  writeFileSync(join(r.userData, 'config.json'), JSON.stringify({ lastKnownAccountUuid: a, 'oauth:tokenCache': P_SECRET }));
  sim.setApp({ running: false });
  const state = emptyState(r.store);
  answerPairs(state, [pairKey(a, b)], 'yes', 'cli', clock.t);
  saveState(r.ctx, state);
  const file = (n) => join(r.userData, n);
  return { r, ctx: r.ctx, clock, sim, fA, fB, group, a, b, file };
}

const rbRun = (w, id, args = []) => spawnSync(process.execPath, [join(w.ctx.acc, 'backup', id, 'rollback.mjs'), ...args], {
  cwd: tmpdir(), windowsHide: true, encoding: 'utf8', env: { ...process.env },
});

test('T17 path-level areas and task run-times: rollback after a complete link', async () => {
  const w = pworld();
  const before = {
    cfg: readFileSync(w.file('claude_desktop_config.json'), 'utf8'),
    rc: readFileSync(w.file('remote-control-state.json'), 'utf8'),
    presets: readFileSync(w.file('ccd-session-presets.json'), 'utf8'),
    toggles: readFileSync(w.file('mcp-user-tool-toggles.json'), 'utf8'),
    store: treeHashes(w.r.store, (rel) => !/scheduled-tasks\.json$|backlog/.test(rel)),
  };
  const rep = await link(w.ctx, {});
  assert.equal(rep.ok, true, JSON.stringify(rep));
  const linkedCfg = readFileSync(w.file('claude_desktop_config.json'), 'utf8');
  assert.notEqual(linkedCfg, before.cfg, 'the link changed the settings');

  // life after the link: B runs task tA, a task is created in B, the app changes an unrelated preference
  w.sim.setApp({ running: true, signedIn: w.b, startedAtMs: w.clock.t });
  w.sim.runTask(w.fB, 'tA', w.clock.tick());
  const bf = join(w.fB.path, 'scheduled-tasks.json');
  const bdoc = readJsonFile(bf);
  bdoc.scheduledTasks.push(makeTask('tNew', { cronExpression: '5 7 * * *' }));
  writeFileSync(bf, JSON.stringify(bdoc, null, 2));
  w.sim.stopApp();
  const cfgObj = readJsonFile(w.file('claude_desktop_config.json'));
  cfgObj.preferences.sidebarMode = 'chat';
  cfgObj.preferences.brandNew = 1;
  writeFileSync(w.file('claude_desktop_config.json'), JSON.stringify(cfgObj, null, 2));
  assert.equal((await fullPass(w.ctx, {})).ok, true);
  assert.ok(readJsonFile(join(w.fA.path, 'scheduled-tasks.json')).scheduledTasks.some((t) => t.id === 'tNew'), 'the new task spread');
  const ranAt = readJsonFile(join(w.fA.path, 'scheduled-tasks.json')).scheduledTasks.find((t) => t.id === 'tA').lastRunAt;
  assert.ok(ranAt);

  const res = rbRun(w, rep.backupId, ['--json']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const out = JSON.parse(res.stdout.trim().split('\n').pop());
  assert.equal(out.paths['claude_desktop_config.json'].status, 'restored');
  assert.equal(out.paths['remote-control-state.json'].status === 'restored' || out.paths['remote-control-state.json'].status === 'unchanged', true);

  // path-level: allow-listed values are back; every other key (including the app's own later change) stays
  const cfg = readJsonFile(w.file('claude_desktop_config.json'));
  assert.deepEqual(cfg.preferences.bypassPermissionsOptInByAccount, { [w.a]: true });
  assert.equal(cfg.preferences.epitaxyPrefs[`epitaxy-auto-mode-denial-count.${w.b}`], undefined);
  assert.equal(cfg.preferences.sidebarMode, 'chat');
  assert.equal(cfg.preferences.brandNew, 1);
  assert.equal(cfg.mcpServers.s.env.TOKEN, P_SECRET);
  assert.equal(cfg['oauth:tokenCache'], `enc-${P_SECRET}`);
  assert.equal(readFileSync(w.file('remote-control-state.json'), 'utf8'), before.rc);
  // whole-file areas: byte for byte; the store (without tasks and backlog): byte for byte
  assert.equal(readFileSync(w.file('ccd-session-presets.json'), 'utf8'), before.presets);
  assert.equal(readFileSync(w.file('mcp-user-tool-toggles.json'), 'utf8'), before.toggles);
  assert.deepEqual(treeHashes(w.r.store, (rel) => !/scheduled-tasks\.json$|backlog/.test(rel)), before.store);
  // tasks: each file as at the backup, plus the run-time max and the task created after the backup in its origin
  const ta = readJsonFile(join(w.fA.path, 'scheduled-tasks.json')).scheduledTasks;
  assert.deepEqual(ta.map((t) => t.id), ['tA']);
  assert.equal(ta[0].lastRunAt, ranAt, 'the run in B is not forgotten: tA does not fire twice');
  const tb = readJsonFile(join(w.fB.path, 'scheduled-tasks.json')).scheduledTasks;
  assert.deepEqual(tb.map((t) => t.id).sort(), ['tB', 'tNew']);
  assert.equal(out.tasks.appended, 1);
  assert.ok(out.tasks.runtimeUpdated >= 1);
  // the state is unlinked; no secret in the snapshot or anywhere under the accounts folder
  const st = loadState(w.ctx);
  assert.equal(st.linked, false);
  for (const f of walkFiles(w.ctx.acc)) assert.ok(!readFileSync(f, 'latin1').includes(P_SECRET), `no secret in ${f}`);
  const snap = readdirSync(w.ctx.acc).find((d) => d.startsWith('pre-rollback-'));
  assert.ok(existsSync(join(w.ctx.acc, snap, 'paths', 'claude_desktop_config.json')));
});

test('T17 --exact restores the task files byte for byte', async () => {
  const w = pworld();
  const t0 = ['A', 'B'].map((x) => readFileSync(join((x === 'A' ? w.fA : w.fB).path, 'scheduled-tasks.json'), 'utf8'));
  const rep = await link(w.ctx, {});
  assert.equal(rep.ok, true);
  w.sim.setApp({ running: true, signedIn: w.b, startedAtMs: w.clock.t });
  w.sim.runTask(w.fB, 'tA', w.clock.tick());
  w.sim.stopApp();
  assert.equal((await fullPass(w.ctx, {})).ok, true);
  const res = rbRun(w, rep.backupId, ['--exact']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const t1 = ['A', 'B'].map((x) => readFileSync(join((x === 'A' ? w.fA : w.fB).path, 'scheduled-tasks.json'), 'utf8'));
  assert.deepEqual(t1, t0);
});

test('T17 a path-level file that no longer round-trips is refused and left alone', async () => {
  const w = pworld();
  const rep = await link(w.ctx, {});
  assert.equal(rep.ok, true);
  const odd = `{"preferences":{"bypassPermissionsOptInByAccount":{"${w.a}":false,"${w.b}":true}},"mcpServers":{"s":{"env":{"TOKEN":"${P_SECRET}"}}}}`;
  writeFileSync(w.file('claude_desktop_config.json'), odd);
  const res = rbRun(w, rep.backupId, ['--json']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(readFileSync(w.file('claude_desktop_config.json'), 'utf8'), odd);
  const out = JSON.parse(res.stdout.trim().split('\n').pop());
  assert.equal(out.paths['claude_desktop_config.json'].status, 'refused');
  assert.ok(!res.stdout.includes(P_SECRET) && !res.stderr.includes(P_SECRET));
});

test('T17 an injected failure mid-link, at several points: rollback restores the store and settings exactly', async () => {
  for (const n of [0, 1, 4, 8]) {
    const w = pworld();
    const before = {
      store: treeHashes(w.r.store),
      files: Object.fromEntries(['claude_desktop_config.json', 'remote-control-state.json', 'ccd-session-presets.json', 'mcp-user-tool-toggles.json'].map((f) => [f, readFileSync(w.file(f), 'utf8')])),
    };
    process.env.SESSION_SYNC_TEST_FAIL_AFTER = String(n);
    resetMutations();
    await assert.rejects(() => link(w.ctx, {}), /FAIL_AFTER/, `n=${n}`);
    delete process.env.SESSION_SYNC_TEST_FAIL_AFTER; resetMutations();
    const id = loadState(w.ctx).backupId;
    if (!id) { assert.deepEqual(treeHashes(w.r.store), before.store, `n=${n}: failed before the backup: nothing changed`); rmSync(w.r.root, { recursive: true, force: true }); continue; }
    const res = rbRun(w, id);
    assert.equal(res.status, 0, `n=${n}: ${res.stdout}${res.stderr}`);
    assert.deepEqual(treeHashes(w.r.store), before.store, `n=${n}: store restored byte for byte`);
    for (const [f, text] of Object.entries(before.files)) assert.equal(readFileSync(w.file(f), 'utf8'), text, `n=${n}: ${f}`);
    rmSync(w.r.root, { recursive: true, force: true });
  }
});
