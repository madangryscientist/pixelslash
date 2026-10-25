import { createServerFn } from "@tanstack/react-start";
import { BadRequest, parseRect } from "#/api/validate";
import { getBuild } from "#/db/builds";
import { clearIgnoreBox } from "#/db/ignore-boxes";
import { getProjectWithOrg } from "#/db/orgs";
import { OverrideError, shotTarget } from "#/db/overrides";
import type { IgnoreRect } from "#/db/schema";
import { NoRecoveryError } from "#/diff/claim";
import { addBoxAndRediff, clearBoxAndRediff } from "#/diff/ignore-box";
import { RerunError } from "#/diff/rerun";
import { orgBlobs } from "#/storage/blobs";
import { blobStore, database, diffSidecarUrl, explainQueue, modelKeySecret } from "./env";
import { field, or404 } from "./input";
import { scopeInput } from "./overrides";
import { requireViewer } from "./session";

/* Ignore boxes drawn on a shot's screen (ob 1499): draw one or clear one, and re-diff the build. */

function rectInput(d: unknown): IgnoreRect {
  const raw = typeof d === "object" && d !== null ? Reflect.get(d, "rect") : undefined;
  try {
    return parseRect(raw, "rect");
  } catch (error) {
    // A server fn has no 400: the message is what the form shows.
    if (error instanceof BadRequest) throw new Error(error.message, { cause: error });
    throw error;
  }
}

/** A refusal is a message the page states, not a 500. */
async function refusalsStated<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (
      error instanceof OverrideError ||
      error instanceof RerunError ||
      error instanceof NoRecoveryError
    )
      throw new Error(error.message, { cause: error });
    throw error;
  }
}

/** The caller's project and build, and the deps a re-diff needs; another org's is a 404. */
async function openBuild(projectId: string, buildId: string) {
  const user = await requireViewer();
  const db = database();
  const { project } = await or404(getProjectWithOrg(db, user.id, projectId));
  const build = await or404(getBuild(db, project.id, buildId));
  return {
    user,
    build,
    deps: {
      db,
      blobs: orgBlobs(blobStore(), project.orgId),
      diffSidecar: diffSidecarUrl(),
      modelKeySecret: modelKeySecret(),
      explainQueue: explainQueue(),
    },
  };
}

export const addIgnoreBoxFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({
    projectId: field(d, "projectId"),
    buildId: field(d, "buildId"),
    snapshotId: field(d, "snapshotId"),
    scope: scopeInput(d),
    rect: rectInput(d),
  }))
  .handler(async ({ data }) => {
    const { user, build, deps } = await openBuild(data.projectId, data.buildId);
    const target = await or404(shotTarget(deps.db, build.id, data.snapshotId, data.scope));
    return refusalsStated(
      addBoxAndRediff(deps, { userId: user.id, build, target, rect: data.rect }),
    );
  });

/** Clear a box from a shot's screen: the open build's shots it applied to are measured again. */
export const clearIgnoreBoxFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({
    projectId: field(d, "projectId"),
    buildId: field(d, "buildId"),
    boxId: field(d, "boxId"),
  }))
  .handler(async ({ data }) => {
    const { user, build, deps } = await openBuild(data.projectId, data.buildId);
    return refusalsStated(clearBoxAndRediff(deps, { userId: user.id, build, boxId: data.boxId }));
  });

/**
 * Clear a box from the project's settings. No build is open there, so none is re-diffed: the next
 * build is measured without it.
 */
export const clearIgnoreBoxFromSettings = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({ projectId: field(d, "projectId"), boxId: field(d, "boxId") }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    const cleared = await or404(
      refusalsStated(clearIgnoreBox(database(), user.id, data.projectId, data.boxId)),
    );
    return cleared !== null;
  });
