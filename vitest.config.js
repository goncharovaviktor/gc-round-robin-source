import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          GC_BASE_URL: "https://getcourse.test",
          GC_MANAGER_CODE_FIELD: "manager_code",
          MANAGER_CONFIG_READY: "true",
          RETENTION_DAYS: "90",
          GC_API_KEY: "integration-test-api-key",
          WEBHOOK_SECRET: "integration-test-webhook-secret-0123456789",
          ADMIN_TOKEN: "integration-test-admin-token-0123456789",
          DISABLE_INTERNAL_CACHE: "true",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.integration.test.js"],
    setupFiles: ["./test/setup.integration.js"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
