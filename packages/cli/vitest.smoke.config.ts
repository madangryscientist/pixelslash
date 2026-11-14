import { defineConfig } from "vitest/config";

// The smoke layer: the built bundle as a child process (`moon run cli:smoke`). Kept out of vitest.config.ts so
// `moon run cli:test` never needs a build.
export default defineConfig({
  test: {
    environment: "node",
    include: ["smoke/**/*.test.ts"],
    globalSetup: ["../../scripts/test-tmp-scope.ts"],
  },
});
