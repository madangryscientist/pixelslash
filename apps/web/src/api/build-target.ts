import { and, desc, eq, ne } from "drizzle-orm";
import { type Actor, actorProject } from "#/db/actor";
import { type NewBuild, createBuild } from "#/db/builds";
import type { Db } from "#/db/db";
import type { Project } from "#/db/orgs";
import { type BuildStatus, builds, projects } from "#/db/schema";
import { BadRequest, object } from "./validate";

/** `subproject` names no subproject of the build's project: a 404 with its own code. Uploads never make one. */
export class UnknownSubprojectError extends Error {
  static readonly CODE = "unknown_subproject";
  readonly code = UnknownSubprojectError.CODE;
  constructor(name: string) {
    super(
      `no subproject "${name}" in this project: create it with \`pixelslash project create ${name} --parent PROJECT\``,
    );
    this.name = "UnknownSubprojectError";
  }
}

/**
 * A CI token's build goes to its project; a personal or org token names one it can see in
 * `projectId`.
 */
export function projectIdOf(body: unknown, actor: Actor): string {
  const named = object(body, "body").projectId;
  if (named !== undefined && typeof named !== "string")
    throw new BadRequest("projectId must be a string");
  if (actor.kind === "ci") return named ?? actor.projectId;
  if (!named)
    throw new BadRequest(
      `projectId is required with ${actor.kind === "org-ci" ? "an org" : "a personal"} token`,
    );
  return named;
}

/**
 * The project a new build lands on: the one `projectId` (or the CI token) names, or, with
 * `subproject`, that project's subproject of that name. With no `subproject` it is the project
 * itself, its own lane with its own baselines, as before subprojects existed.
 */
export async function buildProject(db: Db, actor: Actor, body: unknown): Promise<Project> {
  const project = await actorProject(db, actor, projectIdOf(body, actor));
  const name = object(body, "body").subproject;
  if (name === undefined) return project;
  if (typeof name !== "string" || name === "")
    throw new BadRequest("subproject must be a subproject's name");
  if (project.parentProjectId !== null)
    throw new BadRequest("projectId names a subproject: send its parent's id with subproject");
  const [sub] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.parentProjectId, project.id), eq(projects.name, name)));
  if (!sub) throw new UnknownSubprojectError(name);
  return actorProject(db, actor, sub.id);
}

/**
 * `skipped: true`: nothing ran on this commit (a task cache skipped the capture), so the project
 * gets a `passed` build with no shots, which no baseline pick can choose. A commit the project
 * already built (past uploading) keeps that build: a rerun that skips never hides what the real
 * run found.
 */
export async function skippedBuild(
  db: Db,
  projectId: string,
  input: NewBuild,
): Promise<{ id: string; status: BuildStatus; skipped: boolean }> {
  const [built] = await db
    .select({ id: builds.id, status: builds.status })
    .from(builds)
    .where(
      and(
        eq(builds.projectId, projectId),
        eq(builds.commitSha, input.commitSha),
        // An upload that died leaves its build open; the skipped one is then newer, and counts.
        ne(builds.status, "uploading"),
      ),
    )
    .orderBy(desc(builds.createdAt), desc(builds.id))
    .limit(1);
  if (built) return { ...built, skipped: false };
  return { id: await createBuild(db, projectId, input, "passed"), status: "passed", skipped: true };
}
