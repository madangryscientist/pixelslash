import { defineConfig, devices } from "@playwright/test";

const PORT = 4310;

// The smoke run: the production build (`moon run site:test-e2e` builds first), served by `vite preview`,
// which runs the Worker and its static assets in workerd as Cloudflare would. Desktop and a phone.
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "../../scripts/test-tmp-scope.ts",
  forbidOnly: !!process.env["CI"],
  reporter: "list",
  use: { baseURL: `http://localhost:${PORT}` },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    // The metadata spec reads server responses, so a viewport changes nothing in it.
    { name: "mobile", use: { ...devices["Pixel 7"] }, testIgnore: "metadata.spec.ts" },
  ],
  webServer: {
    command: `bunx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false,
  },
});
