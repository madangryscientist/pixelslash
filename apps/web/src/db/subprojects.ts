import { asc, eq, sql } from "drizzle-orm";
import type { Db } from "./db";
import { type LatestBuild, getProject, ensureProject, latestBuilds } from "./orgs";
import { projects } from "./schema";

/** A subproject as its parent's page lists it: a link and its newest build. */
export type SubprojectRow = { id: string; name: string; latest: LatestBuild | null };

/** The project's subprojects by name, each with its newest build; none for a subproject. */
export async function listSubprojects(
  db: Db,
  userId: string,
  projectId: string,
): Promise<SubprojectRow[]> {
  await getProject(db, userId, projectId);
  const rows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.parentProjectId, projectId))
    .orderBy(asc(sql`lower(${projects.name})`), asc(projects.name));
  const latest = await latestBuilds(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({ ...r, latest: latest.get(r.id) ?? null }));
}

/**
 * A subproject of the project, made by a member from its settings page; idempotent, as
 * `POST /api/v1/projects` with `parent` is. It diffs where its parent does.
 */
export async function createSubproject(
  db: Db,
  userId: string,
  parentId: string,
  name: string,
): Promise<{ id: string; created: boolean }> {
  const parent = await getProject(db, userId, parentId);
  const { project, created } = await ensureProject(db, parent.orgId, {
    name,
    diffLocation: parent.diffLocation,
    parentId,
  });
  return { id: project.id, created };
}
