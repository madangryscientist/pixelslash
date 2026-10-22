import { eq } from "drizzle-orm";
import type { Db } from "./db";
import { getProject } from "./orgs";
import { projectModels } from "./schema";

/**
 * A project's own vision model (ob 1473). The key is write-only: `projectModelFor` is the one read
 * that returns it, for the server's call to the model, and every page reads `ProjectModelView`.
 */

export type ProjectModel = typeof projectModels.$inferSelect;

/** What a page may show: whether a key is set, never the key. */
export type ProjectModelView = {
  baseUrl: string;
  model: string;
  keySet: true;
  autoPassNoise: boolean;
};

/** The model the project configured, key included, for the server's own call; null when none. */
export async function projectModelFor(db: Db, projectId: string): Promise<ProjectModel | null> {
  const [row] = await db.select().from(projectModels).where(eq(projectModels.projectId, projectId));
  return row ?? null;
}

/** The project's model as a member sees it, or null. */
export async function projectModelView(
  db: Db,
  userId: string,
  projectId: string,
): Promise<ProjectModelView | null> {
  await getProject(db, userId, projectId);
  const [row] = await db
    .select({
      baseUrl: projectModels.baseUrl,
      model: projectModels.model,
      autoPassNoise: projectModels.autoPassNoise,
    })
    .from(projectModels)
    .where(eq(projectModels.projectId, projectId));
  return row ? { ...row, keySet: true } : null;
}

export class ModelSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelSettingsError";
  }
}

/** An http(s) base URL with no trailing slash; anything else is refused before it is stored. */
export function modelBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    // Not echoed: a key pasted into the wrong field must not reach an error or a log.
    throw new ModelSettingsError("base URL is not a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new ModelSettingsError("base URL must be http or https");
  if (url.username || url.password)
    throw new ModelSettingsError("put the key in the key field, not the URL");
  return url.toString().replace(/\/+$/, "");
}

export type ModelSettings = {
  baseUrl: string;
  model: string;
  /** Empty or left out keeps the stored key; a first save must give one. */
  apiKey?: string | undefined;
  autoPassNoise: boolean;
};

/**
 * The key to store: the one given, or the stored one when none was. The key belongs to the endpoint
 * it was given for: moving the URL without a new key would send the old endpoint's key to the new one.
 */
function keyToStore(current: ProjectModel | null, baseUrl: string, given: string | undefined) {
  const apiKey = given?.trim();
  if (apiKey) return apiKey;
  if (!current) throw new ModelSettingsError("give the model's API key");
  if (current.baseUrl !== baseUrl)
    throw new ModelSettingsError("a new base URL needs its key again");
  return current.apiKey;
}

/** Save the project's model; any member may, as any member may issue a token. */
export async function setProjectModel(
  db: Db,
  userId: string,
  projectId: string,
  settings: ModelSettings,
): Promise<void> {
  await getProject(db, userId, projectId);
  const baseUrl = modelBaseUrl(settings.baseUrl);
  const model = settings.model.trim();
  if (!model) throw new ModelSettingsError("name the model, e.g. deepseek-flash");
  const apiKey = keyToStore(await projectModelFor(db, projectId), baseUrl, settings.apiKey);
  const fields = { baseUrl, model, autoPassNoise: settings.autoPassNoise, apiKey };
  await db
    .insert(projectModels)
    .values({ projectId, ...fields })
    .onConflictDoUpdate({ target: projectModels.projectId, set: fields });
}

/** Remove the project's model and its key: from the next build on, no shot is sent anywhere. */
export async function clearProjectModel(db: Db, userId: string, projectId: string): Promise<void> {
  await getProject(db, userId, projectId);
  await db.delete(projectModels).where(eq(projectModels.projectId, projectId));
}
