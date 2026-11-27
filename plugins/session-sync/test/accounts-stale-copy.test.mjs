/**
 * Stale-copy conflicts after an account switch (0.5.16 final review, items 1 to 6): ordinary saves are no conflicts and make no
 * backups, a real stale continuation is reported once per episode, prune only deletes files whose sha256 is the indexed one, and
 * `accounts rectify --dry-run` predicts what the live pass does. Temp-dir fixtures only (the app is simulated).
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fullPass, livePass, dryRectify } from '../lib/accounts/pass.mjs';
import { setOldWaiterGate } from '../lib/accounts/rectify.mjs';
import { pruneBackups, backupCopy, resetBackupCache } from '../lib/accounts/backup.mjs';
import { loadState, saveState, emptyState, resetMutations } from '../lib/accounts/state.mjs';
import { answerPairs, pairKey } from '../lib/accounts/folders.mjs';
import { G_SWITCH_MS } from '../lib/accounts/appstate.mjs';
import { makeRoot, makeClock, addFolder, putRecord, recordName, uuid, readRecord, treeHashes } from './fixtures/store.mjs';
import { createSim } from './fixtures/appsim.mjs';

afterEach(() => { delete process.env.SESSION_SYNC_TEST_APP_STATE; resetMutations(); });

const A = uuid('a', 1); const B = uuid('b', 1);
const OA = uuid('1', 1); const OB = uuid('2', 2);
const id = (n) => recordName(n).slice(0, -5);
const SW = G_SWITCH_MS + 1000;

async function world() {
  const r = makeRoot('stale'); const clock = makeClock();
  const sim = createSim({ clock, appFile: join(r.root, 'app.json') });
  const fA = addFolder(r.store, A, OA); const fB = addFolder(r.store, B, OB);
  for (let i = 1; i <= 3; i++) putRecord(fA.path, i, { title: `A ${i}` }, clock.tick());
  sim.setApp({ running: false });
  const st = emptyState(r.store); answerPairs(st, [pairKey(A, B)], 'yes', 'cli', clock.t); saveState(r.ctx, st);
  r.ctx.now = () => clock.t;
  assert.equal((await fullPass(r.ctx, { reasons: ['link'] })).ok, true);
  const w = { r, ctx: r.ctx, clock, sim, fA, fB };
  w.pass = (o = {}) => livePass(r.ctx, o);
  w.state = () => loadState(r.ctx);
  w.title = (f, n) => readRecord(join(f.path, recordName(n))).title;
  w.backups = (reason) => {
    const f = join(r.acc, 'rectify-backups', 'index.jsonl');
    const all = existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    return reason ? all.filter((b) => b.reason === reason) : all;
  };
  return w;
}

test('P1 ordinary saves in B after a clean switch: no conflict, no backup, however many saves follow', async () => {
  const w = await world();
  w.sim.start(A, w.fA, w.r.userData); await w.pass();
  w.sim.signIn(B, w.fB, { userData: w.r.userData }); await w.pass();
  w.clock.tick(SW); await w.pass();
  const seen = [];
  for (let i = 0; i < 4; i++) {
    w.sim.saveFromMemory(id(1), { title: `s${i}` }); w.clock.tick(1000);
    const lp = await w.pass();
    seen.push({ i, conflicts: (lp.rectify.conflicts ?? []).length, backups: w.backups('split-loser').length, aTitle: w.title(w.fA, 1) });
  }
  for (const s of seen) { assert.equal(s.conflicts, 0, `save ${s.i}: no conflict`); assert.equal(s.backups, 0, `save ${s.i}: no backup`); assert.equal(s.aTitle, `s${s.i}`, `save ${s.i}: A follows`); }
  assert.equal(Object.keys(w.state().conflicts ?? {}).length, 0);
});

test('P2 a later stale continuation of the same id and folder is reported again', async () => {
  const w = await world();
  w.sim.start(A, w.fA, w.r.userData); await w.pass();
  const episode = async (tag) => {
    w.sim.signIn(B, w.fB, { userData: w.r.userData, flush: [{ id: id(1), patch: { title: `flush ${tag}` } }] });
    await w.pass();
    w.sim.saveFromMemory(id(1), { title: `stale continued ${tag}` }); w.clock.tick(SW);
    const lp = await w.pass();
    return (lp.rectify.conflicts ?? []).length;
  };
  const e1 = await episode(1);
  w.sim.signIn(A, w.fA, { userData: w.r.userData }); await w.pass(); w.clock.tick(SW); await w.pass();
  w.sim.saveFromMemory(id(1), { title: 'work in A' }); w.clock.tick(SW); await w.pass();
  const e2 = await episode(2);
  assert.equal(e1, 1, 'episode 1 reports one');
  assert.equal(e2, 1, 'episode 2 reports one');
  assert.ok(w.backups('split-loser').length >= 2, 'each real conflict backed up the losing copy before replacing it');
});

const sha = (s) => createHash('sha256').update(s).digest('hex');
const dayOf = (t) => { const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

test('prune: legacy lines (no dst) sharing a base name; only the file whose sha256 is the line, only rectify kinds', () => {
  const acc = mkdtempSync(join(tmpdir(), 'prune-'));
  try {
    const now = Date.now(); const t = now - 20 * 86400000;
    const dir = join(acc, 'rectify-backups', dayOf(t), 'acct', 'org'); mkdirSync(dir, { recursive: true });
    const name = 'local_x.json';
    writeFileSync(join(dir, name), 'DELETE-BACKUP');
    writeFileSync(join(dir, `${name}.1`), 'SPLIT-LOSER-1');
    writeFileSync(join(dir, `${name}.2`), 'SPLIT-LOSER-2');
    const at = new Date(t).toISOString();
    const lines = [
      { at, reason: 'delete', folder: 'acct/org', name, sha256: sha('DELETE-BACKUP') },
      { at, reason: 'split-loser', folder: 'acct/org', name, sha256: sha('SPLIT-LOSER-1') },
      { at, reason: 'split-loser', folder: 'acct/org', name, sha256: sha('SPLIT-LOSER-2') },
    ];
    writeFileSync(join(acc, 'rectify-backups', 'index.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    pruneBackups({ acc, now: () => now }, { days: 14, force: true });
    assert.deepEqual(readdirSync(dir), [name], 'only the delete backup is left');
    assert.equal(readFileSync(join(dir, name), 'utf8'), 'DELETE-BACKUP');
    const left = readFileSync(join(acc, 'rectify-backups', 'index.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).reason);
    assert.deepEqual(left, ['delete']);
  } finally { rmSync(acc, { recursive: true, force: true }); }
});

test('prune: a file whose content no longer matches its line is not deleted, memory and tasks backups are never pruned', () => {
  const acc = mkdtempSync(join(tmpdir(), 'prune-'));
  try {
    const now = Date.now(); const t = now - 30 * 86400000;
    const day = dayOf(t);
    const dir = join(acc, 'rectify-backups', day, 'acct', 'org'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.json'), 'CHANGED');
    writeFileSync(join(dir, 'b.json'), 'MEMORY');
    writeFileSync(join(dir, 'c.json'), 'OK');
    const at = new Date(t).toISOString();
    const lines = [
      { at, reason: 'split-loser', folder: 'acct/org', name: 'a.json', sha256: sha('ORIGINAL'), dst: `${day}/acct/org/a.json` },
      { at, reason: 'memory', folder: 'acct/org', name: 'b.json', sha256: sha('MEMORY'), dst: `${day}/acct/org/b.json` },
      { at, reason: 'split-loser', folder: 'acct/org', name: 'c.json', sha256: sha('OK'), dst: `${day}/acct/org/c.json` },
    ];
    writeFileSync(join(acc, 'rectify-backups', 'index.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    pruneBackups({ acc, now: () => now }, { days: 14, force: true });
    assert.deepEqual(readdirSync(dir).sort(), ['a.json', 'b.json']);
  } finally { rmSync(acc, { recursive: true, force: true }); }
});

/* ------------------------------------------------------------------ dry run */

const treeOf = (w) => {
  const out = {};
  for (const root of [w.r.store, w.r.acc, w.r.userData]) {
    const h = treeHashes(root);
    for (const rel of Object.keys(h)) out[`${root}/${rel}`] = `${h[rel]}@${statSync(join(root, rel)).mtimeMs}`;
  }
  return out;
};

test('dry run with the app running makes the live pass decisions: the conflict and the hold reset are predicted, nothing is written', async () => {
  const w = await world();
  w.sim.start(A, w.fA, w.r.userData); await w.pass();
  w.sim.signIn(B, w.fB, { userData: w.r.userData, flush: [{ id: id(1), patch: { title: 'flush' } }] });
  await w.pass();
  w.sim.saveFromMemory(id(1), { title: 'stale continued' }); w.clock.tick(SW);
  rmSync(join(w.r.acc, 'holds-reset.json'), { force: true });   // the pre-0.5.16 state: the reset has not happened
  const before = treeOf(w);
  const calls = [];
  setOldWaiterGate((_ctx, o) => { calls.push(o); return true; });
  try {
    const rec = dryRectify(w.ctx, {});
    assert.deepEqual(treeOf(w), before, 'a dry run writes nothing');
    assert.equal((rec.conflicts ?? []).length, 1, 'the stale continuation is predicted');
    assert.equal(typeof rec.holdsReset, 'number', 'the hold reset is predicted');
    assert.equal(calls.length, 1); assert.equal(calls[0].dry, true, 'the old-waiter question is asked without ending anything');
    assert.equal(existsSync(join(w.r.acc, 'holds-reset.json')), false);
    setOldWaiterGate(() => false);
    assert.equal(dryRectify(w.ctx, {}).holdsResetDeferred, 'an older waiter is alive');
  } finally { setOldWaiterGate(null); }
  // the real pass then does what the dry run said
  const lp = await w.pass();
  assert.equal((lp.rectify.conflicts ?? []).length, 1);
});

test('dry run: wouldRewriteNewer flags a replaced copy that holds work the winner lacks, not a newer file time', async () => {
  const w = await world();
  // B holds more recent work in record 1 but an older file time; record 2 holds an older copy with an older file time
  rmSync(join(w.fB.path, recordName(1)));
  putRecord(w.fB.path, 1, { title: 'B newer work', lastActivityAt: '2026-10-05T10:00:00.000Z' }, 1_700_000_000_000);
  rmSync(join(w.fB.path, recordName(2)));
  putRecord(w.fB.path, 2, { title: 'B older', lastActivityAt: '2026-09-01T10:00:00.000Z' }, 1_700_000_000_000);
  const before = treeOf(w);
  const rec = dryRectify(w.ctx, {});
  assert.deepEqual(treeOf(w), before);
  const relinks = rec.dry.filter((d) => d.op === 'relink');
  assert.equal(relinks.length, 2);
  assert.equal(relinks.find((d) => d.id === id(1)).newerThanWinner, true, 'work the winner lacks');
  assert.equal(relinks.find((d) => d.id === id(2)).newerThanWinner, false, 'an older copy is not');
});

// ---- 0.5.16 re-review must-fix items ----

test('C2b a pass that read "B signed in" before the switch links B\'s newest copy into the folder the app loaded stale: one conflict, B\'s copy backed up', async () => {
  const w = await world();
  const confs = (lp) => (lp?.rectify?.conflicts ?? []).length;
  w.sim.start(A, w.fA, w.r.userData); await w.pass();
  w.sim.signIn(B, w.fB, { userData: w.r.userData }); await w.pass(); w.clock.tick(SW); await w.pass();
  w.sim.saveFromMemory(id(1), { title: 'B ordinary' }); w.clock.tick(1000); await w.pass();   // FA gets it
  // the waiter is not running: B's newer turns never reach FA
  w.sim.saveFromMemory(id(1), { title: 'B-new' }); w.clock.tick(1000);
  w.sim.saveFromMemory(id(1), { title: 'B-newer' }); w.clock.tick(1000);
  // the pass reads "B signed in"; Mike switches to A (the app loads FA's stale copy) before the pass acts on FA
  let switched = 0;
  const testHook = (when, e) => {
    if (when !== 'before-act' || e.folder !== w.fA.key || switched) return;
    switched++; w.sim.signIn(A, w.fA, { userData: w.r.userData });
  };
  w.clock.tick(500);
  await w.pass({ testHook });
  assert.equal(switched, 1, 'the pass reached FA');
  let n = confs(await w.pass());
  w.sim.saveFromMemory(id(1), { title: 'A-cont' }); w.clock.tick(1000); n += confs(await w.pass());
  w.clock.tick(SW); n += confs(await w.pass());
  const kept = w.backups('split-loser').map((b) => { try { return JSON.parse(readFileSync(join(w.r.acc, 'rectify-backups', ...b.dst.split('/')), 'utf8')).title; } catch { return '?'; } });
  assert.equal(n, 1, 'one conflict');
  assert.ok(kept.includes('B-newer'), `B-newer is backed up (backups: ${JSON.stringify(kept)})`);
});

test('C3 a delete backup is not skipped for a prunable backup of the same content, so retention cannot take its only copy', () => {
  const r = makeRoot('c3'); let t = Date.parse('2026-11-01T12:00:00Z'); r.ctx.now = () => t;
  const p = join(r.root, 'local_x.json'); writeFileSync(p, '{"title":"C"}');
  const a = backupCopy(r.ctx, p, { reason: 'split-loser', folder: 'a/o', name: 'local_x.json' });
  assert.equal(a.skipped, false);
  t += 86400000; resetBackupCache();
  const d = backupCopy(r.ctx, p, { reason: 'delete', folder: 'b/o', name: 'local_x.json' });
  assert.equal(d.skipped, false, 'the delete backup is made');
  // a prunable backup still dedupes against a kept one, and a second delete against the first
  assert.equal(backupCopy(r.ctx, p, { reason: 'split-loser', folder: 'a/o', name: 'local_x.json' }).skipped, true);
  assert.equal(backupCopy(r.ctx, p, { reason: 'delete', folder: 'b/o', name: 'local_x.json' }).skipped, true);
  t += 20 * 86400000; resetBackupCache();
  pruneBackups(r.ctx, { force: true });
  const root = join(r.acc, 'rectify-backups');
  const walk = (d0) => readdirSync(d0, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d0, e.name)) : [join(d0, e.name)]);
  const left = walk(root).filter((f) => !/index\.jsonl|\.pruned-at/.test(f)).filter((f) => readFileSync(f, 'utf8') === '{"title":"C"}');
  assert.equal(left.length, 1, 'the delete copy survives retention');
  assert.deepEqual(readFileSync(join(root, 'index.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).reason), ['delete']);
});
