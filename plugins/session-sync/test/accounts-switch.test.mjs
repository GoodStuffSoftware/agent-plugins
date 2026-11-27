/**
 * T22 - switching accounts in the desktop app after the link (account-switch plan, W1-W17 and the invariants).
 *
 * The app is simulated (fixtures/appsim.mjs): it loads a folder once at sign-in, keeps the records in memory, saves by
 * tmp + rename, and leaves parked sessions writing to the folder they came from. The engine runs `livePass` (the targeted
 * pass) the way the watcher does, on a virtual clock. Pure fs in a temp tree; nothing touches a real store.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, existsSync, readdirSync, writeFileSync, lstatSync, unlinkSync, utimesSync, mkdirSync, rmSync } from 'node:fs';
import { fullPass, livePass, owedWork } from '../lib/accounts/pass.mjs';
import { runWaiter } from '../lib/accounts/waiter.mjs';
import { summaryStats, rectify } from '../lib/accounts/rectify.mjs';
import { pruneBackups } from '../lib/accounts/backup.mjs';
import { loadState, saveState, emptyState, resetMutations, readJson } from '../lib/accounts/state.mjs';
import { answerPairs, pairKey, listFolders, groupOf, pendingPairs, accountsOf } from '../lib/accounts/folders.mjs';
import { G_SWITCH_MS, nameIsHeld } from '../lib/accounts/appstate.mjs';
import { accountsPushFilter } from '../lib/sync.mjs';
import { collectStatus, formatStatus } from '../lib/accounts/report.mjs';
import {
  makeRoot, makeClock, addFolder, putRecord, recordName, inoOf, nlinkOf, uuid, readRecord, readJsonFile, treeHashes, setMtime,
} from './fixtures/store.mjs';
import { createSim } from './fixtures/appsim.mjs';

afterEach(() => { delete process.env.SESSION_SYNC_TEST_APP_STATE; resetMutations(); });

const A = uuid('a', 1); const B = uuid('b', 1); const C = uuid('c', 1);
const OA = uuid('1', 1); const OB = uuid('2', 2); const OC = uuid('3', 3);
const id = (n) => recordName(n).slice(0, -5);
const SW = G_SWITCH_MS + 1000;

/** A linked pair: A holds records 1-3, B holds 4-5 (all mirrored after the link). The app is stopped. */
async function world({ extra = false } = {}) {
  const r = makeRoot('switch');
  const clock = makeClock();
  const sim = createSim({ clock, appFile: join(r.root, 'app.json') });
  const fA = addFolder(r.store, A, OA); const fB = addFolder(r.store, B, OB);
  for (let i = 1; i <= 3; i++) putRecord(fA.path, i, { title: `A ${i}` }, clock.tick());
  for (let i = 4; i <= 5; i++) putRecord(fB.path, i, { title: `B ${i}` }, clock.tick());
  sim.setApp({ running: false });
  const st = emptyState(r.store); answerPairs(st, [pairKey(A, B)], 'yes', 'cli', clock.t); saveState(r.ctx, st);
  r.ctx.now = () => clock.t;
  const lk = await fullPass(r.ctx, { reasons: ['link'] });
  assert.equal(lk.ok, true);
  const w = { r, ctx: r.ctx, clock, sim, fA, fB, files: (f) => readdirSync(f.path).filter((n) => /^local_.*\.json$/.test(n)) };
  w.title = (f, n) => readRecord(join(f.path, recordName(n))).title;
  w.pass = (o = {}) => livePass(r.ctx, o);
  w.ino = (f, n) => inoOf(join(f.path, recordName(n)));
  w.state = () => loadState(r.ctx);
  w.backups = (reason) => {
    const f = join(r.acc, 'rectify-backups', 'index.jsonl');
    const all = existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    return reason ? all.filter((b) => b.reason === reason) : all;
  };
  if (extra) w.fC = addFolder(r.store, C, OC);
  return w;
}

/* ---------------------------------------------------------------- the ported cases (0.5.0 proof, now with the targeted pass) */

test('W1/W3 A to B: B is fresh before the switch; the flush race leaves a stale load, the continued copy wins, nothing is lost', async () => {
  const w = await world();
  w.sim.start(A, w.fA, w.r.userData);
  w.sim.save(w.fA, id(1), { title: 'A1 edit 1' });
  const lp0 = await w.pass();
  assert.equal(lp0.ok, true);
  assert.equal(w.title(w.fB, 1), 'A1 edit 1', 'B is current right after the save, with the app still on A');
  assert.equal(w.ino(w.fA, 1), w.ino(w.fB, 1));
  assert.deepEqual(lp0.live, [w.fA.key], 'A is the loaded folder: it only gets names');

  // the switch flush writes one more save into A, and the app loads B before any pass could run
  w.sim.signIn(B, w.fB, { userData: w.r.userData, flush: [{ id: id(1), patch: { title: 'A1 edit 2 (switch flush)' } }] });
  assert.equal(w.sim.memory.get(id(1)).title, 'A1 edit 1', 'the app shows the copy that was in B at load (the race)');
  const lp = await w.pass();
  assert.equal(lp.ok, true);
  assert.equal(lp.switched, true);
  assert.deepEqual(lp.live, [w.fB.key]);
  assert.deepEqual(lp.cooling, [w.fA.key]);
  assert.equal(w.title(w.fB, 1), 'A1 edit 1', 'the loaded folder is never rewritten');
  assert.ok(lp.rectify.owed.some((o) => o.id === id(1)), 'the newer copy is owed to B');
  assert.equal(w.state().fullPassOwed, true);

  // the conversation is continued from the stale copy
  w.sim.saveFromMemory(id(1), { title: 'continued in B from the stale copy', lastActivityAt: w.sim.memory.get(id(1)).lastActivityAt });
  w.clock.tick(SW);
  const lp2 = await w.pass();
  assert.equal(lp2.ok, true);
  const st = w.state();
  assert.ok(st.conflicts[id(1)], 'the stale continuation is recorded');
  assert.equal(st.conflicts[id(1)].cliChanged, false, 'same transcript: no toast');
  assert.equal(st.conflicts[id(1)].notified, false);
  assert.equal(w.title(w.fA, 1), 'continued in B from the stale copy', 'the newest copy is in the free folder too');
  assert.equal(w.ino(w.fA, 1), w.ino(w.fB, 1));
  const lost = w.backups('split-loser').filter((b) => b.name === recordName(1) && b.folder === w.fA.key);
  assert.equal(lost.length, 1, 'the older copy was backed up before it was replaced');
  const dump = JSON.stringify(readJsonFile(join(w.r.acc, 'state.json')));
  assert.doesNotMatch(dump, /edit 2 \(switch flush\)/, 'state carries ids and inodes, never content');

  // the quit: a full pass finds nothing left
  w.sim.stopApp();
  const fp = await fullPass(w.ctx, {});
  assert.equal(fp.ok, true);
  assert.equal(w.title(w.fA, 1), 'continued in B from the stale copy');
  assert.equal(owedWork(w.ctx, {}).owed, false);
});

test('W3 a conflict whose copies point at different transcripts (/clear) is flagged for a toast; the newest still wins', async () => {
  const w = await world();
  w.sim.start(A, w.fA, w.r.userData);
  await w.pass();
  w.sim.signIn(B, w.fB, { userData: w.r.userData, flush: [{ id: id(1), patch: { title: 'A1 flushed' } }] });
  await w.pass();                                          // the watcher sees the switch at once and notes what B loaded
  w.sim.saveFromMemory(id(1), { title: 'B1 cleared and continued', cliSessionId: uuid('f', 1), lastActivityAt: w.sim.memory.get(id(1)).lastActivityAt });
  w.clock.tick(SW);
  await w.pass();
  const c = w.state().conflicts[id(1)];
  assert.ok(c);
  assert.equal(c.cliChanged, true);
  assert.equal(readRecord(join(w.fA.path, recordName(1))).cliSessionId, uuid('f', 1));
  assert.equal(w.backups('split-loser').filter((b) => b.name === recordName(1)).length, 1);
});

test('W4 B back to A: every folder the app has not loaded is current at every moment, nothing sticks', async () => {
  const w = await world();
  w.sim.start(B, w.fB, w.r.userData);
  w.sim.save(w.fB, id(4), { title: 'B4 edited in B' });
  await w.pass();
  assert.equal(w.title(w.fA, 4), 'B4 edited in B');
  w.sim.signIn(A, w.fA, { userData: w.r.userData });
  assert.equal(w.sim.memory.get(id(4)).title, 'B4 edited in B', 'A shows the edit on its first load');
  const lp = await w.pass();
  assert.equal(lp.switched, true);
  w.sim.saveFromMemory(id(4), { title: 'B4 edited again in A' });
  w.clock.tick(SW);
  await w.pass();
  assert.equal(w.title(w.fB, 4), 'B4 edited again in A');
  // and straight back to B: it loads the current copy, no folder is left behind
  w.sim.signIn(B, w.fB, { userData: w.r.userData });
  assert.equal(w.sim.memory.get(id(4)).title, 'B4 edited again in A');
  const lp2 = await w.pass();
  assert.equal(lp2.ok, true);
  assert.equal(w.state().conflicts[id(4)], undefined);
});

test('W5 sign-out with a running session, then another account signs in a minute later: it shows everything', async () => {
  const w = await world();
  w.sim.start(A, w.fA, w.r.userData);
  w.sim.signOut();
  w.sim.save(w.fA, id(3), { title: 'the session saves while nobody is signed in' });
  putRecord(w.fA.path, 9, { title: 'new in A while signed out' }, w.clock.tick());
  const lp = await w.pass();
  assert.equal(lp.ok, true);
  assert.equal(w.title(w.fB, 9), 'new in A while signed out');
  assert.equal(w.title(w.fB, 3), 'the session saves while nobody is signed in');
  w.clock.tick(60 * 1000);
  w.sim.save(w.fA, id(3), { title: 'still saving a minute later' });
  await w.pass();
  assert.equal(w.title(w.fB, 3), 'still saving a minute later');
  w.sim.signIn(B, w.fB, { userData: w.r.userData });
  assert.equal(w.sim.memory.get(id(3)).title, 'still saving a minute later');
  assert.equal(w.sim.memory.get(id(9)).title, 'new in A while signed out');
  assert.equal(w.files(w.fB).length, 6);
});

/* ---------------------------------------------------------------- the rules of the targeted pass */

test('W2 loaded folder: only names are added; a new record in the free folder reaches the loaded one as a new name', async () => {
  const w = await world();
  w.sim.start(A, w.fA, w.r.userData);
  const before = w.ino(w.fA, 4);
  putRecord(w.fB.path, 6, { title: 'new in B while A is loaded' }, w.clock.tick());
  w.sim.save(w.fB, id(4), { title: 'B4 changed in the folder the app did not load' });
  const lp = await w.pass();
  assert.equal(lp.ok, true);
  assert.equal(w.title(w.fA, 6), 'new in B while A is loaded', 'a new name is added to the loaded folder');
  assert.equal(w.ino(w.fA, 4), before, 'an existing name of the loaded folder is never replaced');
  assert.ok(lp.rectify.owed.some((o) => o.id === id(4)));
  assert.equal(w.state().fullPassOwed, true);
  w.sim.stopApp();
  await fullPass(w.ctx, {});
  assert.equal(w.title(w.fA, 4), 'B4 changed in the folder the app did not load');
});

test('W6 the quit: a full pass finishes what was owed, the watcher has nothing more to do, nothing prompts', async () => {
  const w = await world();
  w.sim.start(A, w.fA, w.r.userData);
  w.sim.save(w.fB, id(4), { title: 'B4 changed behind the loaded folder' });
  await w.pass();
  assert.equal(owedWork(w.ctx, {}).owed, true);
  w.sim.stopApp();
  const fp = await fullPass(w.ctx, {});
  assert.equal(fp.ok, true);
  assert.equal(owedWork(w.ctx, {}).owed, false);
  assert.equal(w.state().fullPassOwed, false);
  assert.equal(w.title(w.fA, 4), 'B4 changed behind the loaded folder');
});

test('W7 a parked session keeps saving to the old account: its copy is held, never re-linked or deleted, and status lists it', async () => {
  const w = await world();
  w.sim.start(A, w.fA, w.r.userData);
  await w.pass();
  w.sim.signIn(B, w.fB, { userData: w.r.userData, multi: true, running: [id(2)] });
  await w.pass();                                         // the switch is seen: A cools
  w.sim.tickParked({ title: 'parked session in the old account' });
  w.clock.tick(SW);
  const lp = await w.pass();                              // A is now free, but the parked session writes it
  assert.equal(lp.ok, true);
  const held = lstatSync(join(w.fA.path, recordName(2)));
  assert.equal(held.nlink, 1, 'the parked copy is not re-linked');
  assert.equal(w.title(w.fA, 2), 'parked session in the old account');
  for (let i = 0; i < 3; i++) { w.sim.tickParked({ title: `parked ${i}` }); w.clock.tick(3000); await w.pass(); }
  assert.equal(w.title(w.fA, 2), 'parked 2');
  assert.equal(existsSync(join(w.fA.path, recordName(2))), true);
  assert.equal(w.title(w.fB, 2), 'A 2', 'B (loaded) keeps what it loaded');
  const status = formatStatus(collectStatus(w.ctx, { probe: false }));
  assert.match(status.join('\n'), /Conversation cccccccc is still running in aaaaaaaa; an idle copy shows in bbbbbbbb/);
});

test('W10 a delete: a free folder follows it (backup, tombstone); a loaded folder keeps its copy until the quit', async () => {
  const w = await world();
  w.sim.start(A, w.fA, w.r.userData);
  w.sim.del(w.fA, id(1));
  const lp = await w.pass();
  assert.equal(lp.ok, true);
  assert.equal(existsSync(join(w.fB.path, recordName(1))), false, 'B (free) follows the delete');
  assert.ok(readdirSync(w.fB.path).some((n) => n.startsWith('deleted_')));
  assert.equal(w.backups('delete').filter((b) => b.name === recordName(1)).length >= 1, true, 'the copy is backed up before it goes');

  // the delete is made in A, and the user is in B before the pass runs: B is loaded, so its copy stays
  w.sim.del(w.fA, id(2));
  w.sim.signIn(B, w.fB, { userData: w.r.userData });
  const lp2 = await w.pass();
  assert.equal(existsSync(join(w.fB.path, recordName(2))), true, 'a loaded folder is not touched');
  assert.ok(lp2.rectify.owed.some((o) => o.id === id(2)));
  w.clock.tick(SW);
  await w.pass();
  assert.equal(existsSync(join(w.fB.path, recordName(2))), true, 'still loaded, still there');
  w.sim.stopApp();
  const fp = await fullPass(w.ctx, {});
  assert.equal(fp.ok, true);
  assert.equal(existsSync(join(w.fB.path, recordName(2))), false, 'the quit pass finishes the delete');
});

test('W11 archive and unarchive are ordinary saves: the free folder follows', async () => {
  const w = await world();
  w.sim.start(A, w.fA, w.r.userData);
  w.sim.save(w.fA, id(1), { isArchived: true });
  await w.pass();
  assert.equal(readRecord(join(w.fB.path, recordName(1))).isArchived, true);
  w.sim.save(w.fA, id(1), { isArchived: false });
  await w.pass();
  assert.equal(readRecord(join(w.fB.path, recordName(1))).isArchived, false);
});

test('W12 the re-stat guard: a record the app writes between the inventory and the re-link is left alone and owed', async () => {
  const w = await world();
  w.sim.start(A, w.fA, w.r.userData);
  w.sim.save(w.fA, id(1), { title: 'A1 newest' });
  let fired = 0;
  const testHook = (when, e) => {
    if (when !== 'before-act' || e.folder !== w.fB.key || e.id !== id(1) || fired) return;
    fired++;
    w.sim.save(w.fB, id(1), { title: 'the app saved it just now' });
  };
  const lp = await w.pass({ testHook });
  assert.equal(fired, 1);
  assert.equal(w.title(w.fB, 1), 'the app saved it just now', 'not overwritten');
  assert.equal(nlinkOf(join(w.fB.path, recordName(1))), 1);
  assert.ok(lp.rectify.owed.some((o) => o.id === id(1)));
  assert.equal(existsSync(join(w.fB.path, `${recordName(1)}.tmp`)), false);
  // a leftover .tmp of the app is a save in flight too
  w.clock.tick(2000);
  w.sim.save(w.fA, id(2), { title: 'A2 newest' });
  writeFileSync(join(w.fB.path, `${recordName(2)}.tmp`), '{');
  const lp2 = await w.pass();
  assert.equal(w.title(w.fB, 2), 'A 2', 'a save in flight is not raced');
  assert.equal(lp2.rectify.counts.saving, 1, "the pass saw the save in flight and skipped that id");
  unlinkSync(join(w.fB.path, `${recordName(2)}.tmp`));
  await w.pass();
  assert.equal(w.title(w.fB, 2), "A2 newest", "the next pass finishes it");
});

test('W14 A to B to A inside the grace window: the folder that is signed in again is loaded, the other cools; nothing is lost', async () => {
  const w = await world();
  w.sim.start(A, w.fA, w.r.userData);
  await w.pass();
  w.sim.signIn(B, w.fB, { userData: w.r.userData });
  const a = await w.pass();
  assert.deepEqual(a.cooling, [w.fA.key]);
  w.clock.tick(3000);
  w.sim.signIn(A, w.fA, { userData: w.r.userData });
  const b = await w.pass();
  assert.deepEqual(b.live, [w.fA.key]);
  assert.deepEqual(b.cooling, [w.fB.key]);
  w.sim.saveFromMemory(id(1), { title: 'continued in A after the bounce' });
  w.clock.tick(SW);
  const c = await w.pass();
  assert.equal(c.ok, true);
  assert.equal(w.title(w.fB, 1), 'continued in A after the bounce');
  assert.equal(w.files(w.fA).length, w.files(w.fB).length);
});

test('W15 every record uploads from exactly one folder, after every switch (the push filter is home-only)', async () => {
  const w = await world();
  const check = async (label) => {
    const st = w.state();
    const f = accountsPushFilter({ ctx: w.ctx, state: st });
    const allIds = new Set([...w.files(w.fA), ...w.files(w.fB)]);
    for (const name of allIds) {
      const homes = [w.fA, w.fB].filter((x) => existsSync(join(x.path, name)) && f(`${x.acct}/${x.org}/${name}`));
      assert.equal(homes.length, 1, `${label}: ${name} uploads from ${homes.length} folders`);
    }
  };
  await check('after the link');
  w.sim.start(A, w.fA, w.r.userData);
  w.sim.save(w.fA, id(1), { title: 'x' });
  putRecord(w.fB.path, 6, { title: 'new in B' }, w.clock.tick());
  await w.pass(); await check('app on A');
  w.sim.signIn(B, w.fB, { userData: w.r.userData });
  await w.pass(); await check('switched to B');
  w.sim.saveFromMemory(id(1), { title: 'y' });
  w.clock.tick(SW); await w.pass(); await check('B continued');
  w.sim.stopApp(); await fullPass(w.ctx, {}); await check('after the quit');
});

test('W16 the signed-in account is unknown (no config key): every folder counts as loaded, nothing is rewritten', async () => {
  const w = await world();
  w.sim.setApp({ running: true, signedIn: null, startedAtMs: w.clock.tick() });
  w.sim.save(w.fA, id(1), { title: 'A1 saved with nobody known' });
  const before = w.ino(w.fB, 1);
  const lp = await w.pass();
  assert.equal(lp.ok, true);
  assert.equal(w.ino(w.fB, 1), before, 'no folder is rewritten while the account is unknown');
  assert.deepEqual([...lp.live].sort(), [w.fA.key, w.fB.key].sort());
});

test('W2b an account that joins the linked group later is held as cooling (names only) until a full pass takes the backup', async () => {
  const w = await world({ extra: true });
  putRecord(w.fC.path, 7, { title: 'C 7' }, w.clock.tick());
  const st = w.state(); answerPairs(st, [pairKey(A, C), pairKey(B, C)], 'yes', 'cli', w.clock.t); saveState(w.ctx, st);
  w.sim.start(A, w.fA, w.r.userData);
  const lp = await w.pass();
  assert.equal(lp.ok, true);
  assert.ok(lp.cooling.includes(w.fC.key), 'C is not freed before the backup');
  assert.equal(w.state().fullPassOwed, true);
  assert.equal(existsSync(join(w.fA.path, recordName(7))), true, 'its conversations still reach the others');
  w.sim.stopApp();
  const fp = await fullPass(w.ctx, {});
  assert.equal(fp.ok, true);
  assert.equal(existsSync(join(w.fC.path, recordName(1))), true);
  assert.equal(owedWork(w.ctx, {}).owed, false);
});

test('W17 invariants after a long run of switches and saves: the newest write of every conversation is what every account holds, one inode per id', async () => {
  const w = await world();
  const last = {};
  w.sim.start(A, w.fA, w.r.userData);
  await w.pass();
  let there = w.fB;
  for (let round = 0; round < 3; round++) {
    for (const n of [1, 2, 3, 4, 5]) { w.sim.saveFromMemory(id(n), { title: `r${round} ${n}` }); last[n] = `r${round} ${n}`; }
    await w.pass();
    const here = w.sim.current;
    w.sim.signIn(there.acct, there, { userData: w.r.userData, flush: [{ id: id(1), patch: { title: `flush ${round}` } }] });
    last[1] = `flush ${round}`;
    await w.pass();
    w.clock.tick(SW); await w.pass();
    there = here;
  }
  w.sim.stopApp();
  const fp = await fullPass(w.ctx, {});
  assert.equal(fp.ok, true);
  assert.deepEqual(w.files(w.fA).sort(), w.files(w.fB).sort());
  for (const n of [1, 2, 3, 4, 5]) {
    assert.equal(w.ino(w.fA, n), w.ino(w.fB, n), `record ${n} is one file`);
    assert.equal(w.title(w.fA, n), last[n], `record ${n} holds its newest write`);
  }
  assert.equal(owedWork(w.ctx, {}).owed, false);
});

/* ---------------------------------------------------------------- the watcher loop (injected watch, clock and sleep) */

/** A runWaiter harness: time moves only in `sleep`, the folder watches are stubs the test fires by hand. */
function loop(w, steps, extra = {}) {
  const listeners = new Map();
  const toasts = []; const logs = [];
  let t = 0; let n = 0;
  const clockFn = () => t;
  const sleep = async (ms) => {
    t += ms; w.clock.t += ms; n++;
    const step = steps[n];
    if (step === 'stop') { try { unlinkSync(join(w.r.acc, 'waiter.claim')); } catch { /* gone */ } return; }
    if (step) await step({ n, t });
  };
  const run = () => runWaiter(w.ctx, {
    reason: 'watch', watch: true, pollMs: 1000, gapMs: 100, probeEveryMs: 1000, debounceMs: 2000, clock: clockFn, sleep,
    watchFn: (path, _o, fn) => { listeners.set(path, fn); return { close() { listeners.delete(path); }, on() {} }; },
    notify: (title, body) => toasts.push({ title, body }), log: (l) => logs.push(l), maxLifetimeMs: 3600 * 1000, ...extra,
  });
  return { run, listeners, toasts, logs, fire: (path, name = 'x.json') => listeners.get(path)?.('rename', name) };
}

test('W1/W13 watcher: a save is current in the other folder about two seconds later by an event, and a dropped event is caught by the poll', async () => {
  const w = await world();
  w.sim.start(A, w.fA, w.r.userData);
  let byEvent = null; let byPoll = null; let early = null;
  const L = loop(w, {
    2: () => { w.sim.save(w.fA, id(1), { title: 'saved, event delivered' }); L.fire(w.fA.path, recordName(1)); },
    3: () => { early = w.title(w.fB, 1); },
    5: () => { byEvent = w.title(w.fB, 1); w.sim.save(w.fA, id(2), { title: 'saved, event dropped' }); },
    9: () => { byPoll = w.title(w.fB, 2); },
    10: 'stop',
  });
  const out = await L.run();
  assert.equal(out.exit, 'lost-claim');
  assert.equal(early, 'A 1', 'inside the debounce nothing has run yet');
  assert.equal(byEvent, 'saved, event delivered');
  assert.equal(byPoll, 'saved, event dropped', 'no event at all: the poll tick did the same pass');
});

test('W13 watcher: a null file name and our own temp names are tolerated; a temp name alone does not start a pass', async () => {
  const w = await world();
  w.sim.start(A, w.fA, w.r.userData);
  const L = loop(w, {
    2: () => { w.sim.save(w.fA, id(1), { title: 'null name event' }); L.fire(w.fA.path, null); },
    6: 'stop',
  });
  await L.run();
  assert.equal(w.title(w.fB, 1), 'null name event');
});

test('W3/W6 watcher: a continued stale copy is toasted once (only when the transcript changed); the quit runs one full pass and the watcher stays', async () => {
  const w = await world();
  w.sim.start(A, w.fA, w.r.userData);
  const L = loop(w, {
    2: () => { w.sim.signIn(B, w.fB, { userData: w.r.userData, flush: [{ id: id(1), patch: { title: 'A1 flushed' } }] }); L.fire(w.r.userData, 'config.json'); },
    4: () => { w.sim.saveFromMemory(id(1), { title: 'B1 cleared and continued', cliSessionId: uuid('f', 1), lastActivityAt: w.sim.memory.get(id(1)).lastActivityAt }); L.fire(w.fB.path, recordName(1)); },
    24: () => { w.sim.stopApp(); },
    40: () => { w.sim.start(A, w.fA, w.r.userData); },
    44: 'stop',
  });
  const out = await L.run();
  assert.equal(out.exit, 'lost-claim', 'the watcher never exited by itself');
  assert.equal(L.toasts.length, 1, 'one toast for the one conflict that changed the transcript');
  assert.match(L.toasts[0].title, /older copy/);
  assert.equal(w.title(w.fA, 1), 'B1 cleared and continued');
  assert.equal(owedWork(w.ctx, {}).owed, false, 'the quit pass ran');
  assert.equal(w.state().conflicts[id(1)].notified, true);
  assert.ok(L.logs.some((l) => /signed-in account changed/.test(l)));
});

test('S7 a second watcher is refused; a watcher whose claim is gone ends', async () => {
  const w = await world();
  w.sim.start(A, w.fA, w.r.userData);
  let second = null;
  const L = loop(w, { 2: async () => { second = await runWaiter(w.ctx, { reason: 'watch', watch: true, watchLockfile: false }); }, 3: 'stop' });
  const out = await L.run();
  assert.equal(second.exit, 'already-running');
  assert.equal(out.exit, 'lost-claim');
});

test('N4 a config.json write that leaves the signed-in account alone is not urgent; a change of account is (real timers, the poll is a minute away)', async () => {
  const w = await world3();
  w.sim.start(A, w.fA, w.r.userData);
  const listeners = new Map();
  const nap = (ms) => new Promise((res) => setTimeout(res, ms));
  const run = runWaiter(w.ctx, {
    reason: 'watch', watch: true, pollMs: 60 * 1000, gapMs: 100, debounceMs: 20, probeEveryMs: 60 * 1000, maxLifetimeMs: 3600 * 1000, notify: () => {},
    watchFn: (path, _o, fn) => { listeners.set(path, fn); return { close() {}, on() {} }; },
  });
  await nap(400);                                          // the first pass (a poll tick) is done; the next poll is a minute away
  w.sim.save(w.fA, id(1), { title: 'saved in A' });
  listeners.get(w.r.userData)('change', 'config.json');    // the app rewrote config.json: same account
  await nap(500);
  assert.equal(w.title(w.fC, 1), 'A 1', 'no pass ran for a config.json write that changed nothing about the account');
  w.sim.signIn(B, w.fB, { userData: w.r.userData });
  listeners.get(w.r.userData)('change', 'config.json');    // the account changed
  await nap(500);
  assert.equal(w.title(w.fC, 1), 'saved in A', 'the account change ran the pass at once');
  try { unlinkSync(join(w.r.acc, 'waiter.claim')); } catch { /* gone */ }
  listeners.get(w.r.userData)('rename', 'lockfile');       // wake the loop so it sees the claim is gone
  assert.equal((await run).exit, 'lost-claim');
});

test('every pass leaves no group conflicts that were not recorded: a quiet run has an empty conflicts table', async () => {
  const w = await world();
  w.sim.start(A, w.fA, w.r.userData);
  w.sim.save(w.fA, id(1), { title: 'plain save' });
  await w.pass();
  w.sim.signIn(B, w.fB, { userData: w.r.userData });
  await w.pass();
  w.clock.tick(SW); await w.pass();
  assert.deepEqual(w.state().conflicts, {});
  assert.deepEqual(readJson(join(w.r.acc, 'state.json')).conflicts, {});
});

test('W8 a never-linked account C signs in (auto): it is outside the group until linked, with its pairs pending', async () => {
  const w = await world({ extra: true });
  putRecord(w.fC.path, 7, { title: 'C 7' }, w.clock.tick());
  const st = w.state(); const folders = listFolders(w.r.store);
  assert.ok(!groupOf(st, folders).map((f) => f.acct).includes(C));
  assert.equal(pendingPairs(st, accountsOf(folders)).length, 2);
  w.sim.start(C, w.fC, w.r.userData);
  const lp = await w.pass();
  assert.equal(lp.ok, true);
  assert.equal(listFolders(w.r.store).filter((f) => f.acct === C).length, 1);
  assert.equal(existsSync(join(w.fA.path, recordName(7))), false, 'C is not linked without an answer');
});

/* ---------------------------------------------------------------- the 0.5.3 review round (B1, S1, S2, S3) */

/** Three linked accounts (A, B, C), records 1-n in A, mirrored by the link. The app is stopped. */
async function world3({ big = 0, n = 3 } = {}) {
  const r = makeRoot('review3');
  const clock = makeClock();
  const sim = createSim({ clock, appFile: join(r.root, 'app.json') });
  const fA = addFolder(r.store, A, OA); const fB = addFolder(r.store, B, OB); const fC = addFolder(r.store, C, OC);
  const pad = big ? 'x'.repeat(big) : '';
  for (let i = 1; i <= n; i++) putRecord(fA.path, i, { title: `A ${i}`, pad }, clock.tick());
  sim.setApp({ running: false });
  const st = emptyState(r.store); answerPairs(st, [pairKey(A, B), pairKey(A, C), pairKey(B, C)], 'yes', 'cli', clock.t); saveState(r.ctx, st);
  r.ctx.now = () => clock.t;
  assert.equal((await fullPass(r.ctx, { reasons: ['link'] })).ok, true);
  const backups = (reason) => {
    const f = join(r.acc, 'rectify-backups', 'index.jsonl');
    const all = existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    return reason ? all.filter((b) => b.reason === reason) : all;
  };
  return {
    r, ctx: r.ctx, clock, sim, fA, fB, fC, backups, pass: (o = {}) => livePass(r.ctx, o), state: () => loadState(r.ctx),
    title: (f, k) => readRecord(join(f.path, recordName(k))).title, ino: (f, k) => inoOf(join(f.path, recordName(k))),
  };
}

test('B1 field drift with no known unload time (an upgrade from 0.5.2, a dead watcher): the newest copy reaches every unloaded folder, and survives a switch, a save and the quit', async () => {
  const w = await world3();
  // the app run began before the drift; the app wrote record 1 in C, then in B, then in A (its newest write is a rename by the user)
  w.sim.start(C, w.fC, w.r.userData);
  w.sim.save(w.fC, id(1), { title: 'C wrote', titleSource: 'auto', remoteControlAutoEligible: false });
  w.sim.signIn(B, w.fB, { userData: w.r.userData });
  w.sim.save(w.fB, id(1), { title: 'B wrote', titleSource: 'auto', remoteControlAutoEligible: true });
  w.sim.signIn(A, w.fA, { userData: w.r.userData });
  w.sim.save(w.fA, id(1), { title: 'A renamed (newest)', titleSource: 'user' });
  // the state a 0.5.2 install leaves: no `signed` (so no unload time), records[].ino = the link-time inode
  const st = w.state(); st.signed = null; st.loadedSnapshot = {}; st.conflicts = {}; saveState(w.ctx, st);
  const lp = await w.pass();
  assert.equal(lp.ok, true);
  assert.deepEqual(lp.rectify.owed.filter((o) => o.id === id(1)), [], 'nothing is held: every write of the run is drift');
  for (const f of [w.fB, w.fC]) assert.equal(w.title(f, 1), 'A renamed (newest)', `the newest copy is in ${f.acct.slice(0, 1)} after one targeted pass`);
  assert.equal(w.ino(w.fA, 1), w.ino(w.fB, 1));
  assert.equal(w.ino(w.fA, 1), w.ino(w.fC, 1));
  assert.deepEqual(w.state().held, {});

  // the user switches to B: it loads the newest copy; a save there must not bring an older write back
  w.sim.signIn(B, w.fB, { userData: w.r.userData });
  assert.equal(w.sim.memory.get(id(1)).title, 'A renamed (newest)');
  await w.pass();
  w.sim.saveFromMemory(id(1), {});
  w.clock.tick(SW); await w.pass();
  w.sim.stopApp();
  assert.equal((await fullPass(w.ctx, {})).ok, true);
  for (const f of [w.fA, w.fB, w.fC]) {
    const rec = readRecord(join(f.path, recordName(1)));
    assert.equal(rec.title, 'A renamed (newest)', `the quit pass kept the newest write in ${f.acct.slice(0, 1)}`);
    assert.equal(rec.titleSource, 'user');
  }
});

test('B1 an unload this watcher saw still holds a parked write; a restart of the app clears the held names', async () => {
  const w = await world3();
  w.sim.start(A, w.fA, w.r.userData);
  await w.pass();
  w.sim.signIn(B, w.fB, { userData: w.r.userData, multi: true, running: [id(2)] });
  await w.pass();
  w.clock.tick(SW);
  w.sim.tickParked({ title: 'parked write' });
  const lp = await w.pass();
  assert.equal(lp.ok, true);
  assert.ok(Object.keys(w.state().held[id(2)] ?? {}).includes(w.fA.key), 'the parked name is recorded as held');
  assert.equal(w.title(w.fA, 2), 'parked write');
  w.sim.stopApp();
  w.clock.tick(5000);
  w.sim.start(B, w.fB, w.r.userData);
  await w.pass();
  assert.deepEqual(w.state().held, {}, 'parked sessions do not survive a restart');
});

test('S1 a busy session saving every turn leaves no backups: the version a pass left behind is an ancestor of the next save', async () => {
  const w = await world3({ big: 50 * 1024, n: 1 });
  w.sim.start(A, w.fA, w.r.userData);
  await w.pass();
  const before = w.backups().length;
  for (let i = 0; i < 12; i++) { w.sim.save(w.fA, id(1), { title: `turn ${i}` }); w.clock.tick(2500); await w.pass(); }
  assert.equal(w.title(w.fB, 1), 'turn 11');
  assert.equal(w.title(w.fC, 1), 'turn 11');
  assert.equal(w.backups().length - before, 0, 'twelve saves, no backup of a superseded version');
});

test('S1 a parked session that saves every turn is bounded the same way', async () => {
  const w = await world3({ big: 50 * 1024, n: 2 });
  w.sim.start(A, w.fA, w.r.userData);
  await w.pass();
  w.sim.signIn(B, w.fB, { userData: w.r.userData, multi: true, running: [id(2)] });
  await w.pass();
  w.clock.tick(SW);
  w.sim.tickParked({ title: 'parked 0' }); await w.pass();
  const before = w.backups('split-loser').length;
  for (let i = 1; i <= 10; i++) { w.sim.tickParked({ title: `parked ${i}` }); w.clock.tick(2500); await w.pass(); }
  assert.equal(w.title(w.fC, 2), 'parked 10');
  assert.equal(w.backups('split-loser').length - before, 0, 'ten parked saves, no backup of a superseded version');
});

test('S1 a version from another history is still backed up when it is replaced (the stale continuation keeps the switch flush)', async () => {
  const w = await world3({ n: 1 });
  w.sim.start(A, w.fA, w.r.userData);
  await w.pass();
  w.sim.signIn(B, w.fB, { userData: w.r.userData, flush: [{ id: id(1), patch: { title: 'A flushed' } }] });
  await w.pass();
  w.sim.saveFromMemory(id(1), { title: 'B continued from the stale copy' });
  w.clock.tick(SW); await w.pass();
  assert.equal(w.backups('split-loser').filter((b) => b.name === recordName(1) && b.folder === w.fA.key).length, 1, 'the flushed copy is in the backups');
});

test('S2 a pass parses only the records that changed: an idle pass reads none', async () => {
  const w = await world3({ n: 6 });
  w.sim.start(A, w.fA, w.r.userData);
  await w.pass();
  const s0 = { ...summaryStats };
  w.clock.tick(30000); await w.pass();
  w.clock.tick(30000); await w.pass();
  assert.equal(summaryStats.parsed - s0.parsed, 0, 'nothing changed on disk: nothing is parsed');
  assert.ok(summaryStats.hits - s0.hits >= 12, 'the summaries came from the cache');
  w.sim.save(w.fA, id(2), { title: 'one save' });
  const s1 = { ...summaryStats };
  w.clock.tick(2500); await w.pass();
  assert.ok(summaryStats.parsed - s1.parsed >= 1 && summaryStats.parsed - s1.parsed <= 2, `only the saved record is parsed (${summaryStats.parsed - s1.parsed})`);
  assert.equal(w.title(w.fB, 2), 'one save');
});

test('S2 a file changed in place with the same size and a new mtime is read again', async () => {
  const w = await world3({ n: 2 });
  w.sim.start(A, w.fA, w.r.userData);
  await w.pass();
  const s0 = summaryStats.parsed;
  const p = join(w.fA.path, recordName(1));
  const text = readFileSync(p, 'utf8');
  writeFileSync(p, text.replace('A 1', 'Z 1'));            // same size, same inode
  const t = w.clock.tick();
  utimesSync(p, t / 1000, t / 1000);
  await w.pass();
  assert.ok(summaryStats.parsed > s0, 'the changed file was parsed');
});

test('S3 a parked name stays held after another folder is linked to it and the loaded folder saves: it is never rewritten', async () => {
  const w = await world3();
  w.sim.start(A, w.fA, w.r.userData);
  await w.pass();
  w.sim.signIn(B, w.fB, { userData: w.r.userData, multi: true, running: [id(2)] });
  await w.pass();
  w.clock.tick(SW);
  w.sim.tickParked({ title: 'parked write in A' });
  const parkedIno = w.ino(w.fA, 2);
  await w.pass();                                             // the parked write wins; C is linked to it, so A's name has two links
  assert.equal(w.ino(w.fC, 2), parkedIno, 'C follows the newest write');
  assert.equal(lstatSync(join(w.fA.path, recordName(2))).nlink, 2);
  w.sim.saveFromMemory(id(2), { title: 'B continued its idle copy' });   // the loaded folder saves
  w.clock.tick(3000);
  const lp2 = await w.pass();
  assert.equal(w.ino(w.fA, 2), parkedIno, 'the parked name is still the parked session\'s file');
  assert.equal(w.title(w.fA, 2), 'parked write in A');
  assert.ok(lp2.rectify.owed.some((o) => o.id === id(2) && o.folder === w.fA.key), 'the newer copy is owed to A, not written there');
  assert.equal(w.title(w.fC, 2), 'B continued its idle copy', 'C is not held (no session writes it): it follows the newest write');
  w.sim.tickParked({ title: 'parked write 2' });
  w.clock.tick(3000); await w.pass();
  assert.equal(w.title(w.fA, 2), 'parked write 2');
  w.sim.stopApp();
  assert.equal((await fullPass(w.ctx, {})).ok, true);
  assert.equal(w.ino(w.fA, 2), w.ino(w.fB, 2), 'the quit pass makes it one inode again');
  assert.deepEqual(w.state().held, {});
});

test('N1 a conflict names every displaced copy, not only the last one met', async () => {
  const w = await world3({ n: 1 });
  w.sim.start(A, w.fA, w.r.userData);
  await w.pass();
  w.sim.signIn(B, w.fB, { userData: w.r.userData, flush: [{ id: id(1), patch: { title: 'A flushed' } }] });
  await w.pass();
  w.sim.saveFromMemory(id(1), { title: 'B continued', cliSessionId: uuid('f', 1), lastActivityAt: w.sim.memory.get(id(1)).lastActivityAt });
  w.clock.tick(SW); await w.pass();
  const c = w.state().conflicts[id(1)];
  assert.ok(c);
  assert.ok(c.losers.includes(w.fA.key), 'A (the flushed copy) is named');
});

/* ---------------------------------------------------------------- 0.5.16: stale copies, own links, retention, dry run */

test('0.5.16 a save the app makes at the switch (inside the cooling window) is drift, not a parked session: nothing is held', async () => {
  const w = await world();
  w.sim.start(A, w.fA, w.r.userData);
  await w.pass();
  w.sim.signIn(B, w.fB, { userData: w.r.userData, flush: [{ id: id(1), patch: { title: 'A flushed at the switch' } }] });
  await w.pass();
  w.clock.tick(SW);
  await w.pass();
  assert.equal(w.state().held[id(1)], undefined, 'the switch-time save is frozen out of the hold');
  const lp = await w.pass();
  assert.equal(lp.rectify.owed.some((o) => o.id === id(1) && /held/.test(o.why)), false);
});

test('0.5.16 own links: the inode each link got is recorded in own-links.json (not state.json) and stays ours after the app saves', async () => {
  const w = await world();
  w.sim.start(A, w.fA, w.r.userData);
  w.sim.save(w.fA, id(1), { title: 'A1 edit 1' });
  await w.pass();
  const ownFile = join(w.r.acc, 'own-links.json');
  const own = readJsonFile(ownFile);
  assert.ok(own.resetAt, 'the one-time reset is recorded');
  assert.equal(own.links[id(1)].filter((x) => x.f === w.fB.key).pop().ino, w.ino(w.fB, 1));
  assert.doesNotMatch(readFileSync(join(w.r.acc, 'state.json'), 'utf8'), /own-links|"links"/, 'state.json keeps its shape');
  w.clock.tick(3000);
  w.sim.save(w.fA, id(1), { title: 'A1 edit 2' });
  await w.pass();
  assert.equal(w.title(w.fB, 1), 'A1 edit 2');
  assert.equal(w.ino(w.fA, 1), w.ino(w.fB, 1));
  assert.equal(readJsonFile(ownFile).links[id(1)].find((x) => x.f === w.fB.key && x.ino === w.ino(w.fB, 1)) !== undefined, true, 'the new inode is recorded too');
  assert.equal(w.backups().length, 0, 'an ancestor of the app\'s save needs no backup');
  // the rule itself: a lone name with an inode that is not state.records[id].ino reads as a parked session unless the link is ours
  const st = w.state();
  st.signed = { unloadedAt: { [B]: 1 } };
  st.records[id(1)].ino = 'x:y';
  const e = { id: id(1), folder: w.fB.key, inoKey: w.ino(w.fB, 1), nlink: 1, mtimeMs: 1e13 };
  assert.equal(nameIsHeld(st, e, 0), true);
  assert.equal(nameIsHeld(st, e, 0, new Set([e.inoKey])), false);
});

test('0.5.16 a stale continuation is logged once per real conflict, not once per save', async () => {
  const w = await world();
  w.sim.start(A, w.fA, w.r.userData);
  await w.pass();
  w.sim.signIn(B, w.fB, { userData: w.r.userData, flush: [{ id: id(1), patch: { title: 'A1 flushed' } }] });
  await w.pass();
  const loaded = w.sim.memory.get(id(1)).lastActivityAt;
  let seen = 0;
  for (let i = 0; i < 3; i++) {
    w.sim.saveFromMemory(id(1), { title: `continued ${i}`, lastActivityAt: loaded });
    const lp = await w.pass();                              // A is still cooling: the newer copy stays displaced for all three passes
    seen += (lp.rectify.conflicts ?? []).length;
  }
  assert.equal(seen, 1);
  assert.equal(w.state().conflicts[id(1)].losers.length, 1);
});

test('0.5.16 a continuation that is not older than the other copy is no conflict', async () => {
  const w = await world();
  w.sim.start(A, w.fA, w.r.userData);
  await w.pass();
  w.sim.signIn(B, w.fB, { userData: w.r.userData, flush: [{ id: id(1), patch: { title: 'A1 flushed' } }] });
  await w.pass();
  w.sim.saveFromMemory(id(1), { title: 'continued, newer record time' });
  w.clock.tick(SW); await w.pass();
  assert.equal(w.state().conflicts?.[id(1)], undefined);
  assert.equal(w.title(w.fA, 1), 'continued, newer record time');
});

test('0.5.16 a backup is written only when a copy that differs is really rewritten', async () => {
  const w = await world();
  const pA = join(w.fA.path, recordName(1)); const pB = join(w.fB.path, recordName(1));
  const bytes = readFileSync(pA);
  unlinkSync(pB); writeFileSync(pB, bytes);                 // same content, another inode
  assert.equal((await fullPass(w.ctx, {})).ok, true);
  assert.equal(w.ino(w.fA, 1), w.ino(w.fB, 1), 'unified');
  assert.equal(w.backups().length, 0, 'identical content: nothing to back up');
  unlinkSync(pB); writeFileSync(pB, JSON.stringify({ ...JSON.parse(bytes), title: 'older and different' }));
  setMtime(pB, lstatSync(pA).mtimeMs - 5000);
  assert.equal((await fullPass(w.ctx, {})).ok, true);
  assert.equal(w.ino(w.fA, 1), w.ino(w.fB, 1));
  assert.equal(w.backups('split-loser').filter((b) => b.name === recordName(1)).length, 1, 'a different copy is backed up once');
});

test('0.5.16 retention: a backup day is deleted only once it ended more than 14 days ago; its index lines go with it', () => {
  const r = makeRoot('retain');
  const now = new Date(2026, 10, 27, 23, 0).getTime();
  r.ctx.now = () => now;
  const root = join(r.acc, 'rectify-backups');
  const days = ['2026-11-12', '2026-11-13', '2026-11-27'];
  for (const d of days) { mkdirSync(join(root, d, 'x', 'y'), { recursive: true }); writeFileSync(join(root, d, 'x', 'y', 'f.json'), '{}'); }
  mkdirSync(join(root, 'keepme'), { recursive: true });
  const at = (y, m, d) => new Date(y, m - 1, d, 12).toISOString();
  writeFileSync(join(root, 'index.jsonl'), [
    { at: at(2026, 11, 12), name: 'old.json', sha256: 'a' }, { at: at(2026, 11, 13), name: 'edge.json', sha256: 'b' }, { at: at(2026, 11, 27), name: 'new.json', sha256: 'c' },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n');
  // 2026-11-13 ended 13 d 23 h ago: kept. 2026-11-12 ended 14 d 23 h ago: deleted.
  const out = pruneBackups(r.ctx, { days: 14 });
  assert.deepEqual(out.pruned, ['2026-11-12']);
  assert.equal(existsSync(join(root, '2026-11-12')), false);
  assert.equal(existsSync(join(root, '2026-11-13', 'x', 'y', 'f.json')), true);
  assert.equal(existsSync(join(root, '2026-11-27')), true);
  assert.equal(existsSync(join(root, 'keepme')), true, 'only YYYY-MM-DD directories are touched');
  const names = readFileSync(join(root, 'index.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).name);
  assert.deepEqual(names, ['edge.json', 'new.json']);
  assert.equal(pruneBackups(r.ctx, { days: 14 }).skipped, true, 'once a day');
});

test('0.5.16 case b: a name the old waiter linked (no inode record) is let go once; the reset does not repeat', async () => {
  const w = await world();
  w.sim.start(A, w.fA, w.r.userData);
  await w.pass();
  w.sim.signIn(B, w.fB, { userData: w.r.userData, multi: true, running: [id(1)] });
  await w.pass();
  w.clock.tick(SW);
  w.sim.tickParked({ title: 'parked write' });
  await w.pass();
  assert.ok(w.state().held[id(1)]?.[w.fA.key], 'held before the reset');
  const ownFile = join(w.r.acc, 'own-links.json');
  rmSync(ownFile);                                          // the state the old waiter left: no inode record, no reset marker
  w.clock.tick(3000);
  const lp = await w.pass();
  assert.ok(lp.rectify.holdsReset >= 1);
  assert.equal(w.state().held[id(1)], undefined, 'no longer held');
  assert.ok(readJsonFile(ownFile).resetAt, 'the reset is recorded');
  w.clock.tick(3000);
  const lp2 = await w.pass();
  assert.equal(lp2.rectify.holdsReset, undefined, 'it ran once');
});

test('0.5.16 dryRun writes nothing and lists what it would change', async () => {
  const w = await world3();
  const pA = join(w.fA.path, recordName(1));
  unlinkSync(pA); putRecord(w.fA.path, 1, { title: 'drifted in A' }, w.clock.tick());
  const st = loadState(w.ctx);
  const group = groupOf(st, listFolders(w.ctx.store));
  const before = treeHashes(w.r.root);
  const inos = [w.fA, w.fB, w.fC].map((f) => w.ino(f, 1));
  const stBefore = JSON.stringify(st);
  const rep = rectify(group, { mode: 'full', ctx: w.ctx, state: st, dryRun: true });
  assert.deepEqual(treeHashes(w.r.root), before, 'no file changed, none was added');
  assert.deepEqual([w.fA, w.fB, w.fC].map((f) => w.ino(f, 1)), inos, 'no link changed');
  assert.equal(JSON.stringify(st), stBefore, 'the state passed in is untouched');
  assert.equal(rep.dry.filter((d) => d.op === 'relink' && d.id === id(1)).length, 2);
  assert.equal(w.backups().length, 0);
});
