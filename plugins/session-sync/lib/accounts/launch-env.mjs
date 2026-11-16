/**
 * launch-env.mjs - a `node --import` preload used by launcher.mjs on Windows.
 *
 * A process made by CIM Win32_Process.Create does not inherit the caller's environment.
 * The launcher writes the few variables the child needs into a JSON file and appends
 * `--ss-env-file <file>` to the command line; this preload applies them to process.env
 * BEFORE cli.mjs loads (config.mjs resolves its paths at import time), removes the two
 * arguments so the CLI's own argument handling never sees them, and deletes the file.
 */

import { readFileSync, unlinkSync } from 'node:fs';

const i = process.argv.indexOf('--ss-env-file');
if (i >= 0) {
  const file = process.argv[i + 1];
  process.argv.splice(i, 2);
  try {
    const o = JSON.parse(readFileSync(file, 'utf8'));
    for (const [k, v] of Object.entries(o)) if (typeof v === 'string') process.env[k] = v;
  } catch { /* no file: run with the default environment */ }
  try { unlinkSync(file); } catch { /* gone */ }
}
