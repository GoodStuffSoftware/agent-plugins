/**
 * 0.5.14: the connector check after an account switch (lib/accounts/connectors.mjs). Synthetic stores, run records, transcripts and task
 * files in temp folders only; the live store and the live transcripts are never read. The toast is injected, so nothing is shown.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeRoot, addFolder, putRecord, putTasks, makeTask, uuid, setMtime } from './fixtures/store.mjs';
import {
  connectorCheck, connectorHookStep, backgroundConnectorCheck, takeConnectorReport, writeConnectorMarker, readConnectorMarker, compareTask, markerFile, flagsFile, noticeFile, EXPIRE_MS, CLAIM_STALE_MS,
} from '../lib/accounts/connectors.mjs';

const ME = uuid('a', 1);
const ORG = uuid('f', 1);
const OTHER = uuid('b', 2);
const GMAIL = '97d72450-0000-4000-8000-000000000001';
const GMAIL2 = '11112222-0000-4000-8000-000000000002';
const GROCERY = '5a5a5a5a-0000-4000-8000-000000000003';
const SWITCH = Date.parse('2026-11-25T04:42:00Z');
const HOUR = 3600_000;
const iso = (ms) => new Date(ms).toISOString();
const keyOf = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

function world() {
  const r = makeRoot('conn');
  const projects = join(r.root, 'projects');
  mkdirSync(projects, { recursive: true });
  const folder = addFolder(r.store, ME, ORG);
  r.ctx.setNow(SWITCH + HOUR);
  return { ...r, projects, folder, n: 0, tasks: [] };
}

/** An enabled task, with a prompt file in the temp dir that holds `prompt`. */
function task(w, id, prompt = 'do the thing') {
  const filePath = join(w.root, `${id}.md`);
  writeFileSync(filePath, prompt);
  w.tasks.push(makeTask(id, { filePath }));
  putTasks(w.folder.path, w.tasks);
}

/** One run of a task: a record in the folder and a transcript with the tool list and the tool_use lines. */
function run(w, taskId, { at, avail = [], called = [] }) {
  w.n += 1;
  const cwd = `C:\\synthetic\\run-${w.n}`;
  const cliSessionId = uuid('d', w.n);
  const p = putRecord(w.folder.path, w.n, { scheduledTaskId: taskId, cwd, cliSessionId, createdAt: at, lastActivityAt: at });
  setMtime(p, at);
  const dir = join(w.projects, keyOf(cwd));
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'user', message: 'hello' }),
    JSON.stringify({ type: 'attachment', attachment: { type: 'deferred_tools_delta', addedNames: avail } }),
    ...called.map((name) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input: {} }] } })),
  ];
  writeFileSync(join(dir, `${cliSessionId}.jsonl`), lines.join('\n') + '\n');
}

/** A run record whose transcript has no tool list yet (the run just started). */
function runNoList(w, taskId, at) {
  w.n += 1;
  const cwd = `C:\\synthetic\\run-${w.n}`;
  const cliSessionId = uuid('d', w.n);
  setMtime(putRecord(w.folder.path, w.n, { scheduledTaskId: taskId, cwd, cliSessionId, createdAt: at }), at);
  mkdirSync(join(w.projects, keyOf(cwd)), { recursive: true });
  writeFileSync(join(w.projects, keyOf(cwd), `${cliSessionId}.jsonl`), JSON.stringify({ type: 'user', message: 'hi' }) + '\n');
}

const tool = (u, t) => `mcp__${u}__${t}`;
const GM = ['search_threads', 'get_thread', 'create_draft'].map((t) => tool(GMAIL, t));
const GR = ['grocery_search', 'grocery_price_check'].map((t) => tool(GROCERY, t));
const BASE = ['Bash', 'Read'];
const check = (w, o = {}) => connectorCheck(w.ctx, { projects: w.projects, ...o });
const snapshot = (w) => JSON.stringify([readdirSync(w.acc).sort(), existsSync(noticeFile(w.ctx))]);

test('C1 a connector the pre-switch run called and the post-switch run lacks is flagged as missing', () => {
  const w = world();
  task(w, 'grocery-run-daily-check');
  run(w, 'grocery-run-daily-check', { at: SWITCH - 5 * HOUR, avail: [...BASE, ...GR], called: [GR[1]] });
  run(w, 'grocery-run-daily-check', { at: SWITCH + 10 * 60_000, avail: BASE });
  const r = check(w, { since: iso(SWITCH), dryRun: true });
  assert.equal(r.ran, true);
  assert.deepEqual(r.flagged, ['grocery-run-daily-check']);
  const f = r.tasks[0].findings[0];
  assert.equal(f.kind, 'missing');
  assert.equal(f.uuid, GROCERY);
  assert.equal(f.name, 'Grocery Run');
});

test('C2 a connector still available after the switch is not flagged', () => {
  const w = world();
  task(w, 'claude-update-watch');
  run(w, 'claude-update-watch', { at: SWITCH - 5 * HOUR, avail: [...BASE, ...GM], called: [GM[0]] });
  run(w, 'claude-update-watch', { at: SWITCH + HOUR / 2, avail: [...BASE, ...GM] });
  const r = check(w, { since: iso(SWITCH), dryRun: true });
  assert.equal(r.tasks[0].status, 'ok');
  assert.deepEqual(r.flagged, []);
});

test('C3 the same tool names under another uuid: "different-id" when the prompt hardcodes the old uuid, "moved" (no alert) when it does not', () => {
  const w = world();
  const moved = GM.map((n) => n.replace(GMAIL, GMAIL2));
  task(w, 'bsk-app-review-watch', `Use ${GMAIL} for mail.`);
  task(w, 'plain-mail-task', 'Read my mail.');
  for (const id of ['bsk-app-review-watch', 'plain-mail-task']) {
    run(w, id, { at: SWITCH - 5 * HOUR, avail: [...BASE, ...GM], called: GM });
    run(w, id, { at: SWITCH + HOUR / 2, avail: [...BASE, ...moved] });
  }
  const r = check(w, { since: iso(SWITCH), dryRun: true });
  const byId = Object.fromEntries(r.tasks.map((t) => [t.taskId, t]));
  assert.equal(byId['bsk-app-review-watch'].status, 'flagged');
  assert.equal(byId['bsk-app-review-watch'].findings[0].kind, 'different-id');
  assert.equal(byId['bsk-app-review-watch'].findings[0].alt, GMAIL2);
  assert.equal(byId['bsk-app-review-watch'].findings[0].hardcoded, true);
  assert.equal(byId['plain-mail-task'].status, 'ok');
  assert.equal(byId['plain-mail-task'].findings[0].kind, 'moved');
  assert.deepEqual(r.flagged, ['bsk-app-review-watch']);
});

test('C4 a connector uuid written in the prompt counts even when the pre run never called it', () => {
  const f = compareTask({ called: [], preAvail: BASE, postAvail: BASE, prompt: `call ${tool(GMAIL, 'search_threads')} first` });
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, 'missing');
  assert.equal(f[0].uuid, GMAIL);
});

test('C4b an id that was already available before the switch is not an "other id" for the missing connector; an empty task list never retires the marker', () => {
  const dup = GM.map((n) => n.replace(GMAIL, GMAIL2));
  const f = compareTask({ called: GM, preAvail: [...GM, ...dup], postAvail: dup, prompt: '' });
  assert.equal(f[0].kind, 'missing');
  const w = world();
  writeConnectorMarker(w.ctx, { at: SWITCH, from: OTHER, to: ME });
  assert.equal(check(w).retired, null);
  assert.equal(existsSync(markerFile(w.ctx)), true);
});

test('C5 a task with no run since the switch stays pending, and so does a run whose tool list is not written yet', () => {
  const w = world();
  task(w, 'no-run-yet');
  task(w, 'just-started');
  run(w, 'no-run-yet', { at: SWITCH - 5 * HOUR, avail: [...BASE, ...GR], called: [GR[0]] });
  run(w, 'just-started', { at: SWITCH - 5 * HOUR, avail: [...BASE, ...GR], called: [GR[0]] });
  runNoList(w, 'just-started', SWITCH + 60_000);
  const r = check(w, { since: iso(SWITCH), dryRun: true });
  assert.deepEqual(r.pending.sort(), ['just-started', 'no-run-yet']);
  assert.deepEqual(r.flagged, []);
});

test('C6 marker lifecycle: written on a switch, partly checked (pending task stays), retired when every enabled task is checked', () => {
  const w = world();
  assert.equal(writeConnectorMarker(w.ctx, { at: SWITCH, from: OTHER, to: ME }), true);
  const m = readConnectorMarker(w.ctx);
  assert.equal(m.switchAt, iso(SWITCH));
  assert.equal(m.from, OTHER);
  assert.equal(m.to, ME);
  assert.deepEqual(m.checked, {});
  task(w, 'a-task');
  task(w, 'b-task');
  run(w, 'a-task', { at: SWITCH - 3 * HOUR, avail: [...BASE, ...GR], called: [GR[0]] });
  run(w, 'a-task', { at: SWITCH + 60_000, avail: BASE });
  run(w, 'b-task', { at: SWITCH - 3 * HOUR, avail: BASE });
  const r1 = check(w);
  assert.equal(r1.retired, null);
  assert.deepEqual(r1.pending, ['b-task']);
  assert.equal(existsSync(markerFile(w.ctx)), true);
  assert.deepEqual(Object.keys(readConnectorMarker(w.ctx).checked), ['a-task']);
  run(w, 'b-task', { at: SWITCH + 2 * HOUR, avail: BASE });
  w.ctx.setNow(SWITCH + 3 * HOUR);
  const r2 = check(w);
  assert.equal(r2.retired, 'complete');
  assert.equal(existsSync(markerFile(w.ctx)), false);
  assert.equal(existsSync(flagsFile(w.ctx)), true, 'the flags outlive the marker');
  assert.equal(connectorHookStep(w.ctx, { spawnFn: fakeSpawn() }).started, false, 'no marker: the hook step starts nothing');
});

test('C7 an unfinished marker expires after 8 days', () => {
  const w = world();
  writeConnectorMarker(w.ctx, { at: SWITCH, from: OTHER, to: ME });
  task(w, 'never-runs');
  w.ctx.setNow(SWITCH + HOUR + EXPIRE_MS - 1000);
  assert.equal(check(w).retired, null);
  assert.equal(existsSync(markerFile(w.ctx)), true);
  w.ctx.setNow(SWITCH + HOUR + EXPIRE_MS + 1000);
  assert.equal(check(w).retired, 'expired');
  assert.equal(existsSync(markerFile(w.ctx)), false);
});

test('C8 alerts are written once per switch and task: toast, notice file, and the SessionStart context line', () => {
  const w = world();
  writeConnectorMarker(w.ctx, { at: SWITCH, from: OTHER, to: ME });
  task(w, 'grocery-run-price-check');
  task(w, 'second-task');
  run(w, 'grocery-run-price-check', { at: SWITCH - 3 * HOUR, avail: [...BASE, ...GR], called: [GR[1]] });
  run(w, 'grocery-run-price-check', { at: SWITCH + 60_000, avail: BASE });
  run(w, 'second-task', { at: SWITCH - 3 * HOUR, avail: BASE });   // keeps the marker pending, so a second check runs
  const toasts = [];
  const toast = (title, body) => toasts.push({ title, body });
  const r1 = check(w, { toast });
  assert.deepEqual(r1.flagged, ['grocery-run-price-check']);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].body, /grocery-run-price-check/);
  const notice = readFileSync(noticeFile(w.ctx), 'utf8');
  assert.match(notice, /grocery-run-price-check/);
  assert.match(notice, /connect Grocery Run on account/);
  assert.match(notice, /or switch back/);
  assert.equal(/\u2014/.test(notice), false);
  // the next hook run finds the same task flagged again: no second toast
  check(w, { toast });
  assert.equal(toasts.length, 1);
  const line = takeConnectorReport(w.ctx);
  assert.match(line, /grocery-run-price-check/);
  assert.match(line, /Grocery Run/);
  assert.equal(takeConnectorReport(w.ctx), null, 'the context line is claimed once');
  // a new switch lets the same task be told again
  const SWITCH2 = SWITCH + 24 * HOUR;
  writeConnectorMarker(w.ctx, { at: SWITCH2, from: ME, to: OTHER });
  run(w, 'grocery-run-price-check', { at: SWITCH2 - HOUR, avail: [...BASE, ...GR], called: [GR[1]] });
  run(w, 'grocery-run-price-check', { at: SWITCH2 + 60_000, avail: BASE });
  w.ctx.setNow(SWITCH2 + HOUR);
  check(w, { toast });
  assert.equal(toasts.length, 2);
  assert.match(takeConnectorReport(w.ctx), /grocery-run-price-check/);
});

test('C9 --dry-run writes nothing and sends no notification, with or without a marker', () => {
  const w = world();
  task(w, 'grocery-run-daily-check');
  run(w, 'grocery-run-daily-check', { at: SWITCH - 3 * HOUR, avail: [...BASE, ...GR], called: [GR[0]] });
  run(w, 'grocery-run-daily-check', { at: SWITCH + 60_000, avail: BASE });
  const toasts = [];
  const toast = (t, b) => toasts.push([t, b]);
  const before = snapshot(w);
  const r = check(w, { since: iso(SWITCH), dryRun: true, toast });
  assert.deepEqual(r.flagged, ['grocery-run-daily-check']);
  assert.equal(snapshot(w), before);
  assert.equal(toasts.length, 0);
  assert.equal(existsSync(markerFile(w.ctx)), false);
  writeConnectorMarker(w.ctx, { at: SWITCH, from: OTHER, to: ME });
  const markerBefore = readFileSync(markerFile(w.ctx), 'utf8');
  const filesBefore = snapshot(w);
  const r2 = check(w, { dryRun: true, toast });
  assert.deepEqual(r2.flagged, ['grocery-run-daily-check']);
  assert.equal(readFileSync(markerFile(w.ctx), 'utf8'), markerBefore);
  assert.equal(snapshot(w), filesBefore);
  assert.equal(toasts.length, 0);
});

test('C10 without a marker the check does not run; a disabled task is ignored', () => {
  const w = world();
  assert.deepEqual(check(w), { ran: false, reason: 'no-marker' });
  w.tasks.push(makeTask('off-task', { enabled: false }));
  putTasks(w.folder.path, w.tasks);
  const r = check(w, { since: iso(SWITCH), dryRun: true });
  assert.deepEqual(r.tasks, []);
});

/** A spawn that records its calls and starts nothing: a test never starts a real process. */
function fakeSpawn(pid = 4242) {
  const calls = [];
  const fn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { pid, on() {}, unref() {} }; };
  fn.calls = calls;
  return fn;
}
const THROTTLE = 15 * 60_000;
const hookOf = (w, spawnFn) => connectorHookStep(w.ctx, { throttleMs: THROTTLE, spawnFn, execPath: 'node-x', cli: 'cli-x.mjs' });

test('C11 the hook step spawns the background check when due, and never when throttled, claimed or without a marker', () => {
  const w = world();
  const spawnFn = fakeSpawn();
  assert.deepEqual(hookOf(w, spawnFn), { started: false, reason: 'no-marker' });
  writeConnectorMarker(w.ctx, { at: SWITCH, from: OTHER, to: ME });
  // due: a fresh marker has no lastCheckAt. It starts one hidden, detached node with the background flag and returns at once
  const r1 = hookOf(w, spawnFn);
  assert.deepEqual(r1, { started: true, reason: 'started', pid: 4242 });
  assert.equal(spawnFn.calls.length, 1);
  assert.deepEqual(spawnFn.calls[0].args, ['cli-x.mjs', 'accounts', 'connector-check', '--background']);
  assert.equal(spawnFn.calls[0].cmd, 'node-x');
  assert.equal(spawnFn.calls[0].opts.detached, true);
  assert.equal(spawnFn.calls[0].opts.windowsHide, true);
  assert.equal(spawnFn.calls[0].opts.stdio, 'ignore');
  assert.equal(existsSync(noticeFile(w.ctx)), false, 'the hook itself scans and writes nothing');
  // throttled: the last check of this switch is inside the window
  const m = readConnectorMarker(w.ctx);
  m.lastCheckAt = iso(w.ctx.now() - 10 * 60_000);
  writeFileSync(markerFile(w.ctx), JSON.stringify(m));
  assert.deepEqual(hookOf(w, spawnFn), { started: false, reason: 'throttled' });
  // due again after the window
  w.ctx.setNow(w.ctx.now() + 6 * 60_000);
  assert.equal(hookOf(w, spawnFn).started, true);
  assert.equal(spawnFn.calls.length, 2);
  // a lastCheckAt in the future (clock set back) is due, not throttled forever
  m.lastCheckAt = iso(w.ctx.now() + 5 * HOUR);
  writeFileSync(markerFile(w.ctx), JSON.stringify(m));
  assert.equal(hookOf(w, spawnFn).started, true);
  assert.equal(spawnFn.calls.length, 3);
  // a lastCheckAt from before this switch does not throttle it
  m.lastCheckAt = iso(SWITCH - 60_000);
  writeFileSync(markerFile(w.ctx), JSON.stringify(m));
  assert.equal(hookOf(w, spawnFn).started, true);
  assert.equal(spawnFn.calls.length, 4);
  // a spawn without a pid is reported, not counted as started
  assert.deepEqual(hookOf(w, () => ({ on() {}, unref() {} })), { started: false, reason: 'spawn-failed', pid: null });
  assert.equal(hookOf(w, () => { throw new Error('boom'); }).started, false);
});

test('C11b a held claim stops the hook from spawning; a stale claim does not; one background check runs at a time', () => {
  const w = world();
  writeConnectorMarker(w.ctx, { at: SWITCH, from: OTHER, to: ME });
  task(w, 'a-task');
  run(w, 'a-task', { at: SWITCH - 3 * HOUR, avail: BASE });
  run(w, 'a-task', { at: SWITCH + 60_000, avail: BASE });
  const spawnFn = fakeSpawn();
  const claimFile = join(w.acc, 'connector-check.claim');
  writeFileSync(claimFile, JSON.stringify({ pid: process.pid, at: w.ctx.now() - 60_000 }));
  assert.deepEqual(hookOf(w, spawnFn), { started: false, reason: 'claimed' });
  assert.equal(spawnFn.calls.length, 0);
  // the background entry does not run while another holds the claim
  assert.deepEqual(backgroundConnectorCheck(w.ctx, { projects: w.projects }), { ran: false, reason: 'claimed' });
  assert.deepEqual(readConnectorMarker(w.ctx).checked, {});
  // a claim older than the stale timeout is a dead run's: the hook spawns, the background run takes it over and releases it
  writeFileSync(claimFile, JSON.stringify({ pid: process.pid, at: w.ctx.now() - CLAIM_STALE_MS - 1000 }));
  assert.equal(hookOf(w, spawnFn).started, true);
  const r = backgroundConnectorCheck(w.ctx, { projects: w.projects });
  assert.equal(r.ran, true);
  assert.equal(existsSync(claimFile), false, 'the claim is released when the run ends');
  writeConnectorMarker(w.ctx, { at: SWITCH, from: OTHER, to: ME });
  // a claim with no content yet (just created) holds by its file time; one whose run is gone does not
  writeFileSync(claimFile, ''); setMtime(claimFile, w.ctx.now() - 1000);
  assert.deepEqual(hookOf(w, spawnFn), { started: false, reason: 'claimed' });
  assert.deepEqual(backgroundConnectorCheck(w.ctx, { projects: w.projects }), { ran: false, reason: 'claimed' });
  writeFileSync(claimFile, JSON.stringify({ pid: 2147483000, at: w.ctx.now() - 60_000 }));
  assert.equal(hookOf(w, spawnFn).started, true, 'a dead holder does not block');
  rmSync(claimFile);
});

test('C11c the background run records lastCheckAt, so the hook then throttles it', () => {
  const w = world();
  writeConnectorMarker(w.ctx, { at: SWITCH, from: OTHER, to: ME });
  task(w, 'a-task');
  task(w, 'b-task');   // no run yet: stays pending, so the marker survives
  run(w, 'a-task', { at: SWITCH - 3 * HOUR, avail: BASE });
  run(w, 'a-task', { at: SWITCH + 60_000, avail: BASE });
  const r = backgroundConnectorCheck(w.ctx, { projects: w.projects });
  assert.deepEqual(r.pending, ['b-task']);
  const m = readConnectorMarker(w.ctx);
  assert.equal(m.lastCheckAt, iso(w.ctx.now()));
  assert.deepEqual(Object.keys(m.checked), ['a-task'], 'a task with no run since the switch stays pending, not checked');
  assert.deepEqual(hookOf(w, fakeSpawn()), { started: false, reason: 'throttled' });
  // a background run that boots inside the window (two hooks raced) does not scan again
  assert.deepEqual(backgroundConnectorCheck(w.ctx, { projects: w.projects, throttleMs: THROTTLE }), { ran: false, reason: 'throttled' });
});

test('C15 tasks without a run first in line do not hold back the checkable ones: one unbudgeted run decides them all', () => {
  const w = world();
  writeConnectorMarker(w.ctx, { at: SWITCH, from: OTHER, to: ME });
  for (const id of ['n1', 'n2', 'n3', 'c1', 'c2']) task(w, id);
  for (const id of ['c1', 'c2']) {
    run(w, id, { at: SWITCH - 3 * HOUR, avail: [...BASE, ...GR], called: [GR[0]] });
    run(w, id, { at: SWITCH + 60_000, avail: BASE });
  }
  const r = backgroundConnectorCheck(w.ctx, { projects: w.projects });
  assert.deepEqual(r.pending.sort(), ['n1', 'n2', 'n3']);
  assert.deepEqual(Object.keys(readConnectorMarker(w.ctx).checked).sort(), ['c1', 'c2']);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(flagsFile(w.ctx), 'utf8')).tasks).sort(), ['c1', 'c2']);
});

test('C14 a newer switch recorded while the check runs: no flags, notice, toast or marker change for the old one', () => {
  const w = world();
  writeConnectorMarker(w.ctx, { at: SWITCH, from: OTHER, to: ME });
  task(w, 'grocery-run-price-check');
  task(w, 'second-task');
  run(w, 'grocery-run-price-check', { at: SWITCH - 3 * HOUR, avail: [...BASE, ...GR], called: [GR[1]] });
  run(w, 'grocery-run-price-check', { at: SWITCH + 60_000, avail: BASE });
  const toasts = [];
  // the live pass records a newer switch after the tasks were checked and before anything is written
  const afterScan = () => writeConnectorMarker(w.ctx, { at: SWITCH + 24 * HOUR, from: ME, to: OTHER });
  const r = backgroundConnectorCheck(w.ctx, { projects: w.projects, afterScan, toast: (t, b) => toasts.push(b) });
  assert.equal(r.dropped, 'newer-switch');
  assert.equal(toasts.length, 0);
  assert.equal(existsSync(noticeFile(w.ctx)), false);
  assert.equal(existsSync(flagsFile(w.ctx)), false);
  const m = readConnectorMarker(w.ctx);
  assert.equal(m.switchAt, iso(SWITCH + 24 * HOUR));
  assert.deepEqual(m.checked, {});
  assert.equal(m.lastCheckAt, undefined);
});

test('C12 a new switch clears the notice and flags of an older switch', () => {
  const w = world();
  writeConnectorMarker(w.ctx, { at: SWITCH, from: OTHER, to: ME });
  task(w, 'grocery-run-price-check');
  task(w, 'second-task');
  run(w, 'grocery-run-price-check', { at: SWITCH - 3 * HOUR, avail: [...BASE, ...GR], called: [GR[1]] });
  run(w, 'grocery-run-price-check', { at: SWITCH + 60_000, avail: BASE });
  check(w);
  assert.equal(existsSync(noticeFile(w.ctx)), true);
  assert.equal(existsSync(flagsFile(w.ctx)), true);
  writeConnectorMarker(w.ctx, { at: SWITCH + 24 * HOUR, from: ME, to: OTHER });
  assert.equal(existsSync(noticeFile(w.ctx)), false, 'the notice never describes the older switch');
  assert.equal(existsSync(flagsFile(w.ctx)), false);
  assert.equal(takeConnectorReport(w.ctx), null);
  // the current switch's own notice survives a later check of that switch
  run(w, 'grocery-run-price-check', { at: SWITCH + 24 * HOUR - HOUR, avail: [...BASE, ...GR], called: [GR[1]] });
  run(w, 'grocery-run-price-check', { at: SWITCH + 24 * HOUR + 60_000, avail: BASE });
  w.ctx.setNow(SWITCH + 25 * HOUR);
  check(w);
  assert.equal(existsSync(noticeFile(w.ctx)), true, 'the notice for the current switch is written');
  check(w);
  assert.match(readFileSync(noticeFile(w.ctx), 'utf8'), new RegExp(iso(SWITCH + 24 * HOUR).replace(/\./g, '\.')));
  assert.match(takeConnectorReport(w.ctx), /grocery-run-price-check/);
});
