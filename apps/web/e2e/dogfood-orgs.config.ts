/**
 * Dogfood: `pixelslash capture` shoots the signed-in organizations page of a local e2e build, so
 * the review app can review a change to itself (ob 1707, ob 1710). Run by hand, not in the gate,
 * from anywhere in the repo:
 *
 *   bun run pixelslash -- capture --config apps/web/e2e/dogfood-orgs.config.ts --out <dir>
 *
 * `start` builds the app, migrates a fresh local D1 and serves it behind the GitHub stand-in;
 * `setup` (dogfood-orgs.setup.ts) signs in through the stand-in and seeds fixed rows. The ports
 * are fixed because the empty state prints the server URL. It shares `.wrangler/e2e` and `dist/`
 * with the e2e suite (vite.config pins the persist path), so do not run it while
 * `nx test:e2e web` runs.
 *
 * Deterministic: fixed ids and dates in the seed, the capture's own stabilise, and every relative
 * time ("3h ago") is an ignore area, since the server renders it from its own clock.
 */
import { fileURLToPath } from "node:url";

export const PORT = 4310;
export const STUB_PORT = PORT + 1;
export const SERVER = `http://localhost:${PORT}`;
export const STUB = `http://localhost:${STUB_PORT}`;
export const WEB = fileURLToPath(new URL("..", import.meta.url));
export const PERSIST = ".wrangler/e2e";

const env = [
  "PIXELSLASH_E2E=1",
  "CLOUDFLARE_ENV=e2e",
  `PIXELSLASH_E2E_PORT=${PORT}`,
  `PIXELSLASH_E2E_STUB_PORT=${STUB_PORT}`,
  `TMPDIR=${WEB}${PERSIST}/tmp`,
].join(" ");

const variant = (theme: "light" | "dark") => ({
  name: theme === "light" ? "desktop" : "desktop-dark",
  viewport: { width: 1280, height: 800 },
  theme,
});

export default {
  baseUrl: SERVER,
  start: {
    command: [
      `cd ${WEB}`,
      `export ${env}`,
      `rm -rf ${PERSIST}`,
      `mkdir -p ${PERSIST}/tmp`,
      "bun run build >&2",
      `bunx wrangler d1 migrations apply DB --local --env e2e --persist-to ${PERSIST} >&2`,
      // The stand-in in the background, the app in front; capture stops the whole group after.
      `(bun e2e/github-stub.ts & bunx vite preview --port ${PORT} --strictPort)`,
    ].join(" && "),
    readyUrl: SERVER,
    timeoutMs: 300_000,
  },
  setup: "./dogfood-orgs.setup.ts",
  routes: [
    { path: "/orgs?org=org-hackcove", name: "orgs-projects", ignore: ['[data-testid="rel-time"]'] },
    { path: "/orgs?org=org-hackcove&tab=members", name: "orgs-members" },
    { path: "/orgs?org=org-fresh", name: "orgs-empty" },
  ],
  variants: [variant("light"), variant("dark")],
  tags: ["web", "orgs"],
};
