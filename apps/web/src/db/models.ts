import { eq } from "drizzle-orm";
import type { Db } from "./db";
import { warn } from "#/lib/log";
import {
  ModelKeySecretError,
  ModelKeyUnreadableError,
  isSealed,
  openKey,
  sealKey,
} from "./model-key";
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

/** Projects whose key could not be read and whose reason is already logged: once, not per call. */
const logged = new Map<string, string>();

/**
 * The model the project configured, with its key in plain text, for the server's own call; null
 * when none. The one place a stored key is decrypted (ob 1786). A key that cannot be (no secret, or
 * the wrong one) is no model: the build is reviewed as plain pixels, and the reason is logged once.
 */
export async function projectModelFor(
  db: Db,
  projectId: string,
  secret: string | undefined,
): Promise<ProjectModel | null> {
  const row = await storedModel(db, projectId);
  if (!row) return null;
  try {
    const apiKey = await openKey(secret, row.apiKey);
    logged.delete(projectId);
    return { ...row, apiKey };
  } catch (e) {
    if (!(e instanceof ModelKeySecretError || e instanceof ModelKeyUnreadableError)) throw e;
    if (logged.get(projectId) !== e.message) {
      logged.set(projectId, e.message);
      warn(`project ${projectId}: its model is not used: ${e.message}`);
    }
    return null;
  }
}

/** The row as stored: the key is sealed, or plain text from before ob 1786. */
async function storedModel(db: Db, projectId: string): Promise<ProjectModel | null> {
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
  /** The server's `MODEL_KEY_SECRET`, which seals the key (ob 1786); never user input. */
  modelKeySecret: string | undefined;
};

/**
 * The key to store, sealed: the one given, or the stored one when none was (a plain-text one from
 * before ob 1786 is sealed here). The key belongs to the endpoint it was given for: moving the URL
 * without a new key would send the old endpoint's key to the new one. A save never stores plain text:
 * with no `MODEL_KEY_SECRET` it fails. A kept key is left as stored if sealed, and sealed if it is
 * still the plain text from before ob 1786; it is only ever opened in `projectModelFor`.
 */
async function keyToStore(
  current: ProjectModel | null,
  baseUrl: string,
  given: string | undefined,
  secret: string | undefined,
) {
  const apiKey = given?.trim();
  try {
    if (apiKey) return await sealKey(secret, apiKey);
    if (!current) throw new ModelSettingsError("give the model's API key");
    if (current.baseUrl !== baseUrl)
      throw new ModelSettingsError("a new base URL needs its key again");
    return isSealed(current.apiKey) ? current.apiKey : await sealKey(secret, current.apiKey);
  } catch (e) {
    throw e instanceof ModelKeySecretError ? new ModelSettingsError(e.message) : e;
  }
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
  const apiKey = await keyToStore(
    await storedModel(db, projectId),
    baseUrl,
    settings.apiKey,
    settings.modelKeySecret,
  );
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
