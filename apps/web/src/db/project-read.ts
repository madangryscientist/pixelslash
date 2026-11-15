import { and, eq } from "drizzle-orm";
import { type Db, NotFoundError } from "./db";
import { effectiveProject } from "./effective";
import type { Org, Project } from "./orgs";
import { members, orgs, projects } from "./schema";

/* Reading one project for a member, and the rule a subproject's parent keeps. */

/** A subproject's parent is a top-level project of the same org: depth is two. */
export async function requireParent(db: Db, orgId: string, parentId: string): Promise<void> {
  const [parent] = await db
    .select({ orgId: projects.orgId, parentProjectId: projects.parentProjectId })
    .from(projects)
    .where(eq(projects.id, parentId));
  if (!parent || parent.orgId !== orgId) throw new NotFoundError("parent project");
  if (parent.parentProjectId !== null)
    throw new SubprojectDepthError("a subproject cannot have subprojects");
}

/** A parent that is itself a subproject: a 400. */
export class SubprojectDepthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubprojectDepthError";
  }
}

/** A project the user can see, or NotFoundError: another org's project does not exist to them. */
export async function getProject(db: Db, userId: string, projectId: string): Promise<Project> {
  const [row] = await db
    .select({ project: projects })
    .from(projects)
    .innerJoin(members, and(eq(members.orgId, projects.orgId), eq(members.userId, userId)))
    .where(eq(projects.id, projectId));
  if (!row) throw new NotFoundError("project");
  return effectiveProject(db, row.project);
}

/** A project as a page shows it: with its parent's id and name when it is a subproject. */
export type PageProject = Project & { parent: { id: string; name: string } | null };

/** A visible project with the org it belongs to: the page header names both, and a subproject's parent. */
export async function getProjectWithOrg(
  db: Db,
  userId: string,
  projectId: string,
): Promise<{ project: PageProject; org: Pick<Org, "id" | "name"> }> {
  const [row] = await db
    .select({ project: projects, org: { id: orgs.id, name: orgs.name } })
    .from(projects)
    .innerJoin(orgs, eq(orgs.id, projects.orgId))
    .innerJoin(members, and(eq(members.orgId, projects.orgId), eq(members.userId, userId)))
    .where(eq(projects.id, projectId));
  if (!row) throw new NotFoundError("project");
  const project = await effectiveProject(db, row.project);
  return { project: { ...project, parent: await parentOf(db, project) }, org: row.org };
}

async function parentOf(db: Db, project: Project): Promise<PageProject["parent"]> {
  if (project.parentProjectId === null) return null;
  const [parent] = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.id, project.parentProjectId));
  return parent ?? null;
}
