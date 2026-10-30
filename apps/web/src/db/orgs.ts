import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { SNAPSHOT_GROUPS } from "#/lib/snapshot-groups";
import { inChunks } from "./chunks";
import { type Db, NotFoundError } from "./db";
import { type BuildCounts, countBuilds, emptyCounts } from "./build-counts";
import { type DiffLocation, builds, members, orgs, projects, users } from "./schema";
import { invites } from "./schema-invites";
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

/** A project's newest build, whatever its branch, with what its shots came to. */
export type LatestBuild = {
  id: string;
  branch: string;
  commitSha: string;
  prNumber: number | null;
  status: (typeof builds.$inferSelect)["status"];
  createdAt: Date;
  /** Every shot the build holds, removed markers included: the size of the bar's whole. */
  total: number;
  counts: BuildCounts;
};

export type ProjectOverview = Project & { latest: LatestBuild | null };

export type OrgMember = {
  userId: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  joinedAt: Date;
};

/** Names a GitHub login or an email, never both (PS-274). */
export type OrgInvite = {
  id: string;
  githubLogin: string | null;
  email: string | null;
  createdAt: Date;
};

export type OrgOverview = Org & {
  projects: ProjectOverview[];
  members: OrgMember[];
  invites: OrgInvite[];
  /** Projects whose latest build has changed shots still waiting for a decision. */
  waiting: number;
};

async function latestBuilds(db: Db, projectIds: string[]): Promise<Map<string, LatestBuild>> {
  const latest = new Map<string, LatestBuild>();
  if (projectIds.length === 0) return latest;
  const rows = await inChunks(projectIds, 0, (part) =>
    db
      .select({
        id: builds.id,
        projectId: builds.projectId,
        branch: builds.branch,
        commitSha: builds.commitSha,
        prNumber: builds.prNumber,
        status: builds.status,
        createdAt: builds.createdAt,
      })
      .from(builds)
      .where(
        and(
          inArray(builds.projectId, part),
          // The id breaks a tie between two builds created in the same millisecond.
          eq(
            builds.id,
            sql`(select b.id from builds b where b.project_id = ${builds.projectId} order by b.created_at desc, b.id desc limit 1)`,
          ),
        ),
      ),
  );
  const counts = await countBuilds(
    db,
    rows.map((row) => row.id),
  );
  for (const { projectId, ...row } of rows) {
    const held = counts.get(row.id) ?? emptyCounts();
    const total = SNAPSHOT_GROUPS.reduce((sum, group) => sum + held[group], 0);
    latest.set(projectId, { ...row, total, counts: held });
  }
  return latest;
}

/**
 * Every org the user belongs to, by name, each with its projects (latest build and counts),
 * its members and its pending invites: what the organizations page draws.
 */
export async function listOrgs(db: Db, userId: string): Promise<OrgOverview[]> {
  const rows = await db
    .select({ org: orgs, project: projects })
    .from(members)
    .innerJoin(orgs, eq(orgs.id, members.orgId))
    .leftJoin(projects, eq(projects.orgId, orgs.id))
    .where(eq(members.userId, userId))
    .orderBy(
      // Case-folded so 'hackcove' sits with 'Pixel Labs' and 'Zed Studio' in name order; the exact name breaks ties.
      asc(sql`lower(${orgs.name})`),
      asc(orgs.name),
      asc(sql`lower(${projects.name})`),
      asc(projects.name),
    );
  const orgIds = [...new Set(rows.map(({ org }) => org.id))];
  if (orgIds.length === 0) return [];
  const [latest, memberRows, inviteRows] = await Promise.all([
    latestBuilds(
      db,
      rows.flatMap(({ project }) => (project ? [project.id] : [])),
    ),
    // In parts, each org whole: an org's members and invites keep their order.
    inChunks(orgIds, 0, (part) =>
      db
        .select({
          orgId: members.orgId,
          userId: users.id,
          login: users.login,
          name: users.name,
          avatarUrl: users.avatarUrl,
          joinedAt: members.createdAt,
        })
        .from(members)
        .innerJoin(users, eq(users.id, members.userId))
        .where(inArray(members.orgId, part))
        .orderBy(asc(members.createdAt), asc(users.login)),
    ),
    inChunks(orgIds, 0, (part) =>
      db
        .select({
          id: invites.id,
          orgId: invites.orgId,
          githubLogin: invites.githubLogin,
          email: invites.email,
          createdAt: invites.createdAt,
        })
        .from(invites)
        .where(inArray(invites.orgId, part))
        .orderBy(asc(invites.createdAt), asc(invites.githubLogin), asc(invites.email)),
    ),
  ]);
  return assemble(rows, latest, memberRows, inviteRows);
}

function addProject(entry: OrgOverview, project: Project, build: LatestBuild | null): void {
  entry.projects.push({ ...project, latest: build });
  if (build && build.counts.toReview > 0) entry.waiting += 1;
}

type OrgRows = { org: Org; project: Project | null }[];

function assemble(
  rows: OrgRows,
  latest: Map<string, LatestBuild>,
  memberRows: (OrgMember & { orgId: string })[],
  inviteRows: (OrgInvite & { orgId: string })[],
): OrgOverview[] {
  const byId = new Map<string, OrgOverview>();
  for (const { org, project } of rows) {
    const entry = byId.get(org.id) ?? {
      ...org,
      projects: [],
      members: [],
      invites: [],
      waiting: 0,
    };
    if (project) addProject(entry, project, latest.get(project.id) ?? null);
    byId.set(org.id, entry);
  }
  for (const { orgId, ...member } of memberRows) byId.get(orgId)?.members.push(member);
  for (const { orgId, ...invite } of inviteRows) byId.get(orgId)?.invites.push(invite);
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

/** `who` is a GitHub login, or an email when it holds an `@` (no GitHub login can, PS-274). */
export async function inviteMember(
  db: Db,
  inviter: User,
  orgId: string,
  who: string,
): Promise<void> {
  await requireMember(db, inviter.id, orgId);
  const name = who.trim().toLowerCase();
  await db
    .insert(invites)
    .values({
      id: crypto.randomUUID(),
      orgId,
      ...(name.includes("@") ? { email: name } : { githubLogin: name }),
      invitedBy: inviter.id,
    })
    .onConflictDoNothing();
}

/** Takes back an invite that has not been taken up. An id from another org is the same 404 as a missing one. */
export async function withdrawInvite(
  db: Db,
  userId: string,
  orgId: string,
  inviteId: string,
): Promise<void> {
  await requireMember(db, userId, orgId);
  const gone = await db
    .delete(invites)
    .where(and(eq(invites.id, inviteId), eq(invites.orgId, orgId)))
    .returning({ id: invites.id });
  if (gone.length === 0) throw new NotFoundError("invite");
}

/**
 * A deployment's default for new projects (ob 1727), from its `DEFAULT_DIFF_LOCATION` var: `ci`
 * only when it says so (the hosted app), so a self-host that sets nothing diffs on its own server.
 */
export const diffLocationOf = (configured: string | undefined): DiffLocation =>
  configured === "ci" ? "ci" : "server";

/** A new project: its name, and where it diffs (ob 1727); left out, the column's default: `server`. */
export type NewProject = { name: string; diffLocation?: DiffLocation | undefined };

export async function createProject(
  db: Db,
  userId: string,
  orgId: string,
  made: string | NewProject,
): Promise<Project> {
  await requireMember(db, userId, orgId);
  return insertProject(db, orgId, made);
}

async function insertProject(db: Db, orgId: string, made: string | NewProject): Promise<Project> {
  const { name, diffLocation } = typeof made === "string" ? { name: made } : made;
  const [project] = await db
    .insert(projects)
    .values({ id: crypto.randomUUID(), orgId, name, diffLocation })
    .returning();
  if (!project) throw new Error("project insert returned nothing");
  return project;
}

/**
 * The project of that name in the org, made if there is none (ob 1787). The caller has already
 * proved it may act in the org: a member's `psu_` token, or the org's own `psorg_` token.
 * Idempotent: a second call, or a lost race on the (org, name) unique index, finds the first.
 */
export async function ensureProject(
  db: Db,
  orgId: string,
  made: NewProject,
): Promise<{ project: Project; created: boolean }> {
  const find = async () => {
    const [row] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.orgId, orgId), eq(projects.name, made.name)));
    return row;
  };
  const existing = await find();
  if (existing) return { project: existing, created: false };
  try {
    return { project: await insertProject(db, orgId, made), created: true };
  } catch (error) {
    const raced = await find();
    if (raced) return { project: raced, created: false };
    throw error;
  }
}

/** Which branch auto-accepts (ob 1559). Any member may change it, as any member may issue a token. */
export async function setDefaultBranch(
  db: Db,
  userId: string,
  projectId: string,
  branch: string,
): Promise<void> {
  await getProject(db, userId, projectId);
  await db.update(projects).set({ defaultBranch: branch }).where(eq(projects.id, projectId));
}

/** Where the project's shots are diffed from the next build on (ob 1727); any member may change it. */
export async function setDiffLocation(
  db: Db,
  userId: string,
  projectId: string,
  diffLocation: DiffLocation,
): Promise<void> {
  await getProject(db, userId, projectId);
  await db.update(projects).set({ diffLocation }).where(eq(projects.id, projectId));
}

/** The GitHub repo the project's builds report a check run to (PS-23); null disconnects it. */
export async function setGithubRepo(
  db: Db,
  userId: string,
  projectId: string,
  githubRepo: string | null,
): Promise<void> {
  const project = await getProject(db, userId, projectId);
  await db.update(projects).set({ githubRepo }).where(eq(projects.id, projectId));
  // A run id belongs to the repo it was made in: another repo gets new runs on the next sync.
  if (project.githubRepo?.toLowerCase() !== githubRepo?.toLowerCase())
    await db.update(builds).set({ checkRunId: null }).where(eq(builds.projectId, projectId));
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
