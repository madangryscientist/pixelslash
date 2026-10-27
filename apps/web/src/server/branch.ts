import { redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { branchView } from "#/db/branch-view";
import { branchWindow } from "#/db/run-metrics";
import { branchMetrics } from "#/lib/branch-metrics";
import { getProjectWithOrg } from "#/db/orgs";
import { isFirstBuild } from "#/db/first-build";
import { signedImagePath } from "#/storage/signed";
import { database, imageSigningSecret } from "./env";
import { field, or404 } from "./input";
import { requireViewer } from "./session";

/** Both modes show the branch shot; it is the same image whichever baseline it is read against. */
const shown = (status: string | null) => status === "changed" || status === "new";

/**
 * The branch page (ob 1723): the branch's newest build, against main and since its last build.
 * The default branch has no branch page: it is what the others are measured against, so the
 * project page stands for it.
 */
export const getBranchPage = createServerFn()
  .validator((d: unknown) => ({ projectId: field(d, "projectId"), branch: field(d, "branch") }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    const db = database();
    const { project, org } = await or404(getProjectWithOrg(db, user.id, data.projectId));
    if (data.branch === project.defaultBranch)
      throw redirect({ to: "/projects/$projectId", params: { projectId: project.id } });
    const view = await or404(branchView(db, project.id, data.branch));
    const secret = imageSigningSecret();
    const thumbs: Record<string, string> = {};
    for (const shot of view.snapshots) {
      if (!shown(shot.diffStatus) && !shown(shot.mainDiffStatus)) continue;
      thumbs[shot.id] = await signedImagePath(`orgs/${project.orgId}/${shot.imageKey}`, secret);
    }
    const firstBuild = await isFirstBuild(db, view.build);
    const metrics = branchMetrics(await branchWindow(db, project.id, data.branch));
    return { org, project, ...view, thumbs, firstBuild, metrics };
  });
