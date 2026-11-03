import { eq, inArray } from "drizzle-orm";
import type { StaleCause } from "#/lib/stale";
import { type Platform, type Twin, platformOfServer } from "#/lib/twins";
import { inChunks } from "./chunks";
import { type Db, NotFoundError } from "./db";
import { scaleOf } from "./review";
import { builds, projects, snapshots } from "./schema";
import { twinsOfBuild } from "./twins";
import { shotsOf } from "./twins-read";

/**
 * The columns of the parity view (PS-298): every shot under one snapshot key (name + theme) that a
 * build's twin pairing finds, with what the view needs to draw and measure each. The pairing is
 * `twinsOfBuild` (PS-295) and nothing here pairs again: this reads that function's answer and adds
 * each shot's blob keys and scale.
 */

/** One column of the view: a shot of the key on one platform. */
export type ParityShot = Twin & {
  imageKey: string;
  metricsKey: string | null;
  /** The device pixel ratio the shot's fingerprint recorded; null for web and for a shot without one. */
  scale: number | null;
  /** The PNG's size in device pixels from its IHDR at upload; null on a shot uploaded before that. */
  size: { width: number; height: number } | null;
};

export type ParityColumns = {
  name: string;
  theme: string;
  twinProject: { id: string; name: string } | null;
  /** Web first, then android, then ios; within a platform by device, viewport and id. */
  shots: ParityShot[];
};

const order = (a: Twin, b: Twin) =>
  ["web", "android", "ios"].indexOf(a.platform) - ["web", "android", "ios"].indexOf(b.platform) ||
  (a.device ?? "").localeCompare(b.device ?? "") ||
  a.viewport.localeCompare(b.viewport) ||
  a.snapshotId.localeCompare(b.snapshotId);

/**
 * The shots under `name` + `theme` that the build holds, and the twins the pairing finds for them
 * on the other platforms. A NotFoundError when the build holds no shot under the key. A build with
 * no other platform in play gives its own shots alone.
 */
export async function parityShotsOf(
  db: Db,
  buildId: string,
  key: { name: string; theme: string },
  options: { crossProject: boolean },
): Promise<ParityColumns> {
  const mine = (await shotsOf(db, buildId)).filter(
    (s) => s.name === key.name && s.theme === key.theme,
  );
  if (mine.length === 0) throw new NotFoundError("snapshot");
  const [owner] = await db
    .select({ id: projects.id, name: projects.name })
    .from(builds)
    .innerJoin(projects, eq(projects.id, builds.projectId))
    .where(eq(builds.id, buildId));
  if (!owner) throw new NotFoundError("build");

  const twins = await twinsOfBuild(db, buildId, options);
  const entries = [...twins.linked, ...twins.unlinked].filter(
    (e) => e.name === key.name && e.theme === key.theme,
  );
  const stale = new Map<string, StaleCause | null>(entries.map((e) => [e.snapshotId, e.stale]));

  const shots = new Map<string, Twin>();
  for (const raw of mine) {
    const platform: Platform = platformOfServer(raw.stored);
    shots.set(raw.id, {
      snapshotId: raw.id,
      platform,
      device: platform === "web" ? null : raw.browser,
      viewport: raw.viewport,
      projectId: raw.projectId,
      projectName: owner.name,
      buildId: raw.buildId,
      source: { kind: "build", commitSha: null },
      hasMetrics: raw.metricsKey !== null,
      stale: stale.get(raw.id) ?? null,
    });
  }
  for (const entry of entries)
    for (const twin of entry.twins)
      if (!shots.has(twin.snapshotId)) shots.set(twin.snapshotId, twin);

  const rows = await inChunks([...shots.keys()], 0, (ids) =>
    db
      .select({
        id: snapshots.id,
        imageKey: snapshots.imageKey,
        metricsKey: snapshots.metricsKey,
        envFingerprint: snapshots.envFingerprint,
        imageSize: snapshots.imageSize,
      })
      .from(snapshots)
      .where(inArray(snapshots.id, ids)),
  );
  const stored = new Map(rows.map((r) => [r.id, r]));
  return {
    name: key.name,
    theme: key.theme,
    twinProject: twins.twinProject,
    shots: [...shots.values()].toSorted(order).flatMap((twin) => {
      const row = stored.get(twin.snapshotId);
      return row
        ? [
            {
              ...twin,
              imageKey: row.imageKey,
              metricsKey: row.metricsKey,
              scale: scaleOf(row.envFingerprint),
              size: row.imageSize ?? null,
            },
          ]
        : [];
    }),
  };
}
