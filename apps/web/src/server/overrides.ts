import { createServerFn } from "@tanstack/react-start";
import { BadRequest, parseDiff } from "#/api/validate";
import { getBuild } from "#/db/builds";
import { getProjectWithOrg } from "#/db/orgs";
import {
  OVERRIDE_KEYS,
  OverrideError,
  type VariantKey,
  saveOverride,
  shotTarget,
} from "#/db/overrides";
import type { DiffOptions } from "#/db/schema";
import { NoRecoveryError } from "#/diff/claim";
import { saveAndRediff } from "#/diff/override";
import { RerunError } from "#/diff/rerun";
import { orgBlobs } from "#/storage/blobs";
import { blobStore, database, modelKeySecret } from "./env";
import { field, or404 } from "./input";
import { requireViewer } from "./session";

/* Diff thresholds set from a shot's screen (ob 1495): save one, and re-diff the open build. */

/** The three options the screen edits, each a number or absent; nothing else is taken. */
function overrideInput(d: unknown): DiffOptions {
  const raw = typeof d === "object" && d !== null ? Reflect.get(d, "options") : undefined;
  try {
    const options = parseDiff(raw ?? {});
    const extra = Object.keys(options).find((k) => !OVERRIDE_KEYS.some((o) => o === k));
    if (extra) throw new Error(`${extra} cannot be set here: set it in the config`);
    return options;
  } catch (error) {
    if (error instanceof BadRequest) throw new Error(error.message, { cause: error });
    throw error;
  }
}

export function scopeInput(d: unknown): "test" | "variant" {
  const scope = field(d, "scope");
  if (scope !== "test" && scope !== "variant") throw new Error("scope must be test or variant");
  return scope;
}

export const saveDiffOverride = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({
    projectId: field(d, "projectId"),
    buildId: field(d, "buildId"),
    snapshotId: field(d, "snapshotId"),
    scope: scopeInput(d),
    options: overrideInput(d),
  }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    const db = database();
    const { project } = await or404(getProjectWithOrg(db, user.id, data.projectId));
    const build = await or404(getBuild(db, project.id, data.buildId));
    const target = await or404(shotTarget(db, build.id, data.snapshotId, data.scope));
    const blobs = orgBlobs(blobStore(), project.orgId);
    try {
      return await saveAndRediff(
        { db, blobs, modelKeySecret: modelKeySecret() },
        { userId: user.id, build, target, options: data.options },
      );
    } catch (error) {
      // A refusal is a message the page states, not a 500.
      if (
        error instanceof OverrideError ||
        error instanceof RerunError ||
        error instanceof NoRecoveryError
      )
        throw new Error(error.message, { cause: error });
      throw error;
    }
  });

/** A variant as the settings page names it: all four parts, or none for the test-wide override. */
function variantInput(d: unknown): VariantKey | null {
  const raw = typeof d === "object" && d !== null ? Reflect.get(d, "variant") : null;
  if (raw === null || raw === undefined) return null;
  return {
    platform: field(raw, "platform"),
    browser: field(raw, "browser"),
    viewport: field(raw, "viewport"),
    theme: field(raw, "theme"),
  };
}

/**
 * Clear one override from the project's settings. No build is open there, so none is re-diffed:
 * the next build is measured with the config's values again.
 */
export const clearDiffOverride = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({
    projectId: field(d, "projectId"),
    name: field(d, "name"),
    variant: variantInput(d),
  }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    const target = { name: data.name, variant: data.variant };
    try {
      return await or404(
        saveOverride(database(), user.id, data.projectId, { ...target, options: {} }),
      );
    } catch (error) {
      if (error instanceof OverrideError) throw new Error(error.message, { cause: error });
      throw error;
    }
  });
