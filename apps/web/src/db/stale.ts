import { and, desc, eq, inArray, isNotNull, notInArray, or } from "drizzle-orm";
import { type StaleCause, type StaleItem, type StalePlatform, type StaleShot } from "#/lib/stale";
import { inChunks } from "./chunks";
import { type Db, NotFoundError } from "./db";
import { heldShot } from "./markers";
import { builds, projects, snapshots, users } from "./schema";

/**
 * Stale twins (PS-297). A native shot is stale when the web shot of the same name and theme was
 * accepted as a change after the native shot was last reviewed: the screen moved on the web and the
 * native app has not been looked at since. Derived on every read from the review columns; nothing
 * stores "stale" except `snapshots.stale_of`, which only marks a native shot the diff found while
 * its key was stale so that the shot, though unchanged, can be reviewed (`markStale`).
 *
 * The rule, for a key (name + theme) and a native platform that holds a shot of the key:
 *
 * - The cause is the newest web shot of the key accepted by a person (`reviewed_by` set) whose diff
 *   was `changed`. A first baseline (`new`), an unchanged shot and an auto-accept (the default
 *   branch, the model's pass, a re-run: `reviewed_by` null) are not a cause.
 * - It stays stale until a person accepts a native shot of the key on that platform, in a native
 *   build created after the cause. A carried shot (`carried_from` set) is the same change shown
 *   again, not a decision on it, and does not count.
 * - A key with no native shot is unlinked (`db/twins.ts`), never stale. A project without any native
 *   shot has nothing stale and costs one query.
 *
 * A project's scope is itself and the project it names as its twin or that names it, in its org
 * (a CI token holds one project and reads only its own).
 */

export const NATIVE = ["android", "ios"] as const;
/** The builds that hold diffed shots; as in `db/twins-read.ts`. */
const DIFFED = ["changes", "passed", "failed"] as const;

/** Statement parameters beside a list of names: the scope's projects, the platforms, the statuses. */
const OTHER_PARAMS = 12;

export type StaleScope = { projectIds: string[]; projectName: (id: string) => string };

/** The projects stale is read across for `projectId`: it, and its twin project in either direction. */
export async function staleScope(
  db: Db,
  projectId: string,
  crossProject = true,
): Promise<StaleScope> {
  const [own] = await db
    .select({
      id: projects.id,
      name: projects.name,
      orgId: projects.orgId,
      twin: projects.twinProjectId,
    })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!own) throw new NotFoundError("project");
  const names = new Map([[own.id, own.name]]);
  if (crossProject) {
    const linked = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(
        and(
          eq(projects.orgId, own.orgId),
          own.twin
            ? or(eq(projects.id, own.twin), eq(projects.twinProjectId, own.id))
            : eq(projects.twinProjectId, own.id),
        ),
      );
    for (const p of linked) names.set(p.id, p.name);
  }
  return { projectIds: [...names.keys()], projectName: (id) => names.get(id) ?? "" };
}

export const keyOf = (s: { name: string; theme: string }) => JSON.stringify([s.name, s.theme]);

/** The names of the native shots in scope: where a stale key can be. Empty for a web-only project. */
async function nativeNames(db: Db, scope: StaleScope): Promise<string[]> {
  const rows = await db
    .selectDistinct({ name: snapshots.name })
    .from(snapshots)
    .innerJoin(builds, eq(builds.id, snapshots.buildId))
    .where(
      and(
        inArray(builds.projectId, scope.projectIds),
        inArray(snapshots.platform, [...NATIVE]),
        inArray(builds.status, [...DIFFED]),
        heldShot(),
      ),
    );
  return rows.map((r) => r.name);
}

/** The newest web change a person accepted, per key, under the names. */
async function changeCauses(
  db: Db,
  scope: StaleScope,
  names: string[],
): Promise<Map<string, { name: string; theme: string; cause: StaleCause }>> {
  const rows = await inChunks(names, OTHER_PARAMS + scope.projectIds.length, (part) =>
    db
      .select({
        snapshotId: snapshots.id,
        buildId: snapshots.buildId,
        projectId: builds.projectId,
        name: snapshots.name,
        theme: snapshots.theme,
        carriedFrom: snapshots.carriedFrom,
        reviewedAt: snapshots.reviewedAt,
        userName: users.name,
        login: users.login,
      })
      .from(snapshots)
      .innerJoin(builds, eq(builds.id, snapshots.buildId))
      .leftJoin(users, eq(users.id, snapshots.reviewedBy))
      .where(
        and(
          inArray(builds.projectId, scope.projectIds),
          inArray(snapshots.name, part),
          notInArray(snapshots.platform, [...NATIVE]),
          eq(snapshots.diffStatus, "changed"),
          eq(snapshots.reviewState, "accepted"),
          isNotNull(snapshots.reviewedBy),
          isNotNull(snapshots.reviewedAt),
        ),
      ),
  );
  // Newest first; at one moment the shot that measured the change (not a carrier of it) names it.
  const ordered = rows.toSorted(
    (a, b) =>
      (b.reviewedAt?.getTime() ?? 0) - (a.reviewedAt?.getTime() ?? 0) ||
      Number(a.carriedFrom !== null) - Number(b.carriedFrom !== null) ||
      a.snapshotId.localeCompare(b.snapshotId),
  );
  const causes = new Map<string, { name: string; theme: string; cause: StaleCause }>();
  for (const r of ordered) {
    const key = keyOf(r);
    if (causes.has(key) || r.reviewedAt === null) continue;
    causes.set(key, {
      name: r.name,
      theme: r.theme,
      cause: {
        snapshotId: r.snapshotId,
        buildId: r.buildId,
        projectId: r.projectId,
        projectName: scope.projectName(r.projectId),
        acceptedBy: r.userName ?? r.login,
        acceptedAt: r.reviewedAt,
      },
    });
  }
  return causes;
}

type Native = {
  id: string;
  buildId: string;
  projectId: string;
  name: string;
  theme: string;
  platform: StalePlatform;
  browser: string;
  viewport: string;
  builtAt: Date;
  /** A person accepted it as its own decision (not carried, not an auto-accept). */
  decided: boolean;
};

/** The native shots of the keys, newest build first. */
async function nativesOf(db: Db, scope: StaleScope, names: string[]): Promise<Native[]> {
  const rows = await inChunks(names, OTHER_PARAMS + scope.projectIds.length, (part) =>
    db
      .select({
        id: snapshots.id,
        buildId: snapshots.buildId,
        projectId: builds.projectId,
        name: snapshots.name,
        theme: snapshots.theme,
        platform: snapshots.platform,
        browser: snapshots.browser,
        viewport: snapshots.viewport,
        builtAt: builds.createdAt,
        reviewState: snapshots.reviewState,
        reviewedBy: snapshots.reviewedBy,
        carriedFrom: snapshots.carriedFrom,
      })
      .from(snapshots)
      .innerJoin(builds, eq(builds.id, snapshots.buildId))
      .where(
        and(
          inArray(builds.projectId, scope.projectIds),
          inArray(snapshots.name, part),
          inArray(snapshots.platform, [...NATIVE]),
          inArray(builds.status, [...DIFFED]),
          heldShot(),
        ),
      )
      .orderBy(desc(builds.createdAt), desc(snapshots.id)),
  );
  return rows.flatMap((r) =>
    r.platform === "android" || r.platform === "ios"
      ? [
          {
            id: r.id,
            buildId: r.buildId,
            projectId: r.projectId,
            name: r.name,
            theme: r.theme,
            platform: r.platform,
            browser: r.browser,
            viewport: r.viewport,
            builtAt: r.builtAt,
            decided:
              r.reviewState === "accepted" && r.reviewedBy !== null && r.carriedFrom === null,
          },
        ]
      : [],
  );
}

/** The newest native shot per device and viewport, as a reviewer is sent to it. */
function shotsOfKey(natives: Native[]): StaleShot[] {
  const seen = new Set<string>();
  const out: StaleShot[] = [];
  for (const n of natives) {
    const at = JSON.stringify([n.browser, n.viewport]);
    if (seen.has(at)) continue;
    seen.add(at);
    out.push({
      snapshotId: n.id,
      buildId: n.buildId,
      projectId: n.projectId,
      device: n.browser,
      viewport: n.viewport,
    });
  }
  return out;
}

/**
 * Every stale twin across the scope: a key on a native platform, with the web change behind it.
 * Ordered by name, theme, platform. `platform` narrows it to one native platform.
 */
export async function staleOf(
  db: Db,
  scope: StaleScope,
  platform?: StalePlatform,
): Promise<StaleItem[]> {
  const names = await nativeNames(db, scope);
  if (names.length === 0) return [];
  const causes = await changeCauses(db, scope, names);
  if (causes.size === 0) return [];
  const natives = await nativesOf(
    db,
    scope,
    [...causes.values()].map((c) => c.name),
  );
  const items: StaleItem[] = [];
  for (const [key, { cause }] of causes) {
    for (const p of NATIVE) {
      if (platform !== undefined && p !== platform) continue;
      const here = natives.filter((n) => keyOf(n) === key && n.platform === p);
      if (here.length === 0) continue;
      // Reviewed by a person in a native build made after the web change: the twin was looked at.
      if (here.some((n) => n.decided && n.builtAt.getTime() > cause.acceptedAt.getTime())) continue;
      const [first] = here;
      if (!first) continue;
      items.push({
        name: first.name,
        theme: first.theme,
        platform: p,
        cause,
        shots: shotsOfKey(here),
      });
    }
  }
  return items.toSorted(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      a.theme.localeCompare(b.theme) ||
      a.platform.localeCompare(b.platform),
  );
}

/** The stale twins of a project (and its twin project): the project page's list and the read. */
export async function projectStale(
  db: Db,
  projectId: string,
  options: { crossProject?: boolean; platform?: StalePlatform } = {},
): Promise<StaleItem[]> {
  const scope = await staleScope(db, projectId, options.crossProject ?? true);
  return staleOf(db, scope, options.platform);
}

/** `platform + key` -> the cause, for marking twins in a build's `twins` section. */
export function staleIndex(items: StaleItem[]): Map<string, StaleCause> {
  return new Map(items.map((i) => [`${i.platform}\u0000${keyOf(i)}`, i.cause]));
}

/** The cause of a native shot's key, or null: the shot is not native, or its key is not stale. */
export function causeOf(
  index: Map<string, StaleCause>,
  shot: { platform: string; name: string; theme: string },
): StaleCause | null {
  return index.get(`${shot.platform}\u0000${keyOf(shot)}`) ?? null;
}
