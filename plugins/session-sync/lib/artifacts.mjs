/**
 * artifacts.mjs - share new artifacts with the other linked claude.ai account (invite sent in the owner's browser, accepted in the receiver's).
 *
 * An artifact belongs to the account whose session published it; the other account sees it only through a share invite that is SENT
 * from a browser signed in as the owner and ACCEPTED as the receiver. This module is the bookkeeping half:
 *
 *   capture  (PostToolUse on the `Artifact` tool)  a NEW artifact is appended to a queue, owner = the account the app runs as now
 *   wake     (UserPromptSubmit)                    when a browser reachable from THIS session's account can send a pending entry or
 *                                                  accept an invited one, one session is told to run the share-artifacts skill (the skill
 *                                                  drives the browser pane, and Claude in Chrome from the account it is connected to)
 *   queue    (`cli.mjs artifacts ...`)             pending / list / mark / forget / pane / chrome-unavailable, used by the skill
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
  mkdirSync, readdirSync, readFileSync, writeFileSync, linkSync, unlinkSync, renameSync, openSync, closeSync, writeSync, statSync, utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { STATE_DIR } from './config.mjs';

export const QUEUE_DIR = join(STATE_DIR, 'artifact-queue');
/** pending: to send. invited: sent, to accept. accepted: accepted by an agent, not yet verified. done: verified (or the user said so). */
export const STATUSES = Object.freeze(['pending', 'invited', 'accepted', 'done', 'failed', 'skipped']);
/** The wake only touches entries this old (an artifact is often republished right after it is made), at most once per CLAIM_MS per account, and leaves a browser that reported itself unavailable alone for BACKOFF_MS. */
export const MIN_AGE_MS = 2 * 60 * 1000;
export const CLAIM_MS = 30 * 60 * 1000;
export const BACKOFF_MS = 30 * 60 * 1000;
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
  if (reason) next.reason = String(reason); else if (['pending', 'done', 'invited', 'accepted'].includes(status)) delete next.reason;
  writeAtomic(entryFile(dir, id), `${JSON.stringify(next, null, 2)}\n`);
  prune(dir, now);
  return { ok: true, entry: next };
}

export function forgetEntry(dir, id) {
  try { unlinkSync(entryFile(dir, id)); return true; } catch { return false; }
}

/** Drop finished entries (done, accepted, skipped) that have not changed for KEEP_MS. */
function prune(dir, now) {
  for (const e of readEntries(dir)) {
    if (['done', 'accepted', 'skipped'].includes(e.status) && now - Date.parse(e.updatedAt ?? e.createdAt) > KEEP_MS) forgetEntry(dir, e.id);
  }
}

/* ---------------------- the browsers the skill can drive ---------------------- */

const stateFile = (dir) => join(dir, 'state.json');

/**
 * { browsers: { <name>: { email, at, account?, unavailableAt? } } }. The skill records each browser's signed-in account on every run.
 * `account` (an account id or its first 8+ characters) is set for a browser only sessions of that account can reach: Claude in Chrome
 * lists only the extension instances connected to the account the session runs as. No `account` = reachable from any session (the
 * desktop app's browser pane). `unavailableAt` is when a run found the browser not connected; recording the browser again clears it.
 */
export function readShareState(dir) {
  try { const s = JSON.parse(readFileSync(stateFile(dir), 'utf8')); return s && typeof s === 'object' && s.browsers && typeof s.browsers === 'object' ? s : { browsers: {} }; } catch { return { browsers: {} }; }
}

export function recordBrowser(dir, name, email, { account, now = Date.now() } = {}) {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) throw new Error(`"${name}" is not a valid browser name (lower-case letters, digits and dashes)`);
  if (!/^[^\s@]+@[^\s@]+$/.test(String(email))) throw new Error(`"${email}" is not an email address`);
  if (account !== undefined && account !== null && !/^[0-9a-f-]{8,36}$/i.test(String(account))) throw new Error(`"${account}" is not an account id (8 to 36 hex characters and dashes)`);
  mkdirSync(dir, { recursive: true });
  const s = readShareState(dir);
  const rec = { email: String(email).trim(), at: new Date(now).toISOString() };
  const acct = account ?? s.browsers[name]?.account;     // a run that only re-confirms the email keeps the account
  if (acct) rec.account = String(acct).toLowerCase();
  s.browsers[name] = rec;
  writeAtomic(stateFile(dir), `${JSON.stringify(s, null, 2)}\n`);
  return s;
}

/** A run found this browser not connected (Chrome closed): the wake leaves its work alone for BACKOFF_MS. */
export function markBrowserUnavailable(dir, name, now = Date.now()) {
  const s = readShareState(dir);
  if (!s.browsers[name]) return { ok: false, reason: `no browser "${name}" is registered (artifacts pane <email> --browser ${name})` };
  s.browsers[name] = { ...s.browsers[name], unavailableAt: new Date(now).toISOString() };
  writeAtomic(stateFile(dir), `${JSON.stringify(s, null, 2)}\n`);
  return { ok: true, browsers: s.browsers };
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
  const browsers = share?.browsers ?? {};
  const have = Object.values(browsers).map((b) => String(b.email).toLowerCase());
  if (!have.length || !browsers.pane) return true;     // the pane is always there; until it has recorded its account it cannot be ruled out
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

/** The configured key (account id or prefix) whose email is this one, or null. */
export function accountOfEmail(emails, email) {
  const want = String(email ?? '').toLowerCase();
  for (const [k, v] of Object.entries(emails ?? {})) if (String(v).toLowerCase() === want) return k.toLowerCase();
  return null;
}

/** The account half of browserUsable: a browser with an `account` answers only sessions of that account (an id or its prefix). */
export function browserReachableFrom(b, active) {
  return !b?.account || !!(active && String(active).toLowerCase().startsWith(String(b.account).toLowerCase()));
}

/**
 * Can a session running as `active` drive this browser now? A browser with an `account` only answers sessions of that account (Claude
 * in Chrome), and not while a run's "unavailable" mark is younger than BACKOFF_MS. No `account`: any session (the pane).
 */
export function browserUsable(b, active, now = Date.now()) {
  if (!browserReachableFrom(b, active)) return false;
  const t = Date.parse(b?.unavailableAt ?? '');
  return !(Number.isFinite(t) && now - t < BACKOFF_MS);
}

/**
 * The browsers that can make progress on this entry from a session running as `active`. A pending entry is SENT from a browser signed in
 * as its owner (no known owner or owner email: any usable browser). The pane is always there: until it has recorded its account it
 * counts as a browser whose account is not known. An invited entry is ACCEPTED in a browser signed in as the receiver, and only a
 * recorded browser can say it is.
 */
export function workBrowsers(e, { emails, share, active, now = Date.now() }) {
  const recorded = Object.entries(share?.browsers ?? {});
  const all = recorded.some(([n]) => n === 'pane') ? recorded : [['pane', {}], ...recorded];
  const usable = all.filter(([, b]) => browserUsable(b, active, now));
  const sameMail = (b, mail) => !!b.email && String(b.email).toLowerCase() === String(mail).toLowerCase();
  if (e.status === 'invited') {
    const rcv = e.ownerAccount ? receiverEmail(emails, e.ownerAccount) : null;
    return rcv ? usable.filter(([, b]) => sameMail(b, rcv)).map(([n]) => n) : [];
  }
  const mail = e.ownerAccount ? emailOf(emails, e.ownerAccount) : null;
  return (mail ? usable.filter(([, b]) => !b.email || sameMail(b, mail)) : usable).map(([n]) => n);
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

const claimFile = (dir, active) => join(dir, `claim-${createHash('sha256').update(String(active).toLowerCase()).digest('hex').slice(0, 16)}`);

/**
 * Take the claim for an account: an exclusive create, so one session in a CLAIM_MS window gets it. The claim file's mtime is when it was
 * taken. An EXPIRED claim is renewed in place (its mtime moved to now), never deleted, so the file is always there for a racer to see;
 * the renewal runs under a short exclusive guard file (`<claim>.take`), is re-checked once the guard is held, and a stale guard (a
 * crashed holder) is removed after GUARD_MS, losing that one prompt. The claim is never cleared early: the rate limit is the whole
 * point, and it also covers entries of both accounts staying pending while the app goes A, B, A, B.
 */
const GUARD_MS = 30 * 1000;
function takeClaim(claim, now) {
  const stamp = () => { try { utimesSync(claim, now / 1000, now / 1000); return true; } catch { return false; } };
  try {
    closeSync(openSync(claim, 'wx'));
    stamp();                                                               // outside tests `now` is the creation time already
    return true;
  } catch (e) { if (e.code !== 'EEXIST') return false; }
  try { if (now - statSync(claim).mtimeMs < CLAIM_MS) return false; } catch { return false; }
  const guard = `${claim}.take`;
  try { closeSync(openSync(guard, 'wx')); } catch (e) {
    if (e.code === 'EEXIST') { try { if (Date.now() - statSync(guard).mtimeMs > GUARD_MS) unlinkSync(guard); } catch { /* gone */ } }
    return false;                                                          // somebody else is renewing it
  }
  try {
    if (now - statSync(claim).mtimeMs < CLAIM_MS) return false;            // renewed while we were getting the guard
    return stamp();
  } catch { return false; } finally { try { unlinkSync(guard); } catch { /* ignore */ } }
}

/**
 * Decide whether this prompt's session should be told to share, and take the claim if so. A session acts when a browser it can reach
 * can make progress (workBrowsers): the owner's browser for a pending entry, the receiver's for an invited one. There is no account
 * switch to wait for: an artifact of the account whose Chrome only that account's sessions can reach has to be shared while one of
 * those runs. Only entries older than MIN_AGE_MS count, and the sessions of one account get the instruction at most once per CLAIM_MS.
 * Cheap on purpose: nothing queued is one failed readdir; the app's account is only read when an entry is old enough to act on.
 * o: { dir, cfg, stateDir, active, share, now, sessionCheck }. `active` (the app's account) is looked up with activeAccount() when not
 * given; `sessionCheck(active)` (async, optional) says whether the prompting session may take the claim.
 * @returns {Promise<{act:boolean, reason:string, due?:object[], text?:string}>}
 */
export async function wake(o = {}) {
  const dir = o.dir ?? QUEUE_DIR;
  const now = o.now ?? Date.now();
  let names;
  try { names = readdirSync(dir); } catch { return { act: false, reason: 'no-queue' }; }
  const open = [];
  for (const n of names) {
    const m = ENTRY_RE.exec(n);
    const e = m ? readEntry(dir, m[1]) : null;
    if (e && e.id === m[1] && (e.status === 'pending' || e.status === 'invited')) open.push(e);
  }
  if (!open.length) return { act: false, reason: 'nothing-pending' };
  const aged = open.filter((e) => now - Date.parse(e.updatedAt ?? e.createdAt) >= MIN_AGE_MS);
  if (!aged.length) return { act: false, reason: 'too-new' };
  if (!featureOn(o.cfg, o.stateDir)) return { act: false, reason: 'disabled' };
  const emails = o.cfg?.artifactShare?.emails ?? {};
  if (new Set(Object.values(emails).map((v) => String(v).toLowerCase())).size < 2) return { act: false, reason: 'no-emails' };   // nothing the skill could send to: set artifactShare.email for both accounts
  const active = o.active !== undefined ? o.active : await activeAccount();
  if (!active) return { act: false, reason: 'no-active-account' };
  const share = o.share ?? readShareState(dir);
  const due = aged.filter((e) => workBrowsers(e, { emails, share, active, now }).length);
  if (!due.length) return { act: false, reason: 'none-due' };
  const claim = claimFile(dir, active);
  try { if (now - statSync(claim).mtimeMs < CLAIM_MS) return { act: false, reason: 'claimed' }; } catch { /* not taken yet */ }
  // Only a session the app knows as an interactive one (the browser tools live there) may take it: not a terminal run, a headless or a scheduled session.
  if (o.sessionCheck && !(await o.sessionCheck(active))) return { act: false, reason: 'not-interactive' };
  if (!takeClaim(claim, now)) return { act: false, reason: 'claimed' };
  return { act: true, reason: 'claimed-now', due, text: wakeInstruction({ due, active, emails, share, now }) };
}

export function wakeInstruction({ due, active, emails, share, now = Date.now() }) {
  const mail = emailOf(emails, active);
  const n = due.length;
  const what = (e) => {
    if (e.status === 'invited') { const r = receiverEmail(emails, e.ownerAccount); return r ? `accept as ${r}` : 'accept'; }
    const o = emailOf(emails, e.ownerAccount);
    return o ? `send from ${o}` : 'send';
  };
  const list = due.slice(0, 5).map((e) => `- ${e.title || '(untitled)'}: ${e.url} (${what(e)})`).join('\n');
  const reach = Object.entries(share?.browsers ?? {}).filter(([, b]) => browserUsable(b, active, now)).map(([k, b]) => `${k}${b.email ? ` (${b.email})` : ''}`);
  return [
    `session-sync: ${n} artifact${n === 1 ? '' : 's'} to share between your two claude.ai accounts (this session runs as ${mail || 'one of them'}${reach.length ? `; browsers registered for it: ${reach.join(', ')}` : ''}):`,
    list + (n > 5 ? `\n- and ${n - 5} more` : ''),
    'Run the session-sync share-artifacts skill (skills/share-artifacts) in ONE background browser subagent (agent-companion:ac-browser when it exists): it sends the Editor invite from the owner\'s browser, accepts it in the receiver\'s browser when that one is reachable, and otherwise returns invitation links. Do not open any browser window yourself, and never launch Chrome.',
    'When it returns, verify what you can with Artifact read and tell the user the result in one or two lines (links to tap only for what could not be accepted). If the user is busy, mention it in one line and carry on with their request first.',
  ].join('\n');
}
