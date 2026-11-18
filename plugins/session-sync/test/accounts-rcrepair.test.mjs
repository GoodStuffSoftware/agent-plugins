/**
 * accounts rc-repair (0.5.8): the file-side steps of the random-Remote-Control-name repair. Synthetic stores and transcripts in temp
 * folders; the process lister and the stopper are injected, so nothing here starts PowerShell or stops a process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeRoot, addFolder, putRecord, uuid } from './fixtures/store.mjs';
import { rcRepair } from '../lib/accounts/rcrepair.mjs';
import { lastBridgeEntry } from '../lib/accounts/rcrestore.mjs';
import { parseCliProcs, stopPids } from '../lib/accounts/proc.mjs';

const ME = '00000000-0000-4000-8000-0000000000a1';
const ORG = uuid('f', 1);
const NOW = Date.parse('2026-11-18T15:00:00Z');
const CLEAR = (cli) => `{"type":"bridge-session","sessionId":"${cli}","bridgeSessionId":"","lastSequenceNum":0}`;
const cli = (n) => uuid('d', n);
const sid = (n) => `local_${uuid('c', n)}`;
const keyOf = (n) => `C:\\synthetic\\project-${n}`.replace(/[^a-zA-Z0-9]/g, '-');

function world() {
  const r = makeRoot('repair');
  writeFileSync(join(r.userData, 'config.json'), JSON.stringify({ lastKnownAccountUuid: ME }));
  const projects = join(r.root, 'projects');
  mkdirSync(projects, { recursive: true });
  const folder = addFolder(r.store, ME, ORG);
  r.ctx.platform = 'win32';
  r.ctx.setNow(NOW);
  return { ...r, projects, folder };
}

/** A session whose transcript ends with `bridge` (an object) and optionally has no trailing newline. */
function session(w, n, { bridge = { bridgeSessionId: 'cse_random', noHistoryBackfill: true }, rec = {}, trailing = true } = {}) {
  putRecord(w.folder.path, n, { title: `Session ${n}`, cliSessionId: cli(n), cwd: `C:\\synthetic\\project-${n}`, ...rec });
  mkdirSync(join(w.projects, keyOf(n)), { recursive: true });
  const line = JSON.stringify({ type: 'bridge-session', sessionId: cli(n), lastSequenceNum: 3, ...bridge });
  const tp = join(w.projects, keyOf(n), `${cli(n)}.jsonl`);
  writeFileSync(tp, [JSON.stringify({ type: 'user', message: 'hi' }), line, JSON.stringify({ type: 'assistant', message: 'yo' })].join('\n') + (trailing ? '\n' : ''));
  return tp;
}

/** A lister that answers from a mutable state; `stop` removes the stopped pids unless `sticky`. */
function procs(initial, { sticky = false } = {}) {
  const st = { list: initial, stopped: [], calls: 0 };
  return {
    st,
    listProcs: async () => { st.calls++; return st.list === null ? null : st.list.map((p) => ({ ...p })); },
    stopPids: (pids) => { st.stopped.push(...pids); if (!sticky) st.list = st.list.filter((p) => !pids.includes(p.pid)); return pids; },
  };
}
const proc = (pid, n, flag = 'resume') => ({ pid, ids: [cli(n)], resume: flag === 'resume' ? [cli(n)] : [] });
const run = (w, id, o = {}) => rcRepair(w.ctx, { id, projects: w.projects, ...o });
const backups = (w) => { const root = join(w.acc, 'rc-restore', 'backup'); return existsSync(root) ? readdirSync(root) : []; };

test('R1 refuses a session that is mid-turn, writes nothing', async () => {
  const w = world(); const tp = session(w, 1, { rec: { isRunning: true } });
  const before = readFileSync(tp, 'utf8'); const p = procs([]);
  const r = await run(w, sid(1), { listProcs: p.listProcs, stopPids: p.stopPids, stopCli: true });
  assert.equal(r.reason, 'mid-turn'); assert.equal(r.ok, false);
  assert.equal(readFileSync(tp, 'utf8'), before); assert.equal(p.st.calls, 0);
});

test('R2 a live CLI without --stop-cli is refused; nothing stopped, nothing written', async () => {
  const w = world(); const tp = session(w, 1);
  const before = readFileSync(tp, 'utf8'); const p = procs([proc(4242, 1)]);
  const r = await run(w, cli(1), { listProcs: p.listProcs, stopPids: p.stopPids });
  assert.equal(r.reason, 'cli-live'); assert.deepEqual(r.pids, [4242]);
  assert.deepEqual(p.st.stopped, []); assert.equal(readFileSync(tp, 'utf8'), before);
});

test('R3 --stop-cli stops only the pids of that conversation, re-checks, backs up, then appends the clear line', async () => {
  const w = world(); const tp = session(w, 1); session(w, 2);
  const before = readFileSync(tp, 'utf8');
  const p = procs([proc(4242, 1), proc(4243, 2), { pid: 4244, ids: [cli(1)], resume: [] }]);
  const r = await run(w, sid(1), { listProcs: p.listProcs, stopPids: p.stopPids, stopCli: true });
  // pid 4244 names the conversation with --session-id only: it is not a --resume process, so the repair refuses before stopping anything (also as a dry run)
  assert.equal(r.reason, 'cli-not-stoppable'); assert.deepEqual(p.st.stopped, []); assert.equal(readFileSync(tp, 'utf8'), before);
  assert.equal((await run(w, sid(1), { listProcs: p.listProcs, stopPids: p.stopPids, stopCli: true, dryRun: true })).reason, 'cli-not-stoppable');
  const p2 = procs([proc(4242, 1), proc(4243, 2)]);
  const ok = await run(w, sid(1), { listProcs: p2.listProcs, stopPids: p2.stopPids, stopCli: true });
  assert.equal(ok.status, 'cleared'); assert.deepEqual(p2.st.stopped, [4242]);
  assert.deepEqual(p2.st.list.map((x) => x.pid), [4243], 'the other conversation keeps its CLI');
  assert.equal(readFileSync(tp, 'utf8'), before + CLEAR(cli(1)) + '\n');
  assert.equal(lastBridgeEntry(tp).bridgeSessionId, '');
  const dir = join(w.acc, 'rc-restore', 'backup', backups(w)[0]);
  assert.equal(readFileSync(join(dir, `${cli(1)}.jsonl`), 'utf8'), before);
});

test('R4 a stopped CLI that is still listed refuses the write', async () => {
  const w = world(); const tp = session(w, 1); const before = readFileSync(tp, 'utf8');
  const p = procs([proc(4242, 1)], { sticky: true });
  const r = await run(w, cli(1), { listProcs: p.listProcs, stopPids: p.stopPids, stopCli: true });
  assert.equal(r.reason, 'cli-still-live'); assert.equal(readFileSync(tp, 'utf8'), before); assert.deepEqual(backups(w), []);
});

test('R5 an unknown process list refuses, before and after a stop', async () => {
  const w = world(); const tp = session(w, 1); const before = readFileSync(tp, 'utf8');
  const a = await run(w, cli(1), { listProcs: async () => null, stopPids: () => assert.fail('must not stop'), stopCli: true });
  assert.equal(a.reason, 'unknown-processes');
  let calls = 0;
  const b = await run(w, cli(1), { listProcs: async () => (++calls === 1 ? [proc(4242, 1)] : null), stopPids: (x) => x, stopCli: true });
  assert.equal(b.reason, 'unknown-processes');
  assert.equal(readFileSync(tp, 'utf8'), before);
});

test('R6 a healthy or already cleared link is refused without --force and cleared with it; --dry-run writes nothing', async () => {
  const w = world(); const healthy = session(w, 1, { bridge: { bridgeSessionId: 'cse_titled' } }); const cleared = session(w, 2, { bridge: { bridgeSessionId: '' } });
  const p = procs([]); const o = { listProcs: p.listProcs, stopPids: p.stopPids };
  assert.equal((await run(w, cli(1), o)).reason, 'not-stale');
  assert.equal((await run(w, cli(2), o)).reason, 'not-stale');
  const before = readFileSync(healthy, 'utf8');
  const d = await run(w, cli(1), { ...o, force: true, dryRun: true });
  assert.equal(d.status, 'dry-run'); assert.equal(readFileSync(healthy, 'utf8'), before); assert.deepEqual(backups(w), []);
  assert.equal((await run(w, cli(1), { ...o, force: true })).status, 'cleared');
  assert.equal(lastBridgeEntry(healthy).bridgeSessionId, '');
  assert.equal(readFileSync(cleared, 'utf8').includes('cse_'), false);
});

test('R7 --dry-run on a stale live session lists the pids it would stop and changes nothing', async () => {
  const w = world(); const tp = session(w, 1); const before = readFileSync(tp, 'utf8');
  const p = procs([proc(4242, 1)]);
  const r = await run(w, cli(1), { listProcs: p.listProcs, stopPids: p.stopPids, stopCli: true, dryRun: true });
  assert.equal(r.status, 'dry-run'); assert.deepEqual(r.wouldStop, [4242]);
  assert.deepEqual(p.st.stopped, []); assert.equal(readFileSync(tp, 'utf8'), before); assert.deepEqual(backups(w), []);
  assert.equal(JSON.stringify(r).includes('--resume'), false, 'no command line in the output');
});

test('R8 --verify passes for a fresh cse_ link and fails for noHistoryBackfill, a cleared link and no link', async () => {
  const w = world();
  session(w, 1, { bridge: { bridgeSessionId: 'cse_new' } });
  session(w, 2, { bridge: { bridgeSessionId: 'cse_random', noHistoryBackfill: true } });
  session(w, 3, { bridge: { bridgeSessionId: '' } });
  const a = await run(w, cli(1), { verify: true });
  assert.deepEqual([a.ok, a.link, a.noHistoryBackfill, a.pass], [true, 'cse_new', false, true]); assert.match(a.text, /PASS/);
  const b = await run(w, cli(2), { verify: true });
  assert.deepEqual([b.ok, b.noHistoryBackfill, b.pass], [false, true, false]); assert.match(b.text, /FAIL/);
  assert.equal((await run(w, cli(3), { verify: true })).pass, false);
});

test('R9 a transcript without a trailing newline gets one before the clear line', async () => {
  const w = world(); const tp = session(w, 1, { trailing: false }); const before = readFileSync(tp, 'utf8');
  assert.equal(before.endsWith('\n'), false);
  const p = procs([]);
  const r = await run(w, cli(1), { listProcs: p.listProcs, stopPids: p.stopPids });
  assert.equal(r.status, 'cleared');
  assert.equal(readFileSync(tp, 'utf8'), before + '\n' + CLEAR(cli(1)) + '\n');
  assert.equal(readFileSync(join(w.acc, 'rc-restore', 'backup', backups(w)[0], `${cli(1)}.jsonl`), 'utf8'), before);
});

test('R10 works with rcRestore disabled in the config; unknown ids and bad ids are refused', async () => {
  const w = world(); session(w, 1);
  writeFileSync(join(w.userData, 'config.json'), JSON.stringify({ lastKnownAccountUuid: ME, rcRestore: { enabled: false } }));
  const p = procs([]);
  assert.equal((await run(w, cli(1), { listProcs: p.listProcs, stopPids: p.stopPids })).status, 'cleared');
  assert.equal((await run(w, cli(9), { listProcs: p.listProcs })).reason, 'no-record');
  assert.equal((await run(w, 'nonsense', {})).reason, 'bad-id');
});

test('R11 parseCliProcs keeps pids and ids only; an unreadable line or a missing end mark is unknown; stopPids runs taskkill hidden per pid', () => {
  const out = `P\t11\tC:\\x\\claude.exe --resume ${cli(1)} --secret abc\nP\t12\tC:\\x\\claude.exe --session-id ${cli(2)}\nok-end\n`;
  const r = parseCliProcs(out);
  assert.deepEqual(r, [{ pid: 11, ids: [cli(1)], resume: [cli(1)] }, { pid: 12, ids: [cli(2)], resume: [] }]);
  assert.equal(JSON.stringify(r).includes('secret'), false);
  assert.equal(parseCliProcs('P\t11\t\nok-end\n'), null);
  assert.equal(parseCliProcs(`P\t11\tx --resume ${cli(1)}\n`), null);
  const calls = [];
  const done = stopPids([11, 0, 12], { spawnSyncFn: (cmd, args, opts) => { calls.push([cmd, args, opts.windowsHide]); return { status: 0 }; } });
  assert.deepEqual(done, [11, 12]);
  assert.deepEqual(calls.map((c) => [c[1][1], c[2]]), [['11', true], ['12', true]]);
});
