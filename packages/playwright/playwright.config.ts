import { defineConfig } from "@playwright/test";

// Runs under the Bun runtime (`bun --bun playwright test`): the engine `snapshot` imports uses Bun APIs.
export default defineConfig({
  testDir: "./test",
  globalSetup: "../../scripts/test-tmp-scope.ts",
  forbidOnly: !!process.env["CI"],
  reporter: "list",
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
