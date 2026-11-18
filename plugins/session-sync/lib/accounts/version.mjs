/** The plugin version of this copy (plugin.json), or null when it cannot be read. Claims record it so a newer copy can replace an older background process. */
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

export const PLUGIN_VERSION = (() => {
  try { return String(JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8')).version ?? '') || null; } catch { return null; }
})();

/**
 * Semver order of two version strings: -1 (a older), 0 (equal), 1 (a newer), or null when either is not a version. Numeric parts are
 * compared as numbers (0.5.10 is newer than 0.5.9); a pre-release is older than its release (1.0.0-rc.1 < 1.0.0); build metadata
 * (+...) is ignored. A leading v is allowed.
 */
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v ?? '').trim());
    return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] } : null;
  };
  const x = parse(a); const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] < y.n[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : (x.pre.length ? -1 : 1);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]; const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p); const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

const LIB_DIR =fileURLToPath(new URL('../', import.meta.url));

function* sourceFiles(dir) {
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* sourceFiles(p);
    else if (/\.(mjs|ps1)$/.test(e.name)) yield p;
  }
}

/**
 * A short hash of this copy's code (every .mjs and .ps1 under lib/), so a waiter started from a build that has the same version
 * number but other code (a fix shipped without a version bump, a development copy) is told apart from the installed one (S5).
 * Computed once per process, at the first call; null when the code cannot be read.
 */
let memo;
export function codeHash(dir = LIB_DIR) {
  if (dir === LIB_DIR && memo !== undefined) return memo;
  let out = null;
  try {
    const h = createHash('sha256');
    for (const f of sourceFiles(dir)) { h.update(relative(dir, f).replace(/\\/g, '/')); h.update('\0'); h.update(readFileSync(f)); h.update('\0'); }
    out = h.digest('hex').slice(0, 16);
  } catch { out = null; }
  if (dir === LIB_DIR) memo = out;
  return out;
}
