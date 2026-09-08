# Changelog

## [0.3.0](https://github.com/GoodStuffSoftware/agent-plugins/compare/session-sync@v0.2.1...session-sync@v0.3.0) (2026-09-08)


### Features

* session-sync plugin — roam Claude conversations, sidebar included ([bf1560f](https://github.com/GoodStuffSoftware/agent-plugins/commit/bf1560f2620bc7f5e655c125eead2c8d891217b6))
* **session-sync:** configurable backup location, not an env var ([655db2d](https://github.com/GoodStuffSoftware/agent-plugins/commit/655db2de9f26e6ce342b4dce7f5d9bb2ec87a886))
* **session-sync:** incremental push from a local manifest, and real setup instructions ([d3f94b7](https://github.com/GoodStuffSoftware/agent-plugins/commit/d3f94b79fd89259764baa64217d923993b675fdc))
* **session-sync:** never silently lose a conversation on pull ([c74da51](https://github.com/GoodStuffSoftware/agent-plugins/commit/c74da5124e301987f2bd1d6ace83a6cfa556b055))
* **session-sync:** support a local remote, and stop pacing it like a cloud one ([8730912](https://github.com/GoodStuffSoftware/agent-plugins/commit/8730912bd82081edc33cf2e425af3f4a24c6a39d))


### Bug Fixes

* **session-sync:** --files-from cannot be combined with --exclude ([f5a86a3](https://github.com/GoodStuffSoftware/agent-plugins/commit/f5a86a3a0436c3b547b0301f06ee6ad0ae094d1d))
* **session-sync:** anchor the session-sync exclusion to the sync root ([68c867f](https://github.com/GoodStuffSoftware/agent-plugins/commit/68c867f4099d74e5b42ad52a9cbdeec9861d9fde))
* **session-sync:** bound the toast-registration PowerShell call; v0.2.1 ([8787dd3](https://github.com/GoodStuffSoftware/agent-plugins/commit/8787dd35222dedd875f282c956b860615e5cbf2c))
* **session-sync:** hooks fire per conversation — scope them, and lock the sync ([2349fd7](https://github.com/GoodStuffSoftware/agent-plugins/commit/2349fd77e0c964802c348fb46f5ad3ce249b3211))
* **session-sync:** restore resume on SessionEnd; debounce now coalesces, never drops ([f1fa342](https://github.com/GoodStuffSoftware/agent-plugins/commit/f1fa3429a632f3a1abe942de427ab3e087efc72f))
* **session-sync:** stop the self-sustaining sync loop, survive long pushes, and cut notification noise ([67da58b](https://github.com/GoodStuffSoftware/agent-plugins/commit/67da58be07746183adfdf0da584ea8e5858029e5))
* **session-sync:** tell the user once when sync is not configured ([1b1286a](https://github.com/GoodStuffSoftware/agent-plugins/commit/1b1286a303e4fb8ceaa7d43c11efd6e0a0dfb886))
* **session-sync:** toasts no longer flash a console window on Windows ([c663ba1](https://github.com/GoodStuffSoftware/agent-plugins/commit/c663ba1ffbfeed23211de25ae157b7ef792db2f8))
