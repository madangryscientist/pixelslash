import { defineConfig, devices } from "@playwright/test";
import { SERVER, STUB, STUB_PORT } from "../../e2e/ports";

// The Docker self-host's e2e (PS-240): `bun run test:e2e:docker` in apps/web. It builds the image,
// so it needs Docker and is not part of `test:e2e`; run it for a change to the image, its
// entrypoint or what it serves. The container shares the host's network, so the browser, the CLI
// and the container all reach the GitHub stand-in and the app at the same localhost URLs.
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  globalSetup: "../../../../scripts/test-tmp-scope.ts",
  reporter: "list",
  workers: 1,
  // Two image builds come first.
  timeout: 900_000,
  use: { baseURL: SERVER, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "bun e2e/github-stub.ts",
      cwd: "../..",
      env: { PIXELSLASH_E2E_STUB_PORT: String(STUB_PORT) },
      url: `${STUB}/health`,
      reuseExistingServer: false,
    },
  ],
});
