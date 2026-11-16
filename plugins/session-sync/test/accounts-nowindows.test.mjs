/**
 * T22 - no windows: a static scan of lib/** finds `windowsHide: true` on every
 * child-process call, and no powershell spawn that is detached (a detached
 * Windows child ignores windowsHide and pops a console).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib');

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

/** Blank out comments and string/template contents are NOT removed (we need 'powershell' literals); only comments. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

/** The text between the parentheses of the call starting at `open` (balanced; strings respected). */
function callArgs(src, open) {
  let depth = 0; let q = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

const CALL = /(^|[^.\w$])(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork|spawnFn)\s*\(/g;

function findCalls(file) {
  const raw = readFileSync(file, 'utf8');
  if (!/node:child_process|child_process/.test(raw) && !/spawnFn/.test(raw)) return [];
  const src = stripComments(raw);
  const out = [];
  for (const m of src.matchAll(CALL)) {
    const open = m.index + m[0].length - 1;
    if (/function\s*\*?\s*$/.test(src.slice(Math.max(0, m.index - 20), m.index + m[1].length))) continue;   // a definition, not a call
    const args = callArgs(src, open);
    out.push({ file, name: m[2], args, line: src.slice(0, m.index).split('\n').length, src });
  }
  return out;
}

/** `windowsHide: true` inline, or a trailing identifier whose definition sets it. */
function hasWindowsHide(call) {
  if (/windowsHide\s*:\s*true/.test(call.args)) return true;
  const last = call.args.split(',').pop().trim();
  if (/^[A-Za-z_$][\w$]*$/.test(last)) {
    return new RegExp(`\\b${last}\\s*=[^;]*windowsHide\\s*:\\s*true`).test(call.src);
  }
  return false;
}

test('T22 the scan finds the child-process calls it is meant to guard', () => {
  const all = walk(LIB).flatMap(findCalls);
  assert.ok(all.length >= 5, `expected the known spawn sites, found ${all.length}`);
  assert.ok(all.some((c) => /accounts[\\/]appstate/.test(c.file)), 'the new appstate probe is in scope');
  assert.ok(all.some((c) => /rollback-standalone/.test(c.file)), 'the standalone rollback is in scope');
});

test('T22 every spawn/exec/fork in lib/** sets windowsHide: true', () => {
  const bad = walk(LIB).flatMap(findCalls).filter((c) => !hasWindowsHide(c))
    .map((c) => `${relative(LIB, c.file)}:${c.line} ${c.name}(...)`);
  assert.deepEqual(bad, [], `child-process calls without windowsHide: true:\n${bad.join('\n')}`);
});

test('T22 no powershell spawn is detached', () => {
  const bad = walk(LIB).flatMap(findCalls)
    .filter((c) => /['"`](powershell|pwsh)(\.exe)?['"`]/i.test(c.args))
    .filter((c) => /detached\s*:\s*true/.test(c.args))
    .map((c) => `${relative(LIB, c.file)}:${c.line}`);
  assert.deepEqual(bad, []);
});

test('T22 the scanner itself catches a missing windowsHide and a detached powershell', () => {
  const src = "import { spawn } from 'node:child_process';\nspawn('powershell.exe', ['-x'], { detached: true });\nspawn('node', []);\n";
  const fake = { file: 'x.mjs', src, line: 2 };
  const calls = [...src.matchAll(CALL)].map((m) => ({ ...fake, name: m[2], args: callArgs(src, m.index + m[0].length - 1) }));
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => !hasWindowsHide(c)));
  assert.ok(/detached\s*:\s*true/.test(calls[0].args) && /powershell/.test(calls[0].args));
});
