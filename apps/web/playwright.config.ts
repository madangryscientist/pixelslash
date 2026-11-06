import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import {
  SENTRY_INGEST,
  SENTRY_PORT,
  SERVER,
  SERVER_PORT,
  SIDECAR,
  SIDECAR_PORT,
  STUB,
  STUB_PORT,
} from "./e2e/ports";

// The web server starts before `globalSetup` scopes TMPDIR, so it gets its own under .wrangler/e2e,
// which the next run clears: miniflare and wrangler leave nothing in /tmp.
const SERVER_TMP = fileURLToPath(new URL(".wrangler/e2e/tmp", import.meta.url));

// `PIXELSLASH_E2E_DEV=1` serves with `vite dev` instead of a production build, so the server diff
// (pngjs in workerd) is also run through the dev module graph (ob 1625).
const dev = process.env["PIXELSLASH_E2E_DEV"] === "1";

// The production run diffs in the diff sidecar (PS-203), as on the LAN self-host. The dev run keeps
// pngjs in workerd, as on Cloudflare, so that path stays under an e2e run; so does
// `PIXELSLASH_E2E_NO_SIDECAR=1` on a production run (the before of PS-203's burst measurement).
const sidecar = !dev && process.env["PIXELSLASH_E2E_NO_SIDECAR"] !== "1";

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
      command: "bun e2e/sentry-ingest.ts",
      env: { PIXELSLASH_E2E_SENTRY_PORT: String(SENTRY_PORT) },
      url: `${SENTRY_INGEST}/health`,
      reuseExistingServer: false,
    },
    ...(sidecar
      ? [
          {
            command: "bun deploy/ssh/diff-sidecar.ts",
            env: { PIXELSLASH_DIFF_SIDECAR_PORT: String(SIDECAR_PORT) },
            url: `${SIDECAR}/health`,
            reuseExistingServer: false,
          },
        ]
      : []),
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
        // And at this error sink, with the DSN the Worker and the browser report to (PS-227).
        PIXELSLASH_E2E_SENTRY_PORT: String(SENTRY_PORT),
        // And at this sidecar, or at none (`vite.config.ts`).
        PIXELSLASH_E2E_SIDECAR: sidecar ? SIDECAR : "",
      },
      // Playwright counts any 2xx-403 answer on the port as "up", and `wrangler d1 migrations apply`
      // above starts a dozen miniflare servers on random loopback ports, which can be this one
      // (they answer 200 and 403). The tests then start while vite is still migrating and get
      // ERR_CONNECTION_REFUSED once that server exits (PS-327). So both runs are ready when vite
      // itself says it listens on this port, which nothing else prints: `vite preview` prints the
      // same `Local:` line as `vite dev` (vite's `server.printUrls()` in `dist/node/cli.js`).
      wait: { stdout: new RegExp(`Local:\\s+http://localhost:${SERVER_PORT}/`) },
      reuseExistingServer: false,
      timeout: 300_000,
    },
  ],
});
