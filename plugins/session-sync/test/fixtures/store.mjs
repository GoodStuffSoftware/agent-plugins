/**
 * fixtures/store.mjs - synthetic desktop-app store for the account-link tests.
 *
 * Everything here is invented: fake uuids, made-up titles and paths. Record
 * shapes follow the field list of the real record (plan section 2 and the
 * field notes), but no id, path or title comes from a real machine.
 */

import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readdirSync, readFileSync, lstatSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

/** Deterministic valid uuid: uuid('a', 3) -> aaaaaaaa-0000-4000-8000-000000000003 */
export function uuid(c, n) {
  return `${String(c).repeat(8)}-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** Virtual clock (ms). File mtimes are set from it, so ordering never depends on real time. */
export function makeClock(start = 1_800_000_000_000) {
  const c = { t: start, tick(ms = 1000) { c.t += ms; return c.t; } };
  return c;
}

/** A temp tree: <root>/Claude (userData), <root>/Claude/claude-code-sessions (store), <root>/acc. */
export function makeRoot(label = 'acct') {
  const root = mkdtempSync(join(tmpdir(), `ss-${label}-`));
  const userData = join(root, 'Claude');
  const store = join(userData, 'claude-code-sessions');
  const acc = join(root, 'acc');
  mkdirSync(store, { recursive: true });
  mkdirSync(acc, { recursive: true });
  let t = 1_800_000_500_000;
  const ctx = { store, userData, acc, now: () => t, platform: process.platform, setNow: (v) => { t = v; } };
  return { root, userData, store, acc, ctx };
}

export function setMtime(path, ms) {
  utimesSync(path, ms / 1000, ms / 1000);
}

/** Create a folder `<store>/<acct>/<org>` and return the folder object the engine uses. */
export function addFolder(store, acct, org) {
  const path = join(store, acct, org);
  mkdirSync(path, { recursive: true });
  return { acct, org, key: `${acct}/${org}`, path };
}

/** A synthetic Code-tab record (shape of the real one; invented content). */
export function recordJson(n, over = {}) {
  const id = `local_${uuid('c', n)}`;
  return {
    sessionId: id,
    cliSessionId: uuid('d', n),
    cwd: `C:\\synthetic\\project-${n}`,
    title: `Synthetic conversation ${n}`,
    model: 'claude-synthetic-1',
    createdAt: '2026-10-01T10:00:00.000Z',
    lastActivityAt: '2026-10-01T10:00:00.000Z',
    isArchived: false,
    permissionMode: 'default',
    bridgeSessionIds: [],
    remoteControlAutoEligible: true,
    enabledMcpTools: [`${uuid('e', 1)}:search`],
    remoteMcpServersConfig: [{ uuid: uuid('e', 1), name: 'Synthetic Connector', url: 'https://connector.example.test/mcp', tools: ['search'], instructions: 'n/a' }],
    publishedArtifacts: [],
    servedConnectorCalls: [],
    messages: [{ role: 'user', text: `hello ${n}` }, { role: 'assistant', text: `hi ${n}` }],
    ...over,
  };
}

export const recordId = (n) => `local_${uuid('c', n)}`;
export const recordName = (n) => `${recordId(n)}.json`;

/** Write a record file (a plain write; the simulator does the atomic kind). */
export function putRecord(folderPath, n, over = {}, mtimeMs) {
  const p = join(folderPath, recordName(n));
  writeFileSync(p, JSON.stringify(recordJson(n, over)));
  if (mtimeMs !== undefined) setMtime(p, mtimeMs);
  return p;
}

export function putTombstone(folderPath, key, ms) {
  const p = join(folderPath, `deleted_${key}`);
  writeFileSync(p, String(ms));
  return p;
}

/** Sidecars the engine must never touch (plan 5.6). Content is unique per folder. */
export function putSidecars(folder, tag = folder.key) {
  const d = folder.path;
  mkdirSync(join(d, 'waiting-input'), { recursive: true });
  const files = {
    'archived-sessions.idx': JSON.stringify({ v: 1, archived: [recordId(1)], tag }),
    'waiting-input/manifest.json': JSON.stringify({ v: 1, sessionId: recordId(1), entries: [{ uuid: 'q1', msg: `queued in ${tag}` }] }),
    [`owed-bridge-delete_${'ab'.repeat(32)}`]: JSON.stringify({ remoteId: `bridge-${tag}` }),
    [`${recordName(1)}.bak-reparent-1`]: JSON.stringify({ old: true, tag }),
    [`${recordName(99)}.tmp`]: JSON.stringify({ half: 'written', tag }),
    'imported-staging': `staging ${tag}`,
  };
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(d, ...rel.split('/')), text);
  return Object.keys(files);
}

const SIDECAR = /(^|\/)(waiting-input\/|owed-bridge-delete_|archived-sessions\.idx$|imported-staging$)|\.bak-|\.tmp$/;

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** rel -> sha256 of every file under dir (links not followed). */
export function treeHashes(dir, filter = () => true) {
  const out = {};
  const rec = (abs) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const p = join(abs, e.name);
      if (e.isDirectory()) rec(p);
      else if (e.isFile()) {
        const rel = relative(dir, p).split(sep).join('/');
        if (filter(rel)) out[rel] = sha256(readFileSync(p));
      }
    }
  };
  rec(dir);
  return out;
}

export const sidecarHashes = (store) => treeHashes(store, (rel) => SIDECAR.test(rel));

/** `dev:ino` of a path as bigint stats give it. */
export function inoOf(p) {
  const s = statSync(p, { bigint: true });
  return `${s.dev}:${s.ino}`;
}

export const nlinkOf = (p) => lstatSync(p).nlink;
export const readRecord = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** Synthetic scheduled-tasks.json content (used by stage 2 and the simulator). */
export function tasksJson(tasks) {
  return { scheduledTasks: tasks };
}

/** A synthetic scheduled task. Daily cron by default (UTC "M H * * *"); pass fireAt for a one-shot. */
export function makeTask(id, over = {}) {
  return {
    id,
    displayName: `Synthetic task ${id}`,
    cronExpression: '20 5 * * *',
    enabled: true,
    filePath: `C:\\synthetic\\.claude\\scheduled-tasks\\${id}\\SKILL.md`,
    createdAt: 1_790_000_000_000,
    cwd: 'C:\\synthetic\\work',
    notifySessionId: `local_${uuid('f', 1)}`,
    ...over,
  };
}

/** Write a folder's scheduled-tasks.json the way the app does (2-space JSON, no trailing newline). */
export function putTasks(folderPath, tasks, top = {}, mtimeMs) {
  const p = join(folderPath, 'scheduled-tasks.json');
  writeFileSync(p, JSON.stringify({ scheduledTasks: tasks, recordedSkips: [], ...top }, null, 2));
  if (mtimeMs !== undefined) setMtime(p, mtimeMs);
  return p;
}

export function putBacklog(folderPath, items, version = 1, mtimeMs) {
  mkdirSync(join(folderPath, 'backlog'), { recursive: true });
  const p = join(folderPath, 'backlog', 'tasks.json');
  writeFileSync(p, JSON.stringify({ version, items }, null, 2));
  if (mtimeMs !== undefined) setMtime(p, mtimeMs);
  return p;
}

export const readJsonFile = (p) => JSON.parse(readFileSync(p, 'utf8'));
