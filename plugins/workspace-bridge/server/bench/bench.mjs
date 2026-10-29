// Free-tier budget benchmark (plan s.3.4, ARCHITECTURE s.8). Not part of `npm test`:
//
//   node bench/bench.mjs [--runs=60] [--warmup=10] [--only=<substring>] [--json=<file>]
//
// It bundles the REAL Worker (src/index.ts, real OAuth library, real tool code) with esbuild and
// runs it in Node 24 against fakes for the things outside the Worker: D1 (node:sqlite running the
// real migrations), KV (a Map), and Google (canned responses on `globalThis.fetch`).
//
// What the numbers mean (read before quoting them):
//  - CPU ms = wall time of one request, minus the time spent inside the fakes (SQLite, KV, building
//    Google's canned Response). The fakes are synchronous in their measured part, so the
//    subtraction is exact. Nothing in a request waits on a real network or a real timer, so wall
//    time minus fake time is the JavaScript CPU the Worker code itself used.
//  - It is Node's V8, not workerd. workerd freezes `performance.now()` while JavaScript runs (a
//    Spectre mitigation), so it cannot be timed from inside; it runs the same V8 but on a
//    different build, with cold isolates and a slower shared core. Treat the figures as a
//    relative guide (what is heavy, what scales with what) and an order of magnitude, not as
//    what Cloudflare will bill. Live check: Workers analytics CPU-time percentiles after use.
//  - Node's WebCrypto (AES-GCM, SHA-256) runs off the main thread, so it hardly shows here; in
//    workerd it is native code that counts as CPU. Crypto cost is estimated in the notes instead.
//  - Warm JIT: every scenario runs `warmup` untimed iterations first. A cold isolate's first
//    request is slower; `coldFirstRequestMs` records the very first request of the process.
//  - Counters (subrequests, KV and D1 operations) are exact for the code paths run.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(ROOT, ".wrangler", "bench");

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const RUNS = Number(arg("runs", 60));
const WARMUP = Number(arg("warmup", 10));
const ONLY = arg("only", "");
const JSON_OUT = arg("json", join(OUT, "results.json"));

// ---- Bundle ----------------------------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });
writeFileSync(
  join(OUT, "cfw-stub.mjs"),
  "export const env = {}; export const exports = {}; export class DurableObject {} export class WorkerEntrypoint {} export class RpcTarget {} export class WorkflowEntrypoint {} export const waitUntil = () => {}; export const withEnv = (_e, f) => f();",
);
await build({
  entryPoints: [join(HERE, "entry.mjs")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: join(OUT, "entry.bundle.mjs"),
  logLevel: "error",
  alias: {
    "cloudflare:workers": join(OUT, "cfw-stub.mjs"),
    "cloudflare:email": join(OUT, "cfw-stub.mjs"),
  },
  banner: {
    js: "import {createRequire as __cr} from 'node:module'; const require = __cr(import.meta.url);",
  },
});

// ---- Counters and the fake-time meter --------------------------------------------------------------

const fresh = () => ({
  google: [],
  kv: { get: 0, put: 0, delete: 0, list: 0 },
  kvPuts: [],
  kvDeletes: 0,
  d1: { queries: 0, batches: 0, stmts: 0, writeStmts: 0, rowsWritten: 0, byTable: {} },
  ratelimit: 0,
});
let C = fresh();
const shim = { ms: 0 };
const meter = (fn) => {
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    shim.ms += performance.now() - t0;
  }
};

// ---- Fake D1 (node:sqlite) -------------------------------------------------------------------------

const sqlite = new DatabaseSync(":memory:");
for (const f of readdirSync(join(ROOT, "migrations")).sort()) {
  sqlite.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
}
const stmtCache = new Map();
const prep = (sql) => {
  let s = stmtCache.get(sql);
  if (!s) {
    s = sqlite.prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
};
const indexCount = new Map();
const indexesOf = (table) => {
  let n = indexCount.get(table);
  if (n === undefined) {
    n = sqlite.prepare(`PRAGMA index_list(${table})`).all().length;
    indexCount.set(table, n);
  }
  return n;
};
const totalChanges = () => sqlite.prepare("SELECT total_changes() AS c").get().c;
const WRITE = /^\s*(insert|update|delete|replace)\b/i;
const TABLE =
  /^\s*(?:insert\s+(?:or\s+\w+\s+)?into|update|delete\s+from|replace\s+into)\s+"?(\w+)/i;
const seen = new Set();
const scans = new Set();

const toParam = (v) => (v === undefined ? null : typeof v === "boolean" ? Number(v) : v);

function execStmt(sql, params, mode) {
  const s = prep(sql);
  const p = params.map(toParam);
  const isWrite = WRITE.test(sql);
  if (!isWrite && !seen.has(sql)) {
    seen.add(sql);
    try {
      const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...p);
      if (plan.some((r) => /^SCAN /.test(r.detail))) scans.add(sql);
    } catch {
      /* a plan that cannot be explained is skipped */
    }
  }
  const before = isWrite ? totalChanges() : 0;
  let results = [];
  let ran = false;
  if (isWrite && !/\breturning\b/i.test(sql)) {
    s.run(...p);
    ran = true;
  }
  if (!ran) results = s.all(...p).map((r) => ({ ...r }));
  C.d1.stmts++;
  let written = 0;
  if (isWrite) {
    C.d1.writeStmts++;
    const changes = totalChanges() - before;
    const table = TABLE.exec(sql)?.[1] ?? "?";
    written = changes * (1 + indexesOf(table));
    C.d1.rowsWritten += written;
    C.d1.byTable[table] = (C.d1.byTable[table] ?? 0) + written;
  }
  return { results, mode, written };
}

class Stmt {
  constructor(sql, params = []) {
    this.sql = sql;
    this.params = params;
  }
  bind(...p) {
    return new Stmt(this.sql, p);
  }
  first(col) {
    return meter(() => {
      C.d1.queries++;
      const { results } = execStmt(this.sql, this.params, "first");
      const row = results[0] ?? null;
      return Promise.resolve(col && row ? row[col] : row);
    });
  }
  all() {
    return meter(() => {
      C.d1.queries++;
      const { results } = execStmt(this.sql, this.params, "all");
      return Promise.resolve({ results, success: true, meta: {} });
    });
  }
  run() {
    return meter(() => {
      C.d1.queries++;
      const { results } = execStmt(this.sql, this.params, "run");
      return Promise.resolve({ results, success: true, meta: { changes: 0 } });
    });
  }
}
const DB = {
  prepare: (sql) => new Stmt(sql),
  batch: (stmts) =>
    meter(() => {
      C.d1.queries++;
      C.d1.batches++;
      sqlite.exec("BEGIN");
      try {
        const out = stmts.map((s) => {
          const { results } = execStmt(s.sql, s.params, "batch");
          return { results, success: true, meta: {} };
        });
        sqlite.exec("COMMIT");
        return Promise.resolve(out);
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    }),
};

// ---- Fake KV ---------------------------------------------------------------------------------------

const kvStore = new Map();
const kvLive = (key) => {
  const e = kvStore.get(key);
  if (!e) return undefined;
  if (e.expires && e.expires <= Date.now()) {
    kvStore.delete(key);
    return undefined;
  }
  return e;
};
const kvType = (opts) => (typeof opts === "string" ? opts : (opts?.type ?? "text"));
const KV = {
  get: (key, opts) =>
    meter(() => {
      C.kv.get++;
      const e = kvLive(key);
      if (!e) return Promise.resolve(null);
      return Promise.resolve(kvType(opts) === "json" ? JSON.parse(e.value) : e.value);
    }),
  getWithMetadata: (key, opts) =>
    meter(() => {
      C.kv.get++;
      const e = kvLive(key);
      if (!e) return Promise.resolve({ value: null, metadata: null });
      return Promise.resolve({
        value: kvType(opts) === "json" ? JSON.parse(e.value) : e.value,
        metadata: e.metadata ?? null,
      });
    }),
  put: (key, value, opts = {}) =>
    meter(() => {
      C.kv.put++;
      C.kvPuts.push(key.split(":")[0]);
      const ttl = opts.expirationTtl;
      kvStore.set(key, {
        value: typeof value === "string" ? value : String(value),
        metadata: opts.metadata,
        expires: opts.expiration ? opts.expiration * 1000 : ttl ? Date.now() + ttl * 1000 : 0,
      });
      return Promise.resolve();
    }),
  delete: (key) =>
    meter(() => {
      C.kv.delete++;
      kvStore.delete(key);
      return Promise.resolve();
    }),
  list: (opts = {}) =>
    meter(() => {
      C.kv.list++;
      const prefix = opts.prefix ?? "";
      const limit = opts.limit ?? 1000;
      const names = [...kvStore.keys()].filter((k) => k.startsWith(prefix) && kvLive(k)).sort();
      const start = opts.cursor ? names.findIndex((n) => n > opts.cursor) : 0;
      const slice = start < 0 ? [] : names.slice(start, start + limit);
      const done = start < 0 || start + limit >= names.length;
      return Promise.resolve({
        keys: slice.map((name) => ({ name, metadata: kvStore.get(name)?.metadata })),
        list_complete: done,
        ...(done ? {} : { cursor: slice[slice.length - 1] }),
      });
    }),
};

// ---- Fake Google ----------------------------------------------------------------------------------

let routes = [];
const setRoutes = (r) => {
  routes = r;
  counters.google = {};
};
const counters = { google: {} };
const json = (status, body, headers = {}) => ({
  status,
  headers: { "Content-Type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

globalThis.fetch = (input, init = {}) => {
  if (typeof input !== "string" && !(input instanceof URL)) {
    throw new Error("bench: fetch(Request) is not supported");
  }
  return meter(() => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const bare = url.origin + url.pathname;
    C.google.push(`${method} ${url.host}${url.pathname}`);
    const route = routes.find(
      (r) =>
        (r.method ?? "GET") === method &&
        (r.url.endsWith("*") ? bare.startsWith(r.url.slice(0, -1)) : bare === r.url),
    );
    if (!route) {
      console.error(`bench: unrouted ${method} ${input}`);
      throw new Error(`bench: unrouted ${method} ${input}`);
    }
    const n = (counters.google[route.url] ?? 0) + 1;
    counters.google[route.url] = n;
    const body =
      typeof init.body === "string"
        ? init.body
        : init.body instanceof URLSearchParams
          ? init.body.toString()
          : init.body
            ? Buffer.from(init.body.buffer ?? init.body).toString("latin1")
            : "";
    const r = route.reply(
      { url, method, body, auth: new Headers(init.headers).get("Authorization") },
      n - 1,
    );
    return Promise.resolve(new Response(r.body, { status: r.status, headers: r.headers }));
  });
};

const GOOGLE_TOKEN = {
  method: "POST",
  url: "https://oauth2.googleapis.com/token",
  reply: () =>
    json(200, {
      access_token: "ya29.refreshed",
      expires_in: 3599,
      token_type: "Bearer",
      scope: "openid",
    }),
};

// ---- Data builders ---------------------------------------------------------------------------------

const b64url = (s) => Buffer.from(s).toString("base64url");
const LOREM =
  "Hello team, here is the quarterly summary we discussed last week. The numbers are in the attached sheet and the plan for next quarter follows. Please review and reply with comments by Friday. ";
const htmlBlock = (i) =>
  `<table width="600" style="font-family:Arial,sans-serif;font-size:14px;color:#333" cellpadding="0" cellspacing="0"><tr><td style="padding:12px"><h2 style="margin:0">Section ${i}</h2><p>${LOREM}<b>Bold</b> &amp; <i>italic</i> &nbsp; &copy; 2026</p><p><a href="https://track.example.com/c/${"x".repeat(80)}?uid=${i}&amp;u=${"9".repeat(40)}">Read more</a> <img src="https://img.example.com/${i}.png" width="600" height="120" alt=""></p></td></tr></table>`;
const htmlOf = (bytes) => {
  let s =
    '<html><head><style>body{margin:0}td{padding:4px}</style></head><body style="background:#fff">';
  for (let i = 0; s.length < bytes; i++) s += htmlBlock(i);
  return `${s}</body></html>`;
};
const hdrs = (o) => Object.entries(o).map(([name, value]) => ({ name, value }));

function messageJson(i, { htmlBytes, plain }) {
  const html = b64url(htmlOf(htmlBytes));
  const headers = hdrs({
    From: `Sender ${i} <s${i}@example.com>`,
    To: "me@example.com",
    Subject: "Re: Quarterly plan",
    Date: "Mon, 27 Oct 2026 10:00:00 +0000",
  });
  const base = {
    id: `m${i}`,
    threadId: "t1",
    labelIds: ["INBOX"],
    snippet: "Hello team, here is the quarterly summary",
    internalDate: String(1_760_000_000_000 + i * 60_000),
    sizeEstimate: html.length,
  };
  if (!plain) {
    return {
      ...base,
      payload: { mimeType: "text/html", headers, body: { size: html.length, data: html } },
    };
  }
  const text = b64url(LOREM.repeat(20));
  return {
    ...base,
    payload: {
      mimeType: "multipart/alternative",
      headers,
      parts: [
        { mimeType: "text/plain", body: { size: text.length, data: text } },
        { mimeType: "text/html", body: { size: html.length, data: html } },
      ],
    },
  };
}
const threadFull = (count, opts) =>
  JSON.stringify({
    id: "t1",
    messages: Array.from({ length: count }, (_, i) => messageJson(i, opts)),
  });

// Google as get_thread reads it: the thread at the index mask (part tree and sizes, no data), then
// a batch of messages.get per message. The canned texts are built once, and the fakes' time is
// subtracted like everywhere else.
const indexPart = (p) => ({
  mimeType: p.mimeType,
  filename: p.filename,
  body: p.body ? { size: p.body.size, attachmentId: p.body.attachmentId } : undefined,
  parts: p.parts?.map(indexPart),
});
const gmailThreadRoutes = (threadText) => {
  const thread = JSON.parse(threadText);
  const indexText = JSON.stringify({
    id: thread.id,
    messages: thread.messages.map((m) => ({
      id: m.id,
      labelIds: m.labelIds,
      payload: indexPart(m.payload),
    })),
  });
  const full = new Map(thread.messages.map((m) => [m.id, JSON.stringify(m)]));
  const meta = new Map(
    thread.messages.map((m) => [
      m.id,
      JSON.stringify({ ...m, payload: { headers: m.payload.headers } }),
    ]),
  );
  return [
    {
      url: `${GMAIL}/threads/${thread.id}`,
      reply: ({ url }) =>
        json(
          200,
          url.searchParams.get("fields")?.includes("payload(mimeType,filename")
            ? indexText
            : threadText,
        ),
    },
    {
      method: "POST",
      url: "https://gmail.googleapis.com/batch/gmail/v1",
      reply: ({ body }) => {
        let out = "";
        for (const m of body.matchAll(/Content-ID: <([^>]+)>\r\n\r\nGET (\S+)/g)) {
          const u = new URL(`https://x${m[2]}`);
          const id = decodeURIComponent(/\/messages\/([^/?]+)/.exec(u.pathname)?.[1] ?? "");
          const text = (u.searchParams.get("format") === "full" ? full : meta).get(id);
          out += `--batch_resp\r\nContent-Type: application/http\r\nContent-ID: <response-${m[1]}>\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${text}\r\n`;
        }
        return {
          status: 200,
          headers: { "Content-Type": "multipart/mixed; boundary=batch_resp" },
          body: `${out}--batch_resp--\r\n`,
        };
      },
    },
  ];
};

const threadMeta = (id) => ({
  id,
  messages: Array.from({ length: 4 }, (_, i) => ({
    labelIds: i === 3 ? ["INBOX", "UNREAD"] : ["INBOX"],
    snippet: `Snippet of message ${i} in ${id}, a line of preview text.`,
    internalDate: String(1_760_000_000_000 + i * 3_600_000),
    payload: {
      headers: hdrs({ From: `Ann Example <ann${i}@example.com>`, Subject: `Quarterly plan ${id}` }),
    },
  })),
});

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const gmailSearchRoutes = (n) => {
  const ids = Array.from({ length: n }, (_, i) => `t${i}`);
  const metaText = new Map(ids.map((id) => [id, JSON.stringify(threadMeta(id))]));
  return [
    { url: `${GMAIL}/threads`, reply: () => json(200, { threads: ids.map((id) => ({ id })) }) },
    {
      method: "POST",
      url: "https://gmail.googleapis.com/batch/gmail/v1",
      reply: ({ body }) => {
        let out = "";
        for (const m of body.matchAll(/Content-ID: <([^>]+)>\r\n\r\nGET (\S+)/g)) {
          const thread = decodeURIComponent(/\/threads\/([^/?]+)/.exec(m[2])?.[1] ?? "");
          out += `--batch_resp\r\nContent-Type: application/http\r\nContent-ID: <response-${m[1]}>\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metaText.get(thread)}\r\n`;
        }
        return {
          status: 200,
          headers: { "Content-Type": "multipart/mixed; boundary=batch_resp" },
          body: `${out}--batch_resp--\r\n`,
        };
      },
    },
  ];
};

const CAL = "https://www.googleapis.com/calendar/v3";
const calendarRoutes = (n) => {
  const items = Array.from({ length: n }, (_, i) => ({
    id: `e${i}`,
    summary: `Event ${i}`,
    start: { dateTime: `2030-01-07T${String(i % 20).padStart(2, "0")}:00:00Z` },
    end: { dateTime: `2030-01-07T${String((i % 20) + 1).padStart(2, "0")}:00:00Z` },
  }));
  return [
    { url: `${CAL}/calendars/primary`, reply: () => json(200, { timeZone: "UTC" }) },
    { url: `${CAL}/calendars/primary/events`, reply: () => json(200, { items }) },
  ];
};

const PEOPLE = "https://people.googleapis.com/v1";
const contactsRoutes = () => {
  const fx = JSON.parse(readFileSync(join(ROOT, "test/fixtures/google/contacts.json"), "utf8"));
  const warm = new Set();
  const route = (url, data) => ({
    url,
    reply: ({ url: u, auth }) => {
      const key = `${url}:${auth}`;
      if (u.searchParams.get("query") === "") {
        warm.add(key);
        return json(200, {});
      }
      return json(200, warm.has(key) ? data : {});
    },
  });
  return [
    route(`${PEOPLE}/people:searchContacts`, fx.searchContacts),
    route(`${PEOPLE}/otherContacts:search`, fx.otherContactsSearch),
  ];
};

const DRIVE = "https://www.googleapis.com/drive/v3";
const driveListRoutes = (n) => {
  const files = Array.from({ length: n }, (_, i) => ({
    id: `f${i}`,
    name: `File ${i}`,
    mimeType: "text/plain",
    modifiedTime: `2026-10-${String(1 + (i % 27)).padStart(2, "0")}T00:00:00Z`,
    ownedByMe: true,
  }));
  return [{ url: `${DRIVE}/files`, reply: () => json(200, { files }) }];
};

// ---- Environment, tokens, requests -----------------------------------------------------------------

const t0Import = performance.now();
const B = await import(pathToFileURL(join(OUT, "entry.bundle.mjs")).href);
const importMs = performance.now() - t0Import;

const ISSUER = "https://mcp.example.com";
const env = {
  DB,
  OAUTH_KV: KV,
  CALL_LIMIT: {
    limit: () => {
      C.ratelimit++;
      return Promise.resolve({ success: true });
    },
  },
  PUBLIC_URL: ISSUER,
  OWNER_CONTACT: "privacy@example.com",
  OWNER_EMAILS: "owner@example.com",
  TOKEN_KEK: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  COOKIE_SECRET: "bench-cookie-secret-bench-cookie-secret",
  GOOGLE_CLIENT_ID: "bench-client",
  GOOGLE_CLIENT_SECRET: "bench-secret",
  SEND_ENABLED: "true",
  SETUP_MODE: "true",
  SEND_REQUIRES_CONFIRM: "false",
  SEND_PER_HOUR: "100000", // the bench sends hundreds of times; the limiter cost is still measured
  SEND_PER_DAY: "1000000",
  MAX_RECIPIENTS: "20",
  MAX_ATTACHMENT_BYTES: "524288",
  MAX_SEND_ATTACHMENT_BYTES: "524288",
  CURRENT_KEY_VERSION: "1",
  AUDIT_RETENTION_DAYS: "365",
};

const makeCtx = () => {
  const pending = [];
  return {
    pending,
    waitUntil: (p) => pending.push(p),
    passThroughOnException: () => {},
    props: {},
  };
};

const now = () => Math.floor(Date.now() / 1000);

async function newOwner() {
  const id = B.randomId("o_");
  sqlite.prepare("INSERT INTO owners (id, created_at) VALUES (?, 0)").run(id);
  return id;
}

let labelSeq = 0;
async function linkAccount(ownerId, opts = {}) {
  const label = opts.label ?? `acct${labelSeq++}`;
  const row = await B.insertAccount(DB, {
    ownerId,
    label,
    address: `${label}@example.com`,
    provider: "google",
    components: opts.components ?? ["mail", "mail.send", "calendar", "files", "contacts"],
    grantedScopes: "",
  });
  const who = { ownerId, accountId: row.id };
  await B.upsertToken(DB, {
    accountId: row.id,
    kind: "refresh",
    sealed: await B.seal(`1//${B.randomId("rt-")}`, { ...who, kind: "refresh" }, env),
  });
  await B.upsertToken(DB, {
    accountId: row.id,
    kind: "access",
    sealed: await B.seal(`ya29.${B.randomId("at-")}`, { ...who, kind: "access" }, env),
    expiresAt: opts.expired ? now() - 10 : now() + 3600,
  });
  sqlite.prepare("UPDATE accounts SET send_as_fetched_at = ? WHERE id = ?").run(now(), row.id);
  return row;
}

const REDIRECT = "https://client.example.com/callback";
async function authorizeCode(kind, ownerId) {
  const api = B.getAuth(env).as.getOAuthApi(env);
  const client = await api.createClient({
    redirectUris: [REDIRECT],
    tokenEndpointAuthMethod: "none",
    clientName: "bench client",
  });
  const verifier = B.base64url(B.randomBytes(32));
  const resource = B.resourceUrl(kind, ISSUER);
  const url = new URL("/authorize", ISSUER);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: REDIRECT,
    scope: B.SCOPES[kind].join(" "),
    state: "s",
    code_challenge: B.base64url(await B.sha256(verifier)),
    code_challenge_method: "S256",
    resource,
  }).toString();
  const request = await api.parseAuthRequest(new Request(url));
  const { redirectTo } = await api.completeAuthorization({
    request,
    userId: ownerId,
    metadata: {},
    scope: [...B.SCOPES[kind]],
    props: { ownerId },
  });
  const code = new URL(redirectTo).searchParams.get("code");
  return { code, verifier, clientId: client.clientId, resource };
}
const tokenRequest = (params) =>
  new Request(new URL("/oauth/token", ISSUER), {
    method: "POST",
    body: new URLSearchParams(params),
  });
const exchange = (a) =>
  tokenRequest({
    grant_type: "authorization_code",
    code: a.code,
    client_id: a.clientId,
    redirect_uri: REDIRECT,
    resource: a.resource,
    code_verifier: a.verifier,
  });

async function mint(kind, ownerId) {
  const res = await B.worker.fetch(exchange(await authorizeCode(kind, ownerId)), env, makeCtx());
  if (!res.ok) throw new Error(`mint failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

let rpcId = 1;
const mcpRequest = (token, kind, method, params) =>
  new Request(ISSUER + B.PATH[kind], {
    method: "POST",
    headers: {
      Host: new URL(ISSUER).host,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, ...(params ? { params } : {}) }),
  });

const parseSse = (text) => {
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return line ? JSON.parse(line.slice(6)) : JSON.parse(text);
};

// ---- Measurement -----------------------------------------------------------------------------------

/** One timed request: returns CPU ms (wall minus the fakes), counters, and the parsed answer. */
async function timedRequest(makeReq) {
  const req = makeReq();
  const ctx = makeCtx();
  C = fresh();
  shim.ms = 0;
  const t0 = performance.now();
  const res = await B.worker.fetch(req, env, ctx);
  const text = await res.text();
  await Promise.all(ctx.pending);
  const wall = performance.now() - t0;
  const cpu = wall - shim.ms;
  return { cpu, wall, shim: shim.ms, status: res.status, text, c: C };
}

const pct = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, p50: pct(s, 50), p95: pct(s, 95), max: s[s.length - 1], min: s[0] };
};

function check(label, r, expectTool) {
  if (r.status !== 200) throw new Error(`${label}: HTTP ${r.status} ${r.text.slice(0, 300)}`);
  const msg = parseSse(r.text);
  if (msg.error) throw new Error(`${label}: ${JSON.stringify(msg.error).slice(0, 300)}`);
  if (expectTool && msg.result?.isError) {
    throw new Error(`${label}: tool error ${JSON.stringify(msg.result.content).slice(0, 400)}`);
  }
  return msg;
}

const results = [];
const wanted = (name) => !ONLY || name.includes(ONLY);

/** CPU benchmark: warmup, then RUNS timed iterations. */
async function bench(name, makeReq, { tool = true, prepare, onResult } = {}) {
  if (!wanted(name)) return;
  let first;
  for (let i = 0; i < WARMUP + RUNS; i++) {
    if (prepare) await prepare();
    const r = await timedRequest(makeReq);
    check(name, r, tool);
    if (onResult) onResult(r);
    if (i === 0) first = r;
    if (i >= WARMUP) {
      bench.cur ??= [];
      bench.cur.push(r);
    }
  }
  const rs = bench.cur;
  bench.cur = undefined;
  const last = rs[rs.length - 1];
  const row = {
    name,
    cpuMs: stats(rs.map((r) => r.cpu)),
    wallMs: stats(rs.map((r) => r.wall)),
    responseBytes: last.text.length,
    firstRunMs: first.cpu,
    counters: {
      google: last.c.google.length,
      googleCalls: last.c.google,
      d1Queries: last.c.d1.queries,
      d1Stmts: last.c.d1.stmts,
      d1RowsWritten: last.c.d1.rowsWritten,
      d1ByTable: last.c.d1.byTable,
      kv: last.c.kv,
      kvPuts: last.c.kvPuts,
      ratelimit: last.c.ratelimit,
    },
  };
  results.push(row);
  const f = (x) => x.toFixed(2);
  console.log(
    `${name.padEnd(46)} p50 ${f(row.cpuMs.p50).padStart(7)}  p95 ${f(row.cpuMs.p95).padStart(7)}  max ${f(row.cpuMs.max).padStart(7)} ms | google ${row.counters.google} d1q ${row.counters.d1Queries} rows ${row.counters.d1RowsWritten} kv ${JSON.stringify(row.counters.kv)}`,
  );
  return row;
}

/** Counter-only run: the cold call (token cache empty) and the next, warm one. */
async function countOnly(name, makeReq) {
  const cold = await timedRequest(makeReq);
  check(name, cold, true);
  const warm = await timedRequest(makeReq);
  check(name, warm, true);
  const pick = (r) => ({
    google: r.c.google.length,
    d1Queries: r.c.d1.queries,
    d1RowsWritten: r.c.d1.rowsWritten,
    kv: r.c.kv,
  });
  return { name, cold: pick(cold), warm: pick(warm), calls: warm.c.google };
}

// ---- Scenarios -------------------------------------------------------------------------------------

console.log(
  `workspace-bridge budget bench: node ${process.version}, ${RUNS} runs after ${WARMUP} warmup, bundle import ${importMs.toFixed(1)} ms\n`,
);
setRoutes([GOOGLE_TOKEN]);

const owner = await newOwner();
await linkAccount(owner, { label: "work" });
const tokenFull = await mint("full", owner);
const tokenRo = await mint("ro", owner);

// Cold first request of the process: the very first MCP request after the bundle loaded.
const coldReq = await timedRequest(() =>
  mcpRequest(tokenFull, "full", "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "bench", version: "1" },
  }),
);
check("cold initialize", coldReq, false);
const coldFirstRequestMs = coldReq.cpu;
console.log(
  `cold first request (initialize, includes JIT warm-up of the whole request path): ${coldFirstRequestMs.toFixed(1)} ms\n`,
);

const INIT = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "bench", version: "1" },
};
for (const [kind, token] of [
  ["full", tokenFull],
  ["ro", tokenRo],
]) {
  await bench(
    `initialize /mcp${kind === "ro" ? "/ro" : ""}`,
    () => mcpRequest(token, kind, "initialize", INIT),
    { tool: false },
  );
  const list = await timedRequest(() => mcpRequest(token, kind, "tools/list"));
  const tools = check("tools/list", list, false).result.tools.length;
  await bench(
    `tools/list /mcp${kind === "ro" ? "/ro" : ""} (${tools} tools)`,
    () => mcpRequest(token, kind, "tools/list"),
    { tool: false },
  );
}

await bench("tools/call list_accounts (1 account)", () =>
  mcpRequest(tokenFull, "full", "tools/call", { name: "list_accounts", arguments: {} }),
);

// search_threads, account "all", two accounts, the largest page.
{
  const o = await newOwner();
  await linkAccount(o, { label: "work" });
  await linkAccount(o, { label: "home" });
  const t = await mint("full", o);
  setRoutes([GOOGLE_TOKEN, ...gmailSearchRoutes(25)]);
  await bench("search_threads all x2 accounts, pageSize 25", () =>
    mcpRequest(t, "full", "tools/call", {
      name: "search_threads",
      arguments: { account: "all", query: "newer_than:7d", pageSize: 25 },
    }),
  );
  await bench("search_threads 1 account, pageSize 20", () =>
    mcpRequest(t, "full", "tools/call", {
      name: "search_threads",
      arguments: { account: "work", query: "newer_than:7d" },
    }),
  );
}

// get_thread on 20 messages. Typical: plain + 40 KB HTML each. Worst: HTML only, 300 KB each
// (past the 256 KB decode budget, so the clip engages).
{
  const o = await newOwner();
  await linkAccount(o, { label: "work" });
  const t = await mint("full", o);
  for (const [label, opts] of [
    ["typical, 20 msgs, plain + 40 KB html", { htmlBytes: 40_000, plain: true }],
    ["worst, 20 msgs, 300 KB html only", { htmlBytes: 300_000, plain: false }],
  ]) {
    const body = threadFull(20, opts);
    setRoutes([GOOGLE_TOKEN, ...gmailThreadRoutes(body)]);
    await bench(`get_thread ${label} (${(body.length / 1e6).toFixed(1)} MB)`, () =>
      mcpRequest(t, "full", "tools/call", { name: "get_thread", arguments: { threadId: "t1" } }),
    );
  }
}

// send_message with one attachment at MAX_SEND_ATTACHMENT_BYTES.
{
  const o = await newOwner();
  await linkAccount(o, { label: "work" });
  const t = await mint("full", o);
  const content = Buffer.alloc(524288, 7).toString("base64");
  setRoutes([
    GOOGLE_TOKEN,
    {
      method: "POST",
      url: "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send",
      reply: () => json(200, { id: "sent1", threadId: "th1", labelIds: ["SENT"] }),
    },
  ]);
  await bench("send_message + 512 KB attachment", () =>
    mcpRequest(t, "full", "tools/call", {
      name: "send_message",
      arguments: {
        to: ["friend@example.com"],
        subject: "Report",
        body: "See attached.",
        attachments: [{ content, filename: "report.bin", mimeType: "application/octet-stream" }],
      },
    }),
  );
  await bench("send_message, no attachment", () =>
    mcpRequest(t, "full", "tools/call", {
      name: "send_message",
      arguments: { to: ["friend@example.com"], subject: "Hi", body: "Short note." },
    }),
  );
}

// download_file_content at the 512 KB cap.
{
  const o = await newOwner();
  await linkAccount(o, { label: "work" });
  const t = await mint("full", o);
  const bytes = Buffer.alloc(524288, 9);
  setRoutes([
    GOOGLE_TOKEN,
    {
      url: `${DRIVE}/files/F1`,
      reply: ({ url }) =>
        url.searchParams.get("alt") === "media"
          ? { status: 200, headers: { "Content-Type": "application/pdf" }, body: bytes }
          : json(200, {
              id: "F1",
              name: "report.pdf",
              mimeType: "application/pdf",
              size: "524288",
              ownedByMe: true,
            }),
    },
  ]);
  await bench("download_file_content at 512 KB cap", () =>
    mcpRequest(t, "full", "tools/call", {
      name: "download_file_content",
      arguments: { fileId: "F1" },
    }),
  );
}

// Google token refresh: a fresh account with an expired access token each iteration.
if (wanted("google token refresh")) {
  const o = await newOwner();
  const t = await mint("full", o);
  setRoutes([GOOGLE_TOKEN, ...driveListRoutes(10)]);
  let acct;
  await bench(
    "tools/call search_files + Google token refresh",
    () =>
      mcpRequest(t, "full", "tools/call", {
        name: "search_files",
        arguments: { query: "x", account: acct.label },
      }),
    {
      prepare: async () => {
        acct = await linkAccount(o, { expired: true });
      },
    },
  );
}

// OAuth endpoints (the MCP client side).
if (wanted("oauth")) {
  const o = await newOwner();
  const pre = [];
  const prepare = async () => {
    pre.push(await authorizeCode("full", o));
  };
  await bench("oauth /token code exchange", () => exchange(pre.pop()), { tool: false, prepare });
  const a = await authorizeCode("full", o);
  let refresh = (await (await B.worker.fetch(exchange(a), env, makeCtx())).json()).refresh_token;
  await bench(
    "oauth /token refresh_token rotation",
    () =>
      tokenRequest({ grant_type: "refresh_token", refresh_token: refresh, client_id: a.clientId }),
    {
      tool: false,
      onResult: (r) => {
        refresh = JSON.parse(r.text).refresh_token;
      },
    },
  );
}

// Fan-out: Google subrequests of every `account: "all"` tool, for 1, 2 and 4 accounts.
const fan = [];
if (wanted("fan-out")) {
  const tools = [
    ["search_threads", { account: "all", query: "x", pageSize: 25 }, () => gmailSearchRoutes(25)],
    [
      "list_events",
      { account: "all", startTime: "2030-01-07T00:00:00Z", endTime: "2030-01-08T00:00:00Z" },
      () => calendarRoutes(25),
    ],
    ["search_events", { account: "all", query: "x" }, () => calendarRoutes(25)],
    ["search_contacts", { account: "all", query: "ada", pageSize: 30 }, contactsRoutes],
    ["search_files", { account: "all", query: "x", pageSize: 25 }, () => driveListRoutes(25)],
    ["list_recent_files", { account: "all" }, () => driveListRoutes(25)],
  ];
  for (const [tool, args, mk] of tools) {
    for (const n of [1, 2, 4]) {
      const o = await newOwner();
      for (let i = 0; i < n; i++) await linkAccount(o);
      const t = await mint("full", o);
      setRoutes([GOOGLE_TOKEN, ...mk()]);
      const r = await countOnly(`${tool} all x${n}`, () =>
        mcpRequest(t, "full", "tools/call", { name: tool, arguments: args }),
      );
      fan.push({ tool, accounts: n, ...r });
      console.log(
        `fan-out ${tool} x${n}: cold google ${r.cold.google} d1q ${r.cold.d1Queries} | warm google ${r.warm.google} d1q ${r.warm.d1Queries}`,
      );
    }
  }
}

// Daily cleanup (cron).
if (wanted("cleanup")) {
  C = fresh();
  shim.ms = 0;
  const t0 = performance.now();
  await B.cleanup(env);
  const wall = performance.now() - t0;
  const row = {
    name: "scheduled cleanup (cron)",
    cpuMs: { p50: wall - shim.ms },
    counters: { d1Queries: C.d1.queries, d1RowsWritten: C.d1.rowsWritten, kv: C.kv },
  };
  results.push(row);
  console.log(
    `cleanup: cpu ${(wall - shim.ms).toFixed(2)} ms, d1q ${C.d1.queries}, kv ${JSON.stringify(C.kv)}`,
  );
}

// OAuth KV write accounting: one client's life (register, authorize, code exchange, refresh).
const oauthKv = {};
if (wanted("kv-accounting")) {
  const o = await newOwner();
  const step = async (name, f) => {
    C = fresh();
    shim.ms = 0;
    await f();
    oauthKv[name] = { kv: { ...C.kv }, puts: [...C.kvPuts] };
  };
  let client;
  await step("register client (/oauth/register)", async () => {
    const res = await B.worker.fetch(
      new Request(new URL("/oauth/register", ISSUER), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: "none",
          client_name: "bench",
        }),
      }),
      env,
      makeCtx(),
    );
    client = await res.json();
  });
  let a;
  await step("authorize (parse + complete, after Google sign-in)", async () => {
    a = await authorizeCode("full", o);
  });
  let tok;
  await step("token: authorization_code exchange", async () => {
    tok = await (await B.worker.fetch(exchange(a), env, makeCtx())).json();
  });
  await step("token: refresh_token grant (access token rotation)", async () => {
    const res = await B.worker.fetch(
      tokenRequest({
        grant_type: "refresh_token",
        refresh_token: tok.refresh_token,
        client_id: a.clientId,
      }),
      env,
      makeCtx(),
    );
    await res.text();
  });
  void client;
  await step("one tool call with the access token", async () => {
    await timedRequest(() =>
      mcpRequest(tok.access_token, "full", "tools/call", { name: "list_accounts", arguments: {} }),
    );
  });
  console.log("\nOAuth KV operations per step:");
  for (const [k, v] of Object.entries(oauthKv))
    console.log(`  ${k}: ${JSON.stringify(v.kv)} puts=${v.puts.join(",")}`);
}

const out = {
  node: process.version,
  runs: RUNS,
  warmup: WARMUP,
  importMs,
  coldFirstRequestMs,
  results,
  fan,
  oauthKv,
  seqScans: [...scans],
};
writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
console.log(`\nresults written to ${JSON_OUT}`);
if (out.seqScans.length)
  console.log(`full-table scans in D1 queries:\n  ${out.seqScans.join("\n  ")}`);
