import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { SERVER, SERVER_PORT, STUB, STUB_PORT } from "./e2e/ports";

// The web server starts before `globalSetup` scopes TMPDIR, so it gets its own under .wrangler/e2e,
// which the next run clears: miniflare and wrangler leave nothing in /tmp.
const SERVER_TMP = fileURLToPath(new URL(".wrangler/e2e/tmp", import.meta.url));

// `PIXELSLASH_E2E_DEV=1` serves with `vite dev` instead of a production build, so the server diff
// (pngjs in workerd) is also run through the dev module graph (ob 1625).
const dev = process.env["PIXELSLASH_E2E_DEV"] === "1";

// Happy paths only, against a local production build signing in through a GitHub stub.
// Each run starts from an empty local D1 (`.wrangler/e2e`).
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "../../scripts/test-tmp-scope.ts",
  forbidOnly: !!process.env["CI"],
  reporter: "list",
  // One local D1 holds every spec's rows: concurrent writers fail with SQLITE_BUSY.
  workers: 1,
  use: { baseURL: SERVER, trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "bun e2e/github-stub.ts",
      env: { PIXELSLASH_E2E_STUB_PORT: String(STUB_PORT) },
      url: `${STUB}/health`,
      reuseExistingServer: false,
    },
    {
      command: [
        "rm -rf .wrangler/e2e",
        "mkdir -p .wrangler/e2e/tmp",
        ...(dev ? [] : ["bun run build"]),
        "wrangler d1 migrations apply DB --local --env e2e --persist-to .wrangler/e2e",
        `vite ${dev ? "dev" : "preview"} --port ${SERVER_PORT} --strictPort`,
      ].join(" && "),
      env: {
        PIXELSLASH_E2E: "1",
        CLOUDFLARE_ENV: "e2e",
        TMPDIR: SERVER_TMP,
        // `vite.config.ts` points the worker at this port instead of the one in `wrangler.jsonc`.
        PIXELSLASH_E2E_STUB_PORT: String(STUB_PORT),
      },
      url: SERVER,
      reuseExistingServer: false,
      timeout: 300_000,
    },
  ],
});
