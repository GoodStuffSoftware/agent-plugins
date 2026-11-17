/**
 * T20 and the `accounts` command tests - the real cli.mjs run as a child process
 * (it runs top-level code on import) against a synthetic store in a per-test home.
 *
 * Nothing here touches the live store or ~/.claude/session-sync: HOME, USERPROFILE,
 * APPDATA and XDG_CONFIG_HOME all point at a temp home, the app state comes from the
 * SESSION_SYNC_TEST_APP_STATE seam, and notifications are off in the sandbox config.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from '../lib/accounts/state.mjs';
import { pairKey } from '../lib/accounts/folders.mjs';
import { recordName, nlinkOf } from './fixtures/store.mjs';
import { cworld, cleanupWorlds, waitFor, CLI, A, B } from './fixtures/cliworld.mjs';

test.after(() => cleanupWorlds());

const askedPair = pairKey(A, B);
const daysAgo = (n) => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();

/* ------------------------------------------------------------------ T20: the SessionStart step */

test('T20 ask: one JSON object on stdout, once, with the ask text and the answer command', () => {
  const w = cworld();
  const r = w.run(['auto-pull', '--from-hook']);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trim();
  const obj = JSON.parse(out);                       // exactly one JSON value, nothing else
  assert.deepEqual(Object.keys(obj), ['hookSpecificOutput']);
  assert.equal(obj.hookSpecificOutput.hookEventName, 'SessionStart');
  const text = obj.hookSpecificOutput.additionalContext;
  assert.match(text, /2 claude\.ai accounts/);
  assert.match(text, /\/session-sync:accounts/);
  assert.match(text, /accounts answer yes/);
  assert.match(text, /unattended/);
  assert.ok(text.includes(CLI.replace(/\\/g, '\\')) || text.includes('cli.mjs'));
  assert.doesNotMatch(text, new RegExp(A), 'the full account uuid is never in the ask');
  const s = w.state();
  assert.equal(s.pairs[askedPair].askCount, 1);
  assert.ok(s.pairs[askedPair].askedAt);
  assert.equal(s.pairs[askedPair].answer, undefined, 'asking is not an answer');

  const again = w.run(['auto-pull', '--from-hook']);
  assert.equal(again.stdout, '', 'the second session the same day is silent');
});

test('T20 ask limits: not again within 7 days, again after 7 days, never after 3 asks', () => {
  const w = cworld();
  w.putState((s) => { s.pairs[askedPair] = { askedAt: daysAgo(2), askCount: 1 }; });
  assert.equal(w.run(['auto-pull', '--from-hook']).stdout, '', 'asked 2 days ago');
  w.putState((s) => { s.pairs[askedPair] = { askedAt: daysAgo(8), askCount: 1 }; });
  assert.ok(JSON.parse(w.run(['auto-pull', '--from-hook']).stdout).hookSpecificOutput, 'asked 8 days ago');
  assert.equal(w.state().pairs[askedPair].askCount, 2);
  w.putState((s) => { s.pairs[askedPair] = { askedAt: daysAgo(30), askCount: 3 }; });
  assert.equal(w.run(['auto-pull', '--from-hook']).stdout, '', 'three asks are the limit');
});

test('T20 ask: two sessions starting together ask once (claim file)', () => {
  const w = cworld();
  const a = w.run(['auto-pull', '--from-hook']);
  // simulate a racing second session by rewinding askedAt but keeping today's claim file
  w.putState((s) => { s.pairs[askedPair] = { askedAt: daysAgo(30), askCount: 1 }; });
  const b = w.run(['auto-pull', '--from-hook']);
  assert.ok(a.stdout.trim());
  assert.equal(b.stdout, '', 'the claim for this pair and day is already taken');
});

test('T20 one account, or accountLink off: silent, no state written', () => {
  const one = cworld({ accounts: 1 });
  const r1 = one.run(['auto-pull', '--from-hook']);
  assert.equal(r1.status, 0);
  assert.equal(r1.stdout, '');
  assert.equal(existsSync(join(one.acc, 'state.json')), false);

  const off = cworld({ config: { accountLink: 'off' } });
  const r2 = off.run(['auto-pull', '--from-hook']);
  assert.equal(r2.stdout, '');
  assert.equal(existsSync(join(off.acc, 'state.json')), false);

  const env = cworld();
  const r3 = env.run(['auto-pull', '--from-hook'], { CLAUDE_PLUGIN_OPTION_ACCOUNTLINK: 'off' });
  assert.equal(r3.stdout, '', 'the env option overrides the file');
});

test('T20 auto: answers yes via auto and links in the background with no output', () => {
  const w = cworld({ config: { accountLink: 'auto' } });
  const r = w.run(['auto-pull', '--from-hook']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(waitFor(() => w.state()?.linked === true), true, 'the detached link finished');
  const s = w.state();
  assert.equal(s.pairs[askedPair].answer, 'yes');
  assert.equal(s.pairs[askedPair].via, 'auto');
  const names = readdirSync(w.fA.path).filter((n) => /^local_/.test(n));
  assert.equal(names.length, 4, 'every record is now under both accounts');
  assert.equal(nlinkOf(join(w.fA.path, recordName(1))), 2);
  // a later session on a linked store prints nothing
  assert.equal(w.run(['auto-pull', '--from-hook']).stdout, '');
});

test('T20 auto with the app running: arms the waiter, the link runs after the app exits', () => {
  const w = cworld({ config: { accountLink: 'auto' } });
  w.setApp({ running: true, signedIn: A, startedAtMs: 1 });
  const r = w.run(['auto-pull', '--from-hook']);
  assert.equal(r.stdout, '');
  assert.equal(waitFor(() => existsSync(join(w.acc, 'waiter.json'))), true, 'a waiter is armed');
  assert.equal(w.state()?.linked ?? false, false, 'nothing is linked while the app runs');
  w.setApp({ running: false });
  assert.equal(waitFor(() => w.state()?.linked === true), true, 'the waiter linked after the app exited');
  assert.equal(waitFor(() => readJson(join(w.acc, 'last-pass.json'))?.ok === true), true, 'and said so');
  // the waiter stays on as the account-switch watcher, with no reason left but "watch"
  assert.equal(waitFor(() => (readJson(join(w.acc, 'waiter.json'))?.reasons ?? []).join() === 'watch'), true, 'it keeps watching');
  assert.equal(existsSync(join(w.acc, 'waiter.claim')), true);
});

/* ------------------------------------------------------------------ accounts commands */

test('accounts status --json: facts, no uuids beyond 8 characters, no record content', () => {
  const w = cworld();
  const r = w.run(['accounts', 'status', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.accounts.length, 2);
  assert.equal(j.linked, false);
  assert.equal(j.pending, 1);
  assert.doesNotMatch(r.stdout, new RegExp(A));
  assert.doesNotMatch(r.stdout, /Synthetic|A 1|B 3/);
  const human = w.run(['accounts', 'status']);
  assert.equal(human.status, 0);
  assert.match(human.stdout, /Accounts: /);
  assert.match(human.stdout, /1 pending/);
});

test('accounts answer yes links now when the app is stopped; --json carries the pass facts', () => {
  const w = cworld();
  const r = w.run(['accounts', 'answer', 'yes', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true);
  assert.equal(j.kind, 'link');
  assert.equal(j.linked, 4);
  assert.ok(j.backupId);
  assert.equal(w.state().linked, true);
  const names = readdirSync(w.fB.path).filter((n) => /^local_/.test(n));
  assert.equal(names.length, 4);
});

test('accounts answer no records the answer and links nothing', () => {
  const w = cworld();
  const r = w.run(['accounts', 'answer', 'no']);
  assert.equal(r.status, 0);
  assert.equal(w.state().pairs[askedPair].answer, 'no');
  assert.equal(w.state().linked, false);
  assert.equal(w.run(['auto-pull', '--from-hook']).stdout, '', 'a no is never asked again');
  assert.equal(w.run(['accounts', 'answer', 'maybe']).status, 2);
});

test('S7 answer yes links again after an unlink or a rollback; the hook never re-asks a "no"', () => {
  const w = cworld();
  assert.equal(w.run(['accounts', 'answer', 'yes']).status, 0);
  const firstBackup = w.state().backupId;
  assert.equal(w.state().linked, true);

  // unlink: the pair is "no"; the hook stays silent (no ask, no link)
  assert.equal(w.run(['accounts', 'unlink']).status, 0);
  assert.equal(w.state().pairs[askedPair].answer, 'no');
  assert.equal(w.state().pairs[askedPair].via, 'unlink');
  assert.equal(w.run(['auto-pull', '--from-hook']).stdout, '', 'a "no" is never asked again');
  assert.equal(w.state().linked, false);
  assert.equal(nlinkOf(join(w.fA.path, recordName(1))), 1);
  // an explicit yes re-answers the pair and links again with a fresh backup
  const again = w.run(['accounts', 'answer', 'yes', '--json']);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(JSON.parse(again.stdout).answered, 1);
  assert.equal(w.state().pairs[askedPair].answer, 'yes');
  assert.equal(w.state().pairs[askedPair].via, 'cli');
  assert.equal(w.state().linked, true);
  assert.notEqual(w.state().backupId, firstBackup, 'the new link has its own pre-link backup');
  assert.equal(w.state().backups.length, 2, 'the old backup is kept in the list');
  assert.equal(nlinkOf(join(w.fA.path, recordName(1))), 2);
  assert.equal(readdirSync(w.fB.path).filter((n) => /^local_/.test(n)).length, 4, 'every name linked again');

  // rollback: the pair is "no" again, and yes links once more
  const rb = w.run(['accounts', 'rollback']);
  assert.equal(rb.status, 0, rb.stdout + rb.stderr);
  assert.equal(w.state().pairs[askedPair].via, 'rollback');
  assert.equal(w.run(['auto-pull', '--from-hook']).stdout, '');
  assert.equal(w.state().linked, false);
  assert.equal(w.run(['accounts', 'answer', 'yes']).status, 0);
  assert.equal(w.state().linked, true);
  assert.equal(nlinkOf(join(w.fA.path, recordName(1))), 2);
  // a yes with nothing left to answer is a no-op; a no never touches a pair that is already yes
  const noop = w.run(['accounts', 'answer', 'yes', '--json']);
  assert.equal(JSON.parse(noop.stdout).answered, 0);
  assert.equal(w.run(['accounts', 'answer', 'no']).status, 0);
  assert.equal(w.state().pairs[askedPair].answer, 'yes');
});

test('accounts link --now refuses while the app runs (exit 3); without --now it arms the waiter', () => {
  const w = cworld();
  w.putState((s) => { s.pairs[askedPair] = { answer: 'yes', via: 'cli', at: daysAgo(1) }; });
  w.setApp({ running: true, signedIn: A, startedAtMs: 1 });
  const refused = w.run(['accounts', 'link', '--now']);
  assert.equal(refused.status, 3);
  assert.match(refused.stdout + refused.stderr, /Quit Claude from the tray icon/);
  assert.equal(existsSync(join(w.acc, 'waiter.json')), false);
  const armed = w.run(['accounts', 'link']);
  assert.equal(armed.status, 0, armed.stderr);
  assert.match(armed.stdout, /Restart Claude to sync your accounts: quit Claude from the tray icon or app menu/);
  w.setApp({ running: false });
  assert.equal(waitFor(() => w.state()?.linked === true), true);
});

test('accounts unlink: refused while the app runs, --when-app-exits arms the waiter, rollback is offered after', () => {
  const w = cworld();
  assert.equal(w.run(['accounts', 'answer', 'yes']).status, 0);
  assert.equal(w.state().linked, true);
  w.setApp({ running: true, signedIn: A, startedAtMs: 1 });
  const refused = w.run(['accounts', 'unlink']);
  assert.equal(refused.status, 3);
  const armed = w.run(['accounts', 'unlink', '--when-app-exits']);
  assert.equal(armed.status, 0, armed.stderr);
  assert.equal(w.state().linked, true, 'still linked while the app runs');
  w.setApp({ running: false });
  assert.equal(waitFor(() => w.state()?.linked === false), true, 'unlinked once the app exited');
  assert.equal(nlinkOf(join(w.fA.path, recordName(1))), 1);
  assert.equal(waitFor(() => !existsSync(join(w.acc, 'waiter.claim'))), true);
});

test('accounts rectify: a manual run reports the pass and the remote check; not linked is exit 3', () => {
  const w = cworld();
  assert.equal(w.run(['accounts', 'rectify']).status, 3);
  assert.equal(w.run(['accounts', 'answer', 'yes']).status, 0);
  const r = w.run(['accounts', 'rectify', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true);
  assert.ok('remoteCheck' in j);
});

test('accounts rollback: no backup is exit 3; --dry-run after a link changes nothing', () => {
  const w = cworld();
  assert.equal(w.run(['accounts', 'rollback']).status, 3);
  assert.equal(w.run(['accounts', 'answer', 'yes']).status, 0);
  const dry = w.run(['accounts', 'rollback', '--dry-run']);
  assert.equal(dry.status, 0, dry.stdout + dry.stderr);
  assert.equal(w.state().linked, true);
  assert.equal(nlinkOf(join(w.fA.path, recordName(1))), 2);
});

test('hook runs never fail the session: a refused or failed accounts command exits 0 and prints nothing', () => {
  const w = cworld();
  const notLinked = w.run(['accounts', 'rectify', '--from-hook']);    // refused: not linked
  assert.equal(notLinked.status, 0);
  assert.equal(notLinked.stdout, '');
  const noGroup = w.run(['accounts', 'link', '--from-hook']);         // refused: no pair answered yes
  assert.equal(noGroup.status, 0);
  assert.equal(noGroup.stdout, '');
  mkdirSync(join(w.acc, 'state.json'), { recursive: true });          // a directory where the state file belongs: saving fails
  const broken = w.run(['accounts', 'answer', 'yes']);
  assert.notEqual(broken.status, 0, 'a manual run reports the failure');
  const hookBroken = w.run(['accounts', 'rectify', '--from-hook']);
  assert.equal(hookBroken.status, 0);
  assert.equal(hookBroken.stdout, '');
});

test('config accountLink: validated, saved, and shown by `config`', () => {
  const w = cworld();
  assert.equal(w.run(['config', 'accountLink', 'bogus']).status, 2);
  const ok = w.run(['config', 'accountLink', 'auto']);
  assert.equal(ok.status, 0);
  assert.equal(JSON.parse(ok.stdout).accountLink, 'auto');
  assert.equal(JSON.parse(w.run(['config']).stdout).accountLink, 'auto');
  assert.equal(JSON.parse(readFileSync(join(w.stateDir, 'config.json'), 'utf8')).accountLink, 'auto');
});

test('config progressIcon: on by default, saved as false and shown by `config`', () => {
  const w = cworld();
  assert.equal(JSON.parse(w.run(['config']).stdout).progressIcon, true);
  const off = w.run(['config', 'progressIcon', 'false']);
  assert.equal(off.status, 0, off.stderr);
  assert.equal(JSON.parse(off.stdout).progressIcon, false);
  assert.equal(JSON.parse(w.run(['config']).stdout).progressIcon, false);
  assert.equal(JSON.parse(readFileSync(join(w.stateDir, 'config.json'), 'utf8')).progressIcon, false);
  assert.equal(JSON.parse(w.run(['config', 'progressIcon', 'true']).stdout).progressIcon, true);
});
