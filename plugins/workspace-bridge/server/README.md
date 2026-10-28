# workspace-bridge server

Cloudflare Worker for the workspace-bridge plugin. Source is TypeScript (Hono); tests run in the
Workers runtime through `@cloudflare/vitest-plugin`.

Run everything from this directory with Node (current LTS):

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run deploy:dry   # wrangler deploy --dry-run: bundles the Worker, uploads nothing
```

## Config

`wrangler.example.jsonc` is committed and holds placeholder ids and a placeholder domain.
Tests (`vitest.config.ts`) and `npm run deploy:dry` read it through an explicit config path, so
CI and a fresh clone need no real configuration.

To run or deploy for real, copy it to `wrangler.jsonc` (git-ignored), fill in your own ids,
domain and vars, and copy `.dev.vars.example` to `.dev.vars` for local secrets. `npm run dev`
(`wrangler dev`) picks up `wrangler.jsonc`; deploy with `npx wrangler deploy`.
