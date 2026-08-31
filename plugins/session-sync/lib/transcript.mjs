/**
 * transcript.mjs — decide whether a replaced conversation file was a
 * fast-forward or a genuine divergence.
 *
 * THE PROBLEM
 * A conversation transcript is append-only JSONL: one JSON object per line,
 * each with its own `uuid`. Sync compares MTIME and lets the newer file win
 * outright. That is right when you continued the chat on one machine (the newer
 * file simply contains the older one) and WRONG when you added messages on two
 * machines — the loser's messages vanish with no error and no trace.
 *
 * WHAT WE DO
 * Pull runs with rclone's --backup-dir, so any local file about to be
 * overwritten is moved aside rather than destroyed. Afterwards we look at what
 * was moved:
 *
 *   fast-forward  every uuid in the old file is still present in the new one.
 *                 Nothing was lost; the moved-aside copy is redundant.
 *   diverged      the old file has uuids the new one lacks. Both versions hold
 *                 real messages, so BOTH are kept and the user is told.
 *
 * WHAT WE DELIBERATELY DO NOT DO
 * Merge divergent transcripts. A union of two branches is computable — dedupe
 * by uuid, sort by timestamp — but it would fabricate a conversation that never
 * happened: two different replies to the same message, interleaved and
 * plausible. A visible extra file is a far better failure than a transcript
 * that reads fine and is not true.
 */

import { readFileSync } from 'node:fs';

/** Line uuids, in order. Returns null if this is not a transcript we understand. */
export function transcriptUuids(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  if (!text.trim()) return [];

  const uuids = [];
  let sawJson = false;
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try { obj = JSON.parse(s); } catch { continue; }   // partial last line is normal
    sawJson = true;
    if (obj && typeof obj.uuid === 'string') uuids.push(obj.uuid);
  }
  return sawJson ? uuids : null;
}

/**
 * Compare a moved-aside copy against the file that replaced it.
 * @returns 'fast-forward' | 'diverged' | 'identical' | 'unknown'
 */
export function classifyReplacement(oldFile, newFile) {
  const oldIds = transcriptUuids(oldFile);
  const newIds = transcriptUuids(newFile);

  // Not JSONL, or unreadable — cannot reason about it, so treat as a conflict
  // and keep the copy. Erring toward keeping data is the whole point.
  if (oldIds === null || newIds === null) return 'unknown';

  if (oldIds.length === 0) return 'fast-forward';        // empty old file, nothing to lose
  const newSet = new Set(newIds);
  const lost = oldIds.filter((id) => !newSet.has(id));

  if (lost.length === 0) {
    return oldIds.length === newIds.length ? 'identical' : 'fast-forward';
  }
  return 'diverged';
}

/** How many messages would have been lost. Used for the message to the user. */
export function lostCount(oldFile, newFile) {
  const oldIds = transcriptUuids(oldFile) || [];
  const newIds = new Set(transcriptUuids(newFile) || []);
  return oldIds.filter((id) => !newIds.has(id)).length;
}
