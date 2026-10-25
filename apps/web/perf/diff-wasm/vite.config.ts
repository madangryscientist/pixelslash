import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { pngjsSyncInflate } from "../../vite.config.ts";

// The app's own pngjs swap and the same Cloudflare plugin, so pngjs runs here as it does in the app.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  logLevel: "warn",
  // Under .wrangler, which the app's typecheck, lint and git all leave out.
  build: { outDir: fileURLToPath(new URL("../../.wrangler/diff-wasm-bench", import.meta.url)) },
  plugins: [
    pngjsSyncInflate,
    cloudflare({
      configPath: fileURLToPath(new URL("./wrangler.jsonc", import.meta.url)),
      persistState: false,
      inspectorPort: false,
    }),
  ],
});
