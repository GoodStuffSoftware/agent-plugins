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

Every plugin under `plugins/` versions **independently** and is released by hand. This repo does not let Actions open pull requests, so changes land on `main` directly and there is no release bot. To release `<plugin>` at version `X.Y.Z`:

1. Set `X.Y.Z` in `plugins/<plugin>/.claude-plugin/plugin.json`, and in any in-code version (`workspace-bridge` also has `plugins/workspace-bridge/server/src/version.ts`).
2. Sync the marketplace entry: `node scripts/sync-plugins.mjs` (`--check` fails if `marketplace.json` drifts from any `plugin.json`; CI runs it).
3. Commit: `git commit -am "chore(<plugin>): release X.Y.Z"`.
4. Push to `main`: `git push origin HEAD:main`.
5. Tag that commit: `git tag <plugin>@vX.Y.Z && git push origin <plugin>@vX.Y.Z`.
6. Publish: `gh release create <plugin>@vX.Y.Z --title "<plugin> X.Y.Z" --notes "..."`.

Existing `CHANGELOG.md` files are history from earlier releases and are no longer generated.

## Credits

Structure and release tooling adapted from work by others — see [CREDITS.md](CREDITS.md).
