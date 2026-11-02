import { defineConfig } from "vitest/config";

// The smoke layer: the built bundle as a child process (`nx smoke cli`). Kept out of vitest.config.ts so
// `nx test cli` never needs a build.
export default defineConfig({
  test: {
    environment: "node",
    include: ["smoke/**/*.test.ts"],
    globalSetup: ["../../scripts/test-tmp-scope.ts"],
  },
});
