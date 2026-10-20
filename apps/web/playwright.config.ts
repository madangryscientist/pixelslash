import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// The web server starts before `globalSetup` scopes TMPDIR, so it gets its own under .wrangler/e2e,
// which the next run clears: miniflare and wrangler leave nothing in /tmp.
const SERVER_TMP = fileURLToPath(new URL(".wrangler/e2e/tmp", import.meta.url));

// Happy paths only, against a local production build signing in through a GitHub stub.
// Each run starts from an empty local D1 (`.wrangler/e2e`).
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "../../scripts/test-tmp-scope.ts",
  forbidOnly: !!process.env["CI"],
  reporter: "list",
  use: { baseURL: "http://localhost:4173", trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "bun e2e/github-stub.ts",
      url: "http://localhost:4174/health",
      reuseExistingServer: false,
    },
    {
      command: [
        "rm -rf .wrangler/e2e",
        "mkdir -p .wrangler/e2e/tmp",
        "CLOUDFLARE_ENV=e2e bun run build",
        "wrangler d1 migrations apply DB --local --env e2e --persist-to .wrangler/e2e",
        "vite preview --port 4173 --strictPort",
      ].join(" && "),
      env: { PIXELSLASH_E2E: "1", TMPDIR: SERVER_TMP },
      url: "http://localhost:4173",
      reuseExistingServer: false,
      timeout: 300_000,
    },
  ],
});
