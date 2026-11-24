import { defineConfig } from "@playwright/test";

const live = process.env.SHOP_OPS_BACKEND === "supabase";
const port = live ? 3031 : 3030;
const baseURL = "http://127.0.0.1:" + port;

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: live ? "test-results/supabase" : "test-results/workspace",
  testMatch: live ? "supabase.spec.ts" : "workspace.spec.ts",
  use: { baseURL, trace: "off" },
  webServer: {
    command: "node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port " + port,
    url: baseURL,
    reuseExistingServer: !process.env.CI && (!live || process.env.SHOP_OPS_REUSE_TEST_SERVER === "1"),
    timeout: 60_000,
  },
});
