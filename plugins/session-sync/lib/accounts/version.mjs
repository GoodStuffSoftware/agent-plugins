/** The plugin version of this copy (plugin.json), or null when it cannot be read. Claims record it so a newer copy can replace an older background process. */
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

export const PLUGIN_VERSION = (() => {
  try { return String(JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8')).version ?? '') || null; } catch { return null; }
})();

const LIB_DIR = fileURLToPath(new URL('../', import.meta.url));

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
