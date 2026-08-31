# Credits

This repo's structure and release tooling borrow from work other people published
first. Naming what came from where, because "we figured it out ourselves" is
usually not true and never useful to the next person.

## Repository and release patterns

**[Nagell/claude-marketplace-template](https://github.com/Nagell/claude-marketplace-template)** — MIT
The per-plugin independent versioning approach: Release Please with a
`plugins/<name>/` monorepo, a sync script that discovers plugins and keeps
`marketplace.json` and the release config aligned with each `plugin.json`, and
conventional-commit-driven releases. Our `scripts/sync-plugins.mjs` and
`release-please-config.json` follow this pattern; the implementation is ours,
the idea is theirs.

**[ivan-magda/claude-code-plugin-template](https://github.com/ivan-magda/claude-code-plugin-template)** — the most-adopted template of the ones we surveyed.
Reference for CI validation on every push/PR and for validating each plugin
manifest independently rather than only the marketplace.

**[ai-plugin-marketplace/template](https://github.com/ai-plugin-marketplace/template)**
The multi-target idea — one marketplace repo serving Claude Code, Cursor, Gemini
CLI, Kiro and Skills CLI from a shared plugin layout. We named this repo
`agent-plugins` rather than `claude-plugins` to leave that door open. We have not
adopted their `@ai-plugin-marketplace/*` toolkit: it is actively developed
(v0.7.0 published 2026-08-27) but pre-1.0 and single-maintainer, and we have only
one target today. Their layout is compatible with ours, so adopting it later
would not require restructuring.

## Upstream tooling

- **[Release Please](https://github.com/googleapis/release-please)** (Google, Apache-2.0) — release automation.
- **[rclone](https://rclone.org)** (MIT) — every storage backend session-sync can use.

## Prior art we deliberately did not reuse

Surveyed while deciding whether to build `session-sync` at all. Each syncs
`~/.claude` and stops there, which leaves the Claude Desktop sidebar empty and
sends users to `claude --resume`:

- [tawanorg/claude-sync](https://github.com/tawanorg/claude-sync) — E2E encrypted, S3/R2/GCS/WebDAV. The encryption design is better than ours.
- [porkchop/claude-code-sync](https://github.com/porkchop/claude-code-sync) — git-backed, optional encryption.
- [tombelieber/claude-backup](https://github.com/tombelieber/claude-backup) — macOS only.
- [hmennen90/claude-device-sync](https://github.com/hmennen90/claude-device-sync) — a plugin with encrypted git sync and Windows support.

None of them is wrong; they solve the transcript half well. `session-sync` exists
for the other half — the desktop session index
([anthropics/claude-code#69585](https://github.com/anthropics/claude-code/issues/69585))
— and for the environment problems that only show up once you run this on
Windows for real.
