import { defineConfig } from "vitest/config";

// Runs under the Bun runtime (`bun --bun vitest`): the code and the tests use Bun APIs.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globalSetup: ["../../scripts/test-tmp-scope.ts"],
    // moon runs up to three test projects at once (`--concurrency 3`), so each takes a third of the cores.
    maxWorkers: "33%",
    setupFiles: ["../../scripts/test-idle-machine.ts"],
  },
});
