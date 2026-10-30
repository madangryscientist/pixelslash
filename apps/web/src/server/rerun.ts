import { createServerFn } from "@tanstack/react-start";
import { getBuild } from "#/db/builds";
import { getProjectWithOrg } from "#/db/orgs";
import { NoRecoveryError } from "#/diff/claim";
import { RerunError, rerunShots } from "#/diff/rerun";
import { orgBlobs } from "#/storage/blobs";
import {
  blobStore,
  syncChecks,
  database,
  diffSidecarUrl,
  explainQueue,
  modelKeySecret,
} from "./env";
import { field, or404 } from "./input";
import { requireViewer } from "./session";

/* Partial re-runs on the page (ob 1738): the build page's "Re-run errored shots" and a shot's "Re-run diff". */

/** The picked shot's id; absent means every errored shot of the build. */
function pickedInput(d: unknown): string | null {
  const raw = typeof d === "object" && d !== null ? Reflect.get(d, "snapshotId") : undefined;
  return raw === undefined || raw === null ? null : field(d, "snapshotId");
}

export const rerunBuildShots = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({
    projectId: field(d, "projectId"),
    buildId: field(d, "buildId"),
    snapshotId: pickedInput(d),
  }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    const db = database();
    const { project } = await or404(getProjectWithOrg(db, user.id, data.projectId));
    const build = await or404(getBuild(db, project.id, data.buildId));
    const blobs = orgBlobs(blobStore(), project.orgId);
    try {
      const rerun = await rerunShots(
        {
          db,
          blobs,
          diffSidecar: diffSidecarUrl(),
          modelKeySecret: modelKeySecret(),
          explainQueue: explainQueue(),
        },
        build,
        data.snapshotId,
      );
      await syncChecks(db, [build.id]);
      return rerun;
    } catch (error) {
      // A refusal is a message the page states, not a 500.
      if (error instanceof RerunError || error instanceof NoRecoveryError)
        throw new Error(error.message, { cause: error });
      throw error;
    }
  });
