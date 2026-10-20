import { notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { snapshotDiffOptions } from "#/db/builds";
import { NotFoundError } from "#/db/db";
import { createOrg, createProject, getProject, inviteMember, listOrgs } from "#/db/orgs";
import {
  NotReviewableError,
  acceptAllSnapshots,
  buildView,
  listBuilds,
  reviewSnapshot,
} from "#/db/review";
import { issueCiToken, listCiTokens, revokeCiToken } from "#/db/tokens";
import { signedImagePath } from "#/storage/signed";
import { database, imageSigningSecret } from "./env";
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

/** A shot that is no longer reviewable is a conflict the page states, not a 404. */
function orConflict<T>(work: Promise<T>): Promise<T> {
  return work.catch((error: unknown) => {
    if (error instanceof NotReviewableError) throw new Error(error.message);
    throw error;
  });
}

/**
 * Images are only ever handed out as signed, short-lived URLs (invariant 5). Snapshot rows hold
 * keys inside the org's prefix; the URL carries the full blob key, so the route needs no database.
 */
async function imageUrls(
  orgId: string,
  keys: {
    main: string | null;
    branch: string | null;
    diff: string | null;
  },
): Promise<{ main: string | null; branch: string | null; diff: string | null }> {
  const secret = imageSigningSecret();
  const sign = (key: string | null) =>
    key ? signedImagePath(`orgs/${orgId}/${key}`, secret) : null;
  return {
    main: await sign(keys.main),
    branch: await sign(keys.branch),
    diff: await sign(keys.diff),
  };
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

/* ---------------------------------------------------------------- review screens (ob 1421) */

export const getProjectPage = createServerFn()
  .validator((d: unknown) => ({ projectId: field(d, "projectId") }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    const db = database();
    const project = await or404(getProject(db, user.id, data.projectId));
    return { project, builds: await listBuilds(db, project.id) };
  });

export const getBuildPage = createServerFn()
  .validator((d: unknown) => ({ projectId: field(d, "projectId"), buildId: field(d, "buildId") }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    const db = database();
    const project = await or404(getProject(db, user.id, data.projectId));
    return { project, ...(await or404(buildView(db, project.id, data.buildId))) };
  });

export const getSnapshotPage = createServerFn()
  .validator((d: unknown) => ({
    projectId: field(d, "projectId"),
    buildId: field(d, "buildId"),
    snapshotId: field(d, "snapshotId"),
  }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    const db = database();
    const project = await or404(getProject(db, user.id, data.projectId));
    const view = await or404(buildView(db, project.id, data.buildId));
    const index = view.snapshots.findIndex((shot) => shot.id === data.snapshotId);
    if (index === -1) throw notFound();
    const snapshot = view.snapshots[index];
    if (!snapshot) throw notFound();
    const images = await imageUrls(project.orgId, {
      main: snapshot.baselineKey,
      branch: snapshot.diffStatus === "removed" ? null : snapshot.imageKey,
      diff: snapshot.diffKey,
    });
    return {
      project,
      build: view.build,
      snapshot,
      images,
      /** The options the diff was run with, through the accessor the server diff reads (ob 1494). */
      diffOptions: await snapshotDiffOptions(db, snapshot.id),
      /** The j/k order is the build's order, so a walk visits every shot once. */
      position: index + 1,
      total: view.snapshots.length,
      previousId: index > 0 ? (view.snapshots[index - 1]?.id ?? null) : null,
      nextId: view.snapshots[index + 1]?.id ?? null,
    };
  });

export const reviewShot = createServerFn({ method: "POST" })
  .validator((d: unknown) => {
    const state = typeof d === "object" && d !== null ? Reflect.get(d, "state") : null;
    if (state !== "accepted" && state !== "rejected") throw new Error("state is required");
    return {
      projectId: field(d, "projectId"),
      snapshotId: field(d, "snapshotId"),
      state,
    };
  })
  .handler(async ({ data }) => {
    const user = await requireViewer();
    const status = await orConflict(
      reviewSnapshot(database(), {
        projectId: data.projectId,
        snapshotId: data.snapshotId,
        state: data.state,
        userId: user.id,
      }),
    );
    return { status };
  });

export const acceptBuild = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({ projectId: field(d, "projectId"), buildId: field(d, "buildId") }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    return orConflict(
      acceptAllSnapshots(database(), {
        projectId: data.projectId,
        buildId: data.buildId,
        userId: user.id,
      }).then((status) => ({ status })),
    );
  });
