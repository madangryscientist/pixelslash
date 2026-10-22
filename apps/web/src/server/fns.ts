import { notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getCookie, getRequestUrl } from "@tanstack/react-start/server";
import { snapshotDiffOptions } from "#/db/builds";
import { flagSnapshot, listFlags, snapshotFlags, withdrawFlag } from "#/db/flags";
import { projectFlake } from "#/db/flakes";
import { isMarker } from "#/db/markers";
import { settingsOverrides, snapshotIgnoreBoxes, snapshotOverrides } from "#/db/override-export";
import { uploadedIgnoreSource } from "#/db/ignore-boxes";
import { overrideChanges } from "#/db/overrides";
import {
  createOrg,
  createProject,
  getProjectWithOrg,
  inviteMember,
  listOrgs,
  setDefaultBranch,
  setDiffLocation,
  withdrawInvite,
} from "#/db/orgs";
import { listBuilds } from "#/db/build-list";
import {
  NotReviewableError,
  acceptAllSnapshots,
  buildView,
  isFirstBuild,
  reviewSnapshot,
} from "#/db/review";
import { DIFF_LOCATIONS, FLAG_KINDS, type FlagKind, type IgnoreRect } from "#/db/schema";
import { issueCiToken, listCiTokens, revokeCiToken } from "#/db/tokens";
import { BadRequest, parseRect } from "#/api/validate";
import { holdsChange } from "#/lib/snapshot-groups";
import { THEME_COOKIE, parseTheme } from "#/lib/theme";
import { signedImagePath } from "#/storage/signed";
import { database, defaultDiffLocation, imageSigningSecret } from "./env";
import { signFlakeOrNull } from "./flake-images";
import { field, noteInput, or404 } from "./input";
import { requireViewer, viewer } from "./session";

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

/** What every page's shell needs: who is signed in, and the theme the cookie asks for. */
export const getShell = createServerFn().handler(async () => ({
  viewer: await getViewerSummary(),
  theme: parseTheme(getCookie(THEME_COOKIE)),
}));

async function getViewerSummary() {
  const user = await viewer();
  return user && { login: user.login, name: user.name };
}

export const getViewer = createServerFn().handler(getViewerSummary);

/**
 * The organizations page's data. `now` is read once here so the server's render and the browser's
 * agree on every "2 h ago"; `serverUrl` is the origin the empty state tells the user to upload to.
 */
export const getOrgs = createServerFn().handler(async () => {
  const user = await requireViewer();
  const orgs = await listOrgs(database(), user.id);
  return { orgs, now: new Date(), serverUrl: getRequestUrl().origin };
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
    const project = await or404(
      createProject(database(), user.id, data.orgId, {
        name: data.name,
        diffLocation: defaultDiffLocation(),
      }),
    );
    return { id: project.id };
  });

export const invite = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({ orgId: field(d, "orgId"), login: field(d, "login") }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    await or404(inviteMember(database(), user, data.orgId, data.login));
  });

export const withdrawOrgInvite = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({ orgId: field(d, "orgId"), inviteId: field(d, "inviteId") }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    await or404(withdrawInvite(database(), user.id, data.orgId, data.inviteId));
  });

export const getProjectSettings = createServerFn()
  .validator((d: unknown) => ({ projectId: field(d, "projectId") }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    const db = database();
    const { project, org } = await or404(getProjectWithOrg(db, user.id, data.projectId));
    const tokens = await listCiTokens(db, user.id, project.id);
    const overrides = await settingsOverrides(db, user.id, project.id);
    return { org, project, tokens, overrides, serverUrl: getRequestUrl().origin };
  });

export const saveDefaultBranch = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({ projectId: field(d, "projectId"), branch: field(d, "branch") }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    await or404(setDefaultBranch(database(), user.id, data.projectId, data.branch));
  });

export const saveDiffLocation = createServerFn({ method: "POST" })
  .validator((d: unknown) => {
    const projectId = field(d, "projectId");
    const location = DIFF_LOCATIONS.find((l) => l === field(d, "location"));
    if (!location) throw new Error(`location must be one of ${DIFF_LOCATIONS.join(", ")}`);
    return { projectId, location };
  })
  .handler(async ({ data }) => {
    const user = await requireViewer();
    await or404(setDiffLocation(database(), user.id, data.projectId, data.location));
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
    const { project, org } = await or404(getProjectWithOrg(db, user.id, data.projectId));
    const builds = await listBuilds(db, project.id);
    const flags = await listFlags(db, user.id, project.id);
    // `now` and `serverUrl` for the same reasons as `getOrgs`: one "2 h ago", the URL to upload to.
    return { org, project, builds, flags, now: new Date(), serverUrl: getRequestUrl().origin };
  });

export const getBuildPage = createServerFn()
  .validator((d: unknown) => ({ projectId: field(d, "projectId"), buildId: field(d, "buildId") }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    const db = database();
    const { project, org } = await or404(getProjectWithOrg(db, user.id, data.projectId));
    const view = await or404(buildView(db, project.id, data.buildId));
    // A card shows the branch shot (cropped to the change in the browser): a changed or new shot has
    // one, a removed one only has the baseline's. No blob is made for it.
    const thumbs: Record<string, string> = {};
    for (const shot of view.snapshots) {
      if (shot.diffStatus !== "changed" && shot.diffStatus !== "new") continue;
      const { branch } = await imageUrls(project.orgId, {
        main: null,
        branch: shot.imageKey,
        diff: null,
      });
      if (branch) thumbs[shot.id] = branch;
    }
    const firstBuild = await isFirstBuild(db, view.build);
    /** Review-UI threshold changes to this build's tests (ob 1495), newest first. */
    const names = [...new Set(view.snapshots.map((shot) => shot.name))];
    const thresholdChanges = await overrideChanges(db, user.id, project.id, names);
    return { org, project, ...view, thumbs, firstBuild, thresholdChanges };
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
    const { project, org } = await or404(getProjectWithOrg(db, user.id, data.projectId));
    const view = await or404(buildView(db, project.id, data.buildId));
    const index = view.snapshots.findIndex((shot) => shot.id === data.snapshotId);
    if (index === -1) throw notFound();
    const snapshot = view.snapshots[index];
    if (!snapshot) throw notFound();
    const images = await imageUrls(project.orgId, {
      main: snapshot.baselineKey,
      branch: isMarker(snapshot) ? null : snapshot.imageKey,
      diff: snapshot.diffKey,
    });
    return {
      org,
      project,
      build: view.build,
      snapshot,
      images,
      /** The options the config asked for (ob 1494); `snapshot.resolvedDiff` holds what was measured. */
      diffOptions: await snapshotDiffOptions(db, snapshot.id),
      /** The review-UI overrides on this shot's test and variant (ob 1495), each with its snippet. */
      overrides: await snapshotOverrides(db, user.id, project.id, snapshot),
      /** The review-UI ignore boxes on this shot's test and variant (ob 1499), and the source of its own. */
      ignoreBoxes: await snapshotIgnoreBoxes(db, user.id, project.id, snapshot),
      uploadedIgnore: await uploadedIgnoreSource(db, snapshot.id),
      /** Every reviewer's detection flag on this shot (ob 1721); the viewer's own is `mine`. */
      flags: await snapshotFlags(db, {
        userId: user.id,
        projectId: project.id,
        snapshotId: snapshot.id,
      }),
      /** The flake the shot is labelled with (ob 1724), its evidence's images signed. */
      flake: await signFlakeOrNull(
        project.orgId,
        await projectFlake(db, project.id, snapshot.flakeId),
      ),
      /** The j/k order is the build's order, so a walk visits every shot once. */
      position: index + 1,
      total: view.snapshots.length,
      previousId: index > 0 ? (view.snapshots[index - 1]?.id ?? null) : null,
      nextId: view.snapshots[index + 1]?.id ?? null,
      /** Every name in the build, so the label reads the same as on the build page. */
      names: view.snapshots.map((shot) => shot.name),
      /**
       * Where this shot sits among the ones a reviewer decides on (`holdsChange`): the changed
       * shots and the unchanged ones that carry an open change. Null off that set.
       */
      review: {
        index: holdsChange(snapshot)
          ? view.snapshots.slice(0, index).filter(holdsChange).length + 1
          : null,
        total: view.snapshots.filter(holdsChange).length,
      },
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

/* ------------------------------------------------------------ detection flags (ob 1721) */

const isFlagKind = (v: unknown): v is FlagKind => FLAG_KINDS.some((kind) => kind === v);

/** The flag's kind, its optional one-line note and its optional rect, from a server-fn payload. */
function flagInput(d: unknown): { kind: FlagKind; note: string | null; rect: IgnoreRect | null } {
  const get = (key: string) => (typeof d === "object" && d !== null ? Reflect.get(d, key) : null);
  const kind = get("kind");
  if (!isFlagKind(kind)) throw new Error(`kind is one of ${FLAG_KINDS.join(", ")}`);
  const note = noteInput(d);
  const rect = get("rect");
  try {
    return { kind, note, rect: rect == null ? null : parseRect(rect, "rect") };
  } catch (error) {
    // A server fn has no 400: the message is what the form shows.
    if (error instanceof BadRequest) throw new Error(error.message, { cause: error });
    throw error;
  }
}

/** Create or replace the viewer's flag on a shot. It decides nothing: review state is untouched. */
export const flagShot = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({
    projectId: field(d, "projectId"),
    snapshotId: field(d, "snapshotId"),
    ...flagInput(d),
  }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    await or404(flagSnapshot(database(), { ...data, userId: user.id }));
  });

export const withdrawShotFlag = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({
    projectId: field(d, "projectId"),
    snapshotId: field(d, "snapshotId"),
  }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    await or404(withdrawFlag(database(), { ...data, userId: user.id }));
  });
