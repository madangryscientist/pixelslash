import { type SQL, and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Build } from "./builds";
import { type Db, NotFoundError } from "./db";
import type { Project } from "./orgs";
import { type DiffLocation, builds, members, orgs, projects, snapshots, users } from "./schema";

/**
 * Who an API request acts for (ob 1728): a CI token holds one project and can upload to it; a
 * personal token acts as its user and sees what they see in the web app.
 */
export type Actor = { kind: "ci"; projectId: string } | { kind: "user"; userId: string };

/** The projects the actor may reach, as a condition on `projects`. Anything else is a 404. */
function visible(db: Db, actor: Actor): SQL {
  if (actor.kind === "ci") return eq(projects.id, actor.projectId);
  const orgIds = db
    .select({ orgId: members.orgId })
    .from(members)
    .where(eq(members.userId, actor.userId));
  return inArray(projects.orgId, orgIds);
}

export async function actorProject(db: Db, actor: Actor, projectId: string): Promise<Project> {
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), visible(db, actor)));
  if (!row) throw new NotFoundError("project");
  return row;
}

/** A build of a project the actor may reach, with the org its blobs live under. */
export async function actorBuild(
  db: Db,
  actor: Actor,
  buildId: string,
): Promise<{ build: Build; orgId: string; diffLocation: DiffLocation }> {
  const [row] = await db
    .select({ build: builds, orgId: projects.orgId, diffLocation: projects.diffLocation })
    .from(builds)
    .innerJoin(projects, eq(projects.id, builds.projectId))
    .where(and(eq(builds.id, buildId), visible(db, actor)));
  if (!row) throw new NotFoundError("build");
  return row;
}

/** Who a personal token is, for the CLI and MCP to check a token with. */
export async function actorUser(db: Db, userId: string) {
  const [row] = await db
    .select({ id: users.id, login: users.login, name: users.name })
    .from(users)
    .where(eq(users.id, userId));
  if (!row) throw new NotFoundError("user");
  return row;
}

/** Every project the actor may reach, with its org: a CI token's one, or all of its user's orgs'. */
export async function actorProjects(db: Db, actor: Actor) {
  return db
    .select({
      id: projects.id,
      name: projects.name,
      defaultBranch: projects.defaultBranch,
      createdAt: projects.createdAt,
      org: { id: orgs.id, name: orgs.name },
    })
    .from(projects)
    .innerJoin(orgs, eq(orgs.id, projects.orgId))
    .where(visible(db, actor))
    .orderBy(asc(sql`lower(${orgs.name})`), asc(sql`lower(${projects.name})`), asc(projects.id));
}

/** A shot of a project the actor may reach, with its build, project and org. */
export async function actorSnapshot(db: Db, actor: Actor, snapshotId: string) {
  const [row] = await db
    .select({ buildId: snapshots.buildId, projectId: projects.id, orgId: projects.orgId })
    .from(snapshots)
    .innerJoin(builds, eq(builds.id, snapshots.buildId))
    .innerJoin(projects, eq(projects.id, builds.projectId))
    .where(and(eq(snapshots.id, snapshotId), visible(db, actor)));
  if (!row) throw new NotFoundError("snapshot");
  return row;
}
