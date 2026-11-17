/**
 * artifacts.mjs - invite new artifacts to the other linked claude.ai account when the user switches accounts.
 *
 * An artifact belongs to the account whose session published it; the other account sees it only through a share invite that is SENT
 * from a browser signed in as the owner and ACCEPTED as the receiver. This module is the bookkeeping half:
 *
 *   capture  (PostToolUse on the `Artifact` tool)  a NEW artifact is appended to a queue, owner = the account the app runs as now
 *   wake     (UserPromptSubmit)                    when the app's account is no longer the owner of pending entries, one session is
 *                                                  told to run the share-artifacts skill (the skill drives the browser pane)
 *   queue    (`cli.mjs artifacts ...`)             pending / list / mark / forget / pane, used by the skill
 *
 * Storage: ~/.claude/session-sync/artifact-queue/, one file per artifact (`a-<id>.json`). A file is published with a hard link, so
 * "append" is atomic (readers never see a half-written entry), dedupe by id is the link failing with EEXIST, and two sessions
 * appending at once need no lock. Status changes rewrite one entry (temp file + rename).
 *
 * The hooks fire in every session: this module imports only node built-ins. The app's signed-in account is read lazily, and only
 * when an entry is captured or there is something pending. It is the same bounded uuid scan the account switch watcher uses
 * (accounts/appstate.mjs readSignedIn); no auth or token field is ever read.
 */

import {
  mkdirSync, readdirSync, readFileSync, writeFileSync, linkSync, unlinkSync, renameSync, openSync, closeSync, writeSync, statSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { STATE_DIR } from './config.mjs';

export const QUEUE_DIR = join(STATE_DIR, 'artifact-queue');
export const STATUSES = Object.freeze(['pending', 'invited', 'done', 'failed', 'skipped']);
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const URL_RE = /https:\/\/claude\.ai\/(?:code\/)?artifact\/([A-Za-z0-9_-]{6,64})/g;
const ENTRY_RE = /^a-([A-Za-z0-9_-]{6,64})\.json$/;
/** Finished entries are dropped this long after their last change. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/* ---------------------------------- capture ---------------------------------- */

/**
 * Did this Artifact call publish a NEW artifact? A publish (the default action, or action "publish") with no `url`: that includes a
 * create from a `type_url`. A `url` means an update; `asset` means an upload; every other action (read, list, delete, open,
 * quickstart, ...) is not a publish.
 */
export function isNewArtifact(input) {
  if (!input || typeof input !== 'object') return false;
  const action = input.action === undefined || input.action === null || input.action === '' ? 'publish' : String(input.action).toLowerCase();
  if (action !== 'publish') return false;
  if (input.url || input.asset || input.asset_ids) return false;
  return true;
}

/**
 * The real tool republishes an existing artifact WITHOUT a `url` in the input (just the file and a label); only the response says so:
 * "Published <path> at <url> (Version N, ...)". N above 1 is a republish, never a new artifact. A create from a `type_url` is always
 * new ("Created a new Artifact at <url> (version ...)"). A response without that marker is taken as new (dedupe by id still applies).
 */
export function isRepublishResponse(input, response) {
  if (input?.type_url) return false;
  let text;
  try { text = typeof response === 'string' ? response : JSON.stringify(response ?? ''); } catch { return false; }
  const m = /\(Version (\d+)\b/.exec(text);
  return !!m && Number(m[1]) > 1;
}

/**
 * The new artifact's id and url from a tool call, or null. The response shape is not documented: an object may carry `url`; a string
 * (or any object, serialized) is scanned for claude.ai/artifact/<id>. A create from a type can also mention other artifacts (the
 * type's own page), so ids that appear in the input (`type_url`, `from_url`) are skipped, and a top-level `url` wins.
 */
export function extractArtifact(input, response) {
  const skip = new Set();
  for (const k of ['type_url', 'from_url', 'url']) {
    for (const m of String(input?.[k] ?? '').matchAll(URL_RE)) skip.add(m[1]);
  }
  const pick = (text) => {
    for (const m of String(text).matchAll(URL_RE)) if (!skip.has(m[1])) return { id: m[1], url: `https://claude.ai/artifact/${m[1]}` };
    return null;
  };
  let obj = response;
  if (typeof response === 'string') { try { const j = JSON.parse(response); if (j && typeof j === 'object') obj = j; } catch { /* plain text */ } }
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    if (obj.is_error === true || obj.isError === true) return null;
    if (typeof obj.url === 'string') { const r = pick(obj.url); if (r) return r; }
  }
  let text;
  try { text = typeof response === 'string' ? response : JSON.stringify(response ?? ''); } catch { return null; }
  return pick(text);
}

/** A title for the notice: the input title, the response title, the one-sentence description, then the file name. One line, no control characters. */
function titleOf(input, response) {
  const file = typeof input?.file_path === 'string' ? input.file_path.split(/[\\/]/).pop() : null;
  for (const t of [input?.title, response && typeof response === 'object' ? response.title : null, input?.description, file]) {
    const s = typeof t === 'string' ? t.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
    if (s) return s.slice(0, 120);
  }
  return null;
}

/** Build a queue entry from a PostToolUse payload, or null when the call did not create an artifact. */
export function entryFromHook(payload, { ownerAccount = null, now = Date.now() } = {}) {
  if (!payload || payload.tool_name !== 'Artifact') return null;
  const input = payload.tool_input;
  if (!isNewArtifact(input)) return null;
  const response = payload.tool_response ?? payload.tool_output;
  if (isRepublishResponse(input, response)) return null;
  const found = extractArtifact(input, response);
  if (!found) return null;
  return {
    id: found.id, url: found.url, title: titleOf(input, payload.tool_response),
    ownerAccount: ownerAccount ? String(ownerAccount).toLowerCase() : null,
    createdAt: new Date(now).toISOString(),
    sessionId: typeof payload.session_id === 'string' ? payload.session_id : null,
    status: 'pending',
  };
}

/* ----------------------------------- queue ----------------------------------- */

/** An id is only ever a claude.ai artifact id: anything else (a path, "..") never reaches the file system. */
const entryFile = (dir, id) => {
  if (!ID_RE.test(String(id))) throw new Error(`"${id}" is not an artifact id`);
  return join(dir, `a-${id}.json`);
};

function sleepMs(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ignore */ } }

/** Temp file + rename, with the short retries Windows needs when another process holds the target for a moment. */
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(tmp, text);
  for (let i = 0; ; i++) {
    try { renameSync(tmp, file); return; } catch (e) {
      if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { try { unlinkSync(tmp); } catch { /* ignore */ } throw e; }
      sleepMs(40);
    }
  }
}

/** Append an entry unless its id is already queued (any status). Returns {added}. */
export function enqueue(dir, entry) {
  if (!ID_RE.test(String(entry?.id))) return { added: false, reason: 'bad-id' };
  mkdirSync(dir, { recursive: true });
  const final = entryFile(dir, entry.id);
  const tmp = `${final}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  const text = `${JSON.stringify(entry, null, 2)}\n`;
  writeFileSync(tmp, text);
  try {
    linkSync(tmp, final);                 // atomic publish; EEXIST = already queued (dedupe, and the loser of a race)
    return { added: true };
  } catch (e) {
    if (e.code === 'EEXIST') return { added: false, reason: 'exists' };
    try {                                 // no hard links on this file system: exclusive create instead
      const fd = openSync(final, 'wx');
      try { writeSync(fd, text); } finally { closeSync(fd); }
      return { added: true };
    } catch (e2) { if (e2.code === 'EEXIST') return { added: false, reason: 'exists' }; throw e2; }
  } finally { try { unlinkSync(tmp); } catch { /* ignore */ } }
}

export function readEntry(dir, id) {
  try { const e = JSON.parse(readFileSync(entryFile(dir, id), 'utf8')); return e && typeof e === 'object' ? e : null; } catch { return null; }
}

/** All readable entries, oldest first. An unreadable or half-written file is skipped. */
export function readEntries(dir) {
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    const m = ENTRY_RE.exec(n);
    if (!m) continue;
    const e = readEntry(dir, m[1]);
    if (e && e.id === m[1]) out.push(e);
  }
  return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
}

export const pendingOf = (entries) => entries.filter((e) => e.status === 'pending');

/** Change one entry's status. {ok, entry} or {ok:false, reason}. */
export function markEntry(dir, id, status, { link, reason, now = Date.now() } = {}) {
  if (!STATUSES.includes(status)) return { ok: false, reason: `unknown status "${status}"` };
  const e = readEntry(dir, id);
  if (!e) return { ok: false, reason: `no queued artifact "${id}"` };
  const next = { ...e, status, updatedAt: new Date(now).toISOString() };
  if (link) next.inviteLink = String(link);
  if (reason) next.reason = String(reason); else if (status === 'pending' || status === 'done' || status === 'invited') delete next.reason;
  writeAtomic(entryFile(dir, id), `${JSON.stringify(next, null, 2)}\n`);
  prune(dir, now);
  return { ok: true, entry: next };
}

export function forgetEntry(dir, id) {
  try { unlinkSync(entryFile(dir, id)); return true; } catch { return false; }
}

/** Drop finished entries (done, skipped) that have not changed for KEEP_MS. */
function prune(dir, now) {
  for (const e of readEntries(dir)) {
    if ((e.status === 'done' || e.status === 'skipped') && now - Date.parse(e.updatedAt ?? e.createdAt) > KEEP_MS) forgetEntry(dir, e.id);
  }
}

/* ---------------------- the browsers the skill can drive ---------------------- */

const stateFile = (dir) => join(dir, 'state.json');

/** { browsers: { <name>: { email, at } } }. The skill records each browser's signed-in account on every run. */
export function readShareState(dir) {
  try { const s = JSON.parse(readFileSync(stateFile(dir), 'utf8')); return s && typeof s === 'object' && s.browsers && typeof s.browsers === 'object' ? s : { browsers: {} }; } catch { return { browsers: {} }; }
}

export function recordBrowser(dir, name, email, now = Date.now()) {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) throw new Error(`"${name}" is not a valid browser name (lower-case letters, digits and dashes)`);
  if (!/^[^\s@]+@[^\s@]+$/.test(String(email))) throw new Error(`"${email}" is not an email address`);
  mkdirSync(dir, { recursive: true });
  const s = readShareState(dir);
  s.browsers[name] = { email: String(email).trim(), at: new Date(now).toISOString() };
  writeAtomic(stateFile(dir), `${JSON.stringify(s, null, 2)}\n`);
  return s;
}

/* ------------------------------- accounts / emails ------------------------------- */

/** The configured email of an account id (a key may be a prefix of the id), or null. */
export function emailOf(emails, accountId) {
  if (!accountId) return null;
  const id = String(accountId).toLowerCase();
  for (const [k, v] of Object.entries(emails ?? {})) if (id.startsWith(k.toLowerCase())) return v;
  return null;
}

export function sameAccount(a, b) {
  if (!a || !b) return false;
  return String(a).toLowerCase() === String(b).toLowerCase();
}

/**
 * Can a browser we can drive act for this owner? A null owner, no recorded browser, or an owner with no configured email cannot be
 * ruled out, so they qualify; once a browser has recorded its account, the owner must be one of the recorded accounts.
 */
export function driveableOwner(owner, emails, share) {
  if (!owner) return true;
  const have = Object.values(share?.browsers ?? {}).map((b) => String(b.email).toLowerCase());
  if (!have.length) return true;
  const mail = emailOf(emails, owner);
  if (!mail) return true;
  return have.includes(mail.toLowerCase());
}

/** The email of the other linked account (the one that receives the invite), or null when it is not known. */
export function receiverEmail(emails, owner) {
  if (!owner) return null;
  const mine = emailOf(emails, owner);
  const others = [...new Set(Object.values(emails ?? {}).map((v) => String(v)))].filter((v) => !mine || v.toLowerCase() !== mine.toLowerCase());
  return mine && others.length === 1 ? others[0] : null;
}

/* ----------------------------------- the wake ----------------------------------- */

/** Is the machine set up for this: accounts linked (accounts/state.json) and artifactShare.enabled not false. Reads one small file. */
export function featureOn(cfg, stateDir = STATE_DIR) {
  if (cfg?.artifactShare?.enabled === false) return false;
  try { return JSON.parse(readFileSync(join(stateDir, 'accounts', 'state.json'), 'utf8'))?.linked === true; } catch { return false; }
}

/**
 * The app's signed-in account (lower-case uuid), or null when it cannot be told. Lazy imports: only a capture or a wake with something
 * pending gets here. SESSION_SYNC_TEST_APP_STATE is the existing test seam of appstate.mjs; production never sets it.
 */
export async function activeAccount() {
  try {
    const { testSeam, readSignedIn } = await import('./accounts/appstate.mjs');
    const seam = testSeam();
    if (seam) return seam.signedIn ? String(seam.signedIn).toLowerCase() : null;
    const { makeCtx } = await import('./accounts/state.mjs');
    return readSignedIn(makeCtx().userData);
  } catch { return null; }
}

/** Is this a session the app lists as an interactive one (local, not archived, not a scheduled task) in the account the app is on? The same test rc-wake uses. */
export async function interactiveSessionFor(active, sessionId) {
  try {
    const { makeCtx } = await import('./accounts/state.mjs');
    const { recordForCliSession, interactiveSession } = await import('./accounts/rcrestore.mjs');
    const found = recordForCliSession(makeCtx(), String(active).toLowerCase(), sessionId);
    return !!found && interactiveSession(found.rec);
  } catch { return false; }
}

const CLAIM_RE = /^claim-[0-9a-f]{16}$/;

/**
 * Decide whether this prompt's session should be told to share, and take the claim if so. Cheap on purpose: nothing queued is one
 * failed readdir; nothing pending is a readdir and a few small reads; the app's account is only read when something is pending.
 * o: { dir, cfg, stateDir, active, share, sessionCheck }. `active` (the app's account) is looked up with activeAccount() when not given;
 * `sessionCheck(active)` (async, optional) says whether the prompting session may take the claim.
 * @returns {Promise<{act:boolean, reason:string, due?:object[], text?:string}>}
 */
export async function wake(o = {}) {
  const dir = o.dir ?? QUEUE_DIR;
  let names;
  try { names = readdirSync(dir); } catch { return { act: false, reason: 'no-queue' }; }
  const entries = [];
  for (const n of names) {
    const m = ENTRY_RE.exec(n);
    const e = m ? readEntry(dir, m[1]) : null;
    if (e && e.id === m[1]) entries.push(e);
  }
  const pending = pendingOf(entries);
  if (!pending.length) { clearClaims(dir, names); return { act: false, reason: 'nothing-pending' }; }
  if (!featureOn(o.cfg, o.stateDir)) return { act: false, reason: 'disabled' };
  const active = o.active !== undefined ? o.active : await activeAccount();
  if (!active) return { act: false, reason: 'no-active-account' };
  const emails = o.cfg?.artifactShare?.emails ?? {};
  if (new Set(Object.values(emails).map((v) => String(v).toLowerCase())).size < 2) return { act: false, reason: 'no-emails' };   // nothing the skill could send to: set artifactShare.email for both accounts
  const share = o.share ?? readShareState(dir);
  const due = pending.filter((e) => !sameAccount(e.ownerAccount, active) && driveableOwner(e.ownerAccount, emails, share));
  if (!due.length) { clearClaims(dir, names); return { act: false, reason: 'none-due' }; }
  // The claim is per switch: it is keyed by the account the app is on only, NOT by what is due, because the skill shrinks the due set as it
  // works and a changed key would hand the instruction to the next prompt again. It goes when nothing is due (back on the owner's account, or
  // everything handled). A run that dies leaves the entries pending: asking for the skill by hand retries them.
  const key = createHash('sha256').update(String(active).toLowerCase()).digest('hex').slice(0, 16);
  const claim = join(dir, `claim-${key}`);
  try { if (statSync(claim)) return { act: false, reason: 'claimed' }; } catch { /* not taken yet */ }
  // Only a session the app knows as an interactive one (the browser tools live there) may take it: not a terminal run, a headless or a scheduled session.
  if (o.sessionCheck && !(await o.sessionCheck(active))) return { act: false, reason: 'not-interactive' };
  try { closeSync(openSync(claim, 'wx')); } catch { return { act: false, reason: 'claimed' }; }
  return { act: true, reason: 'claimed-now', due, text: wakeInstruction({ due, active, emails }) };
}

/** A claim belongs to one switch: once nothing is due (back on the owner's account, or everything handled) the claims go, so the next switch acts again. */
function clearClaims(dir, names) {
  for (const n of names) if (CLAIM_RE.test(n)) { try { unlinkSync(join(dir, n)); } catch { /* ignore */ } }
}

export function wakeInstruction({ due, active, emails }) {
  const mail = emailOf(emails, active);
  const n = due.length;
  const list = due.slice(0, 5).map((e) => `- ${e.title || '(untitled)'}: ${e.url}`).join('\n');
  return [
    `session-sync: ${n} new artifact${n === 1 ? '' : 's'} made in your other claude.ai account ${n === 1 ? 'is' : 'are'} not shared with the account you are on now${mail ? ` (${mail})` : ''}:`,
    list + (n > 5 ? `\n- and ${n - 5} more` : ''),
    'Run the session-sync share-artifacts skill (skills/share-artifacts) in ONE background browser subagent (agent-companion:ac-browser when it exists): it sends an Editor invite to this account from the Claude desktop browser pane and returns invitation links. Do not open any browser window yourself.',
    'When it returns, give the user the invitation links in one short message and ask them to open each one, click Accept, and say when done; then follow the skill to verify and mark them done. If the user is busy, mention it in one line and carry on with their request first.',
  ].join('\n');
}
