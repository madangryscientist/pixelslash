import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SERVER, fakeApi } from "./remote-support.ts";
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

/**
 * The fake API with build `b2` carrying a `twins` section for these shots (each linked to every
 * other), their snapshot records and signed metrics URLs. `shots: []` is a build with no twins.
 */
export function parityApi(shots: Shot[], extraLinked: Shot[][] = []) {
  const api = fakeApi();
  const groups = [shots, ...extraLinked].filter((g) => g.length > 0);
  const before = JSON.parse(JSON.stringify(api.replies["/api/v1/builds/b2"]));
  const twins =
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
  api.replies["/api/v1/builds/b2"] = {
    ...before,
    build: { ...before.build, ...(twins && { twins }) },
  };
  const files = new Map<string, unknown>();
  for (const s of groups.flat()) {
    api.replies[`/api/v1/snapshots/${s.id}`] = {
      api_version: 1,
      snapshot: {
        id: s.id,
        platform: s.platform === "web" ? "linux" : s.platform,
        scale: s.scale ?? (s.platform === "web" ? null : 3),
        images: {},
        metrics_url: s.metrics ? `${SERVER}/images/${s.id}.metrics.json` : null,
      },
    };
    if (s.metrics) files.set(`/images/${s.id}.metrics.json`, s.metrics);
  }
  const fetch = async (raw: string, init?: RequestInit) => {
    const url = new URL(raw);
    const file = files.get(url.pathname);
    if (file !== undefined) return Response.json(file);
    return api.fetch(raw, init);
  };
  return { ...api, fetch };
}

/** A temp dir holding `pixelslash.parity.json` (or `name`), returned as the cwd. */
export async function manifestDir(json: unknown, name = "pixelslash.parity.json"): Promise<string> {
  const dir = await tmp();
  await writeFile(join(dir, name), typeof json === "string" ? json : JSON.stringify(json));
  return dir;
}
