import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { type Plugin, defineConfig } from "vite";
import { freshConnectionPerRequest } from "./src/preview/fresh-connection.ts";

// The Playwright run keeps its local D1/R2 apart, so it never touches dev data.
const e2e = process.env["PIXELSLASH_E2E"] === "1";

const SYNC_INFLATE = fileURLToPath(new URL("./src/diff/pngjs-sync-inflate.cjs", import.meta.url));

/**
 * pngjs decodes a PNG with a wrapper around `zlib.Inflate`, which workerd implements as a class
 * it will not let pngjs call as a function. Only the server needs the swap; see the shim.
 */
function swapSyncInflate(source: string, importer: string | undefined): string | null {
  if (!importer?.includes("pngjs")) return null;
  const wrapper = source === "./sync-inflate" || source === "./sync-inflate.js";
  return wrapper ? SYNC_INFLATE : null;
}

/** The build resolves pngjs through this plugin. */
const pngjsSyncInflate: Plugin = {
  name: "pngjs-sync-inflate",
  enforce: "pre",
  resolveId: swapSyncInflate,
};

/**
 * The e2e run's GitHub stand-in listens on a free port picked per run (`e2e/ports.ts`), so the
 * URLs in `wrangler.jsonc` (:4174, for running the stand-in by hand) are replaced with it.
 */
function pointAtStub(config: { vars?: Record<string, unknown> }) {
  const port = process.env["PIXELSLASH_E2E_STUB_PORT"];
  if (!port) return {};
  const base = `http://localhost:${port}`;
  return { vars: { ...config.vars, GITHUB_OAUTH_BASE: base, GITHUB_API_BASE: base } };
}

export default defineConfig({
  resolve: { tsconfigPaths: true },
  // `vite dev` pre-bundles pngjs, and that bundling does not run Vite's resolver plugins: it needs
  // the same swap of its own (ob 1625).
  environments: {
    ssr: {
      optimizeDeps: {
        rolldownOptions: {
          plugins: [{ name: "pngjs-sync-inflate", resolveId: swapSyncInflate }],
        },
      },
    },
  },
  plugins: [
    pngjsSyncInflate,
    freshConnectionPerRequest(),
    cloudflare({
      viteEnvironment: { name: "ssr" },
      persistState: e2e ? { path: ".wrangler/e2e" } : true,
      // The plugin probes for a free debugger port starting at 9229 and two runs probing at once
      // both get it (EADDRINUSE). Nothing in e2e attaches a debugger.
      ...(e2e ? { inspectorPort: false, config: pointAtStub } : {}),
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});
