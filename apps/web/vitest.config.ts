import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Separate from vite.config.ts so tests do not boot the Start and Cloudflare plugins.
export default defineConfig({
  resolve: { alias: { "#": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "deploy/**/*.test.ts"],
    globalSetup: ["../../scripts/test-tmp-scope.ts"],
  },
});
