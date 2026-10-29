# Good Stuff Software — agent plugins

A plugin marketplace for AI coding agents. Claude Code today; the layout is deliberately agent-agnostic so other targets can be added without restructuring.

```
/plugin marketplace add GoodStuffSoftware/agent-plugins
```

## Plugins

### [session-sync](plugins/session-sync)

Roam your Claude Code conversations between machines — restored **in the desktop sidebar**, not just resumable from the terminal.

Claude keeps conversation data in two places: the transcripts under `~/.claude`, and the desktop app's own session index. Sync tools copy the first and stop, which is why they tell you to use `claude --resume`. The app builds its index on first run and won't rebuild it over an existing `~/.claude`, so a restored machine shows an empty sidebar while every chat sits on disk ([#69585](https://github.com/anthropics/claude-code/issues/69585)). session-sync copies both.

```
/plugin install session-sync@goodstuff
/session-sync:setup
```

Storage is any rclone backend — Drive, S3, R2, Dropbox, WebDAV, SFTP. Sync runs on session-start / session-end hooks; no daemon, no timers.

## Contributing

Issues and PRs welcome. If you hit a platform layout we probe incorrectly — particularly on macOS or Linux, where the desktop paths are inferred rather than verified — a bug report with the output of:

```bash
node plugins/session-sync/lib/cli.mjs status
```

is the most useful thing you can send.

## License

MIT

## Releases

Versions are driven by [Release Please](https://github.com/googleapis/release-please) from conventional commits, and each plugin under `plugins/` versions **independently**.

```bash
git commit -m "fix(session-sync): handle a BOM in the sync marker"   # -> patch
git commit -m "feat(session-sync): support SFTP remotes"             # -> minor
git commit -m "feat(session-sync)!: rename the remote layout"        # -> major
```

Merging the release PR tags `session-sync@vX.Y.Z` and bumps that plugin's `plugin.json`. CI then syncs the marketplace entry:

```bash
node scripts/sync-plugins.mjs           # apply
node scripts/sync-plugins.mjs --check   # CI: fail if out of sync
```

The check runs on every PR, because a `plugin.json` bump that never reaches `marketplace.json` means users silently never receive the update.

### workspace-bridge (manual releases)

`workspace-bridge` is released by hand, not by Release Please, because this repo does not let Actions open pull requests. It is not listed in `release-please-config.json` or `.release-please-manifest.json`, and `sync-plugins.mjs` skips it for those two files. To release version `X.Y.Z`:

1. Set `X.Y.Z` in `plugins/workspace-bridge/.claude-plugin/plugin.json` and `plugins/workspace-bridge/server/src/version.ts`.
2. Run `node scripts/sync-plugins.mjs` to update the marketplace entry, then commit (`chore(release): workspace-bridge X.Y.Z`) and push to `main`.
3. Tag that commit and publish: `git tag workspace-bridge@vX.Y.Z && git push origin workspace-bridge@vX.Y.Z`, then `gh release create workspace-bridge@vX.Y.Z --title "workspace-bridge X.Y.Z" --notes "..."`.

## Credits

Structure and release tooling adapted from work by others — see [CREDITS.md](CREDITS.md).
