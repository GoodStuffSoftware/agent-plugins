#!/usr/bin/env node
// Scans every git-tracked file for private terms. No dependencies.
//
// Terms come from env PRIVATE_NAMES (newline-separated) or from the file named by
// env PRIVATE_NAMES_FILE. On a hit it prints `file:line term#N` (N is the 1-based
// position of the term in the list; the term text is never printed) and exits 1.
// With no terms supplied it prints a notice and exits 0.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Paths that already existed on main and hit a term before this check was added.
// Add exact repo-relative paths here, each with a comment saying why.
const ALLOWLIST = new Set([
  // Names the owner's public GitHub repos (term#1 matches inside a public handle). Left as is.
  "plugins/discord/skills/release-notes/SKILL.md",
]);

function loadTerms() {
  let raw = process.env.PRIVATE_NAMES ?? "";
  if (!raw.trim() && process.env.PRIVATE_NAMES_FILE) {
    raw = readFileSync(process.env.PRIVATE_NAMES_FILE, "utf8");
  }
  return raw
    .split(/\r?\n/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

const terms = loadTerms();
if (terms.length === 0) {
  console.log("leak-check: no PRIVATE_NAMES or PRIVATE_NAMES_FILE supplied, nothing to scan.");
  process.exit(0);
}

const files = execFileSync("git", ["ls-files", "-z"], { maxBuffer: 1 << 28, windowsHide: true })
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

let hits = 0;
for (const file of files) {
  if (ALLOWLIST.has(file)) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // deleted in the working tree, or unreadable
  }
  if (text.includes("\0")) continue; // binary
  const lines = text.toLowerCase().split("\n");
  for (let i = 0; i < lines.length; i++) {
    terms.forEach((term, idx) => {
      if (lines[i].includes(term)) {
        console.log(`${file}:${i + 1} term#${idx + 1}`);
        hits++;
      }
    });
  }
}

if (hits > 0) {
  console.error(`leak-check: ${hits} hit(s). Remove the private values or allowlist the path.`);
  process.exit(1);
}
console.log(
  `leak-check: ${files.length} tracked files scanned against ${terms.length} term(s), clean.`,
);
