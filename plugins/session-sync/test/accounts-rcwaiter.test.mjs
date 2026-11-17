/**
 * Remote Control restore inside the watcher (0.5.4): the step runs after the account pass at a confirmed stop, announces itself through the
 * progress UI, works with a single unlinked account, waits while the app runs, keeps the marker young while Claude stays closed, and reads
 * the app's own launch lines afterwards. In-process, real fs, injected timing and app state (as accounts-waiter.test.mjs).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runWaiter } from '../lib/accounts/waiter.mjs';
import { loadState, saveState, emptyState, readJson, resetMutations } from '../lib/accounts/state.mjs';
import { answerPairs, pairKey } from '../lib/accounts/folders.mjs';
import { RC_START_TEXT, MARKER_REFRESH_MS, lastBridgeEntry } from '../lib/accounts/rcrestore.mjs';
import { makeRoot, makeClock, addFolder, putRecord, uuid, readRecord } from './fixtures/store.mjs';

afterEach(() => { delete process.env.SESSION_SYNC_TEST_APP_STATE; resetMutations(); });

const A = uuid('a', 1); const B = uuid('b', 1);
const OA = uuid('1', 1); const OB = uuid('2', 2);
const iso = (ms) => new Date(ms).toISOString();
const keyOf = (n) => `C:\\synthetic\\project-${n}`.replace(/[^a-zA-Z0-9]/g, '-');

/** Account A signed in; records 1 and 2 were on Remote Control (1 has a stale link); optionally a second account and a link. */
function world({ second = false, answered = false } = {}) {
  const r = makeRoot('rcw');
  const clock = makeClock();
  writeFileSync(join(r.userData, 'config.json'), JSON.stringify({ lastKnownAccountUuid: A }));
  const projects = join(r.root, 'projects');
  const fA = addFolder(r.store, A, OA);
  const files = [];
  for (let i = 1; i <= 2; i++) {
    files.push(putRecord(fA.path, i, { lastActivityAt: iso(r.ctx.now() - i * 3600_000), remoteControlUserEnabled: true, bridgeSessionIds: [`s${i}`], remoteControlAutoEligible: false }, clock.tick()));
    mkdirSync(join(projects, keyOf(i)), { recursive: true });
    const bridge = i === 1 ? JSON.stringify({ type: 'bridge-session', sessionId: uuid('d', i), bridgeSessionId: 'cse_stale', noHistoryBackfill: true, ownerAccountUuid: A, lastSequenceNum: 3 }) + '\n' : '';
    writeFileSync(join(projects, keyOf(i), `${uuid('d', i)}.jsonl`), `{"type":"user","message":"hi"}\n${bridge}{"type":"assistant","message":"yo"}\n`);
  }
  if (second) { const fB = addFolder(r.store, B, OB); putRecord(fB.path, 3, {}, clock.tick()); }
  const appFile = join(r.root, 'app.json');
  const setApp = (running) => writeFileSync(appFile, JSON.stringify(running ? { running: true, signedIn: A, startedAtMs: 1 } : { running: false }));
  process.env.SESSION_SYNC_TEST_APP_STATE = appFile;
  setApp(false);
  const state = emptyState(r.store);
  if (answered) answerPairs(state, [pairKey(A, B)], 'yes', 'cli', clock.t);
  saveState(r.ctx, state);
  return { r, ctx: r.ctx, acc: r.acc, files, projects, setApp, transcript: (i) => join(projects, keyOf(i), `${uuid('d', i)}.jsonl`) };
}

function stepper(onSleep = () => {}) {
  let t = 0; let sleeps = 0;
  return { clock: () => (t += 100), sleep: async () => { sleeps++; await onSleep(sleeps); }, get sleeps() { return sleeps; } };
}
const stopAt = (w, n, onSleep = () => {}) => stepper((i) => { onSleep(i); if (i >= n) { try { unlinkSync(join(w.acc, 'waiter.claim')); } catch { /* gone */ } } });
const recUi = () => {
  const calls = [];
  return { calls, start(info) { calls.push({ what: 'start', text: info.startText }); }, end(res) { calls.push({ what: 'end', status: res.status, headline: res.headline, quiet: !!res.quiet }); } };
};
const common = { watchLockfile: false, gapMs: 150, pollMs: 1, probeEveryMs: 1, watch: true, reason: 'watch', notify: () => {} };
const on = { enabled: true, days: 3 };

test('W1 a single account that was never linked: the watcher still prepares Remote Control at the stop, and says so', async () => {
  const w = world();
  const ui = recUi(); const logs = [];
  const s = stopAt(w, 14);
  const out = await runWaiter(w.ctx, { ...common, clock: s.clock, sleep: s.sleep, ui, rcRestore: on, rcOpts: { projects: w.projects }, log: (l) => logs.push(l) });
  assert.equal(out.exit, 'lost-claim', 'it goes on watching, it does not give up for lack of a link');
  assert.equal(loadState(w.ctx).linked, false);
  assert.deepEqual(ui.calls.map((c) => [c.what, c.status ?? c.text]), [['start', RC_START_TEXT], ['end', 'ok']]);
  assert.match(ui.calls[1].headline, /1 stale link reset, 2 sessions will reconnect/);
  assert.deepEqual(readRecord(w.files[0]).remoteControlLiveAtUpdateQuit.accountId, A);
  assert.equal(readRecord(w.files[1]).remoteControlAutoEligible, true);
  assert.equal(lastBridgeEntry(w.transcript(1)).bridgeSessionId, '');
  assert.ok(logs.some((l) => /remote control restore: 1 relinked, 2 marked/.test(l)));
});

test('W2 rcRestore off (or not given): nothing is written, and an unlinked watcher behaves as it did in 0.5.3 (it tries the link and gives up)', async () => {
  const w = world();
  const s = stepper();
  const out = await runWaiter(w.ctx, { ...common, clock: s.clock, sleep: s.sleep, rcRestore: { enabled: false, days: 3 }, rcOpts: { projects: w.projects } });
  assert.equal(out.exit, 'gave-up');
  assert.equal(readRecord(w.files[0]).remoteControlLiveAtUpdateQuit, undefined);
  assert.equal(lastBridgeEntry(w.transcript(1)).bridgeSessionId, 'cse_stale');
  const s2 = stepper();
  const out2 = await runWaiter(w.ctx, { ...common, clock: s2.clock, sleep: s2.sleep, rcOpts: { projects: w.projects } });
  assert.equal(out2.exit, 'gave-up');
  assert.equal(readRecord(w.files[0]).remoteControlLiveAtUpdateQuit, undefined);
});

test('W3 the setting is read afresh: turned off while the watcher runs, the step does not run', async () => {
  const w = world({ second: true, answered: true });
  const first = await runWaiter(w.ctx, { ...common, watch: false, reason: 'link', clock: stepper().clock, sleep: stepper().sleep });
  assert.equal(first.exit, 'done');
  let enabled = true;
  const s = stopAt(w, 14, (i) => { if (i === 1) enabled = false; });
  const out = await runWaiter(w.ctx, { ...common, clock: s.clock, sleep: s.sleep, rcRestore: () => ({ enabled, days: 3 }), rcOpts: { projects: w.projects } });
  assert.equal(out.exit, 'lost-claim');
  assert.equal(readRecord(w.files[0]).remoteControlLiveAtUpdateQuit, undefined);
});

test('W4 while the app runs nothing is written; at the stop the step runs once', async () => {
  const w = world();
  w.setApp(true);
  let markedWhileRunning = null;
  const s = stopAt(w, 22, (i) => {
    if (i === 8) markedWhileRunning = readRecord(w.files[0]).remoteControlLiveAtUpdateQuit;
    if (i === 9) w.setApp(false);
  });
  const ui = recUi();
  const out = await runWaiter(w.ctx, { ...common, clock: s.clock, sleep: s.sleep, ui, rcRestore: on, rcOpts: { projects: w.projects } });
  assert.equal(out.exit, 'lost-claim');
  assert.equal(markedWhileRunning, undefined);
  assert.ok(readRecord(w.files[0]).remoteControlLiveAtUpdateQuit);
  assert.equal(ui.calls.filter((c) => c.what === 'start').length, 1, 'announced once');
});

test('W5 a refusal (the app started under the step) writes nothing, tries a few times only, and stays quiet', async () => {
  const w = world();
  let asked = 0;
  const ui = recUi();
  const s = stopAt(w, 40);
  const out = await runWaiter(w.ctx, { ...common, clock: s.clock, sleep: s.sleep, ui, rcRestore: on, rcOpts: { projects: w.projects, stopped: () => { asked++; return false; } } });
  assert.equal(out.exit, 'lost-claim');
  assert.equal(readRecord(w.files[0]).remoteControlLiveAtUpdateQuit, undefined);
  assert.equal(lastBridgeEntry(w.transcript(1)).bridgeSessionId, 'cse_stale');
  assert.ok(asked >= 1 && asked <= 3, `tried ${asked} times`);
  assert.deepEqual(ui.calls, [], 'nothing was shown for a step that never began');
});

test('W6 while Claude stays closed the marker is kept young, with no new notice', async () => {
  const w = world();
  const base = w.ctx.now();
  const ui = recUi();
  const s = stopAt(w, 50, (i) => { if (i >= 20) w.ctx.setNow(base + (i - 19) * (MARKER_REFRESH_MS + 1000)); });
  const out = await runWaiter(w.ctx, { ...common, clock: s.clock, sleep: s.sleep, ui, rcRestore: on, rcOpts: { projects: w.projects }, rcRefreshMs: 1000 });
  assert.equal(out.exit, 'lost-claim');
  const at = readRecord(w.files[0]).remoteControlLiveAtUpdateQuit.at;
  assert.ok(at > base, 'refreshed after the first write');
  assert.equal(ui.calls.filter((c) => c.what === 'start').length, 1, 'a refresh is not announced');
});

test('W7 after the app starts again, the watcher logs what the app did at launch (its outcome), once', async () => {
  const w = world();
  const appLog = join(w.r.root, 'main.log');
  writeFileSync(appLog, '');
  const logs = [];
  const s = stopAt(w, 40, (i) => {
    if (i === 20) {
      writeFileSync(appLog, '2099-01-01 00:00:03 [info] [CCD] Remote Control restore after update: {"restored":2,"outcome":"ran"}\n');
      w.setApp(true);
    }
  });
  const out = await runWaiter(w.ctx, { ...common, clock: s.clock, sleep: s.sleep, rcRestore: on, rcOpts: { projects: w.projects, appLog }, log: (l) => logs.push(l) });
  assert.equal(out.exit, 'lost-claim');
  assert.equal(logs.filter((l) => /the app's launch restore: outcome ran/.test(l)).length, 1);
});

test('W8 with linked accounts the account pass comes first, then Remote Control, each announced', async () => {
  const w = world({ second: true, answered: true });
  const first = await runWaiter(w.ctx, { ...common, watch: false, reason: 'link', clock: stepper().clock, sleep: stepper().sleep });
  assert.equal(first.exit, 'done');
  assert.equal(loadState(w.ctx).linked, true);
  const st = loadState(w.ctx); st.fullPassOwed = true; saveState(w.ctx, st);
  const ui = recUi();
  const s = stopAt(w, 30);
  const out = await runWaiter(w.ctx, { ...common, gapMs: 50, reason: 'owed', clock: s.clock, sleep: s.sleep, ui, rcRestore: on, rcOpts: { projects: w.projects } });
  assert.equal(out.exit, 'lost-claim');
  assert.deepEqual(ui.calls.map((c) => c.what), ['start', 'end', 'start', 'end']);
  assert.match(ui.calls[0].text, /while Claude is closed/);
  assert.equal(ui.calls[2].text, RC_START_TEXT);
  assert.ok(readRecord(w.files[1]).remoteControlLiveAtUpdateQuit, 'the marker is on the record the link made one inode');
});

test('W9 a one-shot waiter (no watch) never does the Remote Control step', async () => {
  const w = world({ second: true, answered: true });
  const out = await runWaiter(w.ctx, { ...common, watch: false, reason: 'link', clock: stepper().clock, sleep: stepper().sleep, rcRestore: on, rcOpts: { projects: w.projects } });
  assert.equal(out.exit, 'done');
  assert.equal(readRecord(w.files[0]).remoteControlLiveAtUpdateQuit, undefined);
  assert.equal(JSON.parse(readFileSync(join(w.acc, 'last-pass.json'), 'utf8')).op, 'link');
  assert.equal(readJson(join(w.acc, 'rc-restore.json'), null), null);
});
