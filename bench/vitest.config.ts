import { defineConfig } from "vitest/config";

// Runs under the Bun runtime (`bun --bun vitest`): the code and the tests use Bun APIs.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Several tests spawn `bun` for a diff; a shared CI runner, with nx running projects in parallel,
    // needs more than the 5 s default.
    testTimeout: 30_000,
    globalSetup: ["../scripts/test-tmp-scope.ts"],
  },
});
