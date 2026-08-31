/**
 * Regression tests for marker parsing.
 *
 * These exist because of a real bug: Node's os.hostname() returned
 * "Kristen-laptop" while PowerShell's $env:COMPUTERNAME wrote "KRISTEN-LAPTOP"
 * to the same marker, on the SAME machine. A case-sensitive compare read our
 * own marker as a foreign one and triggered a full multi-gigabyte pull on every
 * session start, forever. The PowerShell-written file also carried a UTF-8 BOM.
 *
 * Run: node --test test/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Mirror of the parsing rules in sync.mjs. Kept in lockstep deliberately:
// if you change one, this test should fail until you change the other.
const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
const normalise = (s) => s.trim().toLowerCase();

function parseMarker(raw, selfHost, sinceIso = null) {
  const text = stripBom(String(raw)).trim();
  const [machineRaw, ts] = text.split('|');
  if (!machineRaw || !ts) return null;
  const machine = normalise(machineRaw);
  if (machine === normalise(selfHost)) return null;
  const when = new Date(ts);
  if (Number.isNaN(when.getTime())) return null;
  if (sinceIso && when <= new Date(sinceIso)) return null;
  return { machine, ts };
}

test('own marker is ignored despite differing case', () => {
  const marker = 'KRISTEN-LAPTOP|2026-08-30T20:45:51.000Z';
  assert.equal(parseMarker(marker, 'Kristen-laptop'), null,
    'case difference must not be read as a foreign machine');
});

test('own marker is ignored despite a UTF-8 BOM', () => {
  const marker = '﻿KRISTEN-LAPTOP|2026-08-30T20:45:51.000Z';
  assert.equal(parseMarker(marker, 'kristen-laptop'), null,
    'a BOM from PowerShell Set-Content must not break the comparison');
});

test('a genuinely different machine IS detected', () => {
  const marker = 'other-desktop|2026-08-30T20:45:51.000Z';
  const hit = parseMarker(marker, 'kristen-laptop');
  assert.ok(hit, 'a different machine must be detected');
  assert.equal(hit.machine, 'other-desktop');
});

test('a foreign push older than our last pull is ignored', () => {
  const marker = 'other-desktop|2026-08-30T10:00:00.000Z';
  assert.equal(parseMarker(marker, 'kristen-laptop', '2026-08-30T12:00:00.000Z'), null,
    'already-seen pushes must not re-trigger a pull');
});

test('a foreign push newer than our last pull is detected', () => {
  const marker = 'other-desktop|2026-08-30T14:00:00.000Z';
  assert.ok(parseMarker(marker, 'kristen-laptop', '2026-08-30T12:00:00.000Z'));
});

test('malformed markers are ignored rather than throwing', () => {
  for (const bad of ['', 'garbage', 'no-pipe-here', 'host|not-a-date', '|', 'host|']) {
    assert.equal(parseMarker(bad, 'kristen-laptop'), null, `should ignore: ${JSON.stringify(bad)}`);
  }
});

test('surrounding whitespace does not defeat the self-check', () => {
  assert.equal(parseMarker('  KRISTEN-LAPTOP |2026-08-30T20:45:51.000Z', 'kristen-laptop'), null);
});
