import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cliMeta } from "./cli-meta.ts";

// Separate from vite.config.ts so tests do not boot the Start and Cloudflare plugins.
export default defineConfig({
  plugins: [cliMeta()],
  resolve: { alias: { "#": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    globalSetup: ["../../scripts/test-tmp-scope.ts"],
  },
});
