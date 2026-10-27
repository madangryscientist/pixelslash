/**
 * Dogfood: `pixelslash capture` shoots the review app's own project, build and snapshot pages,
 * light and dark, from a local e2e build (ob 1706). It reuses the organizations-page dogfood's
 * `start` and `setup` (dogfood-orgs.config.ts, dogfood-orgs.setup.ts), so the sign-in and the
 * fixed seed are the same. `bun run dogfood:upload` (apps/web) captures this and uploads it; see
 * `docs/cli.md`'s "Reviewing the review app with itself".
 */
import orgs from "./dogfood-orgs.config";

// The project page prints "3h ago" from the server's clock.
const RELATIVE_TIMES = ['[data-testid="rel-time"]'];

export default {
  ...orgs,
  routes: [
    { path: "/projects/proj-web", name: "project", ignore: RELATIVE_TIMES },
    { path: "/projects/proj-web/builds/b-web-2", name: "build" },
    { path: "/projects/proj-web/builds/b-web-2/snapshots/b-web-2-s0", name: "snapshot" },
  ],
  tags: ["web", "review"],
};
