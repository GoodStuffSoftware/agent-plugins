# Good Stuff Software — Claude Code plugins

A small [plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces) for Claude Code.

```
/plugin marketplace add GoodStuffSoftware/claude-plugins
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
