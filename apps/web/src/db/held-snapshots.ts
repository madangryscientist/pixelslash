import { Param, SQL, getTableColumns, is, sql } from "drizzle-orm";
import { timeIf, type PartTimer } from "#/server/server-timing";
import { type SnapshotKey, snapshotKeyOf } from "./baselines";
import {
  type Build,
  type SnapshotInput,
  BuildFinalisedError,
  cellsOf,
  fieldsOf,
  stillUploading,
} from "./builds";
import { MAX_PARAMS } from "./chunks";
import type { Db } from "./db";
import { labelOpenFlakes } from "./flakes";
import { heldImages } from "./held-images";
import { snapshots } from "./schema";

/**
 * Held, unchanged shots registered in one pass: the rows of many shots whose PNGs the project
 * already holds, written a few statements at a time instead of one request and one insert each.
 */

/** One shot registered by hash: its meta, and the hash of an image the project holds. */
export type HeldShot = { input: SnapshotInput; sha256: string };

const IDENTITY = ["id", "buildId", "name", "platform", "browser", "viewport", "theme"];

/** Pack rows into statements that each bind at most `MAX_PARAMS` parameters (D1's limit). */
function statementsOf(buildId: string, rows: (typeof snapshots.$inferInsert)[]): SQL[] {
  const statements: SQL[][] = [];
  let binds = 0;
  for (const row of rows) {
    const cells = cellsOf(row);
    // The guard binds the build id once more.
    const own = cells.filter((c) => is(c, Param)).length + 1;
    const last = statements.at(-1);
    if (!last || binds + own > MAX_PARAMS) {
      statements.push([]);
      binds = 0;
    }
    (statements.at(-1) ?? []).push(
      sql`select ${sql.join(cells, sql`, `)} ${stillUploading(buildId)}`,
    );
    binds += own;
  }
  return statements.map((selects) => sql.join(selects, sql` union all `));
}

/**
 * Register many shots whose PNGs the project already holds, in one pass: the build is checked by
 * the caller once, the held images are looked up together and the rows are written a statement
 * at a time with several rows each, not one request and one insert per shot. A shot gets the row
 * `putSnapshot` gives a by-hash shot sent with no metrics, flake record or CI results, and the
 * same flake label (`labelFlake` with no record). A hash the project no longer holds is named in
 * `missing` and its shots are not stored; the client sends those with their files. A key sent
 * twice keeps its last shot, as a PUT sent twice does.
 */
export async function putHeldSnapshots(
  { db, timer }: { db: Db; timer?: PartTimer | undefined },
  build: Build,
  sent: HeldShot[],
): Promise<{ stored: number; missing: string[] }> {
  if (build.status !== "uploading") throw new BuildFinalisedError();
  const hashes = [...new Set(sent.map((s) => s.sha256))];
  const held = await timeIf(timer, "db", () => heldImages(db, build.projectId, hashes));
  const missing = hashes.filter((h) => !held.has(h));
  const byKey = new Map<string, typeof snapshots.$inferInsert>();
  for (const { input, sha256 } of sent) {
    const image = held.get(sha256);
    if (!image) continue;
    const { name, platform, browser, viewport, theme } = input;
    byKey.set(snapshotKeyOf(input), {
      id: crypto.randomUUID(),
      buildId: build.id,
      name,
      platform,
      browser,
      viewport,
      theme,
      ...fieldsOf(input, image, { metricsKey: null, ciResults: null, flake: null }),
    });
  }
  const rows = [...byKey.values()];
  const columns = getTableColumns(snapshots);
  const set = Object.fromEntries(
    Object.entries(columns)
      .filter(([key]) => !IDENTITY.includes(key) && rows.some((r) => key in r))
      .map(([key, col]) => [key, sql.raw(`excluded."${col.name}"`)]),
  );
  const stored: { id: string; flakeId: string | null; key: SnapshotKey }[] = [];
  for (const select of statementsOf(build.id, rows)) {
    const out = await timeIf(timer, "db", () =>
      db
        .insert(snapshots)
        .select(select)
        .onConflictDoUpdate({
          target: [
            snapshots.buildId,
            snapshots.name,
            snapshots.platform,
            snapshots.browser,
            snapshots.viewport,
            snapshots.theme,
          ],
          set,
        })
        .returning({
          id: snapshots.id,
          flakeId: snapshots.flakeId,
          name: snapshots.name,
          platform: snapshots.platform,
          browser: snapshots.browser,
          viewport: snapshots.viewport,
          theme: snapshots.theme,
        }),
    );
    for (const { id, flakeId, ...key } of out) stored.push({ id, flakeId, key });
  }
  // A finalise between the check above and a statement leaves that statement's rows unwritten.
  if (stored.length !== rows.length) throw new BuildFinalisedError();
  await timeIf(timer, "flake", () => labelOpenFlakes(db, build.projectId, stored));
  return { stored: stored.length, missing };
}
