import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The local-build suite (`moon run web:test-local-build`): the production build on a local D1, driven over
// HTTP and by the real CLI. It is integration: nothing here touches a deployment. Kept out of
// vitest.config.ts so `moon run web:test` never builds. `local-build/server.ts` builds and serves the app
// once for the run; the files then run one at a time against that one server, so a count a test reads
// before and after its own work moves by that test's work alone.
export default defineConfig({
  resolve: { alias: { "#": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["local-build/**/*.test.ts"],
    globalSetup: ["../../scripts/test-tmp-scope.ts", "local-build/server.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});
