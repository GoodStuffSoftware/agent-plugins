import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.example.jsonc" },
      miniflare: {
        // Every test uses the same grant, so the per-grant call limit is raised out of the way.
        ratelimits: {
          CALL_LIMIT: { namespace_id: "1002", simple: { limit: 1_000_000, period: 60 } },
        },
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
          // Sending is on for the tool tests; the owner switch (default on) is what they turn off.
          SEND_ENABLED: "true",
          // The older tests exercise the guardrails of a send, not the new-recipient hold
          // (test/send-approval.test.ts sets its own mode); their helpers unset it for back-compat tests.
          SEND_APPROVAL_MODE: "off",
        },
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
