/**
 * T22 W17 - an invariants sweep over random sequences of app events (seeded, so a failure replays): saves, new records, deletes,
 * archives, sign-out, switches with a flush race, a quit and a restart, with a targeted pass after most steps (what the watcher does).
 *
 * After every pass:
 *   S1  a name that was in a loaded or cooling folder is still there, under the same inode (ADD only there)
 *   I1  no content disappears: every version that left every folder is in the rectify backups (by sha)
 *   S5  the home of a record never changes once assigned
 * After every quit pass: one inode per id, the same names in both folders, nothing owed.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fullPass, livePass, owedWork } from '../lib/accounts/pass.mjs';
import { loadState, saveState, emptyState, resetMutations } from '../lib/accounts/state.mjs';
import { answerPairs, pairKey } from '../lib/accounts/folders.mjs';
import { G_SWITCH_MS } from '../lib/accounts/appstate.mjs';
import { makeRoot, makeClock, addFolder, putRecord, recordName, inoOf, uuid } from './fixtures/store.mjs';
import { createSim } from './fixtures/appsim.mjs';

afterEach(() => { delete process.env.SESSION_SYNC_TEST_APP_STATE; resetMutations(); });

const A = uuid('a', 1); const B = uuid('b', 1);
const OA = uuid('1', 1); const OB = uuid('2', 2);
const id = (n) => recordName(n).slice(0, -5);
const SEQUENCES = Number(process.env.SESSION_SYNC_SWEEP_SEQUENCES) || 20;
const STEPS = 22;

function prng(seed) {   // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

async function runSequence(seed) {
  const rnd = prng(seed);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const r = makeRoot('sweep');
  const clock = makeClock();
  const sim = createSim({ clock, appFile: join(r.root, 'app.json') });
  const fA = addFolder(r.store, A, OA); const fB = addFolder(r.store, B, OB);
  const folders = { [A]: fA, [B]: fB };
  for (let i = 1; i <= 3; i++) putRecord(fA.path, i, { title: `A ${i}` }, clock.tick());
  for (let i = 4; i <= 5; i++) putRecord(fB.path, i, { title: `B ${i}` }, clock.tick());
  sim.setApp({ running: false });
  const st0 = emptyState(r.store); answerPairs(st0, [pairKey(A, B)], 'yes', 'cli', clock.t); saveState(r.ctx, st0);
  r.ctx.now = () => clock.t;
  assert.equal((await fullPass(r.ctx, { reasons: ['link'] })).ok, true);

  const names = (f) => readdirSync(f.path).filter((n) => /^local_.*\.json$/.test(n));
  const log = [];
  const homes = new Map();
  const backupShas = () => {
    const f = join(r.acc, 'rectify-backups', 'index.jsonl');
    return new Set(existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).sha256) : []);
  };
  const versions = () => { const s = new Set(); for (const f of [fA, fB]) for (const n of names(f)) s.add(sha(join(f.path, n))); return s; };
  const inoMap = (f) => new Map(names(f).map((n) => [n, inoOf(join(f.path, n))]));

  /** A targeted pass with the invariants checked around it. */
  const pass = async (label) => {
    const st = loadState(r.ctx);
    const now = clock.t;
    const pinned = [];
    if (sim.signedIn) pinned.push(folders[sim.signedIn]);
    for (const [a, until] of Object.entries(st.signed?.cooling ?? {})) if (until > now && folders[a] && !pinned.includes(folders[a])) pinned.push(folders[a]);
    const before = pinned.map((f) => [f, inoMap(f)]);
    const vBefore = versions();
    const res = await livePass(r.ctx, {});
    assert.equal(res.ok || !!res.skipped, true, `${label}: pass failed ${JSON.stringify(res.skipped ?? res)}`);
    for (const [f, m] of before) {
      const after = inoMap(f);
      for (const [n, ino] of m) {
        assert.ok(after.has(n), `S1 ${label}: ${n} vanished from a loaded or cooling folder ${f.acct.slice(0, 1)}`);
        assert.equal(after.get(n), ino, `S1 ${label}: ${n} was re-linked in a loaded or cooling folder ${f.acct.slice(0, 1)}`);
      }
    }
    const vAfter = versions(); const bk = backupShas();
    for (const v of vBefore) if (!vAfter.has(v)) assert.ok(bk.has(v), `I1 ${label}: a version left the folders without a backup (${v.slice(0, 8)})`);
    for (const [rid, rec] of Object.entries(loadState(r.ctx).records ?? {})) {
      if (homes.has(rid)) assert.equal(rec.home, homes.get(rid), `S5 ${label}: the home of ${rid} changed`);
      else if (rec.home) homes.set(rid, rec.home);
    }
  };

  let acct = A;
  let nextN = 10;
  sim.start(acct, folders[acct], r.userData);
  await pass('start');
  for (let step = 0; step < STEPS; step++) {
    const f = folders[acct];
    const ids = [...sim.memory.keys()].filter((i) => existsSync(join(f.path, `${i}.json`)));
    const act = rnd();
    let label;
    if (act < 0.28 && ids.length) { const i = pick(ids); sim.saveFromMemory(i, { title: `s${seed}.${step}` }); label = `save ${i.slice(6, 14)}`; }
    else if (act < 0.38) { putRecord(f.path, nextN, { title: `new ${nextN}` }, clock.tick()); sim.load(f); label = `new ${nextN++}`; }
    else if (act < 0.46 && ids.length > 2) { const i = pick(ids); sim.del(f, i); sim.memory.delete(i); label = `delete ${i.slice(6, 14)}`; }
    else if (act < 0.52 && ids.length) { const i = pick(ids); sim.saveFromMemory(i, { isArchived: rnd() < 0.5 }); label = 'archive'; }
    else if (act < 0.78) {
      const to = acct === A ? B : A;
      const flush = ids.length && rnd() < 0.6 ? [{ id: pick(ids), patch: { title: `flush${step}` } }] : [];
      if (rnd() < 0.3) { sim.signOut(); await pass('signout'); clock.tick(60 * 1000); }
      sim.signIn(to, folders[to], { userData: r.userData, flush });
      acct = to; label = `switch to ${to.slice(0, 1)}`;
    } else if (act < 0.86) { clock.tick(Math.floor(rnd() * 1.5 * G_SWITCH_MS)); label = 'wait'; }
    else if (act < 0.92) {
      // the quit: a full pass, then the app starts again on the same account
      await pass('before quit');
      sim.stopApp();
      const fp = await fullPass(r.ctx, {});
      assert.equal(fp.ok, true, `quit pass failed (seed ${seed}, step ${step}): ${JSON.stringify(fp.reason ?? fp)}`);
      assert.equal(owedWork(r.ctx, {}).owed, false, `seed ${seed} step ${step}: something is still owed after the quit pass`);
      assert.deepEqual(names(fA).sort(), names(fB).sort(), `seed ${seed} step ${step}: names differ after the quit pass`);
      for (const n of names(fA)) assert.equal(inoOf(join(fA.path, n)), inoOf(join(fB.path, n)), `seed ${seed} step ${step}: ${n} is two files after the quit pass`);
      clock.tick(5000);
      sim.start(acct, folders[acct], r.userData);
      label = 'quit and restart';
    } else { label = 'idle'; }
    log.push(label);
    if (rnd() < 0.8) await pass(`${label} [${log.join(' | ')}]`);
    else clock.tick(1000 + Math.floor(rnd() * 3000));
  }
  // the final quit
  sim.stopApp();
  const fp = await fullPass(r.ctx, {});
  assert.equal(fp.ok, true, `final pass failed: ${JSON.stringify(fp.reason ?? fp)} [${log.join(' | ')}]`);
  assert.equal(owedWork(r.ctx, {}).owed, false, `seed ${seed}: owed after the final pass [${log.join(' | ')}]`);
  assert.deepEqual(names(fA).sort(), names(fB).sort(), `seed ${seed}: names differ at the end [${log.join(' | ')}]`);
  for (const n of names(fA)) assert.equal(inoOf(join(fA.path, n)), inoOf(join(fB.path, n)), `seed ${seed}: ${n} is two files at the end`);
}

test(`W17 invariants sweep: ${SEQUENCES} random sequences of saves, deletes, switches, sign-outs and quits`, async () => {
  for (let seed = 1; seed <= SEQUENCES; seed++) {
    try { await runSequence(seed); } catch (e) { e.message = `seed ${seed}: ${e.message}`; throw e; }
  }
});
