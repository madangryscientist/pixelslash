import { resolve, sep } from "node:path";
import { DEV_PAGE_HTML } from "./dev-page-html.ts";
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

export async function devState(store: DevStore, target: string, mode: DevMode): Promise<DevState> {
  const pins = await readPins(store);
  return {
    ...mode,
    target,
    root: store.root,
    latest: (await latestIteration(store, target)) ?? null,
    timeline: await timeline(store, target, pins),
    pins,
  };
}

/** A file under the store, or undefined for a path that climbs out of it. */
function storeFile(store: DevStore, rel: string): string | undefined {
  const root = resolve(store.root);
  const path = resolve(root, decodeURIComponent(rel));
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
  if (path === "/api/state") return json(await devState(store, target, actions.mode()));
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
