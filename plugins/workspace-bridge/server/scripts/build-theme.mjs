#!/usr/bin/env node
// Bundles a theme directory into src/web/theme.generated.ts.
//   node scripts/build-theme.mjs [themeDir] [--check]
// themeDir defaults to env WB_THEME_DIR, then ./theme. wrangler runs this before every deploy
// (`build.command` in wrangler.example.jsonc). `--check` writes nothing and exits 1 when the file
// is not what the directory would produce.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readTheme, renderModule } from "./theme-lib.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const check = args.includes("--check");
const dir = resolve(args.find((a) => !a.startsWith("--")) ?? process.env.WB_THEME_DIR ?? "theme");
const out = resolve(root, "src/web/theme.generated.ts");

const module = renderModule(readTheme(dir));
if (check) {
  const current = existsSync(out) ? readFileSync(out, "utf8") : "";
  if (current !== module) {
    console.error(`theme: ${out} is out of date for ${dir}; run npm run build:theme`);
    process.exit(1);
  }
} else {
  writeFileSync(out, module);
  console.log(`theme: ${dir} -> src/web/theme.generated.ts`);
  if (dir !== resolve(root, "theme")) {
    console.warn(
      "theme: src/web/theme.generated.ts now holds a theme from outside the repository. " +
        "Do not commit it: restore it with `git checkout src/web/theme.generated.ts`.",
    );
  }
}
