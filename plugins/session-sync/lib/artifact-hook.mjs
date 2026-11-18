#!/usr/bin/env node
/**
 * artifact-hook.mjs - the two hook commands of the artifact share (artifacts.mjs). A separate, small entry point on purpose: they run
 * in every session (the wake on every prompt), and cli.mjs loads the whole sync engine first.
 *
 *   node artifact-hook.mjs capture   PostToolUse, matcher "Artifact": queue a newly published artifact. Prints nothing.
 *   node artifact-hook.mjs wake      UserPromptSubmit: tell ONE session to share when a browser reachable from its account can send or accept
 *                                    an entry (entries 2+ minutes old, once per 30 minutes per account). Prints nothing otherwise.
 *
 * Any error: exit 0 with no output, so a prompt or a tool call is never broken by this.
 */

import { appendFileSync, mkdirSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR, loadConfig } from './config.mjs';
import { QUEUE_DIR, entryFromHook, isNewArtifact, enqueue, wake, featureOn, activeAccount, interactiveSessionFor } from './artifacts.mjs';

const mode = process.argv[2];

function log(line) {
  try { mkdirSync(STATE_DIR, { recursive: true }); appendFileSync(join(STATE_DIR, 'sync.log'), `${new Date().toISOString()}  ${line}\n`); } catch { /* ignore */ }
}

/**
 * The hook payload from stdin. Read as a stream, not with readFileSync(0): on macOS a pipe whose data has not arrived yet makes the
 * synchronous read throw EAGAIN, which here would silently drop the payload (a CI run lost one of nine concurrent captures that way).
 * A 3 s timer keeps a runner that never closes stdin from holding the prompt.
 */
async function readInput() {
  if (process.stdin.isTTY) return {};
  try {
    const text = await new Promise((resolve) => {
      const chunks = [];
      const done = () => resolve(Buffer.concat(chunks).toString('utf8'));
      const timer = setTimeout(done, 3000);
      process.stdin.on('data', (c) => chunks.push(c));
      process.stdin.on('end', () => { clearTimeout(timer); done(); });
      process.stdin.on('error', () => { clearTimeout(timer); done(); });
    });
    const j = JSON.parse(text || '{}');
    return j && typeof j === 'object' ? j : {};
  } catch { return {}; }
}

try {
  const input = await readInput();
  if (mode === 'capture') {
    // Cheapest checks first: the matcher already limits this to the Artifact tool, and only a publish without a url is new.
    if (input.tool_name === 'Artifact' && isNewArtifact(input.tool_input)) {
      const cfg = loadConfig();
      if (featureOn(cfg)) {
        const entry = entryFromHook(input, { ownerAccount: await activeAccount() });
        if (entry) {
          const r = enqueue(QUEUE_DIR, entry);
          if (r.added) log(`artifact-share: queued ${entry.id} (owner ${entry.ownerAccount ? entry.ownerAccount.slice(0, 8) : 'unknown'})`);
        }
      }
    }
  } else if (mode === 'wake') {
    const prompt = String(input.prompt ?? '').trim();
    const sid = typeof input.session_id === 'string' ? input.session_id : '';
    if (prompt && sid && !prompt.startsWith('/')) {
      const d = await wake({ cfg: loadConfig(), sessionCheck: (active) => interactiveSessionFor(active, sid) });
      if (d.act) {
        log(`artifact-share: instruction given to session ${String(input.session_id ?? '').slice(0, 8)} for ${d.due.length} artifact(s)`);
        try { writeSync(1, `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: d.text } })}\n`); } catch { /* no stdout */ }
      }
    }
  }
} catch (e) { log(`artifact-share ${mode} failed: ${e?.message || e}`); }
process.exit(0);
