import { createServerFn } from "@tanstack/react-start";
import { summarizeBuild } from "#/ai/summary";
import { getBuild } from "#/db/builds";
import { clearOrgModel, clearProjectModel, setOrgModel, setProjectModel } from "#/db/models";
import { getProjectWithOrg } from "#/db/orgs";
import { database, modelFetch, modelHosts, modelKeySecret } from "./env";
import { field, or404 } from "./input";
import { requireViewer } from "./session";

/** An optional string of at most 500 chars; empty is none. */
function optionalText(input: unknown, key: string): string {
  const value = typeof input === "object" && input !== null ? Reflect.get(input, key) : null;
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length > 500) throw new Error(`${key} is too long`);
  return text;
}

/** The settings fields of a model form, shared by a project's and an org's. */
function modelInput(d: unknown) {
  return {
    baseUrl: optionalText(d, "baseUrl"),
    model: field(d, "model"),
    apiKey: optionalText(d, "apiKey"),
    autoPassNoise: typeof d === "object" && d !== null && Reflect.get(d, "autoPassNoise") === true,
  };
}

/** The project's own vision model (ob 1473). The key is written here and never read back. */
export const saveProjectModel = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({ projectId: field(d, "projectId"), ...modelInput(d) }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    const { projectId, ...settings } = data;
    await or404(
      setProjectModel(database(), user.id, projectId, {
        ...settings,
        modelKeySecret: modelKeySecret(),
        modelHosts: modelHosts(),
      }),
    );
  });

export const removeProjectModel = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({ projectId: field(d, "projectId") }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    await or404(clearProjectModel(database(), user.id, data.projectId));
  });

/** The org's model (ob 1789), used by its projects that have none of their own. Same write-only key. */
export const saveOrgModel = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({ orgId: field(d, "orgId"), ...modelInput(d) }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    const { orgId, ...settings } = data;
    await or404(
      setOrgModel(database(), user.id, orgId, {
        ...settings,
        modelKeySecret: modelKeySecret(),
        modelHosts: modelHosts(),
      }),
    );
  });

export const removeOrgModel = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({ orgId: field(d, "orgId") }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    await or404(clearOrgModel(database(), user.id, data.orgId));
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
    return {
      stored: await summarizeBuild(
        { db, modelKeySecret: modelKeySecret(), modelFetch: modelFetch() },
        build,
      ),
    };
  });
