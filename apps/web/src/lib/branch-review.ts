import type { SnapshotView } from "#/db/review";
import type { DiffResult, DiffStatus } from "#/db/schema";
import { formatNumber } from "./format";
import { groupOf } from "./snapshot-groups";

/**
 * The branch page (ob 1723): the newest build of a branch read against main, from what the diff
 * stored (`main_diff_*`), and the review state each shot has there. Nothing here measures; a shot
 * the diff did not measure against main is `unmeasured` and is never counted as a change.
 */

/** The order the against-main view walks in: what stops a merge first. */
export const MAIN_GROUPS = ["rejected", "waiting", "accepted", "same", "unmeasured"] as const;
export type MainGroup = (typeof MAIN_GROUPS)[number];

/** Who decided a shot's change against main, and on which build of the branch. */
export type Decision = {
  state: "accepted" | "rejected";
  by: string | null;
  buildId: string;
  commitSha: string;
  /** Decided on an earlier build of the branch, and the shot has not changed since (ob 1722). */
  earlier: boolean;
};

export type BranchShot = SnapshotView & { mainGroup: MainGroup; decision: Decision | null };

type Head = { id: string; commitSha: string };

/**
 * Where a shot of the head build stands against main. A change against main is decided by the
 * shot's own review on this build, else by the approval 1722 traces back along the branch, else it
 * waits. There is no branch-level approval: this only reads the shots' review states.
 */
export function branchShot(shot: SnapshotView, head: Head): BranchShot {
  const of = (mainGroup: MainGroup, decision: Decision | null = null) => ({
    ...shot,
    mainGroup,
    decision,
  });
  if (shot.mainDiffStatus === null) return of("unmeasured");
  if (shot.mainDiffStatus === "unchanged") return of("same");
  if (shot.reviewState !== "pending") {
    const { reviewState: state, reviewedBy: by } = shot;
    return of(state === "accepted" ? "accepted" : "rejected", {
      state,
      by,
      buildId: head.id,
      commitSha: head.commitSha,
      earlier: false,
    });
  }
  const approved = shot.approvedEarlier;
  if (approved)
    return of("accepted", {
      state: "accepted",
      by: approved.reviewedBy,
      buildId: approved.buildId,
      commitSha: approved.commitSha,
      earlier: true,
    });
  return of("waiting");
}

export type MainSummary = {
  /** Shots that differ from main: changed or new against it. */
  changed: number;
  accepted: number;
  waiting: number;
  rejected: number;
  /** Not measured against main: not counted above, and enough to withhold "ready". */
  unmeasured: number;
  /** Nothing against main waits or was rejected, and every shot was measured. A reading, not a state. */
  ready: boolean;
};

export function mainSummary(shots: BranchShot[], reviewable: boolean): MainSummary {
  const count = (group: MainGroup) => shots.filter((shot) => shot.mainGroup === group).length;
  const summary = {
    accepted: count("accepted"),
    waiting: count("waiting"),
    rejected: count("rejected"),
    unmeasured: count("unmeasured"),
  };
  return {
    ...summary,
    changed: summary.accepted + summary.waiting + summary.rejected,
    ready: reviewable && summary.waiting + summary.rejected + summary.unmeasured === 0,
  };
}

function boxes(result: DiffResult): string {
  const n = result.regions.filter((region) => region.kind === "change").length;
  return `${formatNumber(result.changedPixels)} px in ${n} box${n === 1 ? "" : "es"}`;
}

/**
 * The measured facts of one comparison, in words: both sizes when they differ (only the overlap
 * was compared), the changed pixels and boxes, or that there was nothing to compare with.
 */
export function measuredFacts(status: DiffStatus | null, result: DiffResult | null): string {
  if (status === "new") return "new: nothing to compare with";
  if (status === "removed") return "removed: in the baseline only";
  if (status === "unchanged") return "no change";
  if (status === null) return "not measured";
  if (!result) return "changed";
  if (!result.sizeChanged) return boxes(result);
  const sizes = `size changed ${result.mainWidth}×${result.mainHeight} → ${result.branchWidth}×${result.branchHeight}`;
  return `${sizes}; overlap compared, ${boxes(result)}`;
}

/** One line of the change summary: the judge's note when there is one, then what was measured. */
export type ChangeLine = {
  id: string;
  name: string;
  variant: string;
  note: string | null;
  facts: string;
  state: string;
};

const variantOf = (shot: SnapshotView) =>
  `${shot.platform} · ${shot.browser} · ${shot.viewport} · ${shot.theme}`;

const byWhom = (by: string | null) => (by ? ` by ${by}` : "");

/** Who decided a change against main, and on which build: "accepted by sam on build 9c2e41a". */
export function decisionText(shot: BranchShot): string {
  const decision = shot.decision;
  if (!decision) return "waiting";
  const since = decision.earlier ? " · unchanged since" : "";
  return `${decision.state}${byWhom(decision.by)} on build ${decision.commitSha.slice(0, 7)}${since}`;
}

/** Against main: every shot that differs from main, rejected first, then waiting, then accepted. */
export function againstMainLines(shots: BranchShot[]): ChangeLine[] {
  const order: MainGroup[] = ["rejected", "waiting", "accepted"];
  return order.flatMap((group) =>
    shots
      .filter((shot) => shot.mainGroup === group)
      .map((shot) => ({
        id: shot.id,
        name: shot.name,
        variant: variantOf(shot),
        note: shot.changeNote,
        facts: measuredFacts(shot.mainDiffStatus, shot.mainDiffResult),
        state: decisionText(shot),
      })),
  );
}

/** Since the last build: the head build's changed, new and removed shots, as the build page groups them. */
export function sinceLastBuildLines(shots: SnapshotView[]): ChangeLine[] {
  const order = ["changed", "new", "removed"] as const;
  return order.flatMap((group) =>
    shots
      .filter((shot) => groupOf(shot) === group)
      .map((shot) => ({
        id: shot.id,
        name: shot.name,
        variant: variantOf(shot),
        note: shot.changeNote,
        facts: measuredFacts(shot.diffStatus, shot.diffResult),
        state:
          shot.reviewState === "pending"
            ? "not reviewed"
            : `${shot.reviewState}${byWhom(shot.reviewedBy)}`,
      })),
  );
}
