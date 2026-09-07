/**
 * Regression test for the SessionStart/SessionEnd hook matchers.
 *
 * 'resume' is a REAL value on both events (confirmed against Claude Code's
 * hooks docs: SessionStart 'resume' = a new session starting to pick up a
 * paused one; SessionEnd 'resume' = "session paused for resume" on the OLD
 * one) — not a typo. But matching it on BOTH meant resuming a conversation
 * fired an auto-pull AND a push within the same fraction of a second, every
 * time: live sync.log showed a pull/push/pull triplet inside 0.7s, and 91
 * "skipped" (lock-contention) log lines against only 18 "push ok" across the
 * whole history. The old session isn't actually finishing when it pauses for
 * resume — the same transcript is immediately picked back up by the resumed
 * session, which fires its own genuine SessionEnd later — so pushing on
 * SessionEnd(resume) bought nothing but a guaranteed collision.
 *
 * This test pins the fix (resume removed from SessionEnd only) so it can't
 * silently regress back to double-firing.
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

test('SessionEnd no longer pushes on resume — that session is pausing, not finishing', () => {
  const values = matcherValues(hooks.hooks.SessionEnd);
  assert.ok(!values.includes('resume'),
    'resume on SessionEnd fires in the same instant as SessionStart(resume) on the new session — a guaranteed lock collision for a session that has not actually ended');
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
