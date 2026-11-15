import { and, desc, eq, inArray, or } from "drizzle-orm";
import { type BuildCounts, countBuilds, emptyCounts } from "#/db/build-counts";
import type { Db } from "#/db/db";
import { builds, projects } from "#/db/schema";
import { type SyncedBuild, plural, titleOf } from "./build-text";
import type { StatusBody } from "./check-run";

/*
 * One PixelSlash status for a top-level project and all its subprojects on a commit: what the
 * newest build of each of them on that commit adds up to. A subproject with no build on the commit
 * (a task cache skipped its capture) is listed as not run and holds nothing.
 */

/** A project of the group: the top-level project itself, or one of its subprojects. */
export type GroupMember = {
  projectId: string;
  name: string;
  /** The top-level project, whose own builds are its lane beside the subprojects'. */
  top: boolean;
  /** Its newest build on the commit; null when it uploaded none there. */
  build: SyncedBuild | null;
  counts: BuildCounts;
};

export type GroupState = {
  state: "pending" | "success" | "failure";
  /** One line: what the status says on the PR. */
  description: string;
  /** The build when only one counted, else the top-level project's page. */
  target: { projectId: string; buildId?: string };
};

const failed = (m: GroupMember) => m.build?.status === "errored" || m.build?.status === "failed";
const diffing = (m: GroupMember) =>
  m.build?.status === "uploading" || m.build?.status === "processing";
const waiting = (m: GroupMember) => m.build?.status === "changes";

/** Where the group's changes wait: "in 3 subprojects", "in web and 2 subprojects". */
function whereOf(members: GroupMember[]): string {
  const subs = members.filter((m) => !m.top).length;
  const top = members.find((m) => m.top);
  if (subs === 0) return top ? `in ${top.name}` : "";
  const subText = plural(subs, "subproject");
  return top ? `in ${top.name} and ${subText}` : `in ${subText}`;
}

/** Failure first (a sibling still diffing does not hide it), then pending, then success. */
export function groupState(members: GroupMember[], topProjectId: string): GroupState {
  const counted = members.filter((m) => m.build !== null);
  const [only] = counted;
  const target =
    counted.length === 1 && only?.build
      ? { projectId: only.projectId, buildId: only.build.id }
      : { projectId: topProjectId };
  const failing = counted.filter(failed);
  const [first] = failing;
  if (first?.build)
    return {
      state: "failure",
      description:
        failing.length === 1
          ? `${first.name}: ${titleOf(first.build, first.counts)}`
          : `${plural(failing.length, "build")} failed: ${failing.map((m) => m.name).join(", ")}`,
      target,
    };
  if (counted.some(diffing)) return { state: "pending", description: "Diffing the shots", target };
  const open = counted.filter(waiting);
  if (open.length > 0) {
    const total = open.reduce((n, m) => n + m.counts.toReview, 0);
    return {
      state: "pending",
      description: `${plural(total, "change")} to review ${whereOf(open)}`,
      target,
    };
  }
  const changed = counted.some((m) => m.counts.changed > 0);
  return {
    state: "success",
    description: changed ? "All changes accepted" : "No visual changes",
    target,
  };
}

/**
 * The top-level project of `projectId` and its subprojects, each with its newest build on
 * `commitSha` and that build's counts; the top-level project first, then its subprojects by name.
 */
export async function groupOf(
  db: Db,
  topProjectId: string,
  commitSha: string,
): Promise<GroupMember[]> {
  const rows = await db
    .select({ id: projects.id, name: projects.name, parent: projects.parentProjectId })
    .from(projects)
    .where(or(eq(projects.id, topProjectId), eq(projects.parentProjectId, topProjectId)));
  const onCommit = await db
    .select({
      id: builds.id,
      projectId: builds.projectId,
      status: builds.status,
      error: builds.error,
    })
    .from(builds)
    .where(
      and(
        inArray(
          builds.projectId,
          rows.map((r) => r.id),
        ),
        eq(builds.commitSha, commitSha),
      ),
    )
    .orderBy(desc(builds.createdAt), desc(builds.id));
  // Newest first, so the first build met per project is the one that counts.
  const newest = new Map<string, SyncedBuild>();
  for (const b of onCommit) if (!newest.has(b.projectId)) newest.set(b.projectId, b);
  const counts = await countBuilds(
    db,
    [...newest.values()].map((b) => b.id),
  );
  const members = rows.map((r) => {
    const build = newest.get(r.id) ?? null;
    return {
      projectId: r.id,
      name: r.name,
      top: r.parent === null,
      build,
      counts: (build && counts.get(build.id)) ?? emptyCounts(),
    };
  });
  return members.toSorted((a, b) => Number(b.top) - Number(a.top) || a.name.localeCompare(b.name));
}

/** Whether the top-level project has subprojects: a plain project keeps its one-build status. */
export async function hasSubprojects(db: Db, topProjectId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.parentProjectId, topProjectId))
    .limit(1);
  return row !== undefined;
}

/** A status description is at most 140 characters. */
const DESCRIPTION_MAX = 140;

/**
 * The status for a build's group: the top-level project's name as its context, the group's state,
 * and a link to the one build that counted, else to the project's page, which lists its subprojects.
 */
export async function groupStatus(
  deps: { db: Db; publicUrl: string | undefined },
  row: { topProjectId: string; commitSha: string; checkName: string },
): Promise<StatusBody> {
  const members = await groupOf(deps.db, row.topProjectId, row.commitSha);
  const { state, description, target } = groupState(members, row.topProjectId);
  const origin = deps.publicUrl?.replace(/\/+$/, "");
  const page = `${origin}/projects/${target.projectId}`;
  return {
    state,
    context: row.checkName,
    description: description.slice(0, DESCRIPTION_MAX),
    ...(origin && { target_url: target.buildId ? `${page}/builds/${target.buildId}` : page }),
  };
}
