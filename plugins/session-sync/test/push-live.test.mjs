/**
 * A push must succeed while Claude is writing: a file that changes, grows or
 * disappears during the copy is settled per file, never fails the run and
 * never causes a whole-run retry (the 2026-11-20/21 failure: one rewritten
 * state file re-ran a 15 to 70 minute pass three times, and every push failed).
 *
 * Fixtures only: a temp folder is the local "remote" and the map/manifest/
 * deferred-file paths are temp too (sandbox-env keeps homedir away from the
 * real ~/.claude). The REAL rclone does every copy that can be exercised for
 * real. rclone cannot be made to lose a race on cue, so the main pass is
 * wrapped by a `runner` that lets rclone copy, then reports the error rclone
 * v1.74.0 prints for a file that changed mid-copy (the canned lines below are
 * what it printed, see classifyCopyErrors in lib/rclone.mjs). The snapshot
 * upload that follows goes to the real rclone.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, utimesSync, statSync, appendFileSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { push, pull, snapshotFile, summarizeDeferred, readDeferredFiles } from '../lib/sync.mjs';
import { loadManifest } from '../lib/manifest.mjs';
import { findRclone, runRclone, parseRcloneLog, classifyCopyErrors } from '../lib/rclone.mjs';

const haveRclone = !!findRclone();
const skip = haveRclone ? false : 'rclone is not installed on this machine';
const LABEL = '~/.claude';

const errLine = (msg, object) => JSON.stringify({ level: 'error', msg, ...(object ? { object, objectType: '*local.Object' } : {}), source: 'x', time: '2026-11-22T00:00:00Z' });
const SIZES = (o) => errLine('Failed to copy: corrupted on transfer: sizes differ src(Local file system at C:/x) 5 vs dst(Local file system at C:/y) 20', o);
const UPDATING = (o) => errLine('Failed to copy: source file is being updated (size changed from 10 to 12)', o);
const SUMMARY = errLine('Attempt 1/1 failed with 1 errors and: corrupted on transfer: sizes differ');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ss-live-'));
  const local = join(root, 'home');
  const remoteDir = join(root, 'remote');
  mkdirSync(local, { recursive: true });
  mkdirSync(remoteDir, { recursive: true });
  const manifestFile = join(root, 'manifest.json');
  const deferredFile = join(root, 'deferred-files.json');
  const map = [{ local, remote: remoteDir, excludes: [], label: LABEL }];
  const base = { map, manifestFile, deferredFile, quiet: true };
  const put = (rel, text, ageSec = 0) => {
    const f = join(local, ...rel.split('/'));
    mkdirSync(join(f, '..'), { recursive: true });
    writeFileSync(f, text);
    const t = (Date.now() + ageSec * 1000) / 1000;
    utimesSync(f, t, t);
    return f;
  };
  const sig = (rel) => { const st = statSync(join(local, ...rel.split('/'))); return `${st.size}:${Math.floor(st.mtimeMs)}`; };
  const man = () => loadManifest(manifestFile)[remoteDir]?.[LABEL] || {};
  const remoteText = (rel) => readFileSync(join(remoteDir, ...rel.split('/')), 'utf8');
  return { root, local, remoteDir, manifestFile, deferredFile, map, base, put, sig, man, remoteText };
}

/** A runner: scripted steps in order, then the real rclone. A step is (args, opts) => result. */
function scripted(...steps) {
  const calls = [];
  const runner = async (args, o) => {
    calls.push(args);
    const step = steps.shift();
    return step ? step(args, o) : runRclone(args, o);
  };
  return { runner, calls };
}

/** rclone copies everything, then reports `lines` as the error for a file that changed under it; rclone removes a corrupted destination. */
const copyThenFail = (fx, rel, lines, mutate) => async (args, o) => {
  await runRclone(args, o);
  rmSync(join(fx.remoteDir, ...rel.split('/')), { force: true });
  mutate?.();
  return { code: 1, stdout: '', stderr: lines.join('\n') };
};

const cleanup = (fx) => rmSync(fx.root, { recursive: true, force: true });

// ---- classifyCopyErrors on canned rclone output ---------------------------

test('classify: a named file that changed is volatile; the end-of-attempt summary line is ignored', () => {
  const ev = parseRcloneLog([SIZES('projects/a/state.json'), SUMMARY].join('\n'));
  const r = classifyCopyErrors(ev, { known: (p) => p === 'projects/a/state.json', localState: () => 'changed' });
  assert.deepEqual([...r.perFile.keys()], ['projects/a/state.json']);
  assert.deepEqual(r.fatal, []);
});

test('classify: no object, an unknown object, or a remote-side error on an unchanged file is fatal', () => {
  const known = (p) => p === 'a.txt';
  const noObj = classifyCopyErrors(parseRcloneLog(errLine('Failed to copy: googleapi: Error 403: quota exceeded')), { known, localState: () => 'same' });
  assert.equal(noObj.fatal.length, 1);
  const unknown = classifyCopyErrors(parseRcloneLog(SIZES('other.txt')), { known, localState: () => 'changed' });
  assert.equal(unknown.fatal.length, 1);
  const remoteSide = classifyCopyErrors(parseRcloneLog(errLine('Failed to copy: googleapi: Error 403: rateLimitExceeded', 'a.txt')), { known, localState: () => 'same' });
  assert.equal(remoteSide.fatal.length, 1);
  assert.equal(remoteSide.perFile.size, 0);
  const junk = classifyCopyErrors(parseRcloneLog('panic: something we do not parse'), { known, localState: () => 'changed' });
  assert.equal(junk.fatal.length, 1);
});

test('classify: a source-side error on an unchanged-looking file is still volatile; a local-remote .partial name maps back', () => {
  const known = (p) => p === 'a.txt';
  const r = classifyCopyErrors(parseRcloneLog([UPDATING('a.txt'), SIZES('a.txt.0a1b2c3d.partial')].join('\n')), { known, localState: () => 'same' });
  assert.deepEqual([...r.perFile.keys()], ['a.txt']);
  assert.deepEqual(r.fatal, []);
});

// ---- snapshotFile ----------------------------------------------------------

test('snapshotFile: a still file is copied with its mtime; a missing file is gone', { skip }, async () => {
  const fx = fixture();
  try {
    fx.put('s.json', '{"a":1}', -100);
    const stage = join(fx.root, 'stage');
    const r = await snapshotFile(fx.local, 's.json', stage);
    assert.equal(r.status, 'ok');
    assert.equal(r.complete, true);
    assert.equal(r.sig, fx.sig('s.json'));
    assert.equal(readFileSync(join(stage, 's.json'), 'utf8'), '{"a":1}');
    assert.equal(Math.floor(statSync(join(stage, 's.json')).mtimeMs / 1000), Math.floor(statSync(join(fx.local, 's.json')).mtimeMs / 1000));
    assert.equal((await snapshotFile(fx.local, 'nope.json', stage)).status, 'gone');
  } finally { cleanup(fx); }
});

test('snapshotFile: a file deleted while it is being copied is gone, not an error', { skip }, async () => {
  const fx = fixture();
  try {
    fx.put('s.json', 'x');
    const r = await snapshotFile(fx.local, 's.json', join(fx.root, 'stage'), { copy: () => { const e = new Error('gone'); e.code = 'ENOENT'; throw e; } });
    assert.equal(r.status, 'gone');
  } finally { cleanup(fx); }
});

test('snapshotFile: a plain file that changes during every copy is unstable', { skip }, async () => {
  const fx = fixture();
  try {
    const f = fx.put('s.json', 'abc');
    const r = await snapshotFile(fx.local, 's.json', join(fx.root, 'stage'), { attempts: 3, pauseMs: 1, copy: (a, b) => { copyFileSync(a, b); appendFileSync(f, 'x'); } });
    assert.equal(r.status, 'unstable');
    assert.equal(existsSync(join(fx.root, 'stage', 's.json')), false, 'no half snapshot is left to upload');
  } finally { cleanup(fx); }
});

test('snapshotFile: a plain file that settles on the second attempt is ok', { skip }, async () => {
  const fx = fixture();
  try {
    const f = fx.put('s.json', 'abc');
    let n = 0;
    const r = await snapshotFile(fx.local, 's.json', join(fx.root, 'stage'), { attempts: 3, pauseMs: 1, copy: (a, b) => { copyFileSync(a, b); if (++n === 1) appendFileSync(f, 'x'); } });
    assert.equal(r.status, 'ok');
    assert.equal(readFileSync(join(fx.root, 'stage', 's.json'), 'utf8'), 'abcx');
  } finally { cleanup(fx); }
});

test('snapshotFile: a growing transcript is cut at what was stat\'ed, then at its last complete line', { skip }, async () => {
  const fx = fixture();
  try {
    const f = fx.put('p/s.jsonl', 'l1\nl2\nl3-par');
    const stage = join(fx.root, 'stage');
    // The writer appends while we copy: the extra bytes must not be in the snapshot.
    const r = await snapshotFile(fx.local, 'p/s.jsonl', stage, { copy: (a, b) => { copyFileSync(a, b); appendFileSync(f, 'tial\nl4\n'); } });
    assert.equal(r.status, 'ok');
    assert.equal(r.complete, false, 'the stat\'ed bytes ended mid-line');
    assert.equal(readFileSync(join(stage, 'p', 's.jsonl'), 'utf8'), 'l1\nl2\n');
  } finally { cleanup(fx); }
});

test('snapshotFile: a transcript that ends on a newline is complete and keeps its exact mtime', { skip }, async () => {
  const fx = fixture();
  try {
    fx.put('p/s.jsonl', 'l1\nl2\n', -50);
    const stage = join(fx.root, 'stage');
    const r = await snapshotFile(fx.local, 'p/s.jsonl', stage);
    assert.equal(r.complete, true);
    assert.equal(readFileSync(join(stage, 'p', 's.jsonl'), 'utf8'), 'l1\nl2\n');
    assert.equal(Math.floor(statSync(join(stage, 'p', 's.jsonl')).mtimeMs / 1000), Math.floor(Number(r.sig.split(':')[1]) / 1000));
  } finally { cleanup(fx); }
});

test('snapshotFile: a transcript with no complete line yet, or one rewritten shorter, is unstable', { skip }, async () => {
  const fx = fixture();
  try {
    fx.put('a.jsonl', 'no newline yet');
    assert.equal((await snapshotFile(fx.local, 'a.jsonl', join(fx.root, 'stage'), { attempts: 2, pauseMs: 1 })).status, 'unstable');
    fx.put('b.jsonl', 'l1\nl2\nl3\n');
    // The copy comes out SHORTER than the size stat'ed just before it: not append-only, never trusted.
    const r = await snapshotFile(fx.local, 'b.jsonl', join(fx.root, 'stage'), { attempts: 2, pauseMs: 1, copy: (a, b) => writeFileSync(b, 'x\n') });
    assert.equal(r.status, 'unstable');
  } finally { cleanup(fx); }
});

// ---- push() with files changing under rclone -------------------------------

test('a file rewritten shorter mid-copy is sent from a snapshot: the run is ok, once, with no whole-run retry', { skip }, async () => {
  const fx = fixture();
  try {
    fx.put('state.json', 'a'.repeat(20), -100);
    fx.put('keep.txt', 'old', -100);
    assert.ok((await push(fx.remoteDir, fx.base)).ok);

    fx.put('state.json', 'b'.repeat(20), -50);
    fx.put('keep.txt', 'new keep', -50);
    const s = scripted(copyThenFail(fx, 'state.json', [SIZES('state.json'), SUMMARY], () => fx.put('state.json', 'short', 0)));
    const logs = [];
    const r = await push(fx.remoteDir, { ...fx.base, runner: s.runner, onLog: (l) => logs.push(l) });
    assert.equal(r.ok, true, logs.join('\n'));
    assert.equal(s.calls.length, 2, 'one main pass and one snapshot upload, never a whole-run retry');
    assert.ok(s.calls[0].includes('--use-json-log') && s.calls[0][s.calls[0].indexOf('--retries') + 1] === '1', 'the main pass asks rclone for exactly one attempt');
    assert.equal(r.staged, 1);
    assert.deepEqual(r.deferred, []);
    assert.equal(fx.remoteText('state.json'), 'short');
    assert.equal(fx.remoteText('keep.txt'), 'new keep', 'everything else was copied');
    assert.equal(fx.man()['state.json'], fx.sig('state.json'), 'the baseline holds the snapshot mark');
    assert.equal(existsSync(fx.deferredFile), false);
    assert.equal((await push(fx.remoteDir, fx.base)).skipped, true, 'nothing is left owing');
  } finally { cleanup(fx); }
});

test('a file deleted mid-copy is dropped from the baseline; the run is ok and the rest is copied', { skip }, async () => {
  const fx = fixture();
  try {
    fx.put('gone.txt', 'x', -100);
    fx.put('keep.txt', 'old', -100);
    assert.ok((await push(fx.remoteDir, fx.base)).ok);
    fx.put('gone.txt', 'xx', -50);
    fx.put('keep.txt', 'new keep', -50);
    const s = scripted(copyThenFail(fx, 'gone.txt', [errLine('Failed to copy: failed to open source object: open C:/x/gone.txt: The system cannot find the file specified.', 'gone.txt'), SUMMARY], () => rmSync(join(fx.local, 'gone.txt'))));
    const r = await push(fx.remoteDir, { ...fx.base, runner: s.runner });
    assert.equal(r.ok, true);
    assert.equal(r.vanished, 1);
    assert.equal(s.calls.length, 1, 'nothing left to upload, no retry');
    assert.equal(fx.remoteText('keep.txt'), 'new keep');
    assert.equal('gone.txt' in fx.man(), false);
  } finally { cleanup(fx); }
});

test('a file that never holds still is deferred: the run is ok, the baseline does not advance, the next pass sends it', { skip }, async () => {
  const fx = fixture();
  try {
    fx.put('busy.txt', 'v1', -100);
    fx.put('keep.txt', 'old', -100);
    fx.put('fresh.txt', 'n', -100);
    assert.ok((await push(fx.remoteDir, fx.base)).ok);
    const before = fx.man()['busy.txt'];

    const busy = fx.put('busy.txt', 'v2-longer', -50);
    fx.put('keep.txt', 'new keep', -50);
    fx.put('brand-new.txt', 'hello', -50);                       // never on the remote, no previous mark
    const s = scripted(async (args, o) => {
      await runRclone(args, o);
      rmSync(join(fx.remoteDir, 'busy.txt'), { force: true });
      rmSync(join(fx.remoteDir, 'brand-new.txt'), { force: true });
      return { code: 1, stdout: '', stderr: [SIZES('busy.txt'), SIZES('brand-new.txt'), SUMMARY].join('\n') };
    });
    const logs = [];
    const r = await push(fx.remoteDir, { ...fx.base, runner: s.runner, onLog: (l) => logs.push(l), snapshotOpts: { attempts: 2, pauseMs: 1, copy: (a, b) => { copyFileSync(a, b); appendFileSync(busy, '.'); appendFileSync(join(fx.local, 'brand-new.txt'), '.'); } } });
    assert.equal(r.ok, true, logs.join('\n'));
    assert.deepEqual(r.deferred.map((d) => d.path).sort(), ['brand-new.txt', 'busy.txt']);
    assert.equal(fx.man()['busy.txt'], before, 'a deferred file keeps its previous mark');
    assert.equal('brand-new.txt' in fx.man(), false, 'a deferred new file is not in the baseline');
    assert.equal(fx.remoteText('keep.txt'), 'new keep');
    assert.ok(logs.some((l) => /deferred 2 file\(s\) to the next pass \(2 unstable\): .*busy\.txt/.test(l)), 'the log names the deferred files');
    const rec = readDeferredFiles(fx.deferredFile);
    assert.equal(rec.count, 2);
    assert.deepEqual(rec.byReason, { unstable: 2 });

    // The next pass picks both up (they are "changed"/"added" again) and clears the record.
    const r2 = await push(fx.remoteDir, fx.base);
    assert.equal(r2.ok, true);
    assert.deepEqual(r2.deferred, []);
    assert.equal(fx.remoteText('busy.txt'), readFileSync(join(fx.local, 'busy.txt'), 'utf8'));
    assert.equal(fx.remoteText('brand-new.txt'), readFileSync(join(fx.local, 'brand-new.txt'), 'utf8'));
    assert.equal(fx.man()['busy.txt'], fx.sig('busy.txt'));
    assert.equal(existsSync(fx.deferredFile), false);
  } finally { cleanup(fx); }
});

test('a transcript caught mid-line lands on a line boundary, is deferred, and a pull never lets that prefix replace the longer local file', { skip }, async () => {
  const fx = fixture();
  try {
    fx.put('p/s.jsonl', 'l1\n', -100);
    assert.ok((await push(fx.remoteDir, fx.base)).ok);
    const before = fx.man()['p/s.jsonl'];

    fx.put('p/s.jsonl', 'l1\nl2\nl3-par', -30);
    const localMtime = statSync(join(fx.local, 'p', 's.jsonl')).mtimeMs;
    const s = scripted(async () => ({ code: 1, stdout: '', stderr: [UPDATING('p/s.jsonl'), SUMMARY].join('\n') }));
    const r = await push(fx.remoteDir, { ...fx.base, runner: s.runner });
    assert.equal(r.ok, true);
    assert.deepEqual(r.deferred.map((d) => [d.path, d.reason]), [['p/s.jsonl', 'partial-tail']]);
    assert.equal(fx.remoteText('p/s.jsonl'), 'l1\nl2\n', 'the remote copy ends on a complete line');
    assert.ok(statSync(join(fx.remoteDir, 'p', 's.jsonl')).mtimeMs < localMtime - 1000, 'older than the local file, so a pull cannot treat it as current');
    assert.equal(fx.man()['p/s.jsonl'], before, 'the baseline does not advance for a transcript that is not current');

    // Pull the prefix back: the longer, newer local file must be untouched.
    const p = await pull(fx.remoteDir, { map: fx.map, quiet: true });
    assert.equal(p.ok, true);
    assert.equal(readFileSync(join(fx.local, 'p', 's.jsonl'), 'utf8'), 'l1\nl2\nl3-par');
    assert.deepEqual(p.conflicts, []);

    // Next pass: the file is changed against the baseline, so the full file goes up.
    const r2 = await push(fx.remoteDir, fx.base);
    assert.equal(r2.ok, true);
    assert.equal(fx.remoteText('p/s.jsonl'), 'l1\nl2\nl3-par');
    assert.equal(fx.man()['p/s.jsonl'], fx.sig('p/s.jsonl'));
  } finally { cleanup(fx); }
});

test('real failures still fail the run and never commit the baseline: no object, remote-side error, failed snapshot upload', { skip }, async () => {
  for (const [name, make] of [
    ['no object named', () => scripted(async () => ({ code: 1, stdout: '', stderr: errLine('Failed to copy: googleapi: Error 403: Rate Limit Exceeded') }))],
    ['remote-side error on a file that did not change', () => scripted(async () => ({ code: 1, stdout: '', stderr: errLine('Failed to copy: googleapi: Error 403: storageQuotaExceeded', 'a.txt') }))],
    ['unparseable output', () => scripted(async () => ({ code: 1, stdout: '', stderr: 'something went badly wrong' }))],
    ['snapshot upload fails', () => scripted(async () => ({ code: 1, stdout: '', stderr: SIZES('a.txt') }), async () => ({ code: 1, stdout: '', stderr: 'upload died' }))],
  ]) {
    const fx = fixture();
    try {
      fx.put('a.txt', 'one', -50);
      const s = make();
      const r = await push(fx.remoteDir, { ...fx.base, runner: s.runner });
      assert.equal(r.ok, false, name);
      assert.equal(existsSync(fx.manifestFile), false, `${name}: the baseline must not be committed`);
      assert.equal(existsSync(fx.deferredFile), false, name);
    } finally { cleanup(fx); }
  }
});

test('the real rclone leaves nothing half-written on the remote and no stage folder behind', { skip }, async () => {
  const fx = fixture();
  try {
    fx.put('a.txt', 'one', -50);
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('session-sync-stage-')).length;
    const s = scripted(copyThenFail(fx, 'a.txt', [SIZES('a.txt')], () => fx.put('a.txt', 'two!', 0)));
    const r = await push(fx.remoteDir, { ...fx.base, runner: s.runner });
    assert.equal(r.ok, true);
    assert.equal(fx.remoteText('a.txt'), 'two!');
    assert.equal(readdirSync(tmpdir()).filter((n) => n.startsWith('session-sync-stage-')).length, before);
    assert.deepEqual(readdirSync(fx.remoteDir).filter((n) => n.includes('.partial')), []);
  } finally { cleanup(fx); }
});

test('a stage folder is removed even when push() throws after a file was settled', { skip }, async () => {
  const fx = fixture();
  try {
    fx.put('a.txt', 'one', -50);
    const local2 = join(fx.root, 'home2');
    mkdirSync(local2, { recursive: true });
    writeFileSync(join(local2, 'b.txt'), 'b');
    const map = [...fx.map, { local: local2, remote: join(fx.root, 'remote2'), excludes: [], label: 'second' }];
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('session-sync-stage-')).length;
    const s = scripted(
      copyThenFail(fx, 'a.txt', [SIZES('a.txt')], () => fx.put('a.txt', 'two!', 0)),   // entry 1: settles a.txt (stage dir created)
      undefined,                                                                       // entry 1: the snapshot upload (real)
      async () => { throw new Error('spawn failed'); },                                // entry 2: rclone cannot run
    );
    await assert.rejects(push(fx.remoteDir, { ...fx.base, map, runner: s.runner }), /spawn failed/);
    assert.equal(readdirSync(tmpdir()).filter((n) => n.startsWith('session-sync-stage-')).length, before, 'no stage folder is left behind');
  } finally { cleanup(fx); }
});

test('a nothing-to-push pass clears a stale deferred-files.json', { skip }, async () => {
  const fx = fixture();
  try {
    fx.put('a.txt', 'one', -50);
    assert.ok((await push(fx.remoteDir, fx.base)).ok);
    writeFileSync(fx.deferredFile, JSON.stringify({ at: 'x', count: 1, byReason: { unstable: 1 }, files: [{ label: LABEL, path: 'gone.txt', reason: 'unstable' }] }));
    const r = await push(fx.remoteDir, fx.base);
    assert.equal(r.skipped, true);
    assert.equal(existsSync(fx.deferredFile), false);
  } finally { cleanup(fx); }
});

test('snapshotFile: a transcript that grew while it was copied is not complete, even when it was cut at a line boundary', { skip }, async () => {
  const fx = fixture();
  try {
    const f = fx.put('p/s.jsonl', 'l1\nl2\n');
    const stage = join(fx.root, 'stage');
    const r = await snapshotFile(fx.local, 'p/s.jsonl', stage, { copy: (a, b) => { copyFileSync(a, b); appendFileSync(f, 'l3\n'); } });
    assert.equal(r.status, 'ok');
    assert.equal(r.complete, false, 'a strict prefix of the live file must never be marked current');
    assert.equal(readFileSync(join(stage, 'p', 's.jsonl'), 'utf8'), 'l1\nl2\n');
  } finally { cleanup(fx); }
});

// ---- reporting -------------------------------------------------------------

test('summarizeDeferred names the files with counts and caps the list', () => {
  assert.equal(summarizeDeferred([]), '');
  const many = Array.from({ length: 25 }, (_, i) => ({ label: LABEL, path: `f${i}.json`, reason: i < 20 ? 'unstable' : 'partial-tail' }));
  const line = summarizeDeferred(many);
  assert.match(line, /^deferred 25 file\(s\) to the next pass \(20 unstable, 5 partial-tail\): /);
  assert.match(line, /f19\.json/);
  assert.doesNotMatch(line, /f20\.json/);
  assert.match(line, /\(\+5 more\)$/);
});
