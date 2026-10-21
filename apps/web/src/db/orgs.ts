import { and, asc, eq } from "drizzle-orm";
import { type Db, NotFoundError } from "./db";
import { invites, members, orgs, projects } from "./schema";
import type { User } from "./users";

export type Org = typeof orgs.$inferSelect;
export type Project = typeof projects.$inferSelect;

/** The creator is the first member. */
export async function createOrg(db: Db, userId: string, name: string): Promise<Org> {
  const [org] = await db.insert(orgs).values({ id: crypto.randomUUID(), name }).returning();
  if (!org) throw new Error("org insert returned nothing");
  await db.insert(members).values({ orgId: org.id, userId });
  return org;
}

/** Every org the user belongs to, each with its projects, by name. */
export async function listOrgs(db: Db, userId: string) {
  const rows = await db
    .select({ org: orgs, project: projects })
    .from(members)
    .innerJoin(orgs, eq(orgs.id, members.orgId))
    .leftJoin(projects, eq(projects.orgId, orgs.id))
    .where(eq(members.userId, userId))
    .orderBy(asc(orgs.name), asc(projects.name));
  const byId = new Map<string, Org & { projects: Project[] }>();
  for (const { org, project } of rows) {
    const entry = byId.get(org.id) ?? { ...org, projects: [] };
    if (project) entry.projects.push(project);
    byId.set(org.id, entry);
  }
  return [...byId.values()];
}

/** Every org-scoped read and write starts here: not a member reads as not found. */
export async function requireMember(db: Db, userId: string, orgId: string): Promise<void> {
  const [row] = await db
    .select({ orgId: members.orgId })
    .from(members)
    .where(and(eq(members.orgId, orgId), eq(members.userId, userId)));
  if (!row) throw new NotFoundError("org");
}

export async function inviteMember(
  db: Db,
  inviter: User,
  orgId: string,
  githubLogin: string,
): Promise<void> {
  await requireMember(db, inviter.id, orgId);
  await db
    .insert(invites)
    .values({
      id: crypto.randomUUID(),
      orgId,
      githubLogin: githubLogin.toLowerCase(),
      invitedBy: inviter.id,
    })
    .onConflictDoNothing();
}

export async function createProject(
  db: Db,
  userId: string,
  orgId: string,
  name: string,
): Promise<Project> {
  await requireMember(db, userId, orgId);
  const [project] = await db
    .insert(projects)
    .values({ id: crypto.randomUUID(), orgId, name })
    .returning();
  if (!project) throw new Error("project insert returned nothing");
  return project;
}

/** A project the user can see, or NotFoundError: another org's project does not exist to them. */
export async function getProject(db: Db, userId: string, projectId: string): Promise<Project> {
  const [row] = await db
    .select({ project: projects })
    .from(projects)
    .innerJoin(members, and(eq(members.orgId, projects.orgId), eq(members.userId, userId)))
    .where(eq(projects.id, projectId));
  if (!row) throw new NotFoundError("project");
  return row.project;
}

/** A visible project with the org it belongs to: the page header names both. */
export async function getProjectWithOrg(
  db: Db,
  userId: string,
  projectId: string,
): Promise<{ project: Project; org: Pick<Org, "id" | "name"> }> {
  const [row] = await db
    .select({ project: projects, org: { id: orgs.id, name: orgs.name } })
    .from(projects)
    .innerJoin(orgs, eq(orgs.id, projects.orgId))
    .innerJoin(members, and(eq(members.orgId, projects.orgId), eq(members.userId, userId)))
    .where(eq(projects.id, projectId));
  if (!row) throw new NotFoundError("project");
  return row;
}
