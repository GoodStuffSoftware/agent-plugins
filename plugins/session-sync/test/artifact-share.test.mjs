/**
 * Artifact share: the PostToolUse capture, the UserPromptSubmit wake and the `artifacts` queue commands (lib/artifacts.mjs,
 * lib/artifact-hook.mjs). Temp dirs and sandbox homes only: never the real ~/.claude/session-sync or the live session store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import {
  isNewArtifact, isRepublishResponse, extractArtifact, entryFromHook, enqueue, readEntries, pendingOf, markEntry, forgetEntry, wake,
  recordBrowser, readShareState, emailOf, receiverEmail, driveableOwner, featureOn,
} from '../lib/artifacts.mjs';
import { artifactShareSettings } from '../lib/config.mjs';
import { cworld, cleanupWorlds, A, B } from './fixtures/cliworld.mjs';
import { putRecord, uuid } from './fixtures/store.mjs';

test.after(() => cleanupWorlds());

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, '..', 'lib', 'artifact-hook.mjs');
const CLI = join(HERE, '..', 'lib', 'cli.mjs');
const ID1 = 'AbCdEf123456AbCdEf1234';
const ID2 = 'ZyXwVu987654ZyXwVu9876';
const URL1 = `https://claude.ai/artifact/${ID1}`;
const tmp = () => mkdtempSync(join(tmpdir(), 'ss-art-'));
const EMAILS = { [A]: 'main@example.com', [B.slice(0, 8)]: 'overflow@example.com' };
const CFG = { artifactShare: { enabled: true, emails: EMAILS } };
const LINKED_DIR = () => { const d = tmp(); mkdirSync(join(d, 'accounts'), { recursive: true }); writeFileSync(join(d, 'accounts', 'state.json'), JSON.stringify({ linked: true })); return d; };
const entry = (id, over = {}) => ({ id, url: `https://claude.ai/artifact/${id}`, title: 't', ownerAccount: A, createdAt: new Date().toISOString(), sessionId: 's', status: 'pending', ...over });

/* ---------------------------------- capture rules ---------------------------------- */

test('N1 only a publish with no url is new: type_url creates count; updates, uploads, reads, lists and deletes do not', () => {
  assert.equal(isNewArtifact({ action: 'publish', file_path: 'a.html', title: 'x' }), true);
  assert.equal(isNewArtifact({ file_path: 'a.html' }), true, 'publish is the default action');
  assert.equal(isNewArtifact({ type_url: 'https://claude.ai/artifact/TypePage123456', title: 'x' }), true);
  assert.equal(isNewArtifact({ action: 'publish', url: URL1, file_path: 'a.html' }), false, 'a republish');
  assert.equal(isNewArtifact({ action: 'publish', url: URL1, file_path: 'a.png', asset: true }), false, 'an asset upload');
  assert.equal(isNewArtifact({ action: 'publish', url: URL1, file_paths: ['a.png'], asset: true }), false);
  for (const action of ['read', 'list', 'delete', 'open', 'quickstart']) assert.equal(isNewArtifact({ action }), false, action);
  assert.equal(isNewArtifact(null), false);
  assert.equal(isNewArtifact('x'), false);
});

test('N2 the url comes out of a string response, an object response, a JSON string and a nested object', () => {
  const input = { action: 'publish', file_path: 'a.html' };
  assert.equal(extractArtifact(input, `Published. View it at ${URL1} (private)`).id, ID1);
  assert.equal(extractArtifact(input, { url: URL1, title: 'x' }).id, ID1);
  assert.equal(extractArtifact(input, JSON.stringify({ url: URL1 })).id, ID1);
  assert.equal(extractArtifact(input, { content: [{ type: 'text', text: `done ${URL1}` }] }).id, ID1);
  assert.equal(extractArtifact(input, { url: 'https://claude.ai/code/artifact/AbCdEf123456AbCdEf1234' }).url, URL1, 'code/artifact links are normalised');
  assert.equal(extractArtifact(input, 'no link here'), null);
  assert.equal(extractArtifact(input, null), null);
  assert.equal(extractArtifact(input, { is_error: true, content: URL1 }), null, 'an error result queues nothing');
  assert.equal(extractArtifact(input, { url: URL1 }).url, URL1);
});

test('N3 a create from a type_url never records the type page as the new artifact', () => {
  const input = { type_url: 'https://claude.ai/artifact/TypePage123456', title: 'x' };
  const resp = `Instructions from https://claude.ai/artifact/TypePage123456. Your artifact: ${URL1}`;
  assert.equal(extractArtifact(input, resp).id, ID1);
  assert.equal(extractArtifact(input, 'only https://claude.ai/artifact/TypePage123456'), null);
});

test('N4 entryFromHook: fields, null owner, and nothing for other tools', () => {
  const payload = { session_id: 'sess-1', tool_name: 'Artifact', tool_input: { title: 'My page', file_path: 'a.html' }, tool_response: URL1 };
  const e = entryFromHook(payload, { ownerAccount: A, now: Date.UTC(2026, 10, 17) });
  assert.deepEqual(e, { id: ID1, url: URL1, title: 'My page', ownerAccount: A, createdAt: '2026-11-17T00:00:00.000Z', sessionId: 'sess-1', status: 'pending' });
  assert.equal(entryFromHook(payload).ownerAccount, null, 'owner unknown is stored as null');
  assert.equal(entryFromHook({ ...payload, tool_name: 'Read' }), null);
  assert.equal(entryFromHook({ ...payload, tool_input: { action: 'list' } }), null);
  assert.equal(entryFromHook({ ...payload, tool_response: { title: 'T from response', url: URL1 }, tool_input: { file_path: 'a' } }).title, 'T from response');
});

/* ------------------------------------ the queue ------------------------------------ */

test('N5 enqueue dedupes by id and leaves no temp file; in-process concurrent appends all land once', async () => {
  const dir = join(tmp(), 'q');
  assert.equal(enqueue(dir, entry(ID1)).added, true);
  assert.equal(enqueue(dir, entry(ID1, { title: 'other' })).added, false);
  assert.equal(readEntries(dir).length, 1);
  assert.equal(readEntries(dir)[0].title, 't', 'the first one is kept');
  const ids = Array.from({ length: 12 }, (_, i) => `Concurrent${String(i).padStart(2, '0')}xx`);
  const res = await Promise.all([...ids, ...ids].map(async (id) => enqueue(dir, entry(id))));
  assert.equal(res.filter((r) => r.added).length, 12);
  assert.equal(readEntries(dir).length, 13);
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
  assert.equal(enqueue(dir, entry('x')).added, false, 'a bad id is refused');
});

test('N6 two processes appending at the same time: every artifact once, no torn or temp file', async () => {
  const w = cworld();
  w.putState((s) => { s.linked = true; });
  const run = (payload) => new Promise((resolve) => {
    const p = spawn(process.execPath, [HOOK, 'capture'], { env: hookEnv(w), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
    p.stdin.end(JSON.stringify(payload));
  });
  const mk = (id) => ({ session_id: 's', tool_name: 'Artifact', tool_input: { title: id, file_path: 'a.html' }, tool_response: `https://claude.ai/artifact/${id}` });
  const ids = ['ProcessAA1111', 'ProcessBB2222', 'ProcessCC3333'];
  const results = await Promise.all([...ids, ...ids, ...ids].map((id) => run(mk(id))));
  assert.ok(results.every((r) => r.code === 0 && r.out === ''));
  const dir = join(w.stateDir, 'artifact-queue');
  assert.deepEqual(readEntries(dir).map((e) => e.id).sort(), [...ids].sort());
  assert.deepEqual(readdirSync(dir).filter((n) => !/^a-.*\.json$/.test(n)), []);
});

test('N7 mark, list, forget; finished entries leave after 30 days; a bad status or id is refused', () => {
  const dir = tmp();
  enqueue(dir, entry(ID1));
  enqueue(dir, entry(ID2));
  assert.equal(markEntry(dir, ID1, 'invited', { link: 'https://claude.ai/artifact/invite/abc' }).entry.inviteLink, 'https://claude.ai/artifact/invite/abc');
  assert.equal(markEntry(dir, ID2, 'skipped', { reason: 'public' }).entry.reason, 'public');
  assert.deepEqual(pendingOf(readEntries(dir)), []);
  assert.equal(markEntry(dir, ID1, 'done').entry.status, 'done');
  assert.equal(markEntry(dir, ID1, 'nonsense').ok, false);
  assert.equal(markEntry(dir, 'NotQueued1234', 'done').ok, false);
  const later = Date.now() + 31 * 24 * 3600 * 1000;
  markEntry(dir, ID2, 'skipped', { reason: 'public', now: later });   // touches the clock: ID1 (done, old) is pruned
  assert.deepEqual(readEntries(dir).map((e) => e.id), [ID2]);
  assert.equal(forgetEntry(dir, ID2), true);
  assert.equal(forgetEntry(dir, ID2), false);
});

test('N8 emails, the other account, and which owners a browser can act for', () => {
  assert.equal(emailOf(EMAILS, A.toUpperCase()), 'main@example.com');
  assert.equal(emailOf(EMAILS, B), 'overflow@example.com', 'a key may be a prefix of the id');
  assert.equal(emailOf(EMAILS, null), null);
  assert.equal(receiverEmail(EMAILS, A), 'overflow@example.com');
  assert.equal(receiverEmail(EMAILS, B), 'main@example.com');
  assert.equal(receiverEmail(EMAILS, null), null);
  assert.equal(receiverEmail({}, A), null);
  assert.equal(driveableOwner(A, EMAILS, { browsers: {} }), true, 'no browser recorded yet: assume it qualifies');
  const share = { browsers: { pane: { email: 'MAIN@example.com' } } };
  assert.equal(driveableOwner(A, EMAILS, share), true);
  assert.equal(driveableOwner(B, EMAILS, share), false);
  assert.equal(driveableOwner(null, EMAILS, share), true);
  assert.equal(driveableOwner('c'.repeat(8), EMAILS, share), true, 'an owner with no configured email cannot be ruled out');
  assert.equal(driveableOwner(B, EMAILS, { browsers: { pane: { email: 'main@example.com' }, chrome: { email: 'overflow@example.com' } } }), true, 'a second browser adds an account');
  const dir = tmp();
  recordBrowser(dir, 'pane', 'main@example.com');
  assert.equal(readShareState(dir).browsers.pane.email, 'main@example.com');
  assert.throws(() => recordBrowser(dir, 'pane', 'not-an-email'));
  assert.throws(() => recordBrowser(dir, '../x', 'a@b.co'));
});

test('N9 settings: on by default; emails are validated', () => {
  assert.deepEqual(artifactShareSettings({}), { enabled: true, emails: {} });
  assert.equal(artifactShareSettings({ artifactShare: { enabled: false } }).enabled, false);
  assert.deepEqual(artifactShareSettings({ artifactShare: { emails: { 'ABCDEF12': 'a@b.co', zz: 'a@b.co', abcdef12ab: 'bad' } } }).emails, { abcdef12: 'a@b.co' });
  const d = LINKED_DIR();
  assert.equal(featureOn({ artifactShare: { enabled: true } }, d), true);
  assert.equal(featureOn({ artifactShare: { enabled: false } }, d), false, 'the off switch');
  assert.equal(featureOn({ artifactShare: { enabled: true } }, tmp()), false, 'accounts not linked');
});

/* ------------------------------------- the wake ------------------------------------- */

const wakeOpts = (extra = {}) => ({ cfg: CFG, stateDir: extra.stateDir, ...extra });

test('N10 nothing queued or nothing pending: no instruction, and an old claim is cleared', async () => {
  const sd = LINKED_DIR();
  const dir = join(sd, 'q');
  assert.equal((await wake({ dir, ...wakeOpts({ stateDir: sd, active: B }) })).reason, 'no-queue');
  enqueue(dir, entry(ID1, { status: 'done' }));
  writeFileSync(join(dir, 'claim-0123456789abcdef'), '');
  const r = await wake({ dir, ...wakeOpts({ stateDir: sd, active: B }) });
  assert.deepEqual([r.act, r.reason], [false, 'nothing-pending']);
  assert.equal(existsSync(join(dir, 'claim-0123456789abcdef')), false);
});

test('N11 a switch away from the owner acts once; a second session does not; back and forth acts again', async () => {
  const sd = LINKED_DIR();
  const dir = join(sd, 'q');
  enqueue(dir, entry(ID1, { ownerAccount: A }));
  assert.deepEqual([(await wake({ dir, ...wakeOpts({ stateDir: sd, active: A }) })).act], [false], 'still on the owner account');
  const first = await wake({ dir, ...wakeOpts({ stateDir: sd, active: B }) });
  assert.equal(first.act, true);
  assert.match(first.text, /share-artifacts/);
  assert.match(first.text, /ONE background/);
  assert.ok(first.text.includes(URL1));
  assert.ok(first.text.includes('overflow@example.com'));
  assert.ok(first.text.split('\n').length <= 6, 'a few lines');
  assert.deepEqual([(await wake({ dir, ...wakeOpts({ stateDir: sd, active: B }) })).reason], ['claimed']);
  await wake({ dir, ...wakeOpts({ stateDir: sd, active: A }) });                 // back on the owner: the switch is over
  assert.equal((await wake({ dir, ...wakeOpts({ stateDir: sd, active: B }) })).act, true, 'the next switch acts again');
});

test('N12 eight sessions prompting at once: exactly one acts (the claim is an exclusive create)', async () => {
  const sd = LINKED_DIR();
  const dir = join(sd, 'q');
  enqueue(dir, entry(ID1));
  const rs = await Promise.all(Array.from({ length: 8 }, () => wake({ dir, ...wakeOpts({ stateDir: sd, active: B }) })));
  assert.equal(rs.filter((r) => r.act).length, 1);
});

test('N13 disabled, not linked, no known account: no instruction and no claim taken', async () => {
  const sd = LINKED_DIR();
  const dir = join(sd, 'q');
  enqueue(dir, entry(ID1));
  const off = await wake({ dir, cfg: { artifactShare: { enabled: false, emails: EMAILS } }, stateDir: sd, active: B });
  assert.deepEqual([off.act, off.reason], [false, 'disabled']);
  const unlinked = await wake({ dir, ...wakeOpts({ stateDir: tmp(), active: B }) });
  assert.deepEqual([unlinked.act, unlinked.reason], [false, 'disabled']);
  const unknown = await wake({ dir, ...wakeOpts({ stateDir: sd, active: null }) });
  assert.deepEqual([unknown.act, unknown.reason], [false, 'no-active-account']);
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('claim-')), []);
});

test('N14 a null owner is due whenever the app has an account; a browser that holds the other account makes an owner not due', async () => {
  const sd = LINKED_DIR();
  const dir = join(sd, 'q');
  enqueue(dir, entry(ID1, { ownerAccount: null }));
  enqueue(dir, entry(ID2, { ownerAccount: B }));
  recordBrowser(dir, 'pane', 'main@example.com');                                   // the pane holds the main account only
  const r = await wake({ dir, ...wakeOpts({ stateDir: sd, active: A }) });
  assert.equal(r.act, true);
  assert.deepEqual(r.due.map((e) => e.id), [ID1], 'ID2 belongs to an account the pane does not hold: left pending');
  const r2 = await wake({ dir, ...wakeOpts({ stateDir: sd, active: 'c'.repeat(36) }) });
  assert.deepEqual(r2.due.map((e) => e.id), [ID1], 'ID2 belongs to an account no driveable browser holds: left pending');
});

/* ----------------------------- the commands, end to end ----------------------------- */

function hookEnv(w) {
  return {
    ...process.env, USERPROFILE: w.home, HOME: w.home, APPDATA: join(w.home, 'AppData', 'Roaming'), XDG_CONFIG_HOME: join(w.home, '.config'),
    SESSION_SYNC_TEST_APP_STATE: w.appFile,
  };
}
const runHook = (w, mode, payload) => spawnSync(process.execPath, [HOOK, mode], { env: hookEnv(w), input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8', windowsHide: true, timeout: 30000 });
const runCli = (w, args) => spawnSync(process.execPath, [CLI, ...args], { env: hookEnv(w), encoding: 'utf8', windowsHide: true, timeout: 30000 });
const publish = (id, input = { title: 'T', file_path: 'a.html' }, response = `https://claude.ai/artifact/${id}`) => ({ session_id: 'sess', tool_name: 'Artifact', tool_input: input, tool_response: response });

test('N15 capture end to end: the owner is the app account at that moment; an update, a read and a string response are handled; stdout stays empty', () => {
  const w = cworld();
  w.putState((s) => { s.linked = true; });
  w.setApp({ running: true, signedIn: A });
  assert.equal(runHook(w, 'capture', publish(ID1)).stdout, '');
  runHook(w, 'capture', publish('Update1234567', { action: 'publish', url: URL1, file_path: 'a.html' }));
  runHook(w, 'capture', publish('Read12345678', { action: 'read', url: URL1 }));
  runHook(w, 'capture', publish(ID2, { type_url: 'https://claude.ai/artifact/TypePage123456', title: 'T' }, { url: `https://claude.ai/artifact/${ID2}` }));
  const q = readEntries(join(w.stateDir, 'artifact-queue'));
  assert.deepEqual(q.map((e) => e.id).sort(), [ID1, ID2].sort());
  assert.ok(q.every((e) => e.ownerAccount === A && e.status === 'pending' && e.sessionId === 'sess'));
});

test('N16 capture: owner unknown is stored as null; unlinked machine and the off switch queue nothing; garbage input is harmless', () => {
  const w = cworld();
  w.putState((s) => { s.linked = true; });
  w.setApp({ running: true });                                  // no signed-in account
  const r = runHook(w, 'capture', publish(ID1));
  assert.deepEqual([r.status, r.stdout], [0, '']);
  assert.equal(readEntries(join(w.stateDir, 'artifact-queue'))[0].ownerAccount, null);
  writeFileSync(join(w.stateDir, 'config.json'), JSON.stringify({ artifactShare: { enabled: false } }));
  runHook(w, 'capture', publish(ID2));
  assert.equal(readEntries(join(w.stateDir, 'artifact-queue')).length, 1, 'off switch');
  const w2 = cworld();                                          // accounts never linked
  runHook(w2, 'capture', publish(ID1));
  assert.equal(existsSync(join(w2.stateDir, 'artifact-queue')), false);
  for (const junk of ['', 'not json', '{"tool_name":"Artifact"}', '[]', 'null']) {
    const j = runHook(w, 'capture', junk);
    assert.deepEqual([j.status, j.stdout], [0, ''], junk);
    const k = runHook(w, 'wake', junk);
    assert.deepEqual([k.status, k.stdout], [0, ''], junk);
  }
});

test('N17 wake end to end: silent with nothing pending; one JSON instruction after a switch; silent for the next session; silent off a slash command', () => {
  const w = cworld({ config: { artifactShare: { emails: EMAILS } } });
  w.putState((s) => { s.linked = true; });
  w.setApp({ running: true, signedIn: A });
  putRecord(w.fB.path, 7, {});                                  // the session is an interactive one of the account the app is on after the switch
  const prompt = (text = 'please continue', session_id = uuid('d', 7)) => ({ session_id, prompt: text, hook_event_name: 'UserPromptSubmit' });
  assert.equal(runHook(w, 'wake', prompt()).stdout, '', 'nothing queued');
  runHook(w, 'capture', publish(ID1));
  assert.equal(runHook(w, 'wake', prompt()).stdout, '', 'still on the owner account');
  w.setApp({ running: true, signedIn: B });
  assert.equal(runHook(w, 'wake', prompt('/clear')).stdout, '', 'a slash command is not a real prompt');
  assert.equal(runHook(w, 'wake', prompt('go', uuid('d', 99))).stdout, '', 'a session the app has no record of (a terminal or headless run) does not act and does not use the claim');
  assert.equal(runHook(w, 'wake', { prompt: 'go' }).stdout, '', 'no session id');
  assert.deepEqual(readdirSync(join(w.stateDir, 'artifact-queue')).filter((n) => n.startsWith('claim-')), []);
  const first = runHook(w, 'wake', prompt());
  assert.equal(first.status, 0, first.stderr);
  const out = JSON.parse(first.stdout);
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(out.hookSpecificOutput.additionalContext, /share-artifacts/);
  assert.equal(runHook(w, 'wake', prompt()).stdout, '', 'one session per switch');
});

test('N18 the commands: pending --json, pane, mark with link and reason, list, forget', () => {
  const w = cworld({ config: { artifactShare: { emails: EMAILS } } });
  w.putState((s) => { s.linked = true; });
  w.setApp({ running: true, signedIn: B });
  const dir = join(w.stateDir, 'artifact-queue');
  enqueue(dir, entry(ID1, { ownerAccount: A }));
  enqueue(dir, entry(ID2, { ownerAccount: A }));
  const p = JSON.parse(runCli(w, ['artifacts', 'pending', '--json']).stdout);
  assert.equal(p.ok, true);
  assert.equal(p.activeAccount, B);
  assert.equal(p.activeEmail, 'overflow@example.com');
  assert.equal(p.entries.length, 2);
  assert.equal(p.entries[0].ownerEmail, 'main@example.com');
  assert.equal(p.entries[0].receiverEmail, 'overflow@example.com');
  assert.equal(runCli(w, ['artifacts', 'pane', 'main@example.com']).status, 0);
  assert.equal(JSON.parse(runCli(w, ['artifacts', 'list', '--json']).stdout).browsers.pane.email, 'main@example.com');
  const m = runCli(w, ['artifacts', 'mark', URL1, 'invited', '--link', 'https://claude.ai/artifact/invite/inv123']);
  assert.equal(m.status, 0, m.stderr);
  assert.equal(runCli(w, ['artifacts', 'mark', ID2, 'skipped', '--reason', 'public']).status, 0);
  const l = JSON.parse(runCli(w, ['artifacts', 'list', '--json']).stdout).entries;
  assert.deepEqual(l.map((e) => [e.status, e.reason ?? null, e.inviteLink ?? null]), [['invited', null, 'https://claude.ai/artifact/invite/inv123'], ['skipped', 'public', null]]);
  assert.equal(JSON.parse(runCli(w, ['artifacts', 'pending', '--json']).stdout).entries.length, 0);
  assert.match(runCli(w, ['artifacts', 'pending']).stdout, /nothing pending/);
  assert.equal(runCli(w, ['artifacts', 'mark', ID1, 'bogus']).status, 2);
  assert.equal(runCli(w, ['artifacts', 'mark', 'NotQueued1234', 'done']).status, 1);
  assert.equal(runCli(w, ['artifacts', 'forget', ID1]).status, 0);
  assert.equal(runCli(w, ['artifacts', 'forget', ID1]).status, 1);
});

test('N19 config keys: artifactShare.enabled and artifactShare.email are saved and merged', () => {
  const w = cworld();
  assert.equal(runCli(w, ['config', 'artifactShare.email', A, 'main@example.com']).status, 0);
  assert.equal(runCli(w, ['config', 'artifactShare.email', B.slice(0, 8), 'overflow@example.com']).status, 0);
  assert.equal(runCli(w, ['config', 'artifactShare.enabled', 'false']).status, 0);
  const cfg = JSON.parse(readFileSync(join(w.stateDir, 'config.json'), 'utf8'));
  assert.deepEqual(cfg.artifactShare, { enabled: false, emails: { [A]: 'main@example.com', [B.slice(0, 8)]: 'overflow@example.com' } });
  assert.equal(runCli(w, ['config', 'artifactShare.email', 'zz', 'x']).status, 2);
  assert.deepEqual(JSON.parse(runCli(w, ['config']).stdout).artifactShare.enabled, false);
});

test('N20 the hooks file registers capture on PostToolUse (matcher Artifact) and wake on UserPromptSubmit, both short', () => {
  const hooks = JSON.parse(readFileSync(join(HERE, '..', 'hooks', 'hooks.json'), 'utf8')).hooks;
  const post = hooks.PostToolUse;
  assert.equal(post.length, 1);
  assert.equal(post[0].matcher, 'Artifact');
  assert.deepEqual(post[0].hooks[0].args.slice(1), ['capture']);
  assert.match(post[0].hooks[0].args[0], /artifact-hook\.mjs$/);
  const w = hooks.UserPromptSubmit.flatMap((g) => g.hooks).find((h) => h.args.includes('wake') && /artifact-hook/.test(h.args[0]));
  assert.ok(w);
  assert.ok(w.timeout <= 10 && post[0].hooks[0].timeout <= 10);
});

/* ------------------------- review round: republishes, claim, ids ------------------------- */

const PUB = (id, v) => `Published C:\\Users\\x\\page.html at https://claude.ai/artifact/${id} (Version ${v}, version id 7c1f)`;
const TYPED = (id) => `Created a new Artifact at https://claude.ai/artifact/${id} (version 3f2a) from the Artifact type https://claude.ai/artifact/TypePage123456 (release 9)`;

test('N21 a republish without a url is not new: only "(Version 1" (or a type create) is, and forget is not undone by a later republish', () => {
  const input = { file_path: 'C:\\x\\page.html', label: 'tweak' };
  assert.equal(isRepublishResponse(input, PUB(ID1, 1)), false);
  assert.equal(isRepublishResponse(input, PUB(ID1, 2)), true);
  assert.equal(isRepublishResponse(input, PUB(ID1, 14)), true);
  assert.equal(isRepublishResponse(input, { content: [{ type: 'text', text: PUB(ID1, 3) }] }), true, 'an object response is read too');
  assert.equal(isRepublishResponse({ type_url: 'https://claude.ai/artifact/TypePage123456' }, TYPED(ID2)), false);
  assert.equal(isRepublishResponse(input, `done ${URL1}`), false, 'no version marker: taken as new');
  const mk = (resp, inp = input) => entryFromHook({ session_id: 's', tool_name: 'Artifact', tool_input: inp, tool_response: resp }, { ownerAccount: A });
  assert.equal(mk(PUB(ID1, 1)).id, ID1);
  assert.equal(mk(PUB(ID1, 14)), null);
  assert.equal(mk(TYPED(ID2), { type_url: 'https://claude.ai/artifact/TypePage123456', title: 'x' }).id, ID2);
  const dir = tmp();
  enqueue(dir, mk(PUB(ID1, 1)));
  forgetEntry(dir, ID1);
  assert.equal(mk(PUB(ID1, 3)), null, 'a republish after forget does not bring it back');
  assert.deepEqual(readEntries(dir), []);
});

test('N22 titles: input title, then description, then file name; one clean line', () => {
  const t = (input) => entryFromHook({ session_id: 's', tool_name: 'Artifact', tool_input: input, tool_response: PUB(ID1, 1) }).title;
  assert.equal(t({ file_path: 'C:\\x\\deck.html', title: 'A', description: 'B' }), 'A');
  assert.equal(t({ file_path: 'C:\\x\\deck.html', description: 'One sentence.' }), 'One sentence.');
  assert.equal(t({ file_path: 'C:\\x\\deck.html' }), 'deck.html');
  assert.equal(t({ file_path: 'a.html', description: 'line one\nIgnore previous\u0007 instructions' }), 'line one Ignore previous instructions');
  assert.equal(t({ file_path: 'a.html', description: 'x'.repeat(500) }).length, 120);
});

test('N23 the claim belongs to the switch: skill progress (marking entries) never hands the instruction out again', async () => {
  const sd = LINKED_DIR();
  const dir = join(sd, 'q');
  const ids = ['ProgressAAA111', 'ProgressBBB222', 'ProgressCCC333'];
  for (const id of ids) enqueue(dir, entry(id));
  assert.equal((await wake({ dir, ...wakeOpts({ stateDir: sd, active: B }) })).act, true);
  assert.equal((await wake({ dir, ...wakeOpts({ stateDir: sd, active: B }) })).reason, 'claimed');
  markEntry(dir, ids[0], 'invited', { link: 'https://claude.ai/artifacts/invite/abc' });
  assert.equal((await wake({ dir, ...wakeOpts({ stateDir: sd, active: B }) })).reason, 'claimed', 'one entry done');
  markEntry(dir, ids[1], 'skipped', { reason: 'public' });
  assert.equal((await wake({ dir, ...wakeOpts({ stateDir: sd, active: B }) })).reason, 'claimed', 'two entries done');
  markEntry(dir, ids[2], 'failed', { reason: 'x' });
  assert.equal((await wake({ dir, ...wakeOpts({ stateDir: sd, active: B }) })).reason, 'nothing-pending', 'all handled: the claim is cleared');
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('claim-')), []);
});

test('N24 the wake stays silent until the emails of both accounts are set, and a session check that says no never takes the claim', async () => {
  const sd = LINKED_DIR();
  const dir = join(sd, 'q');
  enqueue(dir, entry(ID1));
  const none = await wake({ dir, cfg: { artifactShare: { enabled: true, emails: {} } }, stateDir: sd, active: B });
  assert.deepEqual([none.act, none.reason], [false, 'no-emails']);
  const one = await wake({ dir, cfg: { artifactShare: { enabled: true, emails: { [A]: 'main@example.com' } } }, stateDir: sd, active: B });
  assert.equal(one.reason, 'no-emails');
  const no = await wake({ dir, ...wakeOpts({ stateDir: sd, active: B, sessionCheck: async () => false }) });
  assert.deepEqual([no.act, no.reason], [false, 'not-interactive']);
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('claim-')), []);
  const yes = await wake({ dir, ...wakeOpts({ stateDir: sd, active: B, sessionCheck: async (a) => a === B }) });
  assert.equal(yes.act, true);
});

test('N25 eight real hook processes prompting at once after a switch: exactly one prints the instruction', async () => {
  const w = cworld({ config: { artifactShare: { emails: EMAILS } } });
  w.putState((s) => { s.linked = true; });
  w.setApp({ running: true, signedIn: A });
  putRecord(w.fB.path, 7, {});
  runHook(w, 'capture', publish(ID1));
  w.setApp({ running: true, signedIn: B });
  const one = () => new Promise((resolve) => {
    const p = spawn(process.execPath, [HOOK, 'wake'], { env: hookEnv(w), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
    p.stdin.end(JSON.stringify({ session_id: uuid('d', 7), prompt: 'go' }));
  });
  const rs = await Promise.all(Array.from({ length: 8 }, one));
  assert.ok(rs.every((r) => r.code === 0));
  assert.equal(rs.filter((r) => r.out.trim()).length, 1);
});

test('N26 an id that is not an artifact id never reaches the file system: forget and mark refuse it', () => {
  const w = cworld();
  const keep = join(w.stateDir, 'config.json');
  const before = readFileSync(keep, 'utf8');
  for (const bad of ['x/../../config', '..\\config', '../config', 'a b']) {
    assert.equal(runCli(w, ['artifacts', 'forget', bad]).status, 1, bad);
    assert.equal(runCli(w, ['artifacts', 'mark', bad, 'done']).status, 1, bad);
  }
  assert.equal(readFileSync(keep, 'utf8'), before);
  const dir = tmp();
  assert.equal(forgetEntry(dir, '../x'), false);
  assert.equal(markEntry(dir, '../x', 'done').ok, false);
});
