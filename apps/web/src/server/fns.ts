import { notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getCookie, getRequestUrl } from "@tanstack/react-start/server";
import { baselineBuildOf } from "#/db/baseline-build";
import { snapshotDiffOptions } from "#/db/builds";
import { listFlags, snapshotFlags } from "#/db/flags";
import { projectFlake } from "#/db/flakes";
import { isMarker } from "#/db/markers";
import { listOrgModelViews, projectModelSource } from "#/db/models";
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
import { NotReviewableError, afterDecision, buildView, decideAll, decideShot } from "#/db/review";
import { flakeRecaptures } from "#/db/run-metrics";
import { isFirstBuild } from "#/db/first-build";
import { DIFF_LOCATIONS } from "#/db/schema";
import { issueCiToken, listCiTokens, listOrgTokens, revokeCiToken } from "#/db/tokens";
import { projectStale } from "#/db/stale";
import { twinsOfBuild } from "#/db/twins";
import { nextToReviewId } from "#/lib/build-tabs";
import { warn } from "#/lib/log";
import { walkAround } from "#/lib/review-walk";
import { buildExpiry } from "#/lib/retention";
import { holdsChange, reviewGroupOf } from "#/lib/snapshot-groups";
import { twinEntryOf } from "#/lib/twins";
import { THEME_COOKIE, parseTheme } from "#/lib/theme";
import {
  database,
  defaultDiffLocation,
  githubChecksConfigured,
  retentionDays,
  sentryConfig,
  syncChecks,
} from "./env";
import { signFlakeOrNull } from "./flake-images";
import { imageUrls } from "./image-urls";
import { snapshotMetrics } from "./snapshot-metrics";
import { field, or404 } from "./input";
import { requireViewer, viewer } from "./session";

/** A shot that is no longer reviewable is a conflict the page states, not a 404. */
function orConflict<T>(work: Promise<T>): Promise<T> {
  return work.catch((error: unknown) => {
    if (error instanceof NotReviewableError) throw new Error(error.message);
    throw error;
  });
}

/**
 * What every page's shell needs: who is signed in, the theme the cookie asks for, and where the
 * browser reports its errors (null with no DSN, so the browser then never loads the reporter).
 */
export const getShell = createServerFn().handler(async () => ({
  viewer: await getViewerSummary(),
  theme: parseTheme(getCookie(THEME_COOKIE)),
  sentry: sentryConfig(),
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
  const db = database();
  const orgs = await listOrgs(db, user.id);
  const orgTokens = await listOrgTokens(db, user.id);
  const orgModels = await listOrgModelViews(db, user.id);
  return { orgs, orgTokens, orgModels, now: new Date(), serverUrl: getRequestUrl().origin };
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
    const model = await projectModelSource(db, user.id, project.id);
    const checks = githubChecksConfigured();
    return { org, project, tokens, overrides, model, checks, serverUrl: getRequestUrl().origin };
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
    const stale = await projectStale(db, project.id);
    // `now` and `serverUrl` for the same reasons as `getOrgs`: one "2 h ago", the URL to upload to.
    return {
      org,
      project,
      builds,
      flags,
      stale,
      now: new Date(),
      serverUrl: getRequestUrl().origin,
    };
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
      const group = reviewGroupOf(shot);
      if (group !== "changed" && group !== "new") continue;
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
    const modelConfigured = (await projectModelSource(db, user.id, project.id)).source !== "none";
    const recaptures = await flakeRecaptures(db, view.build.id, view.snapshots);
    const expiry = buildExpiry(view.build, project.defaultBranch, retentionDays(), new Date());
    const twins = await twinsOfBuild(db, view.build.id);
    return {
      org,
      project,
      ...view,
      twins,
      expiry,
      thumbs,
      firstBuild,
      thresholdChanges,
      modelConfigured,
      recaptures,
    };
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
    const walk = walkAround(view.snapshots, data.snapshotId);
    if (!walk) throw notFound();
    const { shot: snapshot, position, total, previousId, nextId } = walk;
    const index = position - 1;
    const twins = await twinsOfBuild(db, view.build.id);
    const images = await imageUrls(project.orgId, {
      main: snapshot.baselineKey,
      branch: isMarker(snapshot) ? null : snapshot.imageKey,
      diff: snapshot.diffKey,
      mainBaseline: snapshot.mainBaselineKey,
    });
    return {
      org,
      project,
      build: view.build,
      snapshot,
      /** The build behind the left pane's image, so the viewer names it and does not say "Main". */
      baselineBuild: await baselineBuildOf(db, {
        projectId: project.id,
        snapshotId: snapshot.id,
        defaultBranch: project.defaultBranch,
      }),
      /** This shot's twins on the other platforms (PS-295); null when no other platform is in play. */
      twins: twinEntryOf(twins, snapshot.id),
      images,
      metrics: await snapshotMetrics(project.orgId, snapshot.metricsKey),
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
      position,
      total,
      previousId,
      nextId,
      /** Where a decision on this shot moves the reviewer: the next shot still awaiting one. */
      nextToReviewId: nextToReviewId(view.snapshots, snapshot.id),
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
    const next = typeof d === "object" && d !== null && Reflect.get(d, "next") === true;
    return { projectId: field(d, "projectId"), snapshotId: field(d, "snapshotId"), state, next };
  })
  .handler(async ({ data }) => {
    const user = await requireViewer();
    const db = database();
    const { next, ...decision } = data;
    const decided = await orConflict(decideShot(db, { ...decision, userId: user.id }));
    await syncChecks(db, decided.buildIds);
    // Nowhere to go next: the build page. That is also the answer when the read below fails, since the
    // decision is already written and only the next shot is lost.
    const toBuild = { buildStatus: decided.verdict, nextToReviewId: null };
    if (!next) return { status: decided.verdict, ...toBuild };
    // `next` asks where the reviewer goes, read after the write, so moving on takes no second round
    // trip and another reviewer's reject in between shows in `buildStatus`.
    const after = await afterDecision(db, {
      projectId: data.projectId,
      buildId: decided.buildId,
      snapshotId: data.snapshotId,
    }).catch((e: unknown) => {
      warn(`reviewShot: next shot not read: ${e instanceof Error ? e.message : String(e)}`);
      return toBuild;
    });
    return { status: decided.verdict, ...after };
  });

export const acceptBuild = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({ projectId: field(d, "projectId"), buildId: field(d, "buildId") }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    const db = database();
    const decided = await orConflict(decideAll(db, { ...data, userId: user.id }));
    await syncChecks(db, decided.buildIds);
    return { status: decided.verdict };
  });
