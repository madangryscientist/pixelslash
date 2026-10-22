import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button, buttonClass } from "@hackcove/ui";
import { StatusBadge, useHydrated } from "#/components/ui";
import type { BuildView, SnapshotView } from "#/db/review";
import { firstToReview } from "#/lib/build-tabs";
import { formatDateTime } from "#/lib/format";
import { holdsChange } from "#/lib/snapshot-groups";

function toReviewText(baseline: boolean, toReview: number): string {
  if (baseline) return "baseline set";
  return toReview === 0 ? "nothing to review" : `${toReview} to review`;
}

function Progress({ reviewed, total }: { reviewed: number; total: number }) {
  const percent = total === 0 ? 0 : Math.round((reviewed / total) * 100);
  return (
    <div className="min-w-48 flex-1" data-testid="review-progress">
      <p className="mb-1 text-sm text-slate-600">
        {total === 0 ? "No changed shots to review" : `${reviewed} of ${total} reviewed`}
      </p>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={reviewed}
        aria-label="Changed shots reviewed"
        className="h-2 overflow-hidden rounded-full border border-slate-200 bg-slate-100"
      >
        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function AcceptAll({
  toReview,
  reviewable,
  onAccept,
}: {
  toReview: number;
  reviewable: boolean;
  onAccept: () => Promise<void>;
}) {
  const hydrated = useHydrated();
  const [busy, setBusy] = useState(false);
  const accept = () => {
    setBusy(true);
    void onAccept().finally(() => setBusy(false));
  };
  return (
    <Button
      variant="outline"
      disabled={!hydrated || busy || !reviewable || toReview === 0}
      onClick={accept}
      className="px-3 py-1.5"
    >
      Accept all
    </Button>
  );
}

export function BuildHeader({
  projectId,
  build,
  snapshots,
  toReview,
  reviewable,
  onAccept,
  baseline,
}: {
  projectId: string;
  build: BuildView["build"];
  snapshots: SnapshotView[];
  toReview: number;
  reviewable: boolean;
  onAccept: () => Promise<void>;
  /** The project's first build: it sets the baseline, so there is nothing to review or accept. */
  baseline: boolean;
}) {
  const changed = snapshots.filter(holdsChange);
  // Unchanged here, yet still different from the default branch (ob 1722): an all-"no change"
  // build is not "identical to main".
  const approvedEarlier = snapshots.filter((shot) => shot.approvedEarlier).length;
  const next = firstToReview(snapshots);
  return (
    <header className="mb-6 rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-medium" data-testid="build-branch">
          {build.branch}
        </span>
        <span className="font-mono text-slate-700">{build.commitSha.slice(0, 7)}</span>
        {build.prNumber !== null && <span>PR #{build.prNumber}</span>}
        <StatusBadge status={build.status} />
        <span className="text-slate-500">{formatDateTime(build.createdAt)}</span>
        <span className="font-medium text-slate-700" data-testid="to-review">
          {toReviewText(baseline, toReview)}
        </span>
        {approvedEarlier > 0 && (
          <span className="text-slate-600" data-testid="approved-earlier-count">
            {approvedEarlier} approved earlier on this branch
          </span>
        )}
      </div>
      {baseline ? (
        <p className="mt-4 text-sm text-slate-700" data-testid="build-baseline">
          This build is the baseline. It is the first build that can be a baseline for this project,
          so its {snapshots.length} shot{snapshots.length === 1 ? "" : "s"} have nothing to be
          compared with and need no review. Later builds are compared against it.
        </p>
      ) : (
        <div className="mt-4 flex flex-wrap items-end gap-4">
          <Progress reviewed={changed.length - toReview} total={changed.length} />
          <div className="flex items-center gap-2">
            {next ? (
              <Link
                to="/projects/$projectId/builds/$buildId/snapshots/$snapshotId"
                params={{ projectId, buildId: build.id, snapshotId: next.id }}
                className={`${buttonClass()} px-3 py-1.5`}
                data-testid="review-next"
              >
                Review next
              </Link>
            ) : (
              <Button disabled className="px-3 py-1.5" data-testid="review-next">
                Review next
              </Button>
            )}
            <AcceptAll toReview={toReview} reviewable={reviewable} onAccept={onAccept} />
          </div>
        </div>
      )}
    </header>
  );
}
