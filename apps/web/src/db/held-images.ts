import { and, eq, inArray, ne } from "drizzle-orm";
import { chunk } from "./chunks";
import type { Db } from "./db";
import { heldShot } from "./markers";
import { builds, snapshots } from "./schema";

/** An image the project already holds, named by the hash of its bytes instead of being sent (PS-424). */
export type HeldImage = { sha256: string };

/** The columns a held image lends the shot that names it. */
export type Held = Pick<typeof snapshots.$inferSelect, "imageKey" | "imageSha256" | "imageSize">;

/**
 * The rows of this project's finished builds that hold an image with one of these hashes (PS-424),
 * one per hash. Finished means past `uploading`: `putSnapshot` can still overwrite the blob of a
 * build that is open, and a key shared with another build must never change under it. Scoped to
 * the project (never the org, never another project): a token learns nothing about its siblings.
 * A removed marker holds no image of its own and never matches. The lookup is chunked for D1's
 * 100-parameter limit.
 */
export async function heldImages(
  db: Db,
  projectId: string,
  hashes: readonly string[],
): Promise<Map<string, Held>> {
  const found = new Map<string, Held>();
  // Three more values are bound beside the hashes: the project, `uploading` and `removed`.
  for (const part of chunk(hashes, 3)) {
    const rows = await db
      .select({
        imageKey: snapshots.imageKey,
        imageSha256: snapshots.imageSha256,
        imageSize: snapshots.imageSize,
      })
      .from(snapshots)
      .innerJoin(builds, eq(builds.id, snapshots.buildId))
      .where(
        and(
          inArray(snapshots.imageSha256, part),
          eq(builds.projectId, projectId),
          ne(builds.status, "uploading"),
          heldShot(),
        ),
      );
    for (const row of rows)
      if (row.imageSha256 && !found.has(row.imageSha256)) found.set(row.imageSha256, row);
  }
  return found;
}
