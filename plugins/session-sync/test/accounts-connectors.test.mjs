/**
 * 0.5.14: the connector check after an account switch (lib/accounts/connectors.mjs). Synthetic stores, run records, transcripts and task
 * files in temp folders only; the live store and the live transcripts are never read. The toast is injected, so nothing is shown.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeRoot, addFolder, putRecord, putTasks, makeTask, uuid, setMtime } from './fixtures/store.mjs';
import {
  connectorCheck, connectorCheckStep, takeConnectorReport, writeConnectorMarker, readConnectorMarker, compareTask, markerFile, flagsFile, noticeFile, EXPIRE_MS,
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
  assert.equal(connectorCheckStep(w.ctx), null, 'no marker: the hook step does nothing');
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

test('C11 the hook step is throttled to once per 15 minutes per switch, and a time budget leaves the rest pending', () => {
  const w = world();
  writeConnectorMarker(w.ctx, { at: SWITCH, from: OTHER, to: ME });
  task(w, 'a-task');
  task(w, 'b-task');   // no run yet: stays pending, so the marker survives
  run(w, 'a-task', { at: SWITCH - 3 * HOUR, avail: BASE });
  run(w, 'a-task', { at: SWITCH + 60_000, avail: BASE });
  const hook = { projects: w.projects, throttleMs: 15 * 60_000 };
  const r1 = connectorCheckStep(w.ctx, hook);
  assert.equal(r1.ran, true);
  assert.ok(readConnectorMarker(w.ctx).lastCheckAt, 'the check time is recorded in the marker');
  w.ctx.setNow(SWITCH + HOUR + 10 * 60_000);
  assert.deepEqual(connectorCheckStep(w.ctx, hook), { ran: false, reason: 'throttled' });
  assert.equal(connectorCheck(w.ctx, { projects: w.projects }).ran, true, 'the CLI command is not throttled');
  w.ctx.setNow(SWITCH + HOUR + 16 * 60_000);
  assert.equal(connectorCheckStep(w.ctx, hook).ran, true, 'after the window it runs again');
  // a new switch writes a fresh marker: no lastCheckAt, so it runs at once
  writeConnectorMarker(w.ctx, { at: SWITCH + 2 * HOUR, from: ME, to: OTHER });
  assert.equal(readConnectorMarker(w.ctx).lastCheckAt, undefined);
  assert.equal(connectorCheckStep(w.ctx, hook).ran, true);
  // a zero budget stops before any task: everything stays pending and nothing is marked checked
  const w2 = world();
  writeConnectorMarker(w2.ctx, { at: SWITCH, from: OTHER, to: ME });
  task(w2, 'a-task');
  run(w2, 'a-task', { at: SWITCH - 3 * HOUR, avail: BASE });
  run(w2, 'a-task', { at: SWITCH + 60_000, avail: BASE });
  const r = connectorCheck(w2.ctx, { projects: w2.projects, budgetMs: 0 });
  assert.deepEqual(r.pending, ['a-task']);
  assert.deepEqual(readConnectorMarker(w2.ctx).checked, {});
  assert.equal(r.retired, null);
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
});
