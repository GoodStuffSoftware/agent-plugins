/** The plugin version of this copy (plugin.json), or null when it cannot be read. Claims record it so a newer copy can replace an older background process. */
import { readFileSync } from 'node:fs';

export const PLUGIN_VERSION = (() => {
  try { return String(JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8')).version ?? '') || null; } catch { return null; }
})();
