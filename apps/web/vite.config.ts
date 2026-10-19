import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The Playwright run keeps its local D1/R2 apart, so it never touches dev data.
const e2e = process.env["PIXELSLASH_E2E"] === "1";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      persistState: e2e ? { path: ".wrangler/e2e" } : true,
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});
