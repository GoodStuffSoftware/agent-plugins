// Renders every owner and public page with example.com sample data to static HTML that opens
// over file:// with no sign-in and no server.
//
//   npm run snapshots -- <outDir> [themeDir]
//
// With no themeDir the built-in theme (./theme, or WB_THEME_DIR) is used. The theme's CSS is
// inlined into each page; its assets are copied to <outDir>/theme/assets/ and the pages point at
// them with relative URLs. Forms and links that need the server stay inert; links between the
// sample pages are rewritten to the sample files.

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { readTheme } from "./theme-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [outArg, themeArg] = process.argv.slice(2);
if (!outArg) {
  console.error("usage: npm run snapshots -- <outDir> [themeDir]");
  process.exit(2);
}
const outDir = resolve(outArg);
const themeDir = resolve(themeArg ?? process.env.WB_THEME_DIR ?? join(root, "theme"));
const theme = readTheme(themeDir);

// The page modules are TypeScript with extensionless imports: bundle them for Node.
const work = mkdtempSync(join(tmpdir(), "wb-snapshots-"));
try {
  const bundle = join(work, "pages.mjs");
  await build({
    entryPoints: [join(root, "src/web/snapshot-pages.ts")],
    outfile: bundle,
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "warning",
  });
  const { snapshotPages, setTheme } = await import(pathToFileURL(bundle).href);

  mkdirSync(outDir, { recursive: true });
  const assetDir = join(outDir, "theme", "assets");
  rmSync(join(outDir, "theme"), { recursive: true, force: true });
  if (existsSync(join(themeDir, "assets")))
    cpSync(join(themeDir, "assets"), assetDir, { recursive: true });

  setTheme(theme, "theme/assets/");
  const pages = snapshotPages();

  const links = new Map([
    ["/", "home.html"],
    ["/privacy", "privacy.html"],
    ["/accounts", "accounts.html"],
    ["/accounts/audit", "audit.html"],
  ]);
  const relink = (doc) =>
    doc.replace(/href="(\/[^"]*)"/g, (all, href) => {
      const target = links.get(href);
      return target ? `href="${target}"` : all;
    });
  for (const p of pages) writeFileSync(join(outDir, `${p.file}.html`), relink(p.html));

  const esc = (s) =>
    s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const items = pages
    .map((p) => `<li><a href="${p.file}.html">${esc(p.label)}</a></li>`)
    .join("\n");
  writeFileSync(
    join(outDir, "index.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Page snapshots</title></head><body style="font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem"><h1>Page snapshots</h1><ul>\n${items}\n</ul></body></html>\n`,
  );
  console.log(`snapshots: ${pages.length} pages and index.html in ${outDir} (theme ${themeDir})`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
