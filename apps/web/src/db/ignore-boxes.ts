import { and, desc, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { SnapshotKey } from "./baselines";
import type { Db } from "./db";
import { getProjectWithOrg } from "./orgs";
import { NO_VARIANT, OverrideError, type OverrideTarget, variantOf } from "./overrides";
import { type IgnoreRect, type UiIgnoreBox, snapshots, users } from "./schema";
import { NotFoundError } from "./db";
import { ignoreBoxes } from "./schema-overrides";

/**
 * Ignore boxes drawn in the review UI (ob 1499): a rectangle in image px the server diff skips on
 * one test, or one variant of it, unioned with the ignore areas the shot was uploaded with. Like
 * the UI thresholds (ob 1495) only the server diff reads them, so a CI project refuses a new one but
 * can still clear what it holds (ob 1772). A box
 * is never deleted: clearing it stamps who and when, and the settings page lists the trail.
 */

export type IgnoreBox = OverrideTarget & {
  id: string;
  rect: IgnoreRect;
  by: string;
  at: Date;
  /** Who cleared it and when; `null` while it applies. */
  cleared: { by: string; at: Date } | null;
};

const cleaners = alias(users, "cleaners");

async function rowsOf(db: Db, projectId: string, activeOnly: boolean): Promise<IgnoreBox[]> {
  const rows = await db
    .select({ row: ignoreBoxes, by: users.login, clearedBy: cleaners.login })
    .from(ignoreBoxes)
    .innerJoin(users, eq(users.id, ignoreBoxes.createdBy))
    .leftJoin(cleaners, eq(cleaners.id, ignoreBoxes.clearedBy))
    .where(
      and(
        eq(ignoreBoxes.projectId, projectId),
        activeOnly ? isNull(ignoreBoxes.clearedAt) : undefined,
      ),
    )
    .orderBy(desc(ignoreBoxes.createdAt), ignoreBoxes.id);
  return rows.map(({ row, by, clearedBy }) => ({
    id: row.id,
    name: row.name,
    variant: variantOf(row),
    rect: { x: row.x, y: row.y, width: row.width, height: row.height },
    by,
    at: row.createdAt,
    cleared: row.clearedAt && clearedBy ? { by: clearedBy, at: row.clearedAt } : null,
  }));
}

/** Whether a box applies to a shot: its test, and its variant when it names one. */
function boxApplies(box: OverrideTarget, shot: SnapshotKey): boolean {
  if (box.name !== shot.name) return false;
  const v = box.variant;
  return (
    !v ||
    (v.platform === shot.platform &&
      v.browser === shot.browser &&
      v.viewport === shot.viewport &&
      v.theme === shot.theme)
  );
}

/** A box as the shot's resolved diff stores it, oldest first so the order is stable. */
const asResolved = (b: IgnoreBox): UiIgnoreBox => ({
  ...b.rect,
  id: b.id,
  scope: b.variant ? "variant" : "test",
  by: b.by,
  at: b.at.getTime(),
});

/** The boxes the server diff measures with. Not access-checked: the diff is the server's own. */
export async function loadIgnoreBoxes(
  db: Db,
  projectId: string,
): Promise<{ resolve: (shot: SnapshotKey) => UiIgnoreBox[] }> {
  const active = (await rowsOf(db, projectId, true)).toReversed();
  return { resolve: (shot) => active.filter((b) => boxApplies(b, shot)).map(asResolved) };
}

/**
 * A project's boxes for a member of its org, newest first: those that apply and, in `trail`,
 * every one ever drawn, cleared ones included. Anyone else gets `NotFoundError("project")`.
 */
export async function listIgnoreBoxes(
  db: Db,
  userId: string,
  projectId: string,
): Promise<{ active: IgnoreBox[]; trail: IgnoreBox[] }> {
  await getProjectWithOrg(db, userId, projectId);
  const trail = await rowsOf(db, projectId, false);
  return { active: trail.filter((b) => !b.cleared), trail };
}

async function serverProject(db: Db, userId: string, projectId: string): Promise<void> {
  const { project } = await getProjectWithOrg(db, userId, projectId);
  if (project.diffLocation === "ci")
    throw new OverrideError(
      "this project diffs in CI: the CLI measures with the config, so add the area to its ignore",
    );
}

/** Draw a box on a test (or one variant of it). Returns its id. */
export async function addIgnoreBox(
  db: Db,
  userId: string,
  projectId: string,
  { rect, ...target }: OverrideTarget & { rect: IgnoreRect },
): Promise<string> {
  await serverProject(db, userId, projectId);
  const id = crypto.randomUUID();
  await db.insert(ignoreBoxes).values({
    id,
    projectId,
    name: target.name,
    ...(target.variant ?? NO_VARIANT),
    ...rect,
    createdBy: userId,
    createdAt: new Date(),
  });
  return id;
}

/**
 * Clear a box: it stops applying from the next diff. Returns what it was for, so the caller can
 * re-diff those shots, or `null` when the project has no such box still applying.
 */
export async function clearIgnoreBox(
  db: Db,
  userId: string,
  projectId: string,
  boxId: string,
): Promise<OverrideTarget | null> {
  await getProjectWithOrg(db, userId, projectId);
  const where = and(
    eq(ignoreBoxes.id, boxId),
    eq(ignoreBoxes.projectId, projectId),
    isNull(ignoreBoxes.clearedAt),
  );
  const [row] = await db.select().from(ignoreBoxes).where(where);
  if (!row) return null;
  await db.update(ignoreBoxes).set({ clearedBy: userId, clearedAt: new Date() }).where(where);
  return { name: row.name, variant: variantOf(row) };
}

/** The boxes that apply to one shot, for a member of its org. */
export async function shotIgnoreBoxes(
  db: Db,
  userId: string,
  projectId: string,
  shot: SnapshotKey,
): Promise<IgnoreBox[]> {
  const { active } = await listIgnoreBoxes(db, userId, projectId);
  return active.filter((b) => boxApplies(b, shot));
}

/** Where a shot's uploaded ignore areas came from, as the viewer labels them. */
type UploadedSource = "config" | "manifest";

/**
 * The source of a shot's uploaded ignore areas: a shot we captured got them from the config (its
 * rects and selectors, and `[data-pixelslash-ignore]`); one whose renderer was not ours
 * (`fingerprint.image` "external") from the manifest it was uploaded with.
 */
export async function uploadedIgnoreSource(db: Db, snapshotId: string): Promise<UploadedSource> {
  const [row] = await db
    .select({ fingerprint: snapshots.envFingerprint })
    .from(snapshots)
    .where(eq(snapshots.id, snapshotId));
  if (!row) throw new NotFoundError("snapshot");
  try {
    const parsed: unknown = JSON.parse(row.fingerprint);
    const image = typeof parsed === "object" && parsed ? Reflect.get(parsed, "image") : null;
    return image === "external" ? "manifest" : "config";
  } catch {
    return "config";
  }
}
