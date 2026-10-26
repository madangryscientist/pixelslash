import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import {
  Body,
  BodyStrong,
  Button,
  ButtonLink,
  Card,
  Cluster,
  ClusterGrow,
  Code,
  MetaList,
  ProgressBar,
  Stack,
  TextLink,
} from "@hackcove/ui";
import { StatusBadge, useHydrated } from "#/components/ui";
import type { BuildView, SnapshotView } from "#/db/review";
import { firstToReview } from "#/lib/build-tabs";
import { formatDateTime } from "#/lib/format";
import { holdsChange, skippedFlaky } from "#/lib/snapshot-groups";

function toReviewText(baseline: boolean, toReview: number): string {
  if (baseline) return "baseline set";
  return toReview === 0 ? "nothing to review" : `${toReview} to review`;
}

function Progress({ reviewed, total }: { reviewed: number; total: number }) {
  return (
    <Stack gap="xs" data-testid="review-progress">
      <Body as="p" tone="muted">
        {total === 0 ? "No changed shots to review" : `${reviewed} of ${total} reviewed`}
      </Body>
      <ProgressBar value={reviewed} max={total} label="Changed shots reviewed" tone="positive" />
    </Stack>
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
      size="sm"
    >
      Accept all
    </Button>
  );
}

/** Shots skipped as flaky (ob 1724) hold a change nobody reviews: counted here, not as reviewed. */
function SkippedFlaky({ projectId, count }: { projectId: string; count: number }) {
  if (count === 0) return null;
  return (
    <TextLink
      tone="warn"
      data-testid="skipped-flaky-count"
      render={(props) => (
        <Link to="/projects/$projectId/flakes" params={{ projectId }} {...props} />
      )}
    >
      {count} skipped: flaky
    </TextLink>
  );
}

/** Every branch but the default one has a branch page: the whole branch against main (ob 1723). */
function BranchLink({ projectId, branch }: { projectId: string; branch: string }) {
  return (
    <TextLink
      data-testid="branch-link"
      render={(props) => (
        <Link
          to="/projects/$projectId/branches/$branch"
          params={{ projectId, branch }}
          {...props}
        />
      )}
    >
      Review the whole branch
    </TextLink>
  );
}

/** Open the next shot to review, or accept every one at once. */
function ReviewActions({
  projectId,
  buildId,
  next,
  toReview,
  reviewable,
  onAccept,
}: {
  projectId: string;
  buildId: string;
  next: SnapshotView | undefined;
  toReview: number;
  reviewable: boolean;
  onAccept: () => Promise<void>;
}) {
  return (
    <Cluster gap="xs">
      {next ? (
        <ButtonLink
          size="sm"
          data-testid="review-next"
          render={(props) => (
            <Link
              to="/projects/$projectId/builds/$buildId/snapshots/$snapshotId"
              params={{ projectId, buildId, snapshotId: next.id }}
              {...props}
            />
          )}
        >
          Review next
        </ButtonLink>
      ) : (
        <Button disabled size="sm" data-testid="review-next">
          Review next
        </Button>
      )}
      <AcceptAll toReview={toReview} reviewable={reviewable} onAccept={onAccept} />
    </Cluster>
  );
}

export function BuildHeader({
  projectId,
  defaultBranch,
  build,
  snapshots,
  toReview,
  reviewable,
  onAccept,
  baseline,
  children,
}: {
  projectId: string;
  defaultBranch: string;
  build: BuildView["build"];
  snapshots: SnapshotView[];
  toReview: number;
  reviewable: boolean;
  onAccept: () => Promise<void>;
  /** The project's first build: it sets the baseline, so there is nothing to review or accept. */
  baseline: boolean;
  /** Shown last in the header: the build's AI summary (ob 1668). */
  children?: ReactNode;
}) {
  const skipped = snapshots.filter(skippedFlaky).length;
  const changed = snapshots.filter((shot) => holdsChange(shot) && !skippedFlaky(shot));
  // Unchanged here, yet still different from the default branch (ob 1722): an all-"no change"
  // build is not "identical to main".
  const approvedEarlier = snapshots.filter((shot) => shot.approvedEarlier).length;
  const next = firstToReview(snapshots);
  return (
    <Card as="section">
      <Stack>
        <Cluster gap="sm" wrap>
          <MetaList>
            <BodyStrong data-testid="build-branch">{build.branch}</BodyStrong>
            {build.branch !== defaultBranch && (
              <BranchLink projectId={projectId} branch={build.branch} />
            )}
            <Code>{build.commitSha.slice(0, 7)}</Code>
            {build.prNumber !== null && `PR #${build.prNumber}`}
            {formatDateTime(build.createdAt)}
          </MetaList>
          <StatusBadge status={build.status} />
          <BodyStrong data-testid="to-review">{toReviewText(baseline, toReview)}</BodyStrong>
          <SkippedFlaky projectId={projectId} count={skipped} />
          {approvedEarlier > 0 && (
            <Body tone="muted" data-testid="approved-earlier-count">
              {approvedEarlier} approved earlier on this branch
            </Body>
          )}
        </Cluster>
        {baseline ? (
          <Body as="p" data-testid="build-baseline">
            This build is the baseline. It is the first build that can be a baseline for this
            project, so its {snapshots.length} shot{snapshots.length === 1 ? "" : "s"} have nothing
            to be compared with and need no review. Later builds are compared against it.
          </Body>
        ) : (
          <Cluster gap="sm" align="end" wrap>
            <ClusterGrow>
              <Progress reviewed={changed.length - toReview} total={changed.length} />
            </ClusterGrow>
            <ReviewActions
              projectId={projectId}
              buildId={build.id}
              next={next}
              toReview={toReview}
              reviewable={reviewable}
              onAccept={onAccept}
            />
          </Cluster>
        )}
        {children}
      </Stack>
    </Card>
  );
}
