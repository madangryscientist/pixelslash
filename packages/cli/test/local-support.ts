import { join } from "node:path";
import { servePaths, solidPng } from "./support.ts";
import { gitRepo } from "./upload-support.ts";

/** The stubbed API and fixture project the local fix-loop tests (ob 1735) run against. */

export const SERVER = "https://ps.example";

const flake = (id: string, name: string) => ({
  id,
  name,
  platform: "web",
  browser: "chromium",
  viewport: "400x300",
  theme: "light",
  status: "open",
  note: null,
  evidence: [{ build_id: "b1" }, { build_id: "b2" }],
  updated_at: "2026-10-22T09:00:00.000Z",
});

/** The server picks a red 400x300 baseline for every key it is asked about. */
function baselines(body: string) {
  const keys: unknown = JSON.parse(body || "{}").keys;
  if (!Array.isArray(keys)) throw new Error("no keys sent");
  const baseline = {
    id: "s0",
    image_url: "/images/s0.png",
    fingerprint: { image: "version:test", browser: "chromium 1", fonts: "sha256:f" },
    ignore: [],
  };
  return Response.json({
    api_version: 1,
    diff_location: "server",
    baselines: keys.map((key) => ({ key, baseline, carry: null, accepted: null })),
    removed: [],
  });
}

const ROUTES: Record<string, (body: string) => Response> = {
  "/api/v1/me": () => Response.json({ kind: "user", user: { id: "u1" } }),
  "/api/v1/projects": () =>
    Response.json({
      projects: [{ id: "p1", name: "web", org: { id: "o1", name: "Acme" } }],
      next_cursor: null,
    }),
  "/api/v1/projects/p1/flakes": () =>
    Response.json({ flakes: [flake("f1", "random"), flake("f2", "index")] }),
  "/api/v1/flakes/f2/resolve": () =>
    Response.json({ flake: { ...flake("f2", "index"), status: "resolved" } }),
  "/api/v1/baselines": baselines,
  "/images/s0.png": () => new Response(solidPng(400, 300, [200, 0, 0, 255])),
};

/** The reads the loop needs (projects, flakes, baselines and their PNG) and the resolve. */
export function server() {
  const seen: { method: string; path: string }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    seen.push({ method: init?.method ?? "GET", path });
    const route = ROUTES[path];
    if (!route) return Response.json({ error: "not here" }, { status: 404 });
    return route(typeof init?.body === "string" ? init.body : "");
  };
  return { fetch, seen };
}

/** A git worktree whose config has `/` (live.html) and `random` (random.html) at 400x300. */
export async function project(
  baseUrl = servePaths({ "/": "live.html", "/random": "random.html" }),
) {
  const cwd = await gitRepo();
  await Bun.write(
    join(cwd, "pixelslash.config.json"),
    JSON.stringify({
      baseUrl,
      routes: ["/", { path: "/random", name: "random" }],
      variants: [{ name: "small", viewport: { width: 400, height: 300 } }],
    }),
  );
  return cwd;
}
