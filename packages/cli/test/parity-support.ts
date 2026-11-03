import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SERVER, USER_TOKEN, fakeApi } from "./remote-support.ts";
import { tmp } from "./support.ts";

type Part = Record<string, unknown>;

export const metricsFile = (parts: Record<string, Part>) => ({
  version: "1.0",
  root: "button",
  parts,
});

export const button = (over: Part = {}): Part => ({
  box: { x: 0, y: 0, w: 96, h: 40 },
  gap: 8,
  ...over,
});

type Shot = {
  id: string;
  platform: "web" | "android" | "ios";
  /** The metrics file, or null for a shot that came with none. */
  metrics: unknown;
  scale?: number | null;
  name?: string;
  theme?: string;
};

const entry = (s: Shot, twins: Shot[]) => ({
  snapshot_id: s.id,
  name: s.name ?? "Button/md-primary",
  theme: s.theme ?? "dark",
  platform: s.platform,
  device: s.platform === "web" ? "chromium" : "pixel-8",
  viewport: s.platform === "web" ? "390x844" : "1080x2400",
  has_metrics: s.metrics !== null,
  missing: [],
  twins: twins.map((t) => ({
    snapshot_id: t.id,
    platform: t.platform,
    device: t.platform === "web" ? "chromium" : "pixel-8",
    viewport: t.platform === "web" ? "390x844" : "1080x2400",
    has_metrics: t.metrics !== null,
  })),
});

/** The `twins` section of a build whose shots are linked within each group; none for no group. */
const twinsSection = (groups: Shot[][]) =>
  groups.length === 0
    ? undefined
    : {
        twin_project: null,
        linked: groups.flatMap((g) =>
          g.map((s) =>
            entry(
              s,
              g.filter((t) => t !== s),
            ),
          ),
        ),
        unlinked: [],
      };

/** The snapshot record of a shot, with the signed URL of its metrics file when it has one. */
const snapshotReply = (s: Shot) => ({
  api_version: 1,
  snapshot: {
    id: s.id,
    platform: s.platform === "web" ? "linux" : s.platform,
    scale: s.scale ?? (s.platform === "web" ? null : 3),
    images: {},
    metrics_url: s.metrics ? `${SERVER}/images/${s.id}.metrics.json` : null,
  },
});

/**
 * The fake API with build `b2` carrying a `twins` section for these shots (each linked to every
 * other), their snapshot records and signed metrics URLs. `shots: []` is a build with no twins.
 */
export function parityApi(shots: Shot[], extraLinked: Shot[][] = []) {
  const api = fakeApi();
  const groups = [shots, ...extraLinked].filter((g) => g.length > 0);
  const before = JSON.parse(JSON.stringify(api.replies["/api/v1/builds/b2"]));
  const twins = twinsSection(groups);
  api.replies["/api/v1/builds/b2"] = {
    ...before,
    build: { ...before.build, ...(twins && { twins }) },
  };
  const files = new Map<string, unknown>();
  for (const s of groups.flat()) {
    api.replies[`/api/v1/snapshots/${s.id}`] = snapshotReply(s);
    if (s.metrics) files.set(`/images/${s.id}.metrics.json`, s.metrics);
  }
  const fetch = async (raw: string, init?: RequestInit) => {
    const file = files.get(new URL(raw).pathname);
    if (file !== undefined) return Response.json(file);
    return api.fetch(raw, init);
  };
  return { ...api, fetch, linked: twins?.linked ?? [] };
}

/** A temp dir holding `pixelslash.parity.json` (or `name`), returned as the cwd. */
export async function manifestDir(json: unknown, name = "pixelslash.parity.json"): Promise<string> {
  const dir = await tmp();
  await writeFile(join(dir, name), typeof json === "string" ? json : JSON.stringify(json));
  return dir;
}

/** A stale twin as `GET /api/v1/projects/:id/stale` reports it. */
export const staleTwin = (over: Record<string, unknown> = {}) => ({
  name: "Button/md-primary",
  theme: "dark",
  platform: "android",
  sentence: `Button/md-primary dark on android is stale: web changed in build ${SERVER}/projects/p1/builds/b1, accepted by ada 2026-11-02`,
  cause: {
    snapshot_id: "w0",
    build_id: "b1",
    project_id: "p1",
    project_name: "web",
    accepted_by: "ada",
    accepted_at: "2026-11-02T10:00:00.000Z",
  },
  shots: [{ snapshot_id: "a0", build_id: "b3", project_id: "p1", device: "pixel-8" }],
  ...over,
});

/**
 * The fake API for `parity --release`: project `p1`'s stale list, and, as its accepted baseline
 * pairs, the twin pairs of `shots` (their snapshot records and metrics files as `parityApi` serves).
 */
export function releaseApi(shots: Shot[], stale: unknown[] = [], extraLinked: Shot[][] = []) {
  const api = parityApi(shots, extraLinked);
  api.replies["/api/v1/projects/p1/stale"] = {
    api_version: 1,
    stale,
    next_cursor: null,
    baselines: { platform: "android", linked: api.linked },
  };
  return api;
}

/** The deps `run` takes: the user token, the fake API's fetch and a cwd (a fresh temp dir by default). */
export const deps = async (api: Pick<ReturnType<typeof parityApi>, "fetch">, cwd?: string) => ({
  env: { PIXELSLASH_TOKEN: USER_TOKEN },
  fetch: api.fetch,
  cwd: cwd ?? (await tmp()),
});

export const web = (over = {}) => ({
  id: "w1",
  platform: "web" as const,
  metrics: metricsFile({ button: button(over) }),
});

export const android = (over = {}) => ({
  id: "a1",
  platform: "android" as const,
  metrics: metricsFile({ button: button(over) }),
});
