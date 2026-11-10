import { defineConfig } from "vitest/config";

// Runs under the Bun runtime (`bun --bun vitest`): check-dashes.ts uses Bun.Glob.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test-tmp-scope.ts"],
  },
});
