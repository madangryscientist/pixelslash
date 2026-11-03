import { and, eq, ne } from "drizzle-orm";
import type { StaleCause } from "#/lib/stale";
import {
  type BuildTwins,
  PLATFORMS,
  type Platform,
  type Twin,
  type TwinEntry,
  type TwinSource,
  noTwins,
} from "#/lib/twins";
import { type Db, NotFoundError } from "./db";
import { getProject } from "./orgs";
import { builds, projects } from "./schema";
import { causeOf, staleIndex, staleOf, staleScope } from "./stale";
import { type Held, baselinesOf, buildAtCommit, hasBaselines, held, shotsOf } from "./twins-read";

/**
 * Twin snapshots (PS-295): a web shot and a native shot of the same screen. A twin shares the
 * snapshot's name and theme and differs in platform; viewport and device are not part of the key,
 * so a key may have several shots on a side and all of them are listed. This is a function over a
 * `Db`, not a screen's logic: the parity check (PS-296) calls it too.
 *
 * Where the other platform's shots come from, per platform, first match wins, and a match is
 * authoritative (a key it lacks is unlinked, not looked up elsewhere):
 *
 * 1. The build itself, when it holds any shot of that platform.
 * 2. The linked twin project's newest build at the same commit, when it holds any.
 * 3. The current baselines: the newest accepted shot per snapshot key of the build's project and,
 *    when linked, of the twin project.
 *
 * Nothing here changes a snapshot's identity, its key or its diff.
 */

/** A project that cannot be named as a twin: unknown, itself, or of another org. A 400. */
export class TwinProjectError extends Error {}

const keyOf = (s: { name: string; theme: string }) => JSON.stringify([s.name, s.theme]);

type Options = {
  /**
   * Whether the twin project may be read. A project's own CI token holds one project, so it is
   * read without the link (the twin project's shots are another project's); everyone else may.
   */
  crossProject: boolean;
};

type Named = { id: string; name: string };

/** What the pairing starts from: the build, its project, and the twin project when one is honoured. */
type Context = {
  build: { id: string; projectId: string; commitSha: string };
  own: Named;
  twinProject: Named | null;
  projectName: (id: string) => string;
};

/** Per platform, the shots to pair against and where they came from. */
type Sides = Map<Platform, { source: TwinSource; shots: Held[] }>;

async function contextOf(db: Db, buildId: string, crossProject: boolean): Promise<Context> {
  const [build] = await db
    .select({ id: builds.id, projectId: builds.projectId, commitSha: builds.commitSha })
    .from(builds)
    .where(eq(builds.id, buildId));
  if (!build) throw new NotFoundError("build");
  const [own] = await db
    .select({
      id: projects.id,
      name: projects.name,
      orgId: projects.orgId,
      twin: projects.twinProjectId,
    })
    .from(projects)
    .where(eq(projects.id, build.projectId));
  if (!own) throw new NotFoundError("project");
  const [linked] =
    crossProject && own.twin
      ? await db
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          // A link to another org's project is never honoured, whatever the row says.
          .where(and(eq(projects.id, own.twin), eq(projects.orgId, own.orgId)))
      : [];
  const twinProject = linked ?? null;
  const names = new Map([[own.id, own.name]]);
  if (twinProject) names.set(twinProject.id, twinProject.name);
  return { build, own, twinProject, projectName: (id) => names.get(id) ?? "" };
}

const onPlatform = (shots: Held[], platform: Platform) =>
  shots.filter((s) => s.platform === platform);

/** Adds the twin project's newest build at the build's commit, for the platforms still without a side. */
async function addCommitSides(db: Db, ctx: Context, sides: Sides): Promise<void> {
  const match = ctx.twinProject
    ? await buildAtCommit(db, ctx.twinProject.id, ctx.build.commitSha)
    : null;
  if (!match) return;
  const there = (await shotsOf(db, match.id)).map((raw) => held(raw, ctx.projectName));
  for (const platform of PLATFORMS) {
    const shots = onPlatform(there, platform);
    if (!sides.has(platform) && shots.length > 0)
      sides.set(platform, { source: { kind: "commit", commitSha: match.commitSha }, shots });
  }
}

/** Adds the current baselines, for the platforms still without a side: a platform that has any is in play. */
async function addBaselineSides(db: Db, ctx: Context, mine: Held[], sides: Sides): Promise<void> {
  const projectIds = ctx.twinProject ? [ctx.own.id, ctx.twinProject.id] : [ctx.own.id];
  const open = PLATFORMS.filter((p) => !sides.has(p));
  const found = (
    await baselinesOf(db, {
      projectIds,
      platforms: open,
      names: mine.map((s) => s.name),
      exceptBuild: ctx.build.id,
    })
  ).map((raw) => held(raw, ctx.projectName));
  for (const platform of open) {
    const shots = onPlatform(found, platform);
    const present =
      shots.length > 0 ||
      (await hasBaselines(db, { projectIds, platform, exceptBuild: ctx.build.id }));
    if (present) sides.set(platform, { source: { kind: "baselines", commitSha: null }, shots });
  }
}

/** Per platform, where its shots come from. The build wins, then the twin project's same-commit build, then baselines. */
async function sidesOf(db: Db, ctx: Context, mine: Held[]): Promise<Sides> {
  const sides: Sides = new Map();
  for (const platform of PLATFORMS) {
    const shots = onPlatform(mine, platform);
    if (shots.length > 0)
      sides.set(platform, { source: { kind: "build", commitSha: null }, shots });
  }
  await addCommitSides(db, ctx, sides);
  await addBaselineSides(db, ctx, mine, sides);
  return sides;
}

/** Every platform's shots grouped by key (name + theme), each tagged with where it came from. */
function byKeyOf(sides: Sides): Map<Platform, Map<string, Twin[]>> {
  const byKey = new Map<Platform, Map<string, Twin[]>>();
  for (const [platform, { source, shots }] of sides) {
    const keyed = new Map<string, Twin[]>();
    for (const { name, theme, ...shot } of shots) {
      const key = keyOf({ name, theme });
      keyed.set(key, [...(keyed.get(key) ?? []), { ...shot, source }]);
    }
    byKey.set(platform, keyed);
  }
  return byKey;
}

const twinOrder = (a: Twin, b: Twin) =>
  a.platform.localeCompare(b.platform) ||
  (a.device ?? "").localeCompare(b.device ?? "") ||
  a.viewport.localeCompare(b.viewport) ||
  a.snapshotId.localeCompare(b.snapshotId);

const entryOrder = (a: TwinEntry, b: TwinEntry) =>
  a.name.localeCompare(b.name) ||
  a.theme.localeCompare(b.theme) ||
  a.platform.localeCompare(b.platform) ||
  (a.device ?? "").localeCompare(b.device ?? "") ||
  a.viewport.localeCompare(b.viewport);

/** One shot with the twins every other platform in play holds under its key. */
function entryOf(
  shot: Held,
  inPlay: Platform[],
  byKey: Map<Platform, Map<string, Twin[]>>,
  stale: Map<string, StaleCause>,
): TwinEntry {
  const twins: Twin[] = [];
  const missing: Platform[] = [];
  for (const platform of inPlay.filter((p) => p !== shot.platform)) {
    const here = byKey.get(platform)?.get(keyOf(shot)) ?? [];
    if (here.length === 0) missing.push(platform);
    // A native twin whose key a web change left unreviewed says so (PS-297).
    twins.push(
      ...here.map((t) => ({
        ...t,
        stale: causeOf(stale, { platform: t.platform, name: shot.name, theme: shot.theme }),
      })),
    );
  }
  return {
    snapshotId: shot.snapshotId,
    name: shot.name,
    theme: shot.theme,
    platform: shot.platform,
    device: shot.device,
    viewport: shot.viewport,
    hasMetrics: shot.hasMetrics,
    stale: causeOf(stale, shot),
    twins: twins.toSorted(twinOrder),
    missing,
  };
}

/**
 * The twins of every shot of one build, and its unlinked shots. A build with no platform but its
 * own in play (a web-only project, or no native shot anywhere) comes back empty, and not as an
 * error. `buildId` must be a build the caller already reached (`actorBuild`).
 */
export async function twinsOfBuild(
  db: Db,
  buildId: string,
  options: Options = { crossProject: true },
): Promise<BuildTwins> {
  const ctx = await contextOf(db, buildId, options.crossProject);
  const mine = (await shotsOf(db, ctx.build.id)).map((raw) => held(raw, ctx.projectName));
  if (mine.length === 0) return noTwins(ctx.twinProject);
  const sides = await sidesOf(db, ctx, mine);
  const inPlay = PLATFORMS.filter((p) => sides.has(p));
  if (inPlay.length < 2) return noTwins(ctx.twinProject);

  const byKey = byKeyOf(sides);
  const stale = staleIndex(
    await staleOf(db, await staleScope(db, ctx.own.id, options.crossProject)),
  );
  const entries = mine.map((shot) => entryOf(shot, inPlay, byKey, stale)).toSorted(entryOrder);
  return {
    twinProject: ctx.twinProject,
    linked: entries.filter((e) => e.missing.length === 0),
    unlinked: entries.filter((e) => e.missing.length > 0),
  };
}

/**
 * Name a project of the org as this one's twin, or clear it with null. Any member may, as any
 * member may change the rest of the settings: a non-member gets the same NotFoundError as for any
 * of them, and a project of another org, an unknown one or the project itself is a TwinProjectError.
 */
export async function setTwinProject(
  db: Db,
  userId: string,
  projectId: string,
  twinProjectId: string | null,
): Promise<void> {
  const project = await getProject(db, userId, projectId);
  if (twinProjectId !== null) {
    if (twinProjectId === projectId) throw new TwinProjectError("a project cannot be its own twin");
    const [twin] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, twinProjectId), eq(projects.orgId, project.orgId)));
    if (!twin) throw new TwinProjectError("the twin must be another project of the same org");
  }
  await db.update(projects).set({ twinProjectId }).where(eq(projects.id, projectId));
}

/** The projects the settings page offers as a twin: the org's others, by name. A non-member gets NotFoundError. */
export async function twinCandidates(
  db: Db,
  userId: string,
  projectId: string,
): Promise<{ id: string; name: string }[]> {
  const project = await getProject(db, userId, projectId);
  return db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(and(eq(projects.orgId, project.orgId), ne(projects.id, projectId)))
    .orderBy(projects.name);
}
