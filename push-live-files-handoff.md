# Handoff 2 (supersedes the earlier handoff's TODO list; its Findings/Design sections still hold)

Worktree: C:/Users/msant/dev/agent-plugins/.claude/worktrees/agent-ae9f826a6f3a218a1
Branch fix/session-sync-push-live-files, pushed, HEAD 736de54 (base origin/main = 0.5.10). Knowledge check 2026-11-22: confirmed (the flag alone does not fix "sizes differ"; forum + earlier experiments).

## DONE (committed and pushed)
- lib/rclone.mjs (earlier): copyFlags({retries}), parseRcloneLog, formatRcloneLine, classifyCopyErrors.
- lib/sync.mjs: imports; DEFERRED_FILES const; snapshotFile (exported, async; options attempts/pauseMs/copy); summarizeDeferred (exported); readDeferredFiles (exported); push() now: `--retries 1 --use-json-log` main pass, classify, settleVolatile (stage snapshots, ONE upload, deferral, manifest rewind/delete), recordDeferred writes/removes deferred-files.json after commit; returns {ok,failed,mins,committed,deferred,vanished,staged}. New test-only push options: deferredFile, snapshotOpts, runner (rclone runner). pull() got a test-only `map` option (pullImpl).
  Design deviation (justified, put in the detail file): a JSONL snapshot cut at its last complete line gets remote mtime = local mtime minus 5 s (PARTIAL_TAIL_SKEW_MS), so pull's `--update` can never see an equal-mtime prefix as a reason to overwrite the longer local file. Complete snapshots keep the exact mtime.
- lib/cli.mjs: imports readDeferredFiles; `status` adds `deferredFiles {at,count,byReason,names<=20}`; worker "deferred push ok" and manual "push ok" log lines mention the deferred count.
- test/push-live.test.mjs (17 tests, all pass alone: `node --import ./test/sandbox-env.mjs --test test/push-live.test.mjs`), added to package.json test script.

## REMAINING (in order)
1. Add one CLI test to test/cli.test.mjs (helpers sandbox()/run() there): write `<stateDir>/deferred-files.json` {at,count:2,byReason,files:[{label,path,reason}]}, run `['status']`, parse stdout JSON, assert `deferredFiles.count===2` and names. (status exit code may be 1 if not ready; stdout is still JSON.)
2. Full suite through the resource queue: `node ~/.claude/agent-companion/bin/resource-queue.mjs --help` first, then `npm test` in plugins/session-sync via it, in background. Known flake: cli.test.mjs "request left behind by a dead worker" passes alone.
3. Docs: plugins/session-sync CHANGELOG.md `## 0.5.11 - 2026-11-22` (Fixed: push survives files changing mid-copy; deferred files list in ~/.claude/session-sync/deferred-files.json, in `status` and the log "deferred N file(s)..."; no whole-run retry for volatile files); mention in README / skills (grep for `last-push.txt` or `sync.log` docs) the new file. No em dashes. Check the repo CLAUDE.md and how 0.5.10 was cut (`git show 0cda642 --stat`, "chore(session-sync): release 0.5.10": version bumps in plugin.json/marketplace + CHANGELOG).
4. Write push-live-files-detail.md in the worktree root (approach, why not --local-no-check-updated alone / --ignore-size / whole-tree snapshot, the 5 s skew and pull analysis, test-only hooks, live verification command).
5. Self-review: floor via `node "C:/Users/msant/.claude/plugins/cache/agent-templates/agent-companion/0.31.62/scripts/project-tiers.mjs" floor origin/main..HEAD`; RISK mid likely; reviewer `agent-companion:ac-sonnet-xhigh` (brief starts TYPE: code-review / WRITER: sonnet/high / ROLE: reviewer / RISK: <x>, with original brief, sha, diff range, raw test output, adversarial read instruction, review file REVIEW-push-live.md). One fix round.
6. PR to main, CI via `node "C:/Users/msant/.claude/plugins/cache/agent-templates/agent-companion/0.31.62/scripts/pr-wait.mjs" <pr|sha>` in background, merge, then release commit "chore(session-sync): release 0.5.11" like 0.5.10, CI green on the release commit.
7. Final report (max ~300 tokens, STATUS first): PR, merge and release shas, approach, live verification: stop the running deferred push worker (pid 50000, 0.5.10) first, install the new cache build, then run `CLAUDE_SESSION_SYNC_VERBOSE=1 node <installed>/plugins/session-sync/lib/cli.mjs push` (manual, synchronous, takes the sync lock), then `node <...>/cli.mjs status` and read ~/.claude/session-sync/deferred-files.json plus sync.log lines "deferred ..." / "sent from a snapshot".

## Gotchas
- Bash tool: shell quoting mangles `\n` in sed/echo; use Write/Edit or a heredoc to a file then `sed -i 'Nr file'`.
- Never `python3 -` with empty stdin (hook blocks).
- Real rclone silently skips files missing from --files-from (exit 0), so "deleted mid-copy" in tests is simulated through the `runner` hook (copy for real, then report the canned rclone error).
