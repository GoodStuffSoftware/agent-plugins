import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.example.jsonc" },
      miniflare: {
        // Test-only values; secrets are never in the example config (ARCHITECTURE s.6).
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          PUBLIC_URL: "https://mcp.example.com",
          OWNER_CONTACT: "privacy@example.com",
          OWNER_EMAILS: "owner@example.com,owner2@example.com",
          TOKEN_KEK: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          COOKIE_SECRET: "test-cookie-secret-test-cookie-secret",
          GOOGLE_CLIENT_ID: "test-client",
          GOOGLE_CLIENT_SECRET: "test-secret",
        },
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
