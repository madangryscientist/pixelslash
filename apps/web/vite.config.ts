import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { type Plugin, defineConfig } from "vite";

// The Playwright run keeps its local D1/R2 apart, so it never touches dev data.
const e2e = process.env["PIXELSLASH_E2E"] === "1";

const SYNC_INFLATE = fileURLToPath(new URL("./src/diff/pngjs-sync-inflate.cjs", import.meta.url));

/**
 * pngjs decodes a PNG with a wrapper around `zlib.Inflate`, which workerd implements as a class
 * it will not let pngjs call as a function. Only the server build needs the swap; see the shim.
 */
const pngjsSyncInflate: Plugin = {
  name: "pngjs-sync-inflate",
  enforce: "pre",
  resolveId(source, importer) {
    if (!importer?.includes("pngjs")) return null;
    const wrapper = source === "./sync-inflate" || source === "./sync-inflate.js";
    return wrapper ? SYNC_INFLATE : null;
  },
};

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    pngjsSyncInflate,
    cloudflare({
      viteEnvironment: { name: "ssr" },
      persistState: e2e ? { path: ".wrangler/e2e" } : true,
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});
