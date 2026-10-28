import { defineConfig } from "@playwright/test";

// Runs under Node, as a user's suite does (PS-237): the helper has no Bun API on its path.
export default defineConfig({
  testDir: "./test",
  globalSetup: "../../scripts/test-tmp-scope.ts",
  forbidOnly: !!process.env["CI"],
  reporter: "list",
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
