#!/usr/bin/env node
/**
 * sync-plugins.mjs — single source of truth is each plugin's own manifest.
 *
 * Walks plugins/<name>/.claude-plugin/plugin.json and makes sure:
 *   1. .claude-plugin/marketplace.json has an entry per plugin, with a version
 *      matching that plugin's manifest.
 *   2. release-please-config.json has a package entry per plugin.
 *   3. .release-please-manifest.json has a version per plugin.
 *
 * WHY THIS EXISTS: a plugin's version lives in plugin.json (highest precedence
 * in Claude Code's version resolution), but the marketplace entry and the
 * release tooling each keep their own copy. Hand-maintaining three copies is
 * how a release ships with a stale version and users never receive the update.
 *
 *   node scripts/sync-plugins.mjs           apply
 *   node scripts/sync-plugins.mjs --check   fail if anything is out of sync (CI)
 *
 * Pattern adapted from Nagell/claude-marketplace-template — see CREDITS.md.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');

const MARKETPLACE = join(ROOT, '.claude-plugin', 'marketplace.json');
const RP_CONFIG = join(ROOT, 'release-please-config.json');
const RP_MANIFEST = join(ROOT, '.release-please-manifest.json');
const PLUGINS_DIR = join(ROOT, 'plugins');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const changes = [];

/** Discover every plugin that has a manifest. */
function discover() {
  if (!existsSync(PLUGINS_DIR)) return [];
  return readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const manifest = join(PLUGINS_DIR, d.name, '.claude-plugin', 'plugin.json');
      if (!existsSync(manifest)) return null;
      const json = readJson(manifest);
      return {
        dir: `plugins/${d.name}`,
        name: json.name || d.name,
        version: json.version,
        description: json.description,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

const plugins = discover();
if (!plugins.length) {
  console.error('no plugins found under plugins/ — nothing to sync');
  process.exit(1);
}

// ---- 1. marketplace.json -----------------------------------------------------
const market = readJson(MARKETPLACE);
market.plugins ||= [];
for (const p of plugins) {
  let entry = market.plugins.find((e) => e.name === p.name);
  if (!entry) {
    entry = { name: p.name, source: `./${p.dir}`, description: p.description };
    market.plugins.push(entry);
    changes.push(`marketplace.json: added entry for ${p.name}`);
  }
  if (p.version && entry.version !== p.version) {
    changes.push(`marketplace.json: ${p.name} version ${entry.version ?? '(unset)'} -> ${p.version}`);
    entry.version = p.version;
  }
  if (entry.source !== `./${p.dir}`) {
    changes.push(`marketplace.json: ${p.name} source -> ./${p.dir}`);
    entry.source = `./${p.dir}`;
  }
}
market.plugins.sort((a, b) => a.name.localeCompare(b.name));

// ---- 2. release-please-config.json ------------------------------------------
const rp = existsSync(RP_CONFIG) ? readJson(RP_CONFIG) : { packages: {} };
rp.packages ||= {};
for (const p of plugins) {
  if (!rp.packages[p.dir]) {
    rp.packages[p.dir] = {
      'release-type': 'simple',
      'package-name': p.name,
      'tag-separator': '@',
      component: p.name,
      'changelog-path': 'CHANGELOG.md',
      'extra-files': [
        { type: 'json', path: '.claude-plugin/plugin.json', jsonpath: '$.version' },
      ],
    };
    changes.push(`release-please-config.json: added package ${p.dir}`);
  }
}

// ---- 3. .release-please-manifest.json ---------------------------------------
const rpm = existsSync(RP_MANIFEST) ? readJson(RP_MANIFEST) : {};
for (const p of plugins) {
  if (p.version && rpm[p.dir] !== p.version) {
    changes.push(`.release-please-manifest.json: ${p.dir} ${rpm[p.dir] ?? '(unset)'} -> ${p.version}`);
    rpm[p.dir] = p.version;
  }
}

// ---- report / write ----------------------------------------------------------
if (!changes.length) {
  console.log(`in sync — ${plugins.length} plugin(s): ${plugins.map((p) => `${p.name}@${p.version}`).join(', ')}`);
  process.exit(0);
}

console.log('out of sync:');
for (const c of changes) console.log(`  ${c}`);

if (CHECK) {
  console.error('\nrun `node scripts/sync-plugins.mjs` and commit the result');
  process.exit(1);
}

writeFileSync(MARKETPLACE, JSON.stringify(market, null, 2) + '\n');
writeFileSync(RP_CONFIG, JSON.stringify(rp, null, 2) + '\n');
writeFileSync(RP_MANIFEST, JSON.stringify(rpm, null, 2) + '\n');
console.log('\nwritten.');
