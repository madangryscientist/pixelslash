import { eq } from "drizzle-orm";
import type { Db } from "./db";
import { refuseOnSubproject } from "./effective";
import { getProject } from "./orgs";
import { projects } from "./schema";

/** Whether the project's PR builds post the PR comment (PS-82); the commit status is sent either way. */
export async function setGithubComment(
  db: Db,
  userId: string,
  projectId: string,
  githubComment: boolean,
): Promise<void> {
  refuseOnSubproject(await getProject(db, userId, projectId), "PR comment switch");
  await db.update(projects).set({ githubComment }).where(eq(projects.id, projectId));
}
