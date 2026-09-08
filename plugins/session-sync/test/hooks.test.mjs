/**
 * Regression test for the SessionStart/SessionEnd hook matchers.
 *
 * 'resume' is a REAL value on both events (confirmed against Claude Code's
 * hooks docs: SessionStart 'resume' = a new session starting to pick up a
 * paused one; SessionEnd 'resume' = "session paused for resume" on the OLD
 * one) — not a typo.
 *
 * IT WAS BRIEFLY REMOVED FROM SessionEnd, AND THAT WAS WRONG. The removal
 * rested on an assumption Claude Code does not actually guarantee: that a
 * resumed conversation always fires a later SessionEnd with a different
 * reason. Nothing documents that. If a conversation's ONLY SessionEnd ever
 * fires with reason='resume' — the app force-closed or crashed after a resume
 * — then excluding it means that conversation's final state never reaches the
 * remote. Losing a whole conversation is the exact failure this plugin exists
 * to prevent, and it is not a fair trade for avoiding redundant hook fires.
 *
 * So 'resume' is BACK, and the redundant fires are absorbed rather than
 * avoided: a hook-triggered push records a request and coalesces onto one
 * background worker (lib/defer.mjs), so the pull/push/pull triplet inside 0.7s
 * that motivated the removal now costs one recorded request instead of a lost
 * push. These tests pin the restored matcher so it cannot regress again.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const hooks = JSON.parse(readFileSync(join(HERE, '..', 'hooks', 'hooks.json'), 'utf8'));

function matcherValues(events) {
  return events.flatMap((e) => e.matcher.split('|'));
}

test('SessionStart still pulls on resume (a new session picking up a paused one)', () => {
  const values = matcherValues(hooks.hooks.SessionStart);
  assert.ok(values.includes('resume'), 'SessionStart must still react to resume — nothing else restores on it');
  assert.ok(values.includes('startup'), 'a fresh app launch must still auto-pull');
});

test('SessionEnd DOES push on resume — a conversation whose only SessionEnd is resume must still be backed up', () => {
  const values = matcherValues(hooks.hooks.SessionEnd);
  assert.ok(values.includes('resume'),
    'Claude Code does not guarantee a later non-resume SessionEnd for the same conversation. Excluding resume risks a conversation NEVER having its final state pushed — the redundant fires are absorbed by the coalescing deferral in lib/defer.mjs instead.');
});

test('SessionEnd still covers the reasons that ARE a real end of work', () => {
  const values = matcherValues(hooks.hooks.SessionEnd);
  for (const reason of ['logout', 'prompt_input_exit', 'other']) {
    assert.ok(values.includes(reason), `SessionEnd must still push on ${reason}`);
  }
});

test('SessionEnd still excludes clear — clearing context is not finishing work', () => {
  const values = matcherValues(hooks.hooks.SessionEnd);
  assert.ok(!values.includes('clear'), 'a /clear must not push on every single use');
});

test('every command invoked from a hook passes --from-hook, so the debounce and background hand-off actually apply', () => {
  const allHooks = [...hooks.hooks.SessionStart, ...hooks.hooks.SessionEnd]
    .flatMap((e) => e.hooks)
    .filter((h) => h.type === 'command');
  assert.ok(allHooks.length > 0, 'sanity: the fixture must actually contain hook commands');
  for (const h of allHooks) {
    assert.match(h.command, /--from-hook\b/, `hook command missing --from-hook: ${h.command}`);
  }
});
