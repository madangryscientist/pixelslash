import { createServerFn } from "@tanstack/react-start";
import { summarizeBuild } from "#/ai/summary";
import { getBuild } from "#/db/builds";
import { clearProjectModel, setProjectModel } from "#/db/models";
import { getProjectWithOrg } from "#/db/orgs";
import { database } from "./env";
import { field, or404 } from "./input";
import { requireViewer } from "./session";

/** An optional string of at most 500 chars; empty is none. */
function optionalText(input: unknown, key: string): string {
  const value = typeof input === "object" && input !== null ? Reflect.get(input, key) : null;
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length > 500) throw new Error(`${key} is too long`);
  return text;
}

/** The project's own vision model (ob 1473). The key is written here and never read back. */
export const saveProjectModel = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({
    projectId: field(d, "projectId"),
    baseUrl: optionalText(d, "baseUrl"),
    model: field(d, "model"),
    apiKey: optionalText(d, "apiKey"),
    autoPassNoise: typeof d === "object" && d !== null && Reflect.get(d, "autoPassNoise") === true,
  }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    const { projectId, ...settings } = data;
    await or404(setProjectModel(database(), user.id, projectId, settings));
  });

export const removeProjectModel = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({ projectId: field(d, "projectId") }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    await or404(clearProjectModel(database(), user.id, data.projectId));
  });

/**
 * The build page's Regenerate (ob 1668): summarise the build again with the project's model. A
 * build still being measured has no summary to make; a failed call keeps the one stored.
 */
export const regenerateBuildSummary = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({ projectId: field(d, "projectId"), buildId: field(d, "buildId") }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    const db = database();
    const { project } = await or404(getProjectWithOrg(db, user.id, data.projectId));
    const build = await or404(getBuild(db, project.id, data.buildId));
    if (build.status !== "changes" && build.status !== "passed" && build.status !== "failed")
      throw new Error(`build is ${build.status}: it has no verdict to summarise yet`);
    return { stored: await summarizeBuild({ db }, build) };
  });
