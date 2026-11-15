import { type SQL, eq, sql } from "drizzle-orm";
import { type AnySQLiteColumn, alias } from "drizzle-orm/sqlite-core";
import type { Db } from "./db";
import { projects } from "./schema";

/*
 * What a subproject reads from its parent: the GitHub repo, the PR-comment switch and the default
 * branch (the model and the CI tokens are the parent's too, in `models.ts` and `tokens.ts`). A
 * subproject's own copies of these columns are never read: every server reader goes through
 * `effectiveProject` here, or `inherited` in SQL, so a page shows the value the server acts on.
 */

/** The settings a subproject takes from its parent. */
export type Inherited = {
  githubRepo: string | null;
  githubComment: boolean;
  defaultBranch: string;
};

/** The top-level project of a project: its parent, or itself. */
export const topProjectId = (project: { id: string; parentProjectId: string | null }) =>
  project.parentProjectId ?? project.id;

/** The project with its parent's repo, comment switch and default branch when it is a subproject. */
export async function effectiveProject<P extends Inherited & { parentProjectId: string | null }>(
  db: Db,
  project: P,
): Promise<P> {
  if (project.parentProjectId === null) return project;
  const [parent] = await db
    .select({
      githubRepo: projects.githubRepo,
      githubComment: projects.githubComment,
      defaultBranch: projects.defaultBranch,
    })
    .from(projects)
    .where(eq(projects.id, project.parentProjectId));
  // The parent cascades its subprojects away, so a subproject always has one.
  return parent ? { ...project, ...parent } : project;
}

/** `projects` as a subproject's parent, for a query that left-joins it on `parentJoin`. */
export const parentProjects = alias(projects, "parent_project");

/** The left join that `inherited` reads the parent through. */
export const parentJoin = eq(parentProjects.id, projects.parentProjectId);

/** A column of `projects` as the project acts on it: its parent's for a subproject. */
export function inherited<T>(column: AnySQLiteColumn, parentColumn: AnySQLiteColumn): SQL<T> {
  return sql<T>`case when ${projects.parentProjectId} is null then ${column} else ${parentColumn} end`;
}

/** The project's effective default branch, in SQL (needs `parentJoin`). */
export const effectiveDefaultBranch = () =>
  inherited<string>(projects.defaultBranch, parentProjects.defaultBranch);

/** A write of a setting a subproject reads from its parent: a 400 with its own code. */
export class InheritedFromParentError extends Error {
  static readonly CODE = "inherited_from_parent";
  readonly code = InheritedFromParentError.CODE;
  constructor(setting: string) {
    super(`a subproject's ${setting} is its parent's: set it on the parent project`);
    this.name = "InheritedFromParentError";
  }
}

/** Refuse a write of an inherited setting on a subproject. */
export function refuseOnSubproject(project: { parentProjectId: string | null }, setting: string) {
  if (project.parentProjectId !== null) throw new InheritedFromParentError(setting);
}
