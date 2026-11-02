import { eq } from "drizzle-orm";
import type { Db } from "./db";
import { getProject } from "./orgs";
import { projects } from "./schema";

/** Whether the project's PR builds post the PR comment (PS-82); the check run is sent either way. */
export async function setGithubComment(
  db: Db,
  userId: string,
  projectId: string,
  githubComment: boolean,
): Promise<void> {
  await getProject(db, userId, projectId);
  await db.update(projects).set({ githubComment }).where(eq(projects.id, projectId));
}
