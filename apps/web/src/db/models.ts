import { eq, inArray } from "drizzle-orm";
import type { Db } from "./db";
import { warn } from "#/lib/log";
import { ModelHostError, type ModelHostPolicy, checkModelHost } from "#/ai/model-host";
import {
  ModelKeySecretError,
  ModelKeyUnreadableError,
  isSealed,
  openKey,
  sealKey,
} from "./model-key";
import { getProject, requireMember } from "./orgs";
import { members, orgModels, projectModels, projects } from "./schema";

/**
 * A project's own vision model (ob 1473), or its org's (ob 1789). The key is write-only:
 * `projectModelFor` is the one read that returns it, for the server's call to the model, and every
 * page reads `ModelView`.
 */

/** A model as the server calls it: the project's own, else its org's. */
export type ProjectModel = Pick<
  typeof projectModels.$inferSelect,
  "baseUrl" | "model" | "apiKey" | "autoPassNoise"
>;

/** What a page may show: whether a key is set, never the key. */
export type ModelView = {
  baseUrl: string;
  model: string;
  keySet: true;
  autoPassNoise: boolean;
};

/** Models whose key could not be read and whose reason is already logged: once, not per call. */
const logged = new Map<string, string>();

const MODEL_COLUMNS = {
  baseUrl: orgModels.baseUrl,
  model: orgModels.model,
  apiKey: orgModels.apiKey,
  autoPassNoise: orgModels.autoPassNoise,
};

/**
 * The model a project's builds use, with its key in plain text, for the server's own call; null
 * when none. The project's own settings win; a project with none uses its org's. The one place a
 * stored key is decrypted (ob 1786). A key that cannot be (no secret, or the wrong one) is no model,
 * and a project whose own key is unreadable does not fall back to its org's: the build is reviewed
 * as plain pixels, and the reason is logged once.
 */
export async function projectModelFor(
  db: Db,
  projectId: string,
  secret: string | undefined,
): Promise<ProjectModel | null> {
  const own = await storedModel(db, projectId);
  if (own) return openModel(own, `project ${projectId}`, secret);
  const [org] = await db
    .select({ orgId: orgModels.orgId, ...MODEL_COLUMNS })
    .from(projects)
    .innerJoin(orgModels, eq(orgModels.orgId, projects.orgId))
    .where(eq(projects.id, projectId));
  return org ? openModel(org, `org ${org.orgId}`, secret) : null;
}

async function openModel(
  row: ProjectModel,
  owner: string,
  secret: string | undefined,
): Promise<ProjectModel | null> {
  try {
    const apiKey = await openKey(secret, row.apiKey);
    logged.delete(owner);
    return { baseUrl: row.baseUrl, model: row.model, autoPassNoise: row.autoPassNoise, apiKey };
  } catch (e) {
    if (!(e instanceof ModelKeySecretError || e instanceof ModelKeyUnreadableError)) throw e;
    if (logged.get(owner) !== e.message) {
      logged.set(owner, e.message);
      warn(`${owner}: its model is not used: ${e.message}`);
    }
    return null;
  }
}

/** The project's own row as stored: the key is sealed, or plain text from before ob 1786. */
async function storedModel(db: Db, projectId: string) {
  const [row] = await db.select().from(projectModels).where(eq(projectModels.projectId, projectId));
  return row ?? null;
}

/** The project's own model as a member sees it, or null. */
export async function projectModelView(
  db: Db,
  userId: string,
  projectId: string,
): Promise<ModelView | null> {
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

/** The org's model as a member sees it, or null. */
export async function orgModelView(
  db: Db,
  userId: string,
  orgId: string,
): Promise<ModelView | null> {
  await requireMember(db, userId, orgId);
  const [row] = await db
    .select({
      baseUrl: orgModels.baseUrl,
      model: orgModels.model,
      autoPassNoise: orgModels.autoPassNoise,
    })
    .from(orgModels)
    .where(eq(orgModels.orgId, orgId));
  return row ? { ...row, keySet: true } : null;
}

/** The model of each org the user belongs to that has one, for the organizations page. */
export async function listOrgModelViews(
  db: Db,
  userId: string,
): Promise<(ModelView & { orgId: string })[]> {
  const orgIds = db
    .select({ orgId: members.orgId })
    .from(members)
    .where(eq(members.userId, userId));
  const rows = await db
    .select({
      orgId: orgModels.orgId,
      baseUrl: orgModels.baseUrl,
      model: orgModels.model,
      autoPassNoise: orgModels.autoPassNoise,
    })
    .from(orgModels)
    .where(inArray(orgModels.orgId, orgIds));
  return rows.map((row) => ({ ...row, keySet: true as const }));
}

/** Which model a project's builds use, for its settings page: its own, else its org's, else none. */
export type ModelSource =
  | { source: "project"; model: ModelView; org: ModelView | null }
  | { source: "org"; model: ModelView; org: ModelView }
  | { source: "none"; model: null; org: null };

export async function projectModelSource(
  db: Db,
  userId: string,
  projectId: string,
): Promise<ModelSource> {
  const project = await getProject(db, userId, projectId);
  const own = await projectModelView(db, userId, projectId);
  const org = await orgModelView(db, userId, project.orgId);
  if (own) return { source: "project", model: own, org };
  if (org) return { source: "org", model: org, org };
  return { source: "none", model: null, org: null };
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
  /** Which hosts the server may call (PS-250): its own setting, never user input. */
  modelHosts: ModelHostPolicy;
};

/**
 * The key to store, sealed: the one given, or the stored one when none was (a plain-text one from
 * before ob 1786 is sealed here). The key belongs to the endpoint it was given for: moving the URL
 * without a new key would send the old endpoint's key to the new one. A save never stores plain text:
 * with no `MODEL_KEY_SECRET` it fails. A kept key is left as stored if sealed, and sealed if it is
 * still the plain text from before ob 1786; it is only ever opened in `projectModelFor`.
 */
async function keyToStore(
  current: Pick<ProjectModel, "baseUrl" | "apiKey"> | null,
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

/** The checked settings as a row's columns: the sealed key, and the URL and model cleaned. */
async function fieldsToStore(
  current: Pick<ProjectModel, "baseUrl" | "apiKey"> | null,
  settings: ModelSettings,
) {
  const baseUrl = modelBaseUrl(settings.baseUrl);
  await checkModelHost(baseUrl, settings.modelHosts).catch((e: unknown) => {
    throw e instanceof ModelHostError ? new ModelSettingsError(e.message) : e;
  });
  const model = settings.model.trim();
  if (!model) throw new ModelSettingsError("name the model, e.g. deepseek-flash");
  const apiKey = await keyToStore(current, baseUrl, settings.apiKey, settings.modelKeySecret);
  return { baseUrl, model, autoPassNoise: settings.autoPassNoise, apiKey };
}

/** Save the project's model; any member may, as any member may issue a token. */
export async function setProjectModel(
  db: Db,
  userId: string,
  projectId: string,
  settings: ModelSettings,
): Promise<void> {
  await getProject(db, userId, projectId);
  const fields = await fieldsToStore(await storedModel(db, projectId), settings);
  await db
    .insert(projectModels)
    .values({ projectId, ...fields })
    .onConflictDoUpdate({ target: projectModels.projectId, set: fields });
}

/**
 * Remove the project's own model and its key. Its builds then use the org's model if the org has
 * one, and no model otherwise: no shot is sent anywhere the org did not name.
 */
export async function clearProjectModel(db: Db, userId: string, projectId: string): Promise<void> {
  await getProject(db, userId, projectId);
  await db.delete(projectModels).where(eq(projectModels.projectId, projectId));
}

/** Save the org's model, used by every project of the org without its own; any member may. */
export async function setOrgModel(
  db: Db,
  userId: string,
  orgId: string,
  settings: ModelSettings,
): Promise<void> {
  await requireMember(db, userId, orgId);
  const [current] = await db.select().from(orgModels).where(eq(orgModels.orgId, orgId));
  const fields = await fieldsToStore(current ?? null, settings);
  await db
    .insert(orgModels)
    .values({ orgId, ...fields })
    .onConflictDoUpdate({ target: orgModels.orgId, set: fields });
}

/** Remove the org's model and key: a project without its own then has none. */
export async function clearOrgModel(db: Db, userId: string, orgId: string): Promise<void> {
  await requireMember(db, userId, orgId);
  await db.delete(orgModels).where(eq(orgModels.orgId, orgId));
}
