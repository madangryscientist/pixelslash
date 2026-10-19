import { notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { NotFoundError } from "#/db/db";
import { createOrg, createProject, getProject, inviteMember, listOrgs } from "#/db/orgs";
import { issueCiToken, listCiTokens, revokeCiToken } from "#/db/tokens";
import { database } from "./env";
import { requireViewer, viewer } from "./session";

/** A repository NotFoundError (missing, or another org's) becomes the router's 404. */
async function or404<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof NotFoundError) throw notFound();
    throw error;
  }
}

/** A trimmed, non-empty string of at most 100 chars from a server-fn payload. */
function field(input: unknown, key: string): string {
  const value = typeof input === "object" && input !== null ? Reflect.get(input, key) : null;
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length === 0 || text.length > 100) throw new Error(`${key} is required (1-100 chars)`);
  return text;
}

export const getViewer = createServerFn().handler(async () => {
  const user = await viewer();
  return user && { login: user.login, name: user.name, avatarUrl: user.avatarUrl };
});

export const getOrgs = createServerFn().handler(async () => {
  const user = await requireViewer();
  return listOrgs(database(), user.id);
});

export const newOrg = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({ name: field(d, "name") }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    const org = await createOrg(database(), user.id, data.name);
    return { id: org.id };
  });

export const newProject = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({ orgId: field(d, "orgId"), name: field(d, "name") }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    const project = await or404(createProject(database(), user.id, data.orgId, data.name));
    return { id: project.id };
  });

export const invite = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({ orgId: field(d, "orgId"), login: field(d, "login") }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    await or404(inviteMember(database(), user, data.orgId, data.login));
  });

export const getProjectSettings = createServerFn()
  .validator((d: unknown) => ({ projectId: field(d, "projectId") }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    const db = database();
    const project = await or404(getProject(db, user.id, data.projectId));
    return { project, tokens: await listCiTokens(db, user.id, project.id) };
  });

export const issueToken = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({ projectId: field(d, "projectId"), name: field(d, "name") }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    return or404(issueCiToken(database(), user.id, data.projectId, data.name));
  });

export const revokeToken = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({ tokenId: field(d, "tokenId") }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    await or404(revokeCiToken(database(), user.id, data.tokenId));
  });
