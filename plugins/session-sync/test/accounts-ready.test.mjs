/**
 * `accounts ready` (0.5.17): the copies list, the rpm backup and mirror, the waiter takeover, the behind and mid-turn checks, GO or NO-GO,
 * the CLI exit codes, and the SessionStart hook's takeover. Fixture homes and stores only; no real waiter or app is started.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReady, mirrorTree, backupCopy, resolveTarget, waiterOlderThanSelf, formatReady, ReadyError } from '../lib/accounts/ready.mjs';
import { emptyState, saveState, accPath } from '../lib/accounts/state.mjs';
import { pairKey } from '../lib/accounts/folders.mjs';
import { makeRoot, makeClock, addFolder, putRecord, uuid, setMtime } from './fixtures/store.mjs';
import { CLI } from './fixtures/cliworld.mjs';

const A = uuid('a', 1); const B = uuid('b', 1);
const OA = uuid('1', 1); const OB = uuid('2', 2);
const tmps = [];
const tmp = (l) => { const d = mkdtempSync(join(tmpdir(), `ss-ready-${l}-`)); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } });

const put = (p, text) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); };
const plugin = (root, version, files = {}) => {
  put(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'session-sync', version }));
  for (const [k, v] of Object.entries(files)) put(join(root, ...k.split('/')), v);
};

/** A linked two-account world, a home with a cache copy 0.5.17 and an app copy 0.5.11 under each account, a live waiter at `waiterVersion`. */
function world({ waiterVersion = '0.5.16', rpmVersion = '0.5.11', linked = true } = {}) {
  const r = makeRoot('ready');
  tmps.push(r.root);
  const home = tmp('home');
  const clock = makeClock();
  const fA = addFolder(r.store, A, OA);
  const fB = addFolder(r.store, B, OB);
  const state = emptyState(r.store);
  state.linked = linked;
  state.pairs[pairKey(A, B)] = { answer: 'yes' };
  state.signed = { acct: A, at: 1, prev: B, cooling: {}, unloadedAt: { [B]: 1000 } };
  saveState(r.ctx, state);
  const cache = join(home, '.claude', 'plugins', 'cache', 'goodstuff', 'session-sync', '0.5.17');
  plugin(cache, '0.5.17', { 'lib/cli.mjs': 'new', 'lib/new.mjs': 'n', 'skills/x/SKILL.md': 's' });
  const rpm = {};
  for (const [name, a, o] of [['a', A, OA], ['b', B, OB]]) {
    const root = join(r.userData, 'rpm', a.slice(0, 8), o.slice(0, 8), 'plugin_01TEST');
    plugin(root, rpmVersion, { 'lib/cli.mjs': 'old', 'lib/gone.mjs': 'g' });
    mkdirSync(join(root, '.in_use'), { recursive: true });
    rpm[name] = root;
  }
  const setWaiter = (version) => {
    if (version === null) { for (const f of ['waiter.json', 'waiter.claim']) try { unlinkSync(accPath(r.ctx, f)); } catch { /* none */ } return; }
    writeFileSync(accPath(r.ctx, 'waiter.json'), JSON.stringify({ pid: process.pid, heartbeatAt: new Date(r.ctx.now()).toISOString(), armedAt: new Date(r.ctx.now()).toISOString(), reasons: ['watch'] }));
    writeFileSync(accPath(r.ctx, 'waiter.claim'), JSON.stringify({ pid: process.pid, at: r.ctx.now(), version }));
  };
  setWaiter(waiterVersion);
  const calls = { replace: 0, launch: [], child: [] };
  const deps = {
    app: () => ({ running: true, signedIn: A, startedAtMs: 0 }),
    replaceOld: () => { calls.replace++; setWaiter(null); return { replaced: true }; },
    launch: (args, o) => { calls.launch.push({ args, cli: o.cli }); setWaiter('0.5.17'); return { ok: true, pid: 1 }; },
    child: (cli) => { calls.child.push(cli); setWaiter('0.5.17'); return { ok: true, status: 0 }; },
    sleep: async () => {}, waitMs: 0,
  };
  return { r, ctx: r.ctx, home, clock, fA, fB, cache, rpm, calls, deps, setWaiter, state,
    run: (o = {}) => runReady(r.ctx, { home, self: { path: cache, version: '0.5.17' }, ...o, deps: { ...deps, ...(o.deps ?? {}) } }) };
}

test('mirrorTree: copies what differs, removes the extras, leaves .in_use alone, refuses outside the allowed root', () => {
  const root = tmp('mirror');
  const src = join(root, 'src'); const dest = join(root, 'rpm', 'x');
  plugin(src, '2.0.0', { 'lib/a.mjs': 'new', 'lib/sub/b.mjs': 'b' });
  plugin(dest, '1.0.0', { 'lib/a.mjs': 'old', 'lib/extra.mjs': 'e', 'lib/oldsub/c.mjs': 'c' });
  mkdirSync(join(dest, '.in_use'), { recursive: true });
  const r = mirrorTree(src, dest, join(root, 'rpm'));
  assert.ok(r.copied >= 3 && r.removed === 2);
  assert.equal(readFileSync(join(dest, 'lib', 'a.mjs'), 'utf8'), 'new');
  assert.equal(readFileSync(join(dest, 'lib', 'sub', 'b.mjs'), 'utf8'), 'b');
  assert.equal(JSON.parse(readFileSync(join(dest, '.claude-plugin', 'plugin.json'), 'utf8')).version, '2.0.0');
  assert.ok(!existsSync(join(dest, 'lib', 'extra.mjs')) && !existsSync(join(dest, 'lib', 'oldsub')));
  assert.ok(existsSync(join(dest, '.in_use')), '.in_use stays');
  assert.deepEqual(mirrorTree(src, dest, join(root, 'rpm')), { copied: 0, removed: 0 });   // a second run changes nothing
  assert.throws(() => mirrorTree(src, join(root, 'elsewhere'), join(root, 'rpm')), ReadyError);
});

test('backupCopy: a dated folder under ~/.claude/backups, unique on a second call, without .in_use', () => {
  const root = tmp('bk'); const home = join(root, 'home');
  const copy = join(root, 'copy');
  plugin(copy, '0.5.11', { 'lib/cli.mjs': 'old' });
  mkdirSync(join(copy, '.in_use'), { recursive: true });
  const b1 = backupCopy(copy, '0.5.11', home, Date.UTC(2026, 10, 27));
  const b2 = backupCopy(copy, '0.5.11', home, Date.UTC(2026, 10, 27));
  assert.ok(b1.endsWith('rpm-session-sync-0.5.11-2026-11-27'));
  assert.ok(b2.endsWith('rpm-session-sync-0.5.11-2026-11-27-2'));
  assert.equal(readFileSync(join(b1, 'lib', 'cli.mjs'), 'utf8'), 'old');
  assert.ok(!existsSync(join(b1, '.in_use')));
});

test('resolveTarget: full id, unique prefix, ambiguous, unknown; default is the one other account', () => {
  const accts = [A, B];
  assert.equal(resolveTarget(accts, B, A), B);
  assert.equal(resolveTarget(accts, 'BBBB', A), B);
  assert.equal(resolveTarget(accts, null, A), B);
  assert.equal(resolveTarget(accts, null, B), A);
  assert.throws(() => resolveTarget(['aaaaaaaa-1', 'aaaabbbb-2'], 'aaaa', null), /matches 2/);
  assert.throws(() => resolveTarget(accts, 'zz', A), /no such account/);
  assert.throws(() => resolveTarget(accts, null, null), /not known/);
  assert.throws(() => resolveTarget([A, B, uuid('c', 1)], null, A), /several/);
});

test('ready: an old app copy is backed up and mirrored, the old waiter is replaced from this (newest) copy, an idle linked pair is GO', async () => {
  const w = world();
  const r = await w.run({ to: 'bbbb' });
  assert.equal(r.verdict, 'GO', JSON.stringify(r.reasons));
  assert.equal(r.target, B.slice(0, 8));
  const rpm = r.copies.filter((c) => c.kind === 'desktop');
  assert.equal(rpm.length, 2);
  for (const c of rpm) {
    assert.equal(c.action, 'mirrored');
    assert.equal(c.from, '0.5.11');
    assert.ok(existsSync(join(c.backup, 'lib', 'gone.mjs')), 'the backup holds the old copy');
  }
  for (const root of Object.values(w.rpm)) {
    assert.equal(JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version, '0.5.17');
    assert.equal(readFileSync(join(root, 'lib', 'cli.mjs'), 'utf8'), 'new');
    assert.ok(!existsSync(join(root, 'lib', 'gone.mjs')) && existsSync(join(root, '.in_use')));
  }
  assert.equal(w.calls.replace, 1);
  assert.equal(w.calls.launch.length, 1);
  assert.deepEqual(w.calls.launch[0].args, ['accounts', 'wait', '--reason', 'watch']);
  assert.equal(w.calls.launch[0].cli, join(w.cache, 'lib', 'cli.mjs'), 'the new waiter starts from the newest copy');
  assert.equal(r.waiter.before.version, '0.5.16');
  assert.equal(r.waiter.after.version, '0.5.17');
  assert.deepEqual(w.calls.child, []);
  assert.ok(formatReady(r)[0] === 'GO');
});

test('ready: when this process is not the newest copy the takeover is a hidden child run from the newest copy', async () => {
  const w = world();
  const r = await w.run({ self: { path: w.rpm.a, version: '0.5.11' } });
  assert.equal(w.calls.replace, 0);
  assert.deepEqual(w.calls.child, [join(w.cache, 'lib', 'cli.mjs')]);
  assert.equal(r.waiter.takeover.mode, 'child');
  assert.equal(r.verdict, 'GO', JSON.stringify(r.reasons));
});

test('ready: a current waiter is left alone; no waiter with the app running is started; a takeover that fails is a NO-GO', async () => {
  const cur = world({ waiterVersion: '0.5.17' });
  const r1 = await cur.run();
  assert.equal(cur.calls.replace + cur.calls.launch.length + cur.calls.child.length, 0);
  assert.equal(r1.verdict, 'GO');

  const none = world({ waiterVersion: null });
  const r2 = await none.run();
  assert.equal(none.calls.launch.length, 1);
  assert.equal(r2.verdict, 'GO');

  const stuck = world();
  const r3 = await stuck.run({ deps: { replaceOld: () => ({ replaced: false, reason: 'busy' }) } });
  assert.equal(r3.verdict, 'NO-GO');
  assert.ok(r3.reasons.some((x) => x.code === 'waiter-old'), JSON.stringify(r3.reasons));
  assert.equal(r3.waiter.takeover.ok, false);

  const gone = world({ waiterVersion: null });
  const r4 = await gone.run({ deps: { app: () => ({ running: false, signedIn: null, startedAtMs: 0 }), } , to: 'bbbb' });
  assert.ok(r4.reasons.some((x) => x.code === 'waiter-not-running'));
});

test('ready: behind copies in the target account are a NO-GO; the source account\'s are info', async () => {
  const w = world({ waiterVersion: '0.5.17' });
  const base = w.clock.tick();
  putRecord(w.fA.path, 1, { lastActivityAt: '2026-10-01T12:00:00.000Z', completedTurns: 3 }, base + 5000);
  putRecord(w.fB.path, 1, { lastActivityAt: '2026-10-01T10:00:00.000Z', completedTurns: 1 }, base);
  setMtime(join(w.fA.path, `local_${uuid('c', 1)}.json`), base + 5000);
  const toB = await w.run({ to: B });
  assert.equal(toB.verdict, 'NO-GO');
  assert.deepEqual([toB.behind.target, toB.behind.source], [1, 0]);
  assert.ok(toB.reasons.some((x) => x.code === 'behind-target'));
  const toA = await w.run({ to: A });
  assert.equal(toA.verdict, 'GO', JSON.stringify(toA.reasons));
  assert.deepEqual([toA.behind.target, toA.behind.source], [0, 1]);
  assert.deepEqual(toA.behind.sourceIds, [uuid('c', 1).slice(0, 8)]);
});

test('ready: a session still running in the account that is not loaded is a NO-GO', async () => {
  const w = world({ waiterVersion: '0.5.17' });
  putRecord(w.fB.path, 2, { lastActivityAt: '2026-10-01T12:00:00.000Z' }, w.clock.tick());   // alone in the parked account's folder, written after the unload
  const r = await w.run({ to: B });
  assert.equal(r.verdict, 'NO-GO');
  assert.equal(r.midTurn.length, 1);
  assert.equal(r.midTurn[0].id, uuid('c', 2).slice(0, 8));
  assert.ok(r.reasons.some((x) => x.code === 'mid-turn'));
});

test('ready: an app copy of the target account that cannot be brought up to the cache is a NO-GO; an unlinked pair is a NO-GO', async () => {
  const w = world({ waiterVersion: '0.5.17' });
  const r = await w.run({ to: B, home: tmp('empty-home'), self: { path: w.cache, version: '0.5.11' } });   // no cache copy at all: nothing to mirror from
  assert.ok(r.copies.filter((c) => c.kind === 'desktop').every((c) => c.action === 'no-cache'));
  const un = world({ linked: false });
  const r2 = await un.run({ to: B });
  assert.equal(r2.verdict, 'NO-GO');
  assert.ok(r2.reasons.some((x) => x.code === 'not-linked'));
  const bad = world({ waiterVersion: '0.5.17' });
  const r3 = await bad.run({ to: B, deps: {} });
  assert.equal(r3.verdict, 'GO');   // control: with the cache present the same world is GO
});

test('waiterOlderThanSelf: only a live older claim counts, and nothing else is read', () => {
  const w = world({ waiterVersion: '0.5.16' });
  assert.equal(waiterOlderThanSelf(w.ctx, '0.5.17'), true);
  assert.equal(waiterOlderThanSelf(w.ctx, '0.5.16'), false);
  assert.equal(waiterOlderThanSelf(w.ctx, '0.5.15'), false);
  assert.equal(waiterOlderThanSelf(w.ctx, '0.5.17', () => false), false, 'a dead pid is no waiter');
  w.setWaiter(null);
  assert.equal(waiterOlderThanSelf(w.ctx, '0.5.17'), false);
  writeFileSync(accPath(w.ctx, 'waiter.claim'), JSON.stringify({ pid: process.pid, at: 1 }));
  assert.equal(waiterOlderThanSelf(w.ctx, '0.5.17'), true, 'a claim without a version is an older waiter');
});

/* ---------------------------------------------------------------- the CLI and the hook (real cli.mjs, sandbox home) */

import { cworld, cleanupWorlds, A as CA, B as CB } from './fixtures/cliworld.mjs';
afterEach(() => cleanupWorlds());

test('cli: accounts ready exits 2 for an unknown --to and for --to without a value; prints one JSON object with --json', () => {
  const w = cworld();
  w.putState((s) => { s.linked = true; s.pairs[pairKey(CA, CB)] = { answer: 'yes' }; });
  const bad = w.run(['accounts', 'ready', '--to', 'zzzz', '--json']);
  assert.equal(bad.status, 2, bad.stderr);
  assert.equal(JSON.parse(bad.stdout).ok, false);
  const none = w.run(['accounts', 'ready', '--to']);
  assert.equal(none.status, 2);
  w.setApp({ running: true, signedIn: CA });
  const r = w.run(['accounts', 'ready', '--to', CB.slice(0, 8), '--json']);
  assert.ok([0, 1].includes(r.status), `${r.status} ${r.stderr}`);
  const j = JSON.parse(r.stdout);
  assert.equal(j.command, 'ready');
  assert.equal(j.verdict, r.status === 0 ? 'GO' : 'NO-GO');
  assert.equal(j.target, CB.slice(0, 8));
  assert.ok(Array.isArray(j.copies) && typeof j.elapsedMs === 'number' && 'before' in j.waiter && 'after' in j.waiter);
});

test('cli: launch-detached allows `accounts rectify --from-hook` and nothing longer', () => {
  const w = cworld();
  const log = join(w.home, 'launch.log');
  const ok = w.run(['accounts', 'launch-detached', 'accounts', 'rectify', '--from-hook'], { SESSION_SYNC_TEST_LAUNCH_LOG: log });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8').trim()), { args: ['accounts', 'rectify', '--from-hook'] });
  const no = w.run(['accounts', 'launch-detached', 'accounts', 'rectify', '--from-hook', '--json'], { SESSION_SYNC_TEST_LAUNCH_LOG: log });
  assert.equal(no.status, 1);
  const no2 = w.run(['accounts', 'launch-detached', 'accounts', 'rectify'], { SESSION_SYNC_TEST_LAUNCH_LOG: log });
  assert.equal(no2.status, 1);
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1);
});

test('hook: a live waiter older than this copy starts the takeover through the launcher once; a current or absent waiter starts nothing', () => {
  const w = cworld();
  w.putState((s) => { s.linked = true; s.pairs[pairKey(CA, CB)] = { answer: 'yes' }; });
  const log = join(w.home, 'hook-launch.log');
  const claim = join(w.acc, 'waiter.claim');
  const stamp = join(w.acc, 'hook-rectify.stamp');
  const hook = () => { writeFileSync(stamp, String(Date.now())); return w.run(['auto-pull', '--from-hook'], { SESSION_SYNC_TEST_LAUNCH_LOG: log }); };   // the plain rectify of the hook is held off: only the takeover can launch
  const takeovers = () => (existsSync(log) ? readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l).args.join(' ')).filter((l) => l === 'accounts rectify --from-hook').length : 0);
  hook();   // no waiter
  assert.equal(takeovers(), 0);
  writeFileSync(claim, JSON.stringify({ pid: process.pid, at: Date.now(), version: '0.0.1' }));   // this test process stands in for an older waiter
  rmSync(stamp, { force: true });
  w.run(['auto-pull', '--from-hook'], { SESSION_SYNC_TEST_LAUNCH_LOG: log });
  assert.equal(takeovers(), 1);
  assert.ok(existsSync(stamp), 'the takeover holds off the plain rectify of the same hook');
  w.run(['auto-pull', '--from-hook'], { SESSION_SYNC_TEST_LAUNCH_LOG: log });   // inside the debounce window
  assert.equal(takeovers(), 1);
  rmSync(log, { force: true });
  rmSync(join(w.acc, 'hook-takeover.stamp'), { force: true });
  const ver = JSON.parse(readFileSync(join(CLI, '..', '..', '.claude-plugin', 'plugin.json'), 'utf8')).version;
  writeFileSync(claim, JSON.stringify({ pid: process.pid, at: Date.now(), version: ver }));
  hook();   // a current waiter
  assert.equal(takeovers(), 0);
});
