---
description: Post a GitHub release's notes to a Discord channel. Use when asked to post release notes, or announce a release, to Discord.
---

# Post release notes to Discord

## Blocked dependency — read this before doing any work here

**There are zero GitHub Releases across these repos today.**

- `GoodStuffSoftware/agent-plugins` uses release-please — its first Release object appears only once the first release PR is merged.
- `msantoro12/best-sudoku` has roughly 100 tags and 0 Releases. A tag is not a Release object and carries no body; a Release has to be created at tag time, and none have been.

This is the actual state of both repos, not a bug in this skill. If you land here and there's still no Release with a non-empty body, say so and stop — do not fall back to scraping tags or commits to make up for it. That fallback is exactly what the rule below forbids.

## The rule

**Publish the GitHub Release body, and only the Release body.** Never a commit log. Never an auto-derived changelog. Never the output of `git log`, never a diff summary.

Why: a Release body is human-authored with the intent to publish it, and that intent is exactly what makes it safe to post out of a private repository. A commit-derived summary has no such filter behind it — it can surface production incidents, vulnerability classes, or abuse vectors that were fine as commit messages but were never meant to be announced. This has been demonstrated against real commit history, which is why the rule exists as a hard constraint rather than a style preference.

## Never bulk-post history

A backfill of historical releases for `best-sudoku` (and possibly others) is planned separately from this skill. Once that backfill happens, ~100 Release objects could exist where there are zero today. **This skill must never turn that into ~100 Discord messages.**

Concretely: only publish a Release created **after an explicit cutoff** — a start date or a specific tag — that you or Mike name at the time you're asked to post. If asked to "post the release notes" without a cutoff already agreed, and more than one unposted Release exists (or you can't tell how many exist because of the backfill), stop and ask which one(s) — do not iterate over every Release found and post each one. One invocation of this skill posts one release announcement, not a channel's worth of history.

## Procedure

1. Fetch the release:

   ```bash
   gh release view <tag> --repo <owner/repo> --json body,name,tagName,url
   ```

2. If `body` is empty, **stop**. An empty Release body means no one wrote notes for it. The correct move is to ask for them, not to synthesize a substitute from commits.

3. If `body` (trimmed) is 2000 characters or fewer — Discord's message limit — post it as-is to the target channel:

   ```
   messages_send  {channel_id, content: "<body, trimmed>"}
   ```

4. If it's longer than 2000 characters, don't truncate mid-sentence and don't auto-summarize it to fit. Instead post a short, human-written summary plus the release URL:

   ```
   messages_send  {channel_id, content: "<short summary>\n\n<release url>"}
   ```

5. **Show Mike the exact text and get a yes before sending.** This is outward-facing; he reviews it first, every time — no exceptions for a release that seems routine. Post only into his own server, never a third-party community.

## Not a second scheduler

Two other surfaces already post to Discord on their own schedule. This skill is the on-demand path for one specific event — a release going out — and is not a replacement for either:

- `scripts/build-digest.mjs`, in the public `msantoro12/msantoro12` repo, posts a nightly digest to a channel webhook via `DISCORD_WEBHOOK_URL`.
- `local/discord-presence.mjs` sets Rich Presence.

Don't fold this skill's posting into either of those, and don't use this skill to reproduce what they already do on their own cadence.
