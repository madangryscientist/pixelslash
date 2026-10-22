import { resolve, sep } from "node:path";
import { DEV_PAGE_HTML } from "./dev-page-html.ts";
import { type DevFeature, type FeaturePair, featurePairs } from "./dev-refs.ts";
import {
  type DevIteration,
  type DevStore,
  latestIteration,
  listIterations,
  readIteration,
  readPins,
} from "./dev-store.ts";

/**
 * `pixelslash dev`'s live page (ob 1740), on 127.0.0.1 and a free port. The page polls
 * `/api/state` and redraws when an iteration lands. The POST routes are how a second `dev` in the
 * same worktree drives this session; they only touch the local store, never a server.
 */

export type DevMode = { against: "previous" | "main"; note: string | null; running: boolean };

export type DevActions = {
  run: () => Promise<DevIteration | undefined>;
  pin: () => Promise<string | undefined>;
  unpin: () => Promise<string | undefined>;
  toggleMain: () => Promise<DevMode>;
  mode: () => DevMode;
  /** The target's spec and refs; null when the config has no `features` entry for it. */
  feature: () => Promise<DevFeature | null>;
  /** Fetch the Figma refs again (`f`). */
  refreshRefs: () => Promise<DevFeature | null>;
};

/** A timeline entry: enough to draw the strip without every shot. */
type Step = Pick<
  DevIteration,
  "id" | "at" | "against" | "counts" | "regions" | "changedPixels" | "timings"
>;

export type DevState = DevMode & {
  target: string;
  root: string;
  latest: DevIteration | null;
  timeline: Step[];
  pins: string[];
  feature: DevFeature | null;
  /** The latest shots beside their refs: shown side by side and overlaid, never scored. */
  pairs: FeaturePair[];
};

/** The newest `limit` iterations of `target`, newest first, plus every pin whatever its age. */
async function timeline(
  store: DevStore,
  target: string,
  pins: string[],
  limit = 30,
): Promise<Step[]> {
  const ids = (await listIterations(store)).toReversed();
  const steps: Step[] = [];
  for (const id of ids) {
    if (steps.length >= limit && !pins.includes(id)) continue;
    const it = await readIteration(store, id);
    if (!it || it.target !== target) continue;
    const { at, against, counts, regions, changedPixels, timings } = it;
    steps.push({ id, at, against, counts, regions, changedPixels, timings });
  }
  return steps;
}

export async function devState(
  store: DevStore,
  target: string,
  mode: DevMode,
  feature: DevFeature | null = null,
): Promise<DevState> {
  const pins = await readPins(store);
  const latest = (await latestIteration(store, target)) ?? null;
  return {
    ...mode,
    target,
    root: store.root,
    latest,
    timeline: await timeline(store, target, pins),
    pins,
    feature,
    pairs: latest && feature ? featurePairs(latest, feature) : [],
  };
}

/** A file under the store, or undefined for a path that climbs out of it. */
function storeFile(store: DevStore, rel: string): string | undefined {
  const root = resolve(store.root);
  let name: string;
  try {
    name = decodeURIComponent(rel);
  } catch {
    return undefined;
  }
  const path = resolve(root, name);
  return path.startsWith(root + sep) ? path : undefined;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

/**
 * The header a POST must carry. A page on another origin cannot set it without a preflight this
 * server never answers, so a website cannot drive the session through the browser.
 */
export const DEV_HEADER = "x-pixelslash-dev";

async function post(req: Request, path: string, actions: DevActions): Promise<Response> {
  if (req.headers.get(DEV_HEADER) !== "1") return json({ error: "forbidden" }, 403);
  if (path === "/api/run") return json({ iteration: (await actions.run()) ?? null });
  if (path === "/api/pin") return json({ pinned: (await actions.pin()) ?? null });
  if (path === "/api/unpin") return json({ unpinned: (await actions.unpin()) ?? null });
  if (path === "/api/against") return json(await actions.toggleMain());
  if (path === "/api/refs") return json({ feature: await actions.refreshRefs() });
  return json({ error: "not found" }, 404);
}

/** A resolved ref by its index: a repo PNG may live anywhere in the worktree, so not by path. */
async function refFile(index: string, actions: DevActions): Promise<Response> {
  const ref = (await actions.feature())?.refs[Number(index)];
  if (ref?.file && (await Bun.file(ref.file).exists())) return new Response(Bun.file(ref.file));
  return json({ error: "not found" }, 404);
}

async function get(
  path: string,
  store: DevStore,
  target: string,
  actions: DevActions,
): Promise<Response> {
  if (path === "/")
    return new Response(DEV_PAGE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  if (path === "/api/state")
    return json(await devState(store, target, actions.mode(), await actions.feature()));
  if (path.startsWith("/ref/")) return refFile(path.slice("/ref/".length), actions);
  if (path.startsWith("/files/")) {
    const file = storeFile(store, path.slice("/files/".length));
    if (file && (await Bun.file(file).exists())) return new Response(Bun.file(file));
  }
  return json({ error: "not found" }, 404);
}

export type DevPage = { url: string; stop: () => Promise<void> };

/** Serve the live page; `port` 0 takes a free one. */
export function serveDevPage(
  store: DevStore,
  target: string,
  actions: DevActions,
  port = 0,
): DevPage {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: (req) => {
      // A DNS-rebound name reaches this port too; only our own host may read the shots.
      const host = req.headers.get("host") ?? "";
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return json({ error: "forbidden" }, 403);
      const path = new URL(req.url).pathname;
      return req.method === "POST" ? post(req, path, actions) : get(path, store, target, actions);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: async () => {
      await server.stop(true);
    },
  };
}
