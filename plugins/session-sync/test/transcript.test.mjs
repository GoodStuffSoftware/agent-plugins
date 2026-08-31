/**
 * Tests for conflict classification.
 *
 * A wrong answer here deletes messages. 'fast-forward' means "the displaced copy
 * is redundant, throw it away" — so anything that is actually divergent MUST NOT
 * be classified as fast-forward. These tests are biased accordingly: when in
 * doubt the answer should be conflict, never fast-forward.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyReplacement, lostCount, transcriptUuids } from '../lib/transcript.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'ss-tr-'));
const line = (uuid, parent, text) => JSON.stringify({ uuid, parentUuid: parent, message: text });
const write = (d, name, lines) => { const p = join(d, name); writeFileSync(p, lines.join('\n') + '\n'); return p; };

test('a continued conversation is a fast-forward', () => {
  const d = dir();
  const oldF = write(d, 'old.jsonl', [line('a', null, '1'), line('b', 'a', '2')]);
  const newF = write(d, 'new.jsonl', [line('a', null, '1'), line('b', 'a', '2'), line('c', 'b', '3')]);
  assert.equal(classifyReplacement(oldF, newF), 'fast-forward');
  rmSync(d, { recursive: true, force: true });
});

test('identical files are identical, not a conflict', () => {
  const d = dir();
  const l = [line('a', null, '1'), line('b', 'a', '2')];
  assert.equal(classifyReplacement(write(d, 'o.jsonl', l), write(d, 'n.jsonl', l)), 'identical');
  rmSync(d, { recursive: true, force: true });
});

test('messages only in the displaced copy = diverged (the data-loss case)', () => {
  const d = dir();
  const oldF = write(d, 'old.jsonl', [line('a', null, '1'), line('mine', 'a', 'typed on THIS machine')]);
  const newF = write(d, 'new.jsonl', [line('a', null, '1'), line('theirs', 'a', 'typed on the OTHER machine')]);
  assert.equal(classifyReplacement(oldF, newF), 'diverged',
    'both sides added different messages — neither may be discarded');
  assert.equal(lostCount(oldF, newF), 1);
  rmSync(d, { recursive: true, force: true });
});

test('a shorter remote that drops messages is diverged, not fast-forward', () => {
  const d = dir();
  const oldF = write(d, 'old.jsonl', [line('a', null, '1'), line('b', 'a', '2'), line('c', 'b', '3')]);
  const newF = write(d, 'new.jsonl', [line('a', null, '1')]);
  assert.equal(classifyReplacement(oldF, newF), 'diverged',
    'a truncated replacement must never be treated as a fast-forward');
  assert.equal(lostCount(oldF, newF), 2);
  rmSync(d, { recursive: true, force: true });
});

test('reordering without loss is still a fast-forward', () => {
  const d = dir();
  const oldF = write(d, 'old.jsonl', [line('a', null, '1'), line('b', 'a', '2')]);
  const newF = write(d, 'new.jsonl', [line('b', 'a', '2'), line('a', null, '1'), line('c', 'b', '3')]);
  assert.equal(classifyReplacement(oldF, newF), 'fast-forward', 'membership matters, not order');
  rmSync(d, { recursive: true, force: true });
});

test('a truncated final line does not cause a false conflict', () => {
  const d = dir();
  const oldF = join(d, 'old.jsonl');
  writeFileSync(oldF, line('a', null, '1') + '\n' + line('b', 'a', '2') + '\n' + '{"uuid":"c","par');  // cut mid-write
  const newF = write(d, 'new.jsonl', [line('a', null, '1'), line('b', 'a', '2'), line('c', 'b', '3')]);
  assert.equal(classifyReplacement(oldF, newF), 'fast-forward');
  rmSync(d, { recursive: true, force: true });
});

test('non-JSONL files are "unknown" and therefore KEPT', () => {
  const d = dir();
  const oldF = join(d, 'a.md'); writeFileSync(oldF, '# notes');
  const newF = join(d, 'b.md'); writeFileSync(newF, '# other notes');
  assert.equal(classifyReplacement(oldF, newF), 'unknown',
    'anything we cannot reason about must be preserved, not discarded');
  rmSync(d, { recursive: true, force: true });
});

test('an empty displaced file has nothing to lose', () => {
  const d = dir();
  const oldF = join(d, 'old.jsonl'); writeFileSync(oldF, '');
  const newF = write(d, 'new.jsonl', [line('a', null, '1')]);
  assert.equal(classifyReplacement(oldF, newF), 'fast-forward');
  rmSync(d, { recursive: true, force: true });
});

test('uuid extraction ignores lines without a uuid', () => {
  const d = dir();
  const f = join(d, 'x.jsonl');
  writeFileSync(f, JSON.stringify({ type: 'meta' }) + '\n' + line('a', null, '1') + '\n');
  assert.deepEqual(transcriptUuids(f), ['a']);
  rmSync(d, { recursive: true, force: true });
});
