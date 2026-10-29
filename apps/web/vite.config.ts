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
export const pngjsSyncInflate: Plugin = {
  name: "pngjs-sync-inflate",
  enforce: "pre",
  resolveId: swapSyncInflate,
};

/**
 * The e2e run's GitHub stand-in listens on a free port picked per run (`e2e/ports.ts`), so the
 * URLs in `wrangler.jsonc` (:4174, for running the stand-in by hand) are replaced with it. So is
 * the diff sidecar's (:4181, the LAN's), with the run's own sidecar or with none (PS-203). A run
 * with `PIXELSLASH_E2E_SENTRY_PORT` also gets a DSN pointing at that ingest stand-in (PS-227).
 */
function pointAtStub(config: { vars?: Record<string, unknown> }) {
  const port = process.env["PIXELSLASH_E2E_STUB_PORT"];
  if (!port) return {};
  const base = `http://localhost:${port}`;
  const sidecar = process.env["PIXELSLASH_E2E_SIDECAR"] ?? "";
  const sentryPort = process.env["PIXELSLASH_E2E_SENTRY_PORT"];
  return {
    vars: {
      ...config.vars,
      GITHUB_OAUTH_BASE: base,
      GITHUB_API_BASE: base,
      // Sign in with Google (PS-274) against the same stand-in; fixed test values, never real ones.
      GOOGLE_CLIENT_ID: "e2e-google-client",
      GOOGLE_CLIENT_SECRET: "e2e-google-secret",
      GOOGLE_OAUTH_BASE: base,
      DIFF_SIDECAR_URL: sidecar,
      // The run's own Sentry ingest stand-in (PS-227), so the e2e reports to a sink it can read.
      ...(sentryPort ? { SENTRY_DSN: `http://e2ekey@localhost:${sentryPort}/1` } : {}),
    },
  };
}

/**
 * Which build this is (`src/auth/stub-guard.ts`): `vite dev` is dev, a `CLOUDFLARE_ENV=e2e` build is
 * the test build (Playwright and the LAN self-host), and any other is production, which refuses to
 * start pointed at the GitHub stand-in (PS-250).
 */
function buildKind(command: "serve" | "build"): string {
  if (command === "serve") return "dev";
  return process.env["CLOUDFLARE_ENV"] === "e2e" ? "test" : "production";
}

export default defineConfig(({ command }) => ({
  define: { PIXELSLASH_BUILD_KIND: JSON.stringify(buildKind(command)) },
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
}));
