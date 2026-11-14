import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The smoke layer (`moon run web:smoke`): the production build on a local D1, driven over HTTP. Kept out of
// vitest.config.ts so `moon run web:test` never builds.
export default defineConfig({
  resolve: { alias: { "#": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["smoke/**/*.test.ts"],
    globalSetup: ["../../scripts/test-tmp-scope.ts"],
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});
