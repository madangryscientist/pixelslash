import { defineConfig } from "@playwright/test";

// Plain Node: `npx playwright test`. No Bun on this machine is needed to take the snapshots.
export default defineConfig({
  testDir: "./tests",
  reporter: "list",
  projects: [
    // `snapshot()` needs a launched chromium and a fixed viewport, not `viewport: null`.
    { name: "chromium", use: { browserName: "chromium", viewport: { width: 1024, height: 768 } } },
  ],
});
