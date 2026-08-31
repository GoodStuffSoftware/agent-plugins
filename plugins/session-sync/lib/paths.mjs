/**
 * paths.mjs — locate the two things that have to travel for a conversation to
 * actually come back on another machine.
 *
 * THE WHOLE POINT OF THIS FILE
 * ---------------------------------------------------------------------------
 * Claude Code keeps conversation data in TWO places, and every sync tool we
 * surveyed copies only the first:
 *
 *   1. ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
 *        The transcript. Copy this and `claude --resume` can find the chat.
 *
 *   2. <desktop-app-data>/claude-code-sessions/<userId>/<workspaceId>/
 *          local_<session-uuid>.json
 *        The DESKTOP APP'S OWN INDEX. This is what puts a conversation in the
 *        sidebar. The app builds it on first run and does NOT rebuild it when
 *        it finds an already-populated ~/.claude, so a machine restored from
 *        transcripts alone shows an EMPTY sidebar while the data sits on disk.
 *        (anthropics/claude-code#69585)
 *
 * Sync (1) only and users are told to live in `claude --resume`. Sync (1)+(2)
 * and the conversation is simply *there* when they open the app. That is the
 * only reason this plugin exists.
 *
 * NEVER TRUST process.env FOR THESE
 * ---------------------------------------------------------------------------
 * On Windows the desktop app ships as an MSIX package, which REDIRECTS %APPDATA%
 * for anything it launches. A scheduled task or hook started under it sees
 *   %APPDATA% = %LOCALAPPDATA%\Packages\Claude_<pkg>\LocalCache\Roaming
 * so `%APPDATA%\Claude\claude-code-sessions` silently resolves to a path that
 * may not exist -> the sync logs "skip (missing)" and reports success while
 * copying nothing. Measured 2026-08-30. We probe candidates instead.
 *
 * VERIFICATION STATUS: the Windows layouts (both plain and MSIX-redirected) are
 * confirmed on real machines. The macOS and Linux candidates follow Electron's
 * standard userData locations and are believed-correct but unverified — they are
 * probed, never assumed, and `resolveAll()` reports what it actually found.
 */

import { homedir, platform } from 'node:os';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const SESSION_DIRS = ['claude-code-sessions', 'local-agent-mode-sessions'];

/** ~/.claude — transcripts, memory, rules, agents, skills. Same on every OS. */
export function claudeHome() {
  return join(homedir(), '.claude');
}

/**
 * Candidate roots for the DESKTOP app's data dir, most-specific first.
 * We return every plausible root and let the caller probe; that is what makes
 * this robust against the MSIX redirection above.
 */
export function desktopDataRoots() {
  const home = homedir();
  const p = platform();

  if (p === 'win32') {
    const roots = [];
    // The literal, non-redirected profile path. Correct even when %APPDATA%
    // has been redirected out from under us, which is why it goes FIRST.
    roots.push(join(home, 'AppData', 'Roaming', 'Claude'));
    // Whatever the environment claims (correct in a plain shell).
    if (process.env.APPDATA) roots.push(join(process.env.APPDATA, 'Claude'));
    // The MSIX package container. The package id can change between releases,
    // so glob-ish match rather than hardcoding one.
    const pkgs = join(home, 'AppData', 'Local', 'Packages');
    if (existsSync(pkgs)) {
      try {
        for (const d of readdirSync(pkgs)) {
          if (d.startsWith('Claude_')) {
            roots.push(join(pkgs, d, 'LocalCache', 'Roaming', 'Claude'));
          }
        }
      } catch { /* directory unreadable — fall through to what we have */ }
    }
    return dedupe(roots);
  }

  if (p === 'darwin') {
    return dedupe([
      join(home, 'Library', 'Application Support', 'Claude'),
    ]);
  }

  // Linux + everything else: Electron's XDG userData location.
  return dedupe([
    process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, 'Claude') : null,
    join(home, '.config', 'Claude'),
  ].filter(Boolean));
}

/**
 * Resolve the real session-store directories on this machine.
 * Returns { 'claude-code-sessions': '/abs/path', ... } omitting any not found.
 */
export function sessionStores() {
  const found = {};
  for (const name of SESSION_DIRS) {
    for (const root of desktopDataRoots()) {
      const candidate = join(root, name);
      if (isDir(candidate)) { found[name] = candidate; break; }
    }
  }
  return found;
}

/**
 * Everything this plugin syncs, plus what it deliberately does NOT.
 * `missing` is surfaced to the user rather than swallowed — a silent skip is
 * how you end up "successfully" syncing nothing.
 */
export function resolveAll() {
  const stores = sessionStores();
  const missing = SESSION_DIRS.filter((d) => !stores[d]);
  return {
    platform: platform(),
    claudeHome: claudeHome(),
    claudeHomeExists: isDir(claudeHome()),
    sessionStores: stores,
    missing,
    // Credentials and machine-bound tokens never leave the machine. A copied
    // auth token fails on the far side rather than helping, and putting live
    // tokens in cloud storage is a needless exposure.
    excludes: [
      'cache/**',
      '.credentials.json',
      '.claude.json',
      'mcp.json',
      '.deckhand-bus-token',
      '.deckhand-machine-oauth.json',
      'statsig/**',
      'shell-snapshots/**',
    ],
  };
}

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function dedupe(arr) {
  return [...new Set(arr)];
}
