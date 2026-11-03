import { and, eq, inArray } from "drizzle-orm";
import type { StalePlatform } from "#/lib/stale";
import type { BuildTwins, TwinEntry } from "#/lib/twins";
import type { Db } from "./db";
import { heldShot } from "./markers";
import { builds, snapshots } from "./schema";
import { NATIVE, type StaleScope, causeOf, keyOf, staleIndex, staleOf, staleScope } from "./stale";
import { baselinesOf, held } from "./twins-read";

/** What the stale rule (`./stale`) feeds: the stale mark a diff writes, and the baseline pairs of the release check. */

/**
 * Mark the native shots of a build the diff found while their key was stale (`stale_of` names the
 * web shot behind it), so an unchanged one can still be reviewed and accepted; and clear the mark on
 * shots whose key is not stale (a re-run). Called after the build's shots are measured and before
 * the default branch auto-accepts. A web-only build costs the one query of `nativeNames`.
 */
export async function markStale(db: Db, buildId: string): Promise<void> {
  const [build] = await db
    .select({ projectId: builds.projectId })
    .from(builds)
    .where(eq(builds.id, buildId));
  if (!build) return;
  const mine = await db
    .select({
      id: snapshots.id,
      name: snapshots.name,
      theme: snapshots.theme,
      platform: snapshots.platform,
      staleOf: snapshots.staleOf,
    })
    .from(snapshots)
    .where(
      and(eq(snapshots.buildId, buildId), inArray(snapshots.platform, [...NATIVE]), heldShot()),
    );
  if (mine.length === 0) return;
  const scope = await staleScope(db, build.projectId);
  const stale = staleIndex(await staleOf(db, scope));
  for (const shot of mine) {
    const cause = causeOf(stale, shot);
    const want = cause?.snapshotId ?? null;
    if (want !== shot.staleOf)
      await db.update(snapshots).set({ staleOf: want }).where(eq(snapshots.id, shot.id));
  }
}

/**
 * The baseline twin pairs of a project, for the release check (PS-297): every current web baseline
 * with the current baselines of `platform` under the same key. The `linked` shape of a build's
 * `twins` section, so the parity comparison reads it as it reads a build's.
 */
export async function baselinePairs(
  db: Db,
  scope: StaleScope,
  platform: StalePlatform,
): Promise<BuildTwins["linked"]> {
  const found = (
    await baselinesOf(db, { projectIds: scope.projectIds, platforms: ["web", platform] })
  ).map((raw) => held(raw, scope.projectName));
  const web = found.filter((s) => s.platform === "web");
  const native = found.filter((s) => s.platform === platform);
  const entries: TwinEntry[] = [];
  for (const shot of web) {
    const twins = native
      .filter((n) => keyOf(n) === keyOf(shot))
      .map(({ name: _name, theme: _theme, ...n }) => ({
        ...n,
        source: { kind: "baselines" as const, commitSha: null },
      }));
    if (twins.length === 0) continue;
    entries.push({
      snapshotId: shot.snapshotId,
      name: shot.name,
      theme: shot.theme,
      platform: shot.platform,
      device: shot.device,
      viewport: shot.viewport,
      hasMetrics: shot.hasMetrics,
      stale: null,
      twins,
      missing: [],
    });
  }
  return entries.toSorted(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      a.theme.localeCompare(b.theme) ||
      a.viewport.localeCompare(b.viewport) ||
      a.snapshotId.localeCompare(b.snapshotId),
  );
}
