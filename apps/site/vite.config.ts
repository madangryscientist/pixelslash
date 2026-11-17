import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { buildCommit } from "../web/build-commit.ts";
import { cliMeta } from "./cli-meta.ts";
import { DOC_PAGES } from "./src/content/docs-map.ts";
import { PAGES } from "./src/content/pages.ts";

// Every page is prerendered to static HTML at build time; the Worker serves the files, and answers
// the four moved marketing paths with a 301 (src/server.ts).
export default defineConfig({
  // The root route's `build-commit` meta: which commit the prerendered pages were built from.
  define: { PIXELSLASH_BUILD_COMMIT: JSON.stringify(buildCommit()) },
  resolve: { tsconfigPaths: true },
  // The pages read the repo's own docs (`docs/cli.md`, `SECURITY.md`, ...) at build time.
  server: { fs: { allow: ["../.."] } },
  plugins: [
    cliMeta(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    tanstackStart({
      pages: [
        ...PAGES.map((page) => page.to),
        ...DOC_PAGES.map((page) => `/docs/${page.slug}`),
        "/search-index.json",
        "/sitemap.xml",
      ].map((path) => ({ path })),
      // The list above is every page. Discovery would add `/` (the root route's path), which now
      // answers a 301 to slashslash.build (src/server.ts), and fail the build on it.
      prerender: {
        enabled: true,
        crawlLinks: true,
        failOnError: true,
        autoStaticPathsDiscovery: false,
      },
    }),
    viteReact(),
  ],
});
