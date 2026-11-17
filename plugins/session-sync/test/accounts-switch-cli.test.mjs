/**
 * T22 W8, W9 and S7 through the real cli.mjs (child processes, a sandbox home): what a session start and `accounts status` say
 * once the accounts are linked and the user switches accounts in the desktop app. The only notice the switch path may create is the
 * one-time "Restart Claude to sync your accounts" for an account that was never linked.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from '../lib/accounts/state.mjs';
import { addFolder, putRecord, uuid, makeClock } from './fixtures/store.mjs';
import { cworld, cleanupWorlds, waitFor, A, B } from './fixtures/cliworld.mjs';

test.after(() => cleanupWorlds());

const C = uuid('c', 1); const OC = uuid('3', 3);
const RESTART = /Restart Claude to sync your accounts/;

/** A linked pair (A, B) with the app stopped, then a third account C that was never linked. */
function linkedWorld(config) {
  const w = cworld({ config });
  if (config?.accountLink === 'auto') {
    assert.equal(w.run(['auto-pull', '--from-hook']).stdout, '');
  } else {
    assert.equal(w.run(['accounts', 'answer', 'yes']).status, 0);
  }
  assert.equal(waitFor(() => w.state()?.linked === true), true, 'the pair is linked');
  const fC = addFolder(w.store, C, OC);
  putRecord(fC.path, 30, { title: 'C 30' }, makeClock().tick());
  return { ...w, fC, w };
}
const hookText = (r) => (r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '');
const markers = (w) => readdirSync(w.acc).filter((n) => n.startsWith('restart-notice-'));

test('W8 a never-linked account joins (auto): exactly one restart notice over three session starts and two switches, never an ask', () => {
  const x = linkedWorld({ accountLink: 'auto' });
  const w = x.w;
  w.setApp({ running: true, signedIn: A, startedAtMs: 1 });
  const first = w.run(['auto-pull', '--from-hook']);
  assert.equal(first.status, 0, first.stderr);
  assert.match(hookText(first), RESTART);
  assert.doesNotMatch(hookText(first), /accounts answer yes/, 'no ask: the pair is answered by auto');
  assert.deepEqual(markers(w).length, 1);
  w.setApp({ running: true, signedIn: C, startedAtMs: 1 });
  assert.equal(w.run(['auto-pull', '--from-hook']).stdout, '', 'the second session start is silent');
  w.setApp({ running: true, signedIn: A, startedAtMs: 1 });
  assert.equal(w.run(['auto-pull', '--from-hook']).stdout, '', 'and the third, after switching back');
  assert.equal(markers(w).length, 1);
  const pairs = Object.values(w.state().pairs);
  assert.equal(pairs.length, 3);
  assert.ok(pairs.every((p) => p.answer === 'yes' && p.via === 'auto'), 'every pair, the two new ones too, was answered by auto');
  // the watcher is the single waiter, with the reason "watch"
  assert.equal(waitFor(() => (readJson(join(w.acc, 'waiter.json'))?.reasons ?? []).includes('watch')), true);
});

test('W9 a never-linked account joins (ask): the ask is the prompt; the restart notice comes once, after the answer', () => {
  const x = linkedWorld({});
  const w = x.w;
  w.setApp({ running: true, signedIn: A, startedAtMs: 1 });
  const asked = w.run(['auto-pull', '--from-hook']);
  assert.match(hookText(asked), /accounts answer yes/);
  assert.match(hookText(asked), /Only after a yes, tell them: Restart Claude/, 'the restart is named only as what follows a yes');
  assert.equal(markers(w).length, 0, 'no restart notice before the answer');
  const ans = w.run(['accounts', 'answer', 'yes']);
  assert.equal(ans.status, 0, ans.stderr);
  assert.match(ans.stdout, RESTART);
  assert.equal(markers(w).length, 1);
  const later = w.run(['auto-pull', '--from-hook']);
  assert.doesNotMatch(hookText(later), RESTART, 'told once');
});

test('S7 once linked, nothing asks for a restart or a quit: not a session start, not `accounts status`, not `accounts link`', () => {
  const w = cworld({ config: { accountLink: 'auto' } });
  assert.equal(w.run(['auto-pull', '--from-hook']).stdout, '');
  assert.equal(waitFor(() => w.state()?.linked === true), true);
  w.setApp({ running: true, signedIn: A, startedAtMs: 1 });
  assert.equal(w.run(['auto-pull', '--from-hook']).stdout, '', 'a session start on a linked store with Claude running prints nothing');
  assert.equal(waitFor(() => existsSync(join(w.acc, 'waiter.claim'))), true, 'the watcher is up');
  const status = w.run(['accounts', 'status']);
  assert.equal(status.status, 0, status.stderr);
  assert.doesNotMatch(status.stdout, RESTART);
  assert.match(status.stdout.split('\n')[0], /^Accounts: /);
  const link = w.run(['accounts', 'link']);
  assert.doesNotMatch(link.stdout, RESTART);
  assert.doesNotMatch(link.stdout, /quit Claude/i);
  const st = w.run(['accounts', 'status', '--json']);
  assert.equal(JSON.parse(st.stdout).linked, true);
});
