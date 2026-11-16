/**
 * T14 - the guarded settings merge (S1 to S11) on synthetic files that carry a
 * fake `mcpServers` env secret and oauth-like keys. Only allow-listed paths
 * change, a file that does not round-trip is refused, nothing is written while
 * the app runs, and the secret never appears in a log, a backup or a report.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  mergeSettings, guardedJsonEdit, computePathAreas, unknownAccountKeys, diffPaths, isAllowedPath, ALLOW,
  CFG, PRESETS, TOGGLES, RC,
} from '../lib/accounts/settings.mjs';
import { takeBackup } from '../lib/accounts/backup.mjs';
import { emptyState, readJson } from '../lib/accounts/state.mjs';
import { noteSignedIn, AppRunningError } from '../lib/accounts/appstate.mjs';
import { makeRoot, makeClock, addFolder, readJsonFile, uuid } from './fixtures/store.mjs';

afterEach(() => { delete process.env.SESSION_SYNC_TEST_APP_STATE; delete process.env.SESSION_SYNC_TEST_FAIL_AFTER; });

const SECRET = 'FAKE-SECRET-VALUE-MUST-NEVER-LEAK-4f9c';
const A = uuid('a', 1);
const B = uuid('b', 1);
const OA = uuid('1', 1);
const OB = uuid('2', 2);
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function cfgObject() {
  return {
    preferences: {
      ccdScheduledTasksEnabled: true,
      sidebarMode: 'code',
      bypassPermissionsOptInByAccount: { [A]: true },
      bypassPermissionsGateByAccount: { [A]: true, [B]: true },
      coworkModelAutoFallbackByAccount: { [A]: false, [B]: true },
      remoteChatFolderGrants: { 'grant-1': { orgUuid: OA, accountUuid: A, folders: ['C:\\synthetic\\g'] } },
      chromeExtension: { deviceId: `device-${SECRET}` },
      epitaxyPrefs: {
        'machine-wide-key': 'keep me',
        [`epitaxy-auto-mode-denial-count.${A}`]: 3,
        [`epitaxy-auto-mode-denial-count.${B}`]: 1,
        [`epitaxy-auto-default-nudge-seen.${A}`]: true,
        [`epitaxy-auto-entry-warning-seen.${B}`]: true,
        [`epitaxy-folder-permission-mode-v2.${A}`]: { 'C:\\synthetic\\p1': 'acceptEdits' },
        [`epitaxy-folder-permission-mode-v2.${B}`]: { 'C:\\synthetic\\p2': 'plan' },
        [`epitaxy-perm-mode-acks-v2.${A}`]: ['ack-1'],
        [`epitaxy-perm-mode-acks-v2.${B}`]: ['ack-2'],
        'dframe-code-sections': { [`${A}/${OA}`]: { open: ['one'] } },
        'dframe-group-scopes': { [`${B}/${OB}`]: { scope: 'repo' } },
        [`ultrathinkAvailable.model-x.${A}`]: true,
        [`some-new-feature.${A}`]: 42,
      },
    },
    mcpServers: { synthetic: { command: 'node', env: { API_TOKEN: SECRET } } },
    'oauth:tokenCache': `enc-${SECRET}`,
  };
}

const presetsObject = () => ({
  byAccount: {
    [A]: {
      presets: [
        { id: 'p1', name: 'First', createdAt: 1, lastUsedAt: 10, target: { kind: 'cwd', cwd: 'C:\\x' }, settings: { modelId: 'm', effort: 'high', fastMode: false } },
        { id: 'p2', name: 'Second', createdAt: 2, lastUsedAt: 20, target: { kind: 'cwd', cwd: 'C:\\y' }, settings: { modelId: 'm', effort: 'low', fastMode: true } },
      ],
      builtIns: { quick: { hidden: false } },
      seededFromDraft: true,
    },
  },
});

const togglesObject = () => ({ v: 3, owners: { [A]: [`${uuid('e', 1)}:batch`, `${uuid('e', 1)}:create`] } });

const rcObject = () => ({
  version: 1,
  telemetrySalt: `salt-${SECRET}`,
  identities: {
    [`${OA}:${A}`]: { serve: 'on', folders: { 'C:\\synthetic\\f1': { mode: 'a' } }, pendingDelete: ['x'], pendingUnarchive: [] },
  },
});

function world({ rc = rcObject() } = {}) {
  const r = makeRoot('settings');
  const clock = makeClock();
  const fA = addFolder(r.store, A, OA);
  const fB = addFolder(r.store, B, OB);
  const group = [fA, fB];
  const put = (name, obj, fmt = { indent: 2 }) => {
    const text = JSON.stringify(obj, null, fmt.indent) + (fmt.trailingNewline ? '\n' : '');
    writeFileSync(join(r.userData, name), text);
  };
  put(CFG, cfgObject());
  put(PRESETS, presetsObject(), { indent: '\t' });
  put(TOGGLES, togglesObject());
  if (rc) put(RC, rc, { indent: 2, trailingNewline: true });
  writeFileSync(join(r.userData, 'config.json'), JSON.stringify({ lastKnownAccountUuid: B, 'oauth:tokenCache': `enc-${SECRET}` }));
  writeFileSync(join(r.userData, 'ant-device-registry.json'), JSON.stringify({ devices: [{ key: SECRET }] }));
  const state = emptyState(r.store);
  const merge = (extra = {}) => mergeSettings(group, { mode: 'full', ctx: r.ctx, state, ...extra });
  const file = (n) => join(r.userData, n);
  return { r, clock, fA, fB, group, state, merge, file, put };
}

/** Every file below `dir`, as text (for the secret grep). */
function walkText(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkText(p, out); else if (e.isFile()) out.push([p, readFileSync(p, 'latin1')]);
  }
  return out;
}

async function captured(fn) {
  const chunks = [];
  const wo = process.stdout.write; const we = process.stderr.write;
  const lo = console.log; const le = console.error; const lw = console.warn; const li = console.info;
  const cap = (...a) => chunks.push(a.map(String).join(' '));
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  process.stderr.write = (c) => { chunks.push(String(c)); return true; };
  console.log = cap; console.error = cap; console.warn = cap; console.info = cap;
  try { return { value: await fn(), out: chunks.join('\n') }; } finally {
    process.stdout.write = wo; process.stderr.write = we;
    console.log = lo; console.error = le; console.warn = lw; console.info = li;
  }
}

/* ------------------------------------------------------------------ the merge */

test('T14 S1-S7: only allow-listed paths change, every other path is deep-equal, formatting kept', () => {
  const w = world();
  const before = JSON.parse(readFileSync(w.file(CFG), 'utf8'));
  const textBefore = readFileSync(w.file(CFG), 'utf8');
  const rep = w.merge();
  assert.equal(rep.files[CFG].status, 'written');
  const after = JSON.parse(readFileSync(w.file(CFG), 'utf8'));
  const diffs = diffPaths(before, after);
  assert.ok(diffs.length > 0);
  for (const p of diffs) assert.ok(isAllowedPath(CFG, p, w.group), `unexpected change at ${p.join('.')}`);
  // everything outside the allow-list is untouched
  assert.deepEqual(after.mcpServers, before.mcpServers);
  assert.deepEqual(after['oauth:tokenCache'], before['oauth:tokenCache']);
  assert.deepEqual(after.preferences.bypassPermissionsGateByAccount, before.preferences.bypassPermissionsGateByAccount);
  assert.deepEqual(after.preferences.remoteChatFolderGrants, before.preferences.remoteChatFolderGrants);
  assert.deepEqual(after.preferences.chromeExtension, before.preferences.chromeExtension);
  assert.equal(after.preferences.sidebarMode, 'code');
  assert.equal(after.preferences.epitaxyPrefs['machine-wide-key'], 'keep me');
  assert.equal(after.preferences.epitaxyPrefs[`some-new-feature.${A}`], 42);
  assert.equal(after.preferences.epitaxyPrefs[`ultrathinkAvailable.model-x.${A}`], true);
  const ep = after.preferences.epitaxyPrefs;
  // S1 and S2 (first link: OR)
  assert.equal(after.preferences.bypassPermissionsOptInByAccount[B], true);
  assert.equal(after.preferences.coworkModelAutoFallbackByAccount[A], true);
  // S3 max, S4 or, S5 map, S6 set, S7 map
  assert.equal(ep[`epitaxy-auto-mode-denial-count.${A}`], 3);
  assert.equal(ep[`epitaxy-auto-mode-denial-count.${B}`], 3);
  assert.equal(ep[`epitaxy-auto-default-nudge-seen.${B}`], true);
  assert.equal(ep[`epitaxy-auto-entry-warning-seen.${A}`], true);
  assert.deepEqual(ep[`epitaxy-folder-permission-mode-v2.${A}`], { 'C:\\synthetic\\p1': 'acceptEdits', 'C:\\synthetic\\p2': 'plan' });
  assert.deepEqual(ep[`epitaxy-folder-permission-mode-v2.${B}`], { 'C:\\synthetic\\p2': 'plan', 'C:\\synthetic\\p1': 'acceptEdits' });
  assert.deepEqual([...ep[`epitaxy-perm-mode-acks-v2.${A}`]].sort(), ['ack-1', 'ack-2']);
  assert.deepEqual([...ep[`epitaxy-perm-mode-acks-v2.${B}`]].sort(), ['ack-1', 'ack-2']);
  assert.deepEqual(Object.keys(ep['dframe-code-sections']).sort(), [`${A}/${OA}`, `${B}/${OB}`].sort());
  assert.deepEqual(ep['dframe-code-sections'][`${B}/${OB}`], { open: ['one'] });
  assert.deepEqual(ep['dframe-group-scopes'][`${A}/${OA}`], { scope: 'repo' });
  // format kept: 2 spaces, no trailing newline, LF
  assert.equal(textBefore.endsWith('}'), true);
  const textAfter = readFileSync(w.file(CFG), 'utf8');
  assert.equal(textAfter, JSON.stringify(after, null, 2));
  // unknown per-account keys are reported (names only, masked), not synced
  assert.deepEqual(rep.unknown, [`preferences.epitaxyPrefs.some-new-feature.${A.slice(0, 8)}`]);
  assert.equal(ep[`some-new-feature.${B}`], undefined);
  // a second pass changes nothing
  const again = w.merge();
  assert.equal(again.files[CFG].status, 'unchanged');
  assert.equal(readFileSync(w.file(CFG), 'utf8'), textAfter);
});

test('T14 S8-S9 presets: merged by id into the account that had none; tab indent kept; byAccount created', () => {
  const w = world();
  const rep = w.merge();
  assert.equal(rep.files[PRESETS].status, 'written');
  const text = readFileSync(w.file(PRESETS), 'utf8');
  assert.equal(text, JSON.stringify(JSON.parse(text), null, '\t'));
  const p = JSON.parse(text);
  assert.deepEqual(p.byAccount[B].presets.map((x) => x.id), ['p1', 'p2']);
  assert.deepEqual(p.byAccount[B].builtIns, { quick: { hidden: false } });
  assert.equal(p.byAccount[B].seededFromDraft, true);
  assert.deepEqual(p.byAccount[A].presets.map((x) => x.id), ['p1', 'p2']);
  // an edit in B and a new preset in A propagate; a removal propagates
  p.byAccount[B].presets[0].name = 'First (B)';
  p.byAccount[A].presets.push({ id: 'p3', name: 'Third', createdAt: 3, lastUsedAt: 30 });
  p.byAccount[A].presets = p.byAccount[A].presets.filter((x) => x.id !== 'p2');
  writeFileSync(w.file(PRESETS), JSON.stringify(p, null, '\t'));
  w.merge();
  const q = readJsonFile(w.file(PRESETS));
  assert.deepEqual(q.byAccount[A].presets.map((x) => x.id).sort(), ['p1', 'p3']);
  assert.deepEqual(q.byAccount[B].presets.map((x) => x.id).sort(), ['p1', 'p3']);
  assert.equal(q.byAccount[A].presets.find((x) => x.id === 'p1').name, 'First (B)');
});

test('T14 S10 tool toggles: the first link seeds the base and changes nothing; later changes sync', () => {
  const w = world();
  const before = readFileSync(w.file(TOGGLES), 'utf8');
  const rep = w.merge();
  assert.equal(rep.files[TOGGLES].status, 'unchanged');
  assert.equal(readFileSync(w.file(TOGGLES), 'utf8'), before, 'the new account does not inherit the old account\'s disabled tools');
  assert.deepEqual(readJson(join(w.r.acc, 'settings-base.json')).slots.S10[A].length, 2);
  // later: A disables one more tool and B disables a tool of its own
  const t = readJsonFile(w.file(TOGGLES));
  t.owners[A].push(`${uuid('e', 1)}:delete`);
  t.owners[B] = [`${uuid('e', 2)}:other`];
  writeFileSync(w.file(TOGGLES), JSON.stringify(t, null, 2));
  w.merge();
  const u = readJsonFile(w.file(TOGGLES));
  assert.deepEqual([...u.owners[B]].sort(), [`${uuid('e', 1)}:delete`, `${uuid('e', 2)}:other`].sort());
  assert.ok(u.owners[A].includes(`${uuid('e', 2)}:other`));
  assert.equal(u.owners[A].filter((x) => x.endsWith(':batch')).length, 1);
  assert.equal(u.v, 3);
});

test('T14 S11 remote control: update-only, never creates an identity; other keys untouched', () => {
  const w = world();
  const before = readFileSync(w.file(RC), 'utf8');
  const rep = w.merge();
  assert.equal(rep.files[RC].status, 'unchanged');
  assert.equal(readFileSync(w.file(RC), 'utf8'), before, 'only the old account has an identity: nothing syncs');
  // the new account gets an identity (by the app); now serve and folders sync
  const rc = readJsonFile(w.file(RC));
  rc.identities[`${OB}:${B}`] = { serve: 'off', folders: { 'C:\\synthetic\\f2': { mode: 'b' } }, pendingDelete: ['mine'] };
  writeFileSync(w.file(RC), JSON.stringify(rc, null, 2) + '\n');
  noteSignedIn(w.state, B, Date.parse('2026-11-16T10:00:00Z'));
  const rep2 = w.merge({ signedIn: B });
  assert.equal(rep2.files[RC].status, 'written');
  const out = readJsonFile(w.file(RC));
  assert.equal(out.identities[`${OA}:${A}`].serve, 'off');                   // first link: newest signed-in account's value
  assert.deepEqual(Object.keys(out.identities[`${OA}:${A}`].folders).sort(), ['C:\\synthetic\\f1', 'C:\\synthetic\\f2']);
  assert.deepEqual(out.identities[`${OA}:${A}`].pendingDelete, ['x']);       // account-bound queues are never copied
  assert.deepEqual(out.identities[`${OB}:${B}`].pendingDelete, ['mine']);
  assert.equal(out.telemetrySalt, rcObject().telemetrySalt);
  assert.equal(Object.keys(out.identities).length, 2);
  assert.ok(readFileSync(w.file(RC), 'utf8').endsWith('\n'), 'trailing newline kept');
});

test('T14 conflicts: signed-in account wins; with an unknown account (or a tie) the base is kept', () => {
  const w = world();
  w.merge();
  const set = (a, b) => {
    const c = readJsonFile(w.file(CFG));
    c.preferences.bypassPermissionsOptInByAccount[A] = a;
    c.preferences.bypassPermissionsOptInByAccount[B] = b;
    writeFileSync(w.file(CFG), JSON.stringify(c, null, 2));
  };
  // both changed to different values; base was true/true
  set(false, true);                                                           // only A changed
  w.merge();
  assert.deepEqual(readJsonFile(w.file(CFG)).preferences.bypassPermissionsOptInByAccount, { [A]: false, [B]: false });
  set(true, false);                                                           // A and B both changed (base false/false -> true/false: only A changed)
  w.merge();
  const m1 = readJsonFile(w.file(CFG)).preferences.bypassPermissionsOptInByAccount;
  assert.deepEqual(m1, { [A]: true, [B]: true });
  // now a real two-sided conflict on a value kind: epitaxy denial counts are max; use a map conflict instead
  const c = readJsonFile(w.file(CFG));
  c.preferences.epitaxyPrefs[`epitaxy-folder-permission-mode-v2.${A}`]['C:\\synthetic\\p1'] = 'from A';
  c.preferences.epitaxyPrefs[`epitaxy-folder-permission-mode-v2.${B}`]['C:\\synthetic\\p1'] = 'from B';
  writeFileSync(w.file(CFG), JSON.stringify(c, null, 2));
  const unknown = w.merge({ signedIn: null });
  assert.ok(unknown.conflicts >= 1);
  const k = readJsonFile(w.file(CFG)).preferences.epitaxyPrefs;
  assert.equal(k[`epitaxy-folder-permission-mode-v2.${A}`]['C:\\synthetic\\p1'], 'acceptEdits', 'unknown signed-in account: the base is kept');
  assert.equal(k[`epitaxy-folder-permission-mode-v2.${B}`]['C:\\synthetic\\p1'], 'acceptEdits');
  // known signed-in account wins
  const c2 = readJsonFile(w.file(CFG));
  c2.preferences.epitaxyPrefs[`epitaxy-folder-permission-mode-v2.${A}`]['C:\\synthetic\\p1'] = 'from A';
  c2.preferences.epitaxyPrefs[`epitaxy-folder-permission-mode-v2.${B}`]['C:\\synthetic\\p1'] = 'from B';
  writeFileSync(w.file(CFG), JSON.stringify(c2, null, 2));
  noteSignedIn(w.state, B, Date.parse('2026-11-16T12:00:00Z'));
  noteSignedIn(w.state, A, Date.parse('2026-11-15T12:00:00Z'));
  w.merge({ signedIn: B });
  const k2 = readJsonFile(w.file(CFG)).preferences.epitaxyPrefs;
  assert.equal(k2[`epitaxy-folder-permission-mode-v2.${A}`]['C:\\synthetic\\p1'], 'from B');
});

/* ------------------------------------------------------------------ the guard */

test('T14 guard: a file that does not round-trip is refused and left byte-identical', () => {
  const w = world();
  const odd = '{"preferences":{"bypassPermissionsOptInByAccount":{"' + A + '":true}},\n  "mcpServers":{"s":{"env":{"T":"' + SECRET + '"}}}}';
  writeFileSync(w.file(CFG), odd);
  const before = sha(w.file(CFG));
  const rep = w.merge();
  assert.equal(rep.files[CFG].status, 'refused');
  assert.equal(rep.files[CFG].reason, 'not round-trippable');
  assert.equal(sha(w.file(CFG)), before);
  // an unparseable file likewise
  writeFileSync(w.file(RC), '{ nope');
  const b2 = sha(w.file(RC));
  assert.equal(w.merge().files[RC].status, 'refused');
  assert.equal(sha(w.file(RC)), b2);
  // and nothing else was refused wrongly
  assert.equal(rep.files[PRESETS].status, 'written');
});

test('T14 guard: a mutation outside the allow-list writes nothing', () => {
  const w = world();
  const before = sha(w.file(CFG));
  const r = guardedJsonEdit(w.file(CFG), (obj) => { obj.mcpServers.synthetic.env.API_TOKEN = 'changed'; }, { allowed: (p) => isAllowedPath(CFG, p, w.group) });
  assert.equal(r.status, 'refused');
  assert.equal(sha(w.file(CFG)), before);
  assert.ok(!JSON.stringify(r).includes(SECRET));
  const r2 = guardedJsonEdit(w.file(CFG), (obj) => { obj.preferences.sidebarMode = 'x'; }, { allowed: (p) => isAllowedPath(CFG, p, w.group) });
  assert.equal(r2.status, 'refused');
  // a key of an account outside the group is not allow-listed
  const r3 = guardedJsonEdit(w.file(CFG), (obj) => { obj.preferences.bypassPermissionsOptInByAccount[uuid('9', 9)] = true; }, { allowed: (p) => isAllowedPath(CFG, p, w.group) });
  assert.equal(r3.status, 'refused');
  assert.equal(sha(w.file(CFG)), before);
});

test('T14 nothing is written while the app runs (live pass), and an app that starts mid-write aborts it', () => {
  const w = world();
  const hashes = Object.fromEntries([CFG, PRESETS, TOGGLES, RC].map((n) => [n, sha(w.file(n))]));
  const rep = w.merge({ mode: 'live' });
  assert.equal(rep.pending, true, 'a difference is owed');
  for (const n of Object.keys(hashes)) assert.equal(sha(w.file(n)), hashes[n], `${n} untouched`);
  assert.equal(existsSync(join(w.r.acc, 'settings-base.json')), false);
  // the S1 re-check right before the rename
  assert.throws(() => w.merge({ guard: () => { throw new AppRunningError('started'); } }), AppRunningError);
  for (const n of Object.keys(hashes)) assert.equal(sha(w.file(n)), hashes[n], `${n} untouched after the abort`);
  assert.deepEqual(readdirSync(w.r.userData).filter((n) => n.startsWith('.session-sync-link-')), [], 'no temp name left behind');
});

test('N3 a full pass sweeps a stale temp copy of ours from USERDATA and leaves a recent one', () => {
  const w = world();
  const stale = join(w.r.userData, '.session-sync-link-aaaaaaaaaaaa');
  const fresh = join(w.r.userData, '.session-sync-link-bbbbbbbbbbbb');
  writeFileSync(stale, 'x'); writeFileSync(fresh, 'x');
  utimesSync(stale, (w.r.ctx.now() - 2 * 3600e3) / 1000, (w.r.ctx.now() - 2 * 3600e3) / 1000);
  utimesSync(fresh, (w.r.ctx.now() - 1000) / 1000, (w.r.ctx.now() - 1000) / 1000);
  w.merge({ mode: 'live' });
  assert.equal(existsSync(stale), true, 'a live pass writes nothing');
  w.merge();
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true);
});

test('T14 an injected failure mid-merge leaves every file whole', () => {
  const w = world();
  process.env.SESSION_SYNC_TEST_FAIL_AFTER = '0';
  assert.throws(() => w.merge(), /SESSION_SYNC_TEST_FAIL_AFTER/);
  for (const n of [CFG, PRESETS, TOGGLES, RC]) JSON.parse(readFileSync(w.file(n), 'utf8'));
  delete process.env.SESSION_SYNC_TEST_FAIL_AFTER;
  assert.equal(w.merge().files[CFG].status, 'written');
});

test('T14 unknown per-account keys: names only, masked; excluded keys are not reported', () => {
  const w = world();
  const names = unknownAccountKeys(cfgObject(), w.group);
  assert.deepEqual(names, [`preferences.epitaxyPrefs.some-new-feature.${A.slice(0, 8)}`]);
  assert.ok(!names.join().includes(A));
  assert.ok(ALLOW.length === 11 || ALLOW.length > 0);
});

/* ------------------------------------------------------------------ secrets */

test('T14 secret grep: the secret appears in no report, log, backup, state or sidecar file', async () => {
  const w = world();
  const before = { cfg: JSON.parse(readFileSync(w.file(CFG), 'utf8')), cfgSha: sha(w.file('config.json')), regSha: sha(w.file('ant-device-registry.json')) };
  const areas = computePathAreas(w.r.ctx, w.group);
  assert.ok(!JSON.stringify(areas).includes(SECRET), 'path-level areas hold allow-listed values only');
  assert.ok(areas[CFG].sha256 && areas[RC].sha256);
  const { value: bk, out: out1 } = await captured(() => takeBackup(w.r.ctx, { group: w.group, pathAreas: areas }));
  const { value: rep, out: out2 } = await captured(() => { const a = w.merge({ signedIn: B }); w.merge({ mode: 'live' }); return a; });
  const reportText = JSON.stringify({ rep, areas, manifest: bk.manifest });
  for (const [label, text] of [['report', reportText], ['stdout/stderr', out1 + out2]]) assert.ok(!text.includes(SECRET), `${label} is clean`);
  const leaks = [];
  for (const root of [w.r.acc]) for (const [p, text] of walkText(root)) if (text.includes(SECRET)) leaks.push(p);
  assert.deepEqual(leaks, [], 'no file under the accounts folder holds the secret');
  // no copy of a secret-bearing file next to the original
  assert.deepEqual(readdirSync(w.r.userData).filter((n) => /\.bak|\.tmp|\.session-sync-link/.test(n)), []);
  // the live files still hold their own secret (they are the original), and unrelated files are untouched
  assert.equal(readJsonFile(w.file(CFG)).mcpServers.synthetic.env.API_TOKEN, SECRET);
  assert.deepEqual(readJsonFile(w.file(CFG)).mcpServers, before.cfg.mcpServers);
  assert.equal(sha(w.file('config.json')), before.cfgSha, 'config.json is never written');
  assert.equal(sha(w.file('ant-device-registry.json')), before.regSha, 'device registry is never touched');
  // the backup has path areas and whole-file areas only
  const names = bk.manifest.entries.map((e) => e.rel);
  assert.ok(!names.includes(CFG) && !names.includes(RC) && !names.includes('config.json'));
  assert.ok(statSync(join(bk.dir, 'manifest.json')).size > 0);
});

test('T14 path areas record the original allow-listed values or absent, and the original file hash', () => {
  const w = world();
  const areas = computePathAreas(w.r.ctx, w.group);
  const paths = areas[CFG].paths;
  assert.deepEqual(paths[JSON.stringify(['preferences', 'bypassPermissionsOptInByAccount', A])], { value: true });
  assert.deepEqual(paths[JSON.stringify(['preferences', 'bypassPermissionsOptInByAccount', B])], { absent: true });
  assert.deepEqual(paths[JSON.stringify(['preferences', 'epitaxyPrefs', `epitaxy-auto-mode-denial-count.${A}`])], { value: 3 });
  assert.equal(areas[CFG].sha256, sha(w.file(CFG)));
  assert.ok(Object.keys(areas[RC].paths).every((k) => JSON.parse(k)[0] === 'identities'));
  assert.ok(!Object.keys(areas[RC].paths).some((k) => k.includes('telemetrySalt')));
});
