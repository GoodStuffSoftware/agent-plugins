/**
 * sandbox-env.mjs — loaded with `node --import` BEFORE any test or lib module,
 * so that `npm test` is structurally incapable of reading or writing the real
 * user's Claude data.
 *
 * WHY THIS HAS TO BE A PRELOAD
 * ---------------------------------------------------------------------------
 * Overriding env per-child-process (which is what test/cli.test.mjs used to do)
 * covers the CLI subprocesses and nothing else. The in-process tests import
 * lib/config.mjs and lib/sync.mjs directly, and those modules resolve
 * STATE_DIR / CONFIG_FILE / MANIFEST_FILE / FIRST_SUCCESS_MARKER from
 * os.homedir() AT IMPORT TIME. By then it is too late to redirect them. A
 * preload runs first, so every module in the run — and every process it
 * spawns, which inherits this env — sees the sandbox.
 *
 * AND WHY IT COVERS MORE THAN HOME
 * ---------------------------------------------------------------------------
 * lib/paths.mjs deliberately probes `process.env.APPDATA` directly, on top of
 * the homedir-derived candidates, as its documented workaround for the desktop
 * app's MSIX %APPDATA% redirection. So a test run that overrode only
 * USERPROFILE still found the REAL `AppData\Roaming\Claude\claude-code-sessions`
 * and `local-agent-mode-sessions` — and an adversarial review confirmed by
 * execution that real conversation index data was being copied into a scratch
 * temp folder on every `npm test` on a developer machine. Every variable the
 * plugin can reach real data through is redirected here:
 *
 *   USERPROFILE      os.homedir() on Windows -> ~/.claude, the state dir
 *   HOME             os.homedir() on POSIX
 *   APPDATA          paths.mjs's direct probe (and rclone.conf discovery)
 *   XDG_CONFIG_HOME  paths.mjs's Linux desktop-data root
 *
 * NOT redirected, on purpose: LOCALAPPDATA / ProgramFiles / PATH. Those are
 * only ever read by rclone.mjs to LOCATE THE RCLONE BINARY, never to find user
 * data. Redirecting them would just make every rclone-backed test skip.
 *
 * test/sandbox.test.mjs asserts all of this from inside the run, rather than
 * trusting this comment.
 */

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SANDBOX = mkdtempSync(join(tmpdir(), 'ss-test-sandbox-'));

// Kept so tests can assert the real locations are NOT what got resolved.
process.env.SESSION_SYNC_TEST_SANDBOX = SANDBOX;
process.env.SESSION_SYNC_TEST_REAL_USERPROFILE = process.env.USERPROFILE || '';
process.env.SESSION_SYNC_TEST_REAL_APPDATA = process.env.APPDATA || '';
process.env.SESSION_SYNC_TEST_REAL_HOME = process.env.HOME || '';

const home = join(SANDBOX, 'home');
mkdirSync(join(home, '.claude'), { recursive: true });
mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true });

process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.APPDATA = join(home, 'AppData', 'Roaming');
process.env.XDG_CONFIG_HOME = join(home, '.config');

// A stray CLAUDE_SESSION_SYNC_REMOTE in the developer's own shell would point
// real pushes at a real remote. Tests set their own per-case.
delete process.env.CLAUDE_SESSION_SYNC_REMOTE;

process.on('exit', () => {
  try { rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* OS temp cleanup will get it */ }
});
