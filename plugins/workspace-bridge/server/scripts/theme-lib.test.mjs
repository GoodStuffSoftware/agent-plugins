// Run with `node --test scripts/theme-lib.test.mjs` (npm test does it first). Plain Node: the Worker test pool has
// no file system.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readTheme, renderModule } from "./theme-lib.mjs";

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>';

function theme(files) {
  const dir = mkdtempSync(join(tmpdir(), "wb-theme-test-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function rejects(files, pattern) {
  const dir = theme(files);
  try {
    assert.throws(() => readTheme(dir), pattern);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("accepts a good theme", () => {
  const dir = theme({
    "theme.css": ":root{--wb-accent:#123456}\r\n",
    "name.txt": "Example Co\n",
    "assets/logo.svg": SVG,
    "assets/f.woff2": Buffer.from("wOF2abcd"),
  });
  try {
    const t = readTheme(dir);
    assert.equal(t.css, ":root{--wb-accent:#123456}\n");
    assert.equal(t.name, "Example Co");
    assert.deepEqual(Object.keys(t.assets).sort(), ["f.woff2", "logo.svg"]);
    assert.match(renderModule(t), /THEME_DATA/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the shipped default theme is valid", () => {
  const t = readTheme(fileURLToPath(new URL("../theme", import.meta.url)));
  assert.equal(t.name, "");
  assert.ok(
    readFileSync(new URL("../src/web/theme.generated.ts", import.meta.url), "utf8").includes(
      "THEME_DATA",
    ),
  );
});

test("rejects what it is documented to reject", () => {
  rejects({ "theme.css": '@import "x.css";' }, /@import/);
  rejects({ "theme.css": "a{background:url(https://x.example/a.png)}" }, /another origin/);
  rejects({ "theme.css": "a{background:url(//x.example/a.png)}" }, /another origin/);
  rejects({ "theme.css": "a{}</style><script>" }, /<\/style/);
  rejects({ "theme.css": "a{}".repeat(30000) }, /over/);
  rejects({ "name.txt": "x".repeat(41) }, /name.txt/);
  rejects({ "name.txt": "a\nb" }, /name.txt/);
  rejects({ "assets/a.svg": "<svg><script>1</script></svg>" }, /scripts/);
  rejects({ "assets/a.svg": '<svg onload="1"/>' }, /scripts/);
  rejects(
    { "assets/a.svg": '<svg><image href="https://x.example/a.png"/></svg>' },
    /other origins/,
  );
  rejects({ "assets/a.woff2": Buffer.from("nope") }, /not woff2/);
  rejects({ "assets/Bad Name.svg": SVG }, /lowercase/);
  rejects({ "assets/a.png": "x" }, /only .svg and .woff2/);
  rejects({ "other.txt": "x" }, /unexpected/);
});

test("snapshots writes every page and copies the theme's assets", () => {
  const dir = theme({
    "theme.css": ":root{--wb-accent:#123456}",
    "name.txt": "Example Co",
    "assets/logo.svg": SVG,
  });
  const out = mkdtempSync(join(tmpdir(), "wb-snap-test-"));
  try {
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL("./snapshots.mjs", import.meta.url)), out, dir],
      { windowsHide: true },
    );
    assert.ok(existsSync(join(out, "index.html")));
    assert.ok(existsSync(join(out, "theme/assets/logo.svg")));
    const home = readFileSync(join(out, "home.html"), "utf8");
    assert.ok(home.includes("--wb-accent:#123456"));
    assert.ok(home.includes('src="theme/assets/logo.svg"'));
    assert.ok(
      readFileSync(join(out, "approval-share.html"), "utf8").includes("Anyone with the link"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});
