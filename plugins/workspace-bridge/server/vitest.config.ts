import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Tests run against the committed example config; no real wrangler.jsonc is needed.
      wrangler: { configPath: "./wrangler.example.jsonc" },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
