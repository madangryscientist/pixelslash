import { pageBuilds } from "#/db/build-list";
import { type Actor, actorBuild, actorProject, actorProjects, actorSnapshot } from "#/db/actor";
import { type Db, NotFoundError } from "#/db/db";
import { type ProjectFlag, flagProjectId, markFlagExported, projectFlags } from "#/db/flags";
import {
  type BuildCounts,
  type SnapshotView,
  buildView,
  countBuilds,
  emptyCounts,
} from "#/db/review";
import {
  BUILD_STATUSES,
  type BuildStatus,
  type DiffRegion,
  type DiffResult,
  type builds,
} from "#/db/schema";
import { awaitsDecision, groupOf, skippedFlaky } from "#/lib/snapshot-groups";
import { signedImagePath } from "#/storage/signed";
import { BadRequest, Forbidden } from "./validate";

/**
 * The read API (ob 1729): what the CLI and the MCP server read builds and shots with. Every
 * handler reaches rows through `db/actor.ts` and shapes them from the `db/*` read models; none
 * queries by itself. Keys are snake_case and every reply carries `api_version`. `/api/v1` is a
 * stable contract: a field may be added, never renamed, retyped or removed (AGENTS.md).
 */
export const API_VERSION = 1;

export type ReadCtx = {
  db: Db;
  actor: Actor;
  /** The server's own origin, for `web_url` and image URLs. */
  origin: string;
  imageSecret: () => string;
  query: URLSearchParams;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export const reply = (body: object) => Response.json({ api_version: API_VERSION, ...body });

export const iso = (date: Date | null) => date?.toISOString() ?? null;

function limitOf(query: URLSearchParams): number {
  const raw = query.get("limit");
  if (raw === null) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT)
    throw new BadRequest(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  return n;
}

/** A cursor is opaque to clients: the last row's time and id, base64url. */
function encodeCursor(at: { createdAt: Date; id: string } | null): string | null {
  if (!at) return null;
  return btoa(`${at.createdAt.getTime()}:${at.id}`).replaceAll("+", "-").replaceAll("/", "_");
}

function decodeCursor(raw: string | null): { createdAt: Date; id: string } | undefined {
  if (raw === null) return undefined;
  let text: string;
  try {
    text = atob(raw.replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    throw new BadRequest("cursor is not one this API gave");
  }
  const match = /^(\d{1,15}):(.+)$/.exec(text);
  if (!match?.[1] || !match[2]) throw new BadRequest("cursor is not one this API gave");
  return { createdAt: new Date(Number(match[1])), id: match[2] };
}

function statusOf(raw: string | null): BuildStatus | undefined {
  if (raw === null) return undefined;
  const status = BUILD_STATUSES.find((s) => s === raw);
  if (!status) throw new BadRequest(`status must be one of ${BUILD_STATUSES.join(", ")}`);
  return status;
}

export const buildUrl = (ctx: Pick<ReadCtx, "origin">, projectId: string, buildId: string) =>
  `${ctx.origin}/projects/${projectId}/builds/${buildId}`;

export const snapshotUrl = (ctx: ReadCtx, projectId: string, buildId: string, snapshotId: string) =>
  `${buildUrl(ctx, projectId, buildId)}/snapshots/${snapshotId}`;

/** A signed link to one of an org's blobs: the image route serves org-scoped keys only. */
export async function imageUrl(
  ctx: Pick<ReadCtx, "origin" | "imageSecret">,
  orgId: string,
  key: string | null,
): Promise<string | null> {
  return key && `${ctx.origin}${await signedImagePath(`orgs/${orgId}/${key}`, ctx.imageSecret())}`;
}

function counts(c: BuildCounts) {
  return {
    changed: c.changed,
    new: c.new,
    removed: c.removed,
    unchanged: c.unchanged,
    rebaseline: c.rebaseline,
    unmeasured: c.unmeasured,
    pending: c.pending,
    accepted: c.accepted,
    rejected: c.rejected,
    to_review: c.toReview,
    skipped_flaky: c.skippedFlaky,
  };
}

type BuildRow = Pick<
  typeof builds.$inferSelect,
  "id" | "branch" | "commitSha" | "prNumber" | "status" | "error" | "createdAt"
>;

function build(ctx: ReadCtx, projectId: string, row: BuildRow, c: BuildCounts) {
  return {
    id: row.id,
    project_id: projectId,
    branch: row.branch,
    commit_sha: row.commitSha,
    pr_number: row.prNumber,
    status: row.status,
    error: row.error,
    counts: counts(c),
    created_at: iso(row.createdAt),
    web_url: buildUrl(ctx, projectId, row.id),
  };
}

export function regionOf(r: DiffRegion) {
  return {
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
    changed_pixels: r.changedPixels,
    antialiased_pixels: r.antialiasedPixels,
    kind: r.kind,
    why: r.why ?? null,
  };
}

function diffResult(d: DiffResult | null) {
  if (!d) return null;
  return {
    changed_pixels: d.changedPixels,
    antialiased_pixels: d.antialiasedPixels,
    ignored_pixels: d.ignoredPixels,
    ignored: d.ignored,
    specks: d.specks,
    regions: d.regions.map(regionOf),
    width: d.width,
    height: d.height,
    main_width: d.mainWidth,
    main_height: d.mainHeight,
    branch_width: d.branchWidth,
    branch_height: d.branchHeight,
    size_changed: d.sizeChanged,
  };
}

function snapshot(ctx: ReadCtx, projectId: string, buildId: string, s: SnapshotView) {
  return {
    id: s.id,
    build_id: buildId,
    name: s.name,
    platform: s.platform,
    browser: s.browser,
    viewport: s.viewport,
    theme: s.theme,
    tags: s.tags,
    group: groupOf(s),
    diff_status: s.diffStatus,
    diff_result: diffResult(s.diffResult),
    rebaseline_needed: s.rebaselineNeeded,
    review_state: s.reviewState,
    reviewed_by: s.reviewedBy,
    reviewed_at: iso(s.reviewedAt),
    awaits_decision: awaitsDecision(s),
    flake_id: s.flakeId,
    flaky_policy: s.flakyPolicy,
    skipped_flaky: skippedFlaky(s),
    carried_from: s.carriedFrom && {
      snapshot_id: s.carriedFrom,
      build_id: s.carriedFromBuild,
    },
    approved_earlier: s.approvedEarlier && {
      snapshot_id: s.approvedEarlier.snapshotId,
      build_id: s.approvedEarlier.buildId,
      commit_sha: s.approvedEarlier.commitSha,
      reviewed_by: s.approvedEarlier.reviewedBy,
      reviewed_at: iso(s.approvedEarlier.reviewedAt),
      default_branch: s.approvedEarlier.defaultBranch,
    },
    measured_by: s.measuredBy,
    engine_version: s.engineVersion,
    diff_error: s.diffError,
    created_at: iso(s.createdAt),
    web_url: snapshotUrl(ctx, projectId, buildId, s.id),
  };
}

/** A project as `/api/v1` replies with it; the list and `POST /projects` share this one shape. */
export function projectOf(ctx: ReadCtx, p: Awaited<ReturnType<typeof actorProjects>>[number]) {
  return {
    id: p.id,
    name: p.name,
    org: p.org,
    default_branch: p.defaultBranch,
    created_at: iso(p.createdAt),
    web_url: `${ctx.origin}/projects/${p.id}`,
  };
}

/** The reply shapes, for tests and for clients written against this file. */
export type ApiProject = ReturnType<typeof projectOf>;
export type ApiBuild = ReturnType<typeof build>;
export type ApiSnapshot = ReturnType<typeof snapshot>;
export type ApiImages = Record<"head" | "baseline" | "diff", string | null>;
export type ApiFlag = Awaited<ReturnType<typeof flag>>;

export async function listProjects(ctx: ReadCtx): Promise<Response> {
  const rows = await actorProjects(ctx.db, ctx.actor);
  return reply({ projects: rows.map((p) => projectOf(ctx, p)), next_cursor: null });
}

export async function listBuilds(ctx: ReadCtx, projectId: string): Promise<Response> {
  const project = await actorProject(ctx.db, ctx.actor, projectId);
  const page = await pageBuilds(ctx.db, project.id, {
    branch: ctx.query.get("branch") ?? undefined,
    status: statusOf(ctx.query.get("status")),
    after: decodeCursor(ctx.query.get("cursor")),
    limit: limitOf(ctx.query),
  });
  return reply({
    builds: page.builds.map((b) => build(ctx, project.id, b, b.counts)),
    next_cursor: encodeCursor(page.next),
  });
}

export async function getBuild(ctx: ReadCtx, buildId: string): Promise<Response> {
  const { build: row } = await actorBuild(ctx.db, ctx.actor, buildId);
  const view = await buildView(ctx.db, row.projectId, row.id);
  const c = (await countBuilds(ctx.db, [row.id])).get(row.id) ?? emptyCounts();
  return reply({
    build: {
      ...build(ctx, row.projectId, view.build, c),
      snapshots: view.snapshots.map((s) => snapshot(ctx, row.projectId, row.id, s)),
    },
  });
}

export async function getSnapshot(ctx: ReadCtx, snapshotId: string): Promise<Response> {
  const { buildId, projectId, orgId } = await actorSnapshot(ctx.db, ctx.actor, snapshotId);
  const view = await buildView(ctx.db, projectId, buildId);
  const shot = view.snapshots.find((s) => s.id === snapshotId);
  // actorSnapshot found it in this build, so buildView holds it.
  if (!shot) throw new Error(`snapshot ${snapshotId} missing from build ${buildId}`);
  return reply({
    snapshot: {
      ...snapshot(ctx, projectId, buildId, shot),
      images: {
        head: await imageUrl(ctx, orgId, shot.imageKey),
        baseline: await imageUrl(ctx, orgId, shot.baselineKey),
        diff: await imageUrl(ctx, orgId, shot.diffKey),
      },
    },
  });
}

async function flag(ctx: ReadCtx, projectId: string, orgId: string, f: ProjectFlag) {
  return {
    id: f.id,
    kind: f.kind,
    note: f.note,
    rect: f.rect && { x: f.rect.x, y: f.rect.y, w: f.rect.width, h: f.rect.height },
    by: f.by,
    snapshot: f.snapshot,
    build: { id: f.build.id, branch: f.build.branch, commit_sha: f.build.commitSha },
    measured: {
      diff_status: f.measured.diffStatus,
      changed_pixels: f.measured.changedPixels,
    },
    images: {
      head: await imageUrl(ctx, orgId, f.keys.image),
      baseline: await imageUrl(ctx, orgId, f.keys.baseline),
      diff: await imageUrl(ctx, orgId, f.keys.diff),
    },
    created_at: iso(f.createdAt),
    updated_at: iso(f.updatedAt),
    exported_at: iso(f.exportedAt),
    web_url: snapshotUrl(ctx, projectId, f.build.id, f.snapshot.id),
  };
}

export async function listDetectionFlags(ctx: ReadCtx, projectId: string): Promise<Response> {
  const project = await actorProject(ctx.db, ctx.actor, projectId);
  const page = await projectFlags(ctx.db, project.id, {
    after: decodeCursor(ctx.query.get("cursor")),
    limit: limitOf(ctx.query),
  });
  return reply({
    detection_flags: await Promise.all(
      page.flags.map((f) => flag(ctx, project.id, project.orgId, f)),
    ),
    next_cursor: encodeCursor(page.next),
  });
}

/**
 * `POST /api/v1/detection-flags/:id/exported` (ob 1734): the bench's import marks a flag it turned
 * into a case, so the list shows what is still unworked. A person's token only; a CI token is 403.
 */
export async function markDetectionFlagExported(ctx: ReadCtx, flagId: string): Promise<Response> {
  if (ctx.actor.kind !== "user") throw new Forbidden("a CI token cannot mark a flag exported");
  const project = await actorProject(ctx.db, ctx.actor, await flagProjectId(ctx.db, flagId)).catch(
    (e: unknown) => {
      // Another org's flag is the same 404 as a missing one.
      throw e instanceof NotFoundError ? new NotFoundError("detection flag") : e;
    },
  );
  const marked = await markFlagExported(ctx.db, project.id, flagId);
  return reply({ detection_flag: await flag(ctx, project.id, project.orgId, marked) });
}
